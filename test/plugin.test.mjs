/**
 * Integration tests for the plugin's own wiring.
 *
 * These call the real `apply` against a stub context: `defineTool` compiles
 * both schemas for real (so an unsupported schema fails here), the sandbox
 * policy and shell seams are observed, and the gate is driven with a fake
 * agent so the steer-injection path is exercised end to end.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, resolveSettings } from '../lib/index.js'
import { dropFixture, makeFixture } from './fixture.mjs'

const VITEST_FAIL = `
 RUN  v2.1.8 /project

 ❯ src/login.test.ts (2 tests | 1 failed) 12ms
   × test_login_redirect 8ms
     → expected 200 to be 302 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/login.test.ts > test_login_redirect
AssertionError: expected 200 to be 302 // Object.is equality

 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
   Duration  1.20s
`

const VITEST_PASS = ' Test Files  1 passed (1)\n      Tests  4 passed (4)\n   Duration  0.90s\n'

/** One settled `ShellRunResult` as `ctx.shell.run` would report it. */
function shellResult(stdout, exitCode, overrides = {}) {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 120_000,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
    sandbox: { mode: 'workspace-write', denied: false },
    ...overrides,
  }
}

/** A stub Cordis context exposing exactly the surface `apply` consumes. */
function makeHarness(workspaceRoot) {
  const definitions = []
  const listeners = new Map()
  const shellRequests = []
  const policyRequests = []
  const queue = []
  const ctx = {
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
    shell: {
      resolve(request) {
        return { workdir: workspaceRoot, timeoutMs: 0, stdoutMaxBytes: 0, ...request }
      },
      async run(spec) {
        shellRequests.push(spec)
        return queue.length > 1 ? queue.shift() : queue[0]
      },
      start() {
        throw new Error('background process capacity is not exercised by this stub')
      },
    },
    sandboxPolicy: {
      resolve(request) {
        policyRequests.push(request)
        return { mode: 'workspace-write', workspaceRoot }
      },
    },
    get() {
      return undefined
    },
    on(event, handler) {
      const handlers = listeners.get(event) ?? []
      handlers.push(handler)
      listeners.set(event, handlers)
      return () => {}
    },
  }
  return {
    ctx,
    definitions,
    listeners,
    shellRequests,
    policyRequests,
    queue,
    tool: (name) => {
      const found = definitions.find((definition) => definition.name === name)
      assert.ok(found, `tool ${name} is not registered`)
      return found
    },
  }
}

/** A fake agent recording everything the gate steers into it. */
function makeAgent(id = 'sess-1') {
  const steered = []
  return {
    id,
    session: { id },
    steer(message) {
      steered.push(message)
    },
    steered,
  }
}

/** A `ToolRunContext` carrying only what these tools read. */
function makeExec(agent) {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'test_run',
    arguments: {},
    agent,
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  }
}

/** Assert one tool result satisfies the output schema the model contract declares. */
function assertValidOutput(tool, value) {
  const violations = validateJsonSchemaValue(tool.output.schema, value, '')
  assert.deepEqual(violations, [], `${tool.name} returned a value its own schema rejects`)
}

const VITEST_PKG = JSON.stringify({ devDependencies: { vitest: '^2.0.0' } })

async function vitestWorkspace(t) {
  const root = await makeFixture({ 'package.json': VITEST_PKG, 'src/login.test.ts': '', 'vitest.config.ts': '' })
  t.after(() => dropFixture(root))
  return root
}

test('apply registers the three tools plus the gate and cleanup listeners', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  apply(harness.ctx, {})
  assert.deepEqual(
    harness.definitions.map((definition) => definition.name),
    ['test_probe', 'test_run', 'test_closure_check'],
  )
  assert.equal(harness.listeners.get('agent/turn-stopping')?.length, 1)
  assert.equal(harness.listeners.get('session/disposed')?.length, 1)
})

test('the declared output schemas survive compilation with their requiredness intact', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  apply(harness.ctx, {})

  const probe = harness.tool('test_probe')
  assert.equal(probe.output.schema.type, 'object')
  assert.ok(probe.output.schema.required.includes('framework'))
  assert.ok(probe.output.schema.required.includes('testFiles'))
  assert.equal(probe.output.schema.additionalProperties, false)

  const run = harness.tool('test_run')
  for (const field of ['ok', 'summary', 'failures', 'outputTail', 'exitCode', 'sandbox', 'jobId', 'notes']) {
    assert.ok(run.output.schema.required.includes(field), `test_run output must require ${field}`)
  }
  assert.deepEqual(run.output.schema.properties.summary.required, ['total', 'passed', 'failed', 'skipped'])
  assert.equal(run.output.schema.properties.failures.items.additionalProperties, false)
  // Every parameter is optional, so the implicit parameter root declares none required.
  assert.equal(run.parameters.required, undefined)

  const closure = harness.tool('test_closure_check')
  assert.ok(closure.output.schema.required.includes('status'))
  assert.ok(closure.output.schema.required.includes('unresolved'))
})

test('test_probe reports the workspace framework through the sandbox policy root', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  apply(harness.ctx, {})
  const agent = makeAgent()
  const value = await harness.tool('test_probe').execute({}, makeExec(agent))
  assertValidOutput(harness.tool('test_probe'), value)
  assert.equal(value.framework, 'vitest')
  assert.equal(value.configPath, 'vitest.config.ts')
  assert.equal(value.workingDir, root)
  assert.equal(value.sandboxMode, 'workspace-write')
  assert.deepEqual(value.testFiles, ['src/login.test.ts'])
})

test('test_run executes under the resolved sandbox policy and returns a structured summary', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  harness.queue.push(shellResult(VITEST_FAIL, 1))
  apply(harness.ctx, {})
  const agent = makeAgent()
  const value = await harness.tool('test_run').execute({}, makeExec(agent))
  assertValidOutput(harness.tool('test_run'), value)

  assert.equal(value.kind, 'foreground')
  assert.equal(value.ok, false)
  assert.equal(value.framework, 'vitest')
  assert.equal(value.command, 'npx vitest run')
  assert.equal(value.exitCode, 1)
  assert.deepEqual(value.summary, { total: 4, passed: 3, failed: 1, skipped: 0 })
  assert.equal(value.failures.length, 1)
  assert.equal(value.failures[0].name, 'src/login.test.ts > test_login_redirect')
  assert.match(value.outputTail, /Duration/)
  assert.deepEqual(value.sandbox, { mode: 'workspace-write', denied: false })

  // The command ran through the shell seam, in the policy workspace root, carrying the policy.
  assert.equal(harness.shellRequests.length, 1)
  assert.equal(harness.shellRequests[0].workdir, root)
  assert.deepEqual(harness.shellRequests[0].sandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
  assert.equal(harness.shellRequests[0].timeoutMs, 120_000)
  assert.equal(harness.sandboxPolicyCount ?? 0, 0)
  assert.ok(harness.policyRequests.length >= 1)
  assert.equal(harness.policyRequests[0].session.id, 'sess-1')
})

test('last_failed re-runs exactly the cases the previous run reported', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  harness.queue.push(shellResult(VITEST_FAIL, 1), shellResult(VITEST_PASS, 0))
  apply(harness.ctx, {})
  const exec = makeExec(makeAgent())
  await harness.tool('test_run').execute({}, exec)
  await harness.tool('test_run').execute({ last_failed: true }, exec)
  assert.match(harness.shellRequests[1].command, /^npx vitest run -t 'src\/login\\\.test\\\.ts > test_login_redirect'$/)
})

test('a command override is run verbatim', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  harness.queue.push(shellResult(VITEST_PASS, 0))
  apply(harness.ctx, {})
  const value = await harness.tool('test_run').execute({ command: 'node --test' }, makeExec(makeAgent()))
  assert.equal(value.command, 'node --test')
  assert.equal(harness.shellRequests[0].command, 'node --test')
})

test('the closure loop blocks, intercepts twice, releases as unresolved, then clears', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  harness.queue.push(shellResult(VITEST_FAIL, 1), shellResult(VITEST_PASS, 0))
  apply(harness.ctx, {})
  const agent = makeAgent('sess-loop')
  const exec = makeExec(agent)
  const gate = harness.listeners.get('agent/turn-stopping')[0]
  const stop = (turn) => gate({ agent, turn, signal: new AbortController().signal })

  const first = await harness.tool('test_run').execute({}, exec)
  assert.equal(first.ok, false)
  const blocked = await harness.tool('test_closure_check').execute({}, exec)
  assertValidOutput(harness.tool('test_closure_check'), blocked)
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.reason, '1 test failed')
  assert.equal(blocked.unresolved, false)

  // First and second stops of the turn are intercepted.
  await stop(1)
  await stop(1)
  assert.equal(agent.steered.length, 2)
  const message = agent.steered[0]
  assert.match(message.content[0].text, /^\[dsh-test-closure\] 上一轮测试未通过。失败用例：/)
  assert.match(message.content[0].text, /test_login_redirect/)
  assert.match(message.content[0].text, /请修复后重新运行 test_run 验证。/)
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.plugin, 'dsh-test-closure')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.role, 'user')

  // Third stop: budget exhausted, turn released, session marked unresolved.
  await stop(1)
  assert.equal(agent.steered.length, 2)
  const released = await harness.tool('test_closure_check').execute({}, exec)
  assert.equal(released.status, 'blocked')
  assert.equal(released.unresolved, true)

  // The marker records the release; it does not disable the gate. A later turn
  // gets its own budget, which is what keeps a long session gated.
  await stop(2)
  assert.equal(agent.steered.length, 3)

  // A passing run clears both the block and the marker.
  const second = await harness.tool('test_run').execute({}, exec)
  assert.equal(second.ok, true)
  const cleared = await harness.tool('test_closure_check').execute({}, exec)
  assert.equal(cleared.status, 'pass')
  assert.equal(cleared.unresolved, false)
  await stop(2)
  assert.equal(agent.steered.length, 3, 'a green session is never intercepted')
})

test('the interception budget is refilled by a new turn', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  harness.queue.push(shellResult(VITEST_FAIL, 1))
  apply(harness.ctx, { maxInterceptRounds: 1 })
  const agent = makeAgent('sess-turn')
  const exec = makeExec(agent)
  const gate = harness.listeners.get('agent/turn-stopping')[0]

  await harness.tool('test_run').execute({}, exec)
  await gate({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1)
  await gate({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 1, 'the budget for turn 1 is spent')

  // A later turn gets its own budget, even though the session stays red.
  harness.queue.push(shellResult(VITEST_FAIL, 1))
  await harness.tool('test_run').execute({}, exec)
  await gate({ agent, turn: 2, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 2)
})

test('a session with no recorded run is never blocked', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  apply(harness.ctx, {})
  const agent = makeAgent('sess-quiet')
  const verdict = await harness.tool('test_closure_check').execute({}, makeExec(agent))
  assert.equal(verdict.status, 'pass')
  assert.equal(verdict.ran, false)
  await harness.listeners.get('agent/turn-stopping')[0]({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steered.length, 0)
})

test('disposing a session forgets its record and its budget', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  harness.queue.push(shellResult(VITEST_FAIL, 1))
  apply(harness.ctx, {})
  const agent = makeAgent('sess-gone')
  const exec = makeExec(agent)
  await harness.tool('test_run').execute({}, exec)
  await harness.listeners.get('session/disposed')[0]({ id: 'sess-gone' })
  const verdict = await harness.tool('test_closure_check').execute({}, exec)
  assert.equal(verdict.ran, false)
  assert.equal(verdict.status, 'pass')
})

test('state does not leak between sessions', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  harness.queue.push(shellResult(VITEST_FAIL, 1))
  apply(harness.ctx, {})
  await harness.tool('test_run').execute({}, makeExec(makeAgent('sess-a')))
  const other = await harness.tool('test_closure_check').execute({}, makeExec(makeAgent('sess-b')))
  assert.equal(other.status, 'pass')
  assert.equal(other.ran, false)
})

test('run_in_background without the job registry fails with an actionable error', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  apply(harness.ctx, {})
  await assert.rejects(
    () => harness.tool('test_run').execute({ run_in_background: true }, makeExec(makeAgent())),
    /requires the job registry/,
  )
})

test('an unknown framework with no override fails loudly instead of running nothing', async (t) => {
  const root = await makeFixture({ 'src/only.ts': '' })
  t.after(() => dropFixture(root))
  const harness = makeHarness(root)
  apply(harness.ctx, {})
  await assert.rejects(() => harness.tool('test_run').execute({}, makeExec(makeAgent())), /no test command to run/)
  assert.equal(harness.shellRequests.length, 0)
})

test('enabled: false contributes nothing at all', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  apply(harness.ctx, { enabled: false })
  assert.equal(harness.definitions.length, 0)
  assert.equal(harness.listeners.size, 0)
})

test('invalid configuration fails loudly at load time', () => {
  assert.throws(() => resolveSettings({ maxInterceptRounds: -1 }), /maxInterceptRounds must be an integer >= 0/)
  assert.throws(() => resolveSettings({ defaultTimeoutMs: 0 }), /defaultTimeoutMs must be an integer >= 1/)
  assert.throws(() => resolveSettings({ summaryTailChars: 1.5 }), /summaryTailChars must be an integer >= 0/)
  assert.deepEqual(resolveSettings(), {
    maxInterceptRounds: 2,
    defaultTimeoutMs: 120_000,
    summaryTailChars: 3_000,
    enabled: true,
  })
})

test('summaryTailChars bounds what the model sees, not what the parser reads', async (t) => {
  const root = await vitestWorkspace(t)
  const harness = makeHarness(root)
  harness.queue.push(shellResult(VITEST_FAIL, 1))
  apply(harness.ctx, { summaryTailChars: 40 })
  const value = await harness.tool('test_run').execute({}, makeExec(makeAgent()))
  assert.equal(value.outputTail.length, 40)
  assert.equal(value.summary.failed, 1, 'counts come from the whole output, not from the tail')
})
