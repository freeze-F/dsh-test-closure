/**
 * dsh-test-closure — a closed loop from "is there a test suite" to "the turn
 * may end".
 *
 * The plugin contributes three tools and one turn-stopping gate:
 *
 * 1. `test_probe` detects the workspace's test framework without running it.
 * 2. `test_run` executes the suite through `ctx.shell` under the SAME
 *    per-session sandbox policy the built-in `bash` tool resolves, then
 *    reduces the raw output to a structured summary instead of returning it.
 * 3. `test_closure_check` reports whether the session's last run satisfies the
 *    completion condition — for the model, and for the gate below.
 * 4. An `agent/turn-stopping` listener steers a corrective message back into
 *    the agent when the last run still fails. `agent/turn-stopping` is a
 *    serial event: it cannot veto the boundary by returning anything, and its
 *    documented objection channel is `agent.steer(...)` — the loop re-reads its
 *    next-step inbox after the dispatch and runs another step when a listener
 *    put something there. That is the whole interception mechanism.
 *
 * Interception is bounded per turn (`maxInterceptRounds`, default 2). When the
 * budget is exhausted the turn is released and the session is marked
 * `unresolved`, so a red suite can never trap an agent in an endless loop; a
 * later passing run clears the marker.
 *
 * @module dsh-test-closure
 */
import { isAbsolute, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ClosureState } from './closure.js'
import type { ClosureVerdict, RunRecord } from './closure.js'
import { planCommand } from './commands.js'
import { parseTests } from './parse.js'
import type { TestFailure, TestSummary } from './parse.js'
import { probeTests } from './probe.js'
import type { Framework } from './probe.js'

/** Plugin name, also the source label of every message this plugin injects. */
export const name = 'dsh-test-closure'

/**
 * Hard dependencies. `tools` is where the three tools are registered; `shell`
 * is the execution seam the built-in `bash` tool uses, so this plugin inherits
 * its sandboxing and process management instead of spawning anything itself;
 * `sandboxPolicy` is the resolver that turns the calling session into the
 * effective mode and workspace root.
 */
export const inject = ['tools', 'shell', 'sandboxPolicy']

/** Session key used for calls that arrive without a calling agent. */
const NO_SESSION = '<no-session>'

/** Configuration accepted from `cordis.yml` / `cordis.patch.yml`. */
export interface Config {
  /** Maximum corrective interceptions per turn before the turn is released. */
  maxInterceptRounds?: number
  /** Timeout applied when a call does not pass `timeout_ms`. */
  defaultTimeoutMs?: number
  /** Characters of raw runner output kept and returned as `outputTail`. */
  summaryTailChars?: number
  /** Master switch: `false` contributes no tools and no gate. */
  enabled?: boolean
}

/** Runtime configuration schema — validated by the loader before `apply`. */
export const Config: z<Config> = z.object({
  maxInterceptRounds: z.natural().default(2).description('Maximum corrective interceptions per turn (default 2)'),
  defaultTimeoutMs: z.natural().default(120_000).description('Default test-run timeout in milliseconds (default 120000)'),
  summaryTailChars: z.natural().default(3_000).description('Characters of raw output returned as outputTail (default 3000)'),
  enabled: z.boolean().default(true).description('Whether the plugin contributes its tools and gate (default true)'),
})

/** The same configuration with every field resolved and validated. */
export interface ResolvedSettings {
  maxInterceptRounds: number
  defaultTimeoutMs: number
  summaryTailChars: number
  enabled: boolean
}

/** Fail-loud configuration defaults, kept identical to the schema's. */
const SETTINGS_DEFAULTS: ResolvedSettings = {
  maxInterceptRounds: 2,
  defaultTimeoutMs: 120_000,
  summaryTailChars: 3_000,
  enabled: true,
}

/**
 * Apply defaults and refuse values this plugin could not act on. The schema
 * already rejected non-numbers; what it cannot express is "positive" and
 * "integral", and a negative budget would silently disable interception.
 * @param config - loader-validated configuration, possibly empty.
 * @returns the complete, validated settings.
 * @throws Error naming every offending field at once.
 */
export function resolveSettings(config: Config = {}): ResolvedSettings {
  const merged: ResolvedSettings = {
    maxInterceptRounds: config.maxInterceptRounds ?? SETTINGS_DEFAULTS.maxInterceptRounds,
    defaultTimeoutMs: config.defaultTimeoutMs ?? SETTINGS_DEFAULTS.defaultTimeoutMs,
    summaryTailChars: config.summaryTailChars ?? SETTINGS_DEFAULTS.summaryTailChars,
    enabled: config.enabled ?? SETTINGS_DEFAULTS.enabled,
  }
  const problems: string[] = []
  const integer = (field: string, value: number, min: number): void => {
    if (!Number.isInteger(value) || value < min) problems.push(`${field} must be an integer >= ${min} (got ${String(value)})`)
  }
  integer('maxInterceptRounds', merged.maxInterceptRounds, 0)
  integer('defaultTimeoutMs', merged.defaultTimeoutMs, 1)
  integer('summaryTailChars', merged.summaryTailChars, 0)
  if (problems.length > 0) throw new Error(`dsh-test-closure: invalid configuration — ${problems.join('; ')}`)
  return merged
}

/** The session key one tool call or gate dispatch belongs to. */
function sessionKeyOf(agent: Agent | undefined): string {
  return agent === undefined ? NO_SESSION : String(agent.id)
}

/** The last `limit` characters of a string. */
function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/** One CSV-ish line of counts, used by every renderer. */
function renderSummary(summary: TestSummary): string {
  return `${summary.total} total, ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`
}

/** Model-facing lines for a failure list, bounded to `limit` entries. */
function renderFailures(failures: readonly TestFailure[], limit = 10): string[] {
  const lines = failures.slice(0, limit).map((failure) =>
    failure.message === '' ? `  - ${failure.name}` : `  - ${failure.name}: ${failure.message}`,
  )
  if (failures.length > limit) lines.push(`  - …and ${failures.length - limit} more`)
  return lines
}

/**
 * The canonical JSON value `test_probe` returns.
 *
 * Declared structurally rather than as {@link ProbeResult} because the output
 * schema widens `framework` to `string`: the schema is the contract the
 * registry enforces, and it cannot promise a narrower union than the model
 * may read back.
 */
interface ProbeValue {
  framework: string
  configPath: string
  testFiles: string[]
  suggestedCommand: string
  workingDir: string
  sandboxMode: string
}

/** Model-facing text for `test_probe`. */
function renderProbe(value: ProbeValue): string {
  const lines = [
    `framework: ${value.framework}`,
    `config: ${value.configPath === '' ? '(none found)' : value.configPath}`,
    `command: ${value.suggestedCommand === '' ? '(none — pass command explicitly)' : value.suggestedCommand}`,
    `working dir: ${value.workingDir} (sandbox: ${value.sandboxMode})`,
    `test files: ${value.testFiles.length}`,
  ]
  for (const file of value.testFiles.slice(0, 40)) lines.push(`  - ${file}`)
  if (value.testFiles.length > 40) lines.push(`  …and ${value.testFiles.length - 40} more`)
  return lines.join('\n')
}

/** The canonical JSON value `test_run` returns, built from one record. */
interface RunValue {
  kind: string
  ok: boolean
  framework: string
  command: string
  workingDir: string
  exitCode: number | null
  durationMs: number
  summary: TestSummary
  failures: TestFailure[]
  outputTail: string
  timedOut: boolean
  aborted: boolean
  sandbox: { mode: string; denied: boolean }
  jobId: string
  notes: string[]
}

/** Model-facing text for `test_run`. */
function renderRun(value: RunValue): string {
  if (value.kind === 'background') {
    return [
      `started background test run (job ${value.jobId})`,
      `command: ${value.command}`,
      'poll it with job_output; the closure gate sees the result once the job settles.',
    ].join('\n')
  }
  const header = `${value.ok ? 'PASS' : 'FAIL'} ${value.framework} · \`${value.command}\``
  const lines = [
    header,
    `exit ${String(value.exitCode)} · ${value.durationMs}ms · sandbox ${value.sandbox.mode}${value.sandbox.denied ? ' (denied)' : ''}`,
    `summary: ${renderSummary(value.summary)}`,
  ]
  if (value.timedOut) lines.push('the run hit its timeout and was killed')
  if (value.failures.length > 0) {
    lines.push('failures:')
    lines.push(...renderFailures(value.failures))
  }
  for (const note of value.notes) lines.push(`note: ${note}`)
  if (value.outputTail !== '') lines.push('output tail:', value.outputTail.trimEnd())
  return lines.join('\n')
}

/** Model-facing text for `test_closure_check`. */
function renderVerdict(value: {
  status: string
  reason: string
  ran: boolean
  unresolved: boolean
  framework: string
  command: string
  failures: TestFailure[]
}): string {
  if (!value.ran) return 'status: pass — no test run recorded in this session, so nothing is gating completion'
  if (value.status === 'pass') {
    return `status: pass — the last run (${value.framework}: ${value.command}) passed`
  }
  const lines = [`status: blocked — ${value.reason}`, `last run: ${value.framework}: ${value.command}`, 'failures:']
  lines.push(...renderFailures(value.failures))
  lines.push('fix the failures and run test_run again before finishing.')
  if (value.unresolved) lines.push('this session is already marked unresolved: the gate will not intercept again')
  return lines.join('\n')
}

/** The one-line account carried by an injected corrective message. */
function interceptSummary(verdict: ClosureVerdict): string {
  const first = verdict.failures[0]
  const detail = first === undefined ? verdict.reason : `${verdict.reason}: ${first.name}`
  return tail(detail, 110)
}

/**
 * The corrective message the gate steers into the agent.
 *
 * The first line keeps the contract's exact wording so the interception is
 * recognizable in a transcript; the rest is the evidence the model needs to
 * act without re-reading the raw output.
 */
function interceptMessage(verdict: ClosureVerdict, round: number, maxRounds: number): string {
  const lines = [`[dsh-test-closure] 上一轮测试未通过。失败用例：`]
  lines.push(...renderFailures(verdict.failures, 5))
  lines.push(`请修复后重新运行 test_run 验证。`)
  lines.push(
    `（${verdict.reason}；第 ${round}/${maxRounds} 次拦截，本轮达到上限后若仍未通过将放行并把会话标记为 unresolved。）`,
  )
  return lines.join('\n')
}

/**
 * Load the plugin.
 * @param ctx - plugin context; every registration below is an effect disposed with it.
 * @param config - loader-validated configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = resolveSettings(config)
  if (!settings.enabled) return

  const state = new ClosureState()
  const shell: ShellExecutor = ctx.shell
  const sandbox: SandboxPolicyService = ctx.sandboxPolicy

  /** The resolved sandbox policy for one call — the same resolver the bash tool uses. */
  const policyFor = (exec: ToolRunContext) =>
    sandbox.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  /** Resolve a requested working directory against the policy's workspace root. */
  const workdirFor = (requested: string | undefined, workspaceRoot: string): string => {
    const trimmed = requested?.trim() ?? ''
    if (trimmed === '') return workspaceRoot
    return isAbsolute(trimmed) ? trimmed : resolve(workspaceRoot, trimmed)
  }

  /** Build the shell request shared by the foreground and background paths. */
  const requestFor = (exec: ToolRunContext, command: string, workdir: string, timeoutMs: number | undefined) => {
    const policy = policyFor(exec)
    const shellEnv: ShellEnvRegistry | undefined = ctx.get('shellEnv')
    return shell.resolve({
      command,
      workdir,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(shellEnv !== undefined ? { dshEnv: shellEnv.collect(exec) } : {}),
      sandboxPolicy: { mode: policy.mode, workspaceRoot: policy.workspaceRoot },
      signal: exec.signal,
    })
  }

  /** Reduce one settled run into the record the closure state and the tools share. */
  const recordOf = (input: {
    framework: Framework
    command: string
    workdir: string
    exitCode: number | null
    durationMs: number
    stdout: string
    stderr: string
    timedOut: boolean
    aborted: boolean
    sandboxMode: string
    sandboxDenied: boolean
  }): RunRecord => {
    const parsed = parseTests(input.framework, input.stdout, input.stderr)
    const ok = !input.timedOut && !input.aborted && input.exitCode === 0 && parsed.summary.failed === 0
    return {
      ok,
      framework: input.framework,
      command: input.command,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      summary: parsed.summary,
      failures: parsed.failures,
      outputTail: tail(`${input.stdout}\n${input.stderr}`.trimEnd(), settings.summaryTailChars),
      timedOut: input.timedOut,
      aborted: input.aborted,
      sandboxMode: input.sandboxMode,
      sandboxDenied: input.sandboxDenied,
      at: Date.now(),
    }
  }

  // ---------------------------------------------------------------------
  // Tool 1: test_probe
  // ---------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'test_probe',
      description:
        'Detect the test framework of the workspace without running anything. Scans for vitest, jest, an npm test script, pytest, or a node:test layout, and reports the framework, its config file, the test files found, and the command test_run would use.',
      parameters: {
        working_dir: {
          type: 'string',
          description: 'Directory to scan; defaults to the session workspace root. A relative path resolves against that root.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            framework: { type: 'string', description: 'Detected framework, or "unknown".', required: true },
            configPath: { type: 'string', description: 'Workspace-relative config file, empty when none was found.', required: true },
            testFiles: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative test files.', required: true },
            suggestedCommand: { type: 'string', description: 'Command test_run would use; empty when unknown.', required: true },
            workingDir: { type: 'string', description: 'Absolute directory that was scanned.', required: true },
            sandboxMode: { type: 'string', description: 'Sandbox mode the session resolves to.', required: true },
          },
        },
        render: (_args, value): ContentBlock[] => [{ type: 'text', text: renderProbe(value) }],
      },
      async execute(args, exec) {
        const policy = policyFor(exec)
        const workdir = workdirFor(args.working_dir, policy.workspaceRoot)
        const probe = await probeTests(workdir)
        return {
          framework: probe.framework,
          configPath: probe.configPath,
          testFiles: probe.testFiles,
          suggestedCommand: probe.suggestedCommand,
          workingDir: workdir,
          sandboxMode: policy.mode,
        }
      },
    }),
  )

  // ---------------------------------------------------------------------
  // Tool 2: test_run
  // ---------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'test_run',
      description:
        'Run the workspace test suite under the session sandbox policy and return a structured summary (counts, per-case failures, output tail) instead of the raw log. The framework is auto-detected unless given; `target` narrows to files/directories; `last_failed` re-runs only the cases that failed last time; `command` replaces the whole command line. Long suites can run as a background job.',
      parameters: {
        framework: {
          type: 'string',
          enum: ['vitest', 'jest', 'npm-test', 'pytest', 'node:test'],
          description: 'Framework to run; omit to auto-detect with test_probe.',
        },
        target: {
          type: 'string',
          description: 'Space-separated files, directories, or node ids passed to the runner as path filters.',
        },
        last_failed: {
          type: 'boolean',
          description: 'Re-run only the cases that failed in the previous test_run of this session.',
        },
        command: {
          type: 'string',
          description: 'Complete command override, run verbatim; replaces the framework default and ignores target/last_failed.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Timeout in milliseconds; defaults to the configured defaultTimeoutMs.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Start the suite as a background job and return its job id instead of waiting.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', description: '"foreground" or "background".', required: true },
            ok: { type: 'boolean', description: 'Whether the run passed.', required: true },
            framework: { type: 'string', description: 'Framework actually used.', required: true },
            command: { type: 'string', description: 'Command line actually executed.', required: true },
            workingDir: { type: 'string', description: 'Absolute working directory.', required: true },
            exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }], description: 'Process exit code, null when signal-killed.', required: true },
            durationMs: { type: 'integer', description: 'Wall-clock duration in milliseconds.', required: true },
            summary: {
              required: true,
              type: 'object',
              additionalProperties: false,
              properties: {
                total: { type: 'integer', required: true },
                passed: { type: 'integer', required: true },
                failed: { type: 'integer', required: true },
                skipped: { type: 'integer', required: true },
              },
            },
            failures: {
              required: true,
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  message: { type: 'string', required: true },
                },
              },
            },
            outputTail: { type: 'string', description: 'Trailing raw output, up to summaryTailChars characters.', required: true },
            timedOut: { type: 'boolean', description: 'Whether the timeout killed the run.', required: true },
            aborted: { type: 'boolean', description: 'Whether the caller cancelled the run.', required: true },
            sandbox: {
              required: true,
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: { type: 'string', required: true },
                denied: { type: 'boolean', required: true },
              },
            },
            jobId: { type: 'string', description: 'Background job id, empty for foreground runs.', required: true },
            notes: { type: 'array', items: { type: 'string' }, description: 'Caveats about the planned command.', required: true },
          },
        },
        render: (_args, value): ContentBlock[] => [{ type: 'text', text: renderRun(value) }],
      },
      async execute(args, exec) {
        const key = sessionKeyOf(exec.agent)
        const policy = policyFor(exec)
        const workdir = policy.workspaceRoot

        // Detection runs even for an explicit framework, because `last_failed`
        // needs the previous record's names and an explicit framework may still
        // need the probe's base command when no `command` override is given.
        const probe = await probeTests(workdir)
        const framework = (args.framework ?? probe.framework) as Framework
        const previous = state.last(key)
        const plan = planCommand({
          framework,
          suggestedCommand: probe.suggestedCommand,
          target: args.target,
          lastFailed: args.last_failed,
          failedNames: previous?.failures.map((failure) => failure.name) ?? [],
          override: args.command,
        })
        if (plan.command.trim() === '') {
          throw new Error(
            'dsh-test-closure: no test command to run — the probe found no framework. Pass `command` explicitly, or set up a test runner.',
          )
        }

        const timeoutMs = args.timeout_ms ?? settings.defaultTimeoutMs

        if (args.run_in_background === true) {
          const jobs: JobRegistry | undefined = ctx.get('jobs')
          if (jobs === undefined) {
            throw new Error(
              'dsh-test-closure: run_in_background requires the job registry (@deepseek-ai/dsh-jobs) and its tools (@deepseek-ai/dsh-tool-jobs) to be composed',
            )
          }
          const startedAt = Date.now()
          const jobId = jobs.start({
            kind: 'bash',
            label: plan.command,
            ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
            run: () => {
              const spec = requestFor(exec, plan.command, workdir, timeoutMs)
              const process_ = shell.start(spec)
              let collected = ''
              const drain = (): string => {
                const read = process_.readOutput()
                collected += read.delta
                return read.delta
              }
              return {
                cancel: (): void => {
                  process_.kill()
                },
                readOutput: drain,
                done: process_.done.then(() => {
                  collected += process_.readOutput().delta
                  state.record(
                    key,
                    recordOf({
                      framework,
                      command: plan.command,
                      workdir,
                      exitCode: process_.exitCode,
                      durationMs: Date.now() - startedAt,
                      stdout: collected,
                      stderr: '',
                      timedOut: false,
                      aborted: false,
                      sandboxMode: policy.mode,
                      sandboxDenied: process_.sandbox?.denied === true,
                    }),
                  )
                  return process_.status === 'killed'
                    ? { status: 'killed' as const, detail: process_.signal ?? 'killed before exit' }
                    : { status: 'completed' as const, detail: `exit code: ${String(process_.exitCode ?? 0)}` }
                }),
              }
            },
          })
          return {
            kind: 'background',
            ok: true,
            framework,
            command: plan.command,
            workingDir: workdir,
            exitCode: null,
            durationMs: 0,
            summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
            failures: [],
            outputTail: '',
            timedOut: false,
            aborted: false,
            sandbox: { mode: policy.mode, denied: false },
            jobId: String(jobId),
            notes: plan.notes,
          }
        }

        const startedAt = Date.now()
        const result = await shell.run(requestFor(exec, plan.command, workdir, timeoutMs))
        const record = recordOf({
          framework,
          command: plan.command,
          workdir,
          exitCode: result.exitCode,
          durationMs: Date.now() - startedAt,
          stdout: result.stdout.text,
          stderr: result.stderr.text,
          timedOut: result.timedOut,
          aborted: result.aborted,
          sandboxMode: result.sandbox?.mode ?? policy.mode,
          sandboxDenied: result.sandbox?.denied === true,
        })
        state.record(key, record)
        return {
          kind: 'foreground',
          ok: record.ok,
          framework: record.framework,
          command: record.command,
          workingDir: workdir,
          exitCode: record.exitCode,
          durationMs: record.durationMs,
          summary: record.summary,
          failures: record.failures,
          outputTail: record.outputTail,
          timedOut: record.timedOut,
          aborted: record.aborted,
          sandbox: { mode: record.sandboxMode, denied: record.sandboxDenied },
          jobId: '',
          notes: plan.notes,
        }
      },
    }),
  )

  // ---------------------------------------------------------------------
  // Tool 3: test_closure_check
  // ---------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'test_closure_check',
      description:
        'Report whether this session satisfies the test completion condition: blocked while the last test_run still has failures, pass when it passed or no run happened yet. The turn-stopping gate consults the same state.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', description: '"pass" or "blocked".', required: true },
            reason: { type: 'string', description: 'Why the session is blocked; empty when it passes.', required: true },
            ran: { type: 'boolean', description: 'Whether any test run was recorded for this session.', required: true },
            unresolved: { type: 'boolean', description: 'Whether the gate already released this session while red.', required: true },
            framework: { type: 'string', description: 'Framework of the last recorded run.', required: true },
            command: { type: 'string', description: 'Command of the last recorded run.', required: true },
            failures: {
              required: true,
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  message: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value): ContentBlock[] => [{ type: 'text', text: renderVerdict(value) }],
      },
      async execute(_args, exec) {
        const key = sessionKeyOf(exec.agent)
        const verdict = state.verdict(key)
        const record = state.last(key)
        return {
          status: verdict.status,
          reason: verdict.reason,
          ran: verdict.ran,
          unresolved: verdict.unresolved,
          framework: record?.framework ?? '',
          command: record?.command ?? '',
          failures: verdict.failures,
        }
      },
    }),
  )

  // ---------------------------------------------------------------------
  // The gate
  // ---------------------------------------------------------------------
  // Serial event: nothing a listener returns can cancel the boundary. The
  // supported objection is `agent.steer(...)`, which lands in the next-step
  // inbox the loop re-reads immediately after this dispatch — so a message
  // here runs another step instead of closing the turn.
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const key = String(agent.id)
    const verdict = state.verdict(key)
    if (verdict.status !== 'blocked') return
    // The budget is per turn, so the release condition is too: an `unresolved`
    // session is a RECORD that its last exhausted turn ended still red, not a
    // permanent veto. A later turn gets a fresh budget — otherwise two unlucky
    // turns early in a long session would disable the gate for the rest of it —
    // while a passing run is what actually clears the marker.
    const used = state.interceptCount(key, turn)
    if (used >= settings.maxInterceptRounds) {
      state.markUnresolved(key, verdict.reason)
      return
    }
    const round = state.bumpIntercept(key, turn)
    agent.steer(
      createUserMessage({
        content: [{ type: 'text', text: interceptMessage(verdict, round, settings.maxInterceptRounds) }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: interceptSummary(verdict),
        },
      }),
    )
  })

  // ---------------------------------------------------------------------
  // Session cleanup
  // ---------------------------------------------------------------------
  ctx.on('session/disposed', (session: Session) => {
    state.forget(String(session.id))
  })
}
