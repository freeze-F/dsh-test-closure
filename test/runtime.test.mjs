/**
 * Real-runtime tests.
 *
 * These mount the plugin in an actual Cordis application — the real tool
 * registry, the real shell seam, the real subprocess backend, and the real
 * sandbox-policy resolver — and then run an actual test suite in a temporary
 * workspace. Nothing here is stubbed except the agent and the session, which
 * are supplied in exactly the shape `ctx.sandboxPolicy.resolve` documents
 * (`events` log plus `header.cwd`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import * as plugin from '../lib/index.js'
import { dropFixture, makeFixture } from './fixture.mjs'

// `node --test` marks every file it spawns with NODE_TEST_CONTEXT. The real
// shell seam forwards the scrubbed parent environment to its children, so an
// inner `node --test` inherits the mark and refuses to run, reporting
// "node:test run() is being called recursively within a test file" and exiting
// 0 with no results. That is an artifact of nesting a test runner inside one,
// never of a real session — so this file drops the mark to give the plugin the
// ordinary child environment it sees in production. Each test file runs in its
// own child process, so the deletion is contained.
delete process.env.NODE_TEST_CONTEXT
delete process.env.NODE_TEST_WORKER_ID

const suite = (subtract) => `import { test } from 'node:test'
import assert from 'node:assert/strict'

test('adds', () => { assert.equal(1 + 1, 2) })
test('subtracts', () => { assert.equal(2 - 1, ${subtract}) })
`

/** Await a fiber with a deadline, so a composition mistake fails instead of hanging. */
async function settle(fiber, label) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 15_000)
    // Never hold the test process open on a deadline that is about to be cleared.
    timer.unref?.()
  })
  try {
    return await Promise.race([Promise.resolve(fiber), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Mount the smallest real application that can host the plugin. */
async function mountApp(workspaceRoot, pluginConfig) {
  const ctx = new Context()
  const mounts = [
    ['systemPrompt', ctx.plugin(SystemPrompt)],
    ['tools', ctx.plugin(ToolRuntime)],
    ['subprocess', ctx.plugin(LocalSubprocessRuntime)],
    ['shell', ctx.plugin(LocalBashExecutor)],
    ['sandboxPolicy', ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot })],
    ['plugin', ctx.plugin(plugin, pluginConfig ?? {})],
  ]
  for (const [label, fiber] of mounts) await settle(fiber, label)
  return ctx
}

/** A session in exactly the shape the policy resolver reads. */
function makeSession(id, cwd, events = []) {
  return { id, events, header: { cwd } }
}

/** A fake agent: identity, a real session stub, and the steer sink the gate writes to. */
function makeAgent(ctx, session) {
  const steered = []
  return {
    id: session.id,
    session,
    ctx,
    steer(message) {
      steered.push(message)
    },
    steered,
  }
}

test('the plugin mounts in a real Cordis app and registers its tools', { timeout: 60_000 }, async (t) => {
  const root = await makeFixture({ 'package.json': '{"name":"fx","private":true}' })
  t.after(() => dropFixture(root))
  const ctx = await mountApp(root)
  t.after(() => ctx.fiber.dispose())
  const names = ctx.tools.schemas().map((schema) => schema.name)
  assert.ok(names.includes('test_probe'), `test_probe missing from ${names.join(', ')}`)
  assert.ok(names.includes('test_run'))
  assert.ok(names.includes('test_closure_check'))
})

test('a real suite runs through the real registry and reports structured failures', { timeout: 60_000 }, async (t) => {
  const root = await makeFixture({
    'package.json': '{"name":"fx","private":true}',
    'math.test.mjs': suite(2),
  })
  t.after(() => dropFixture(root))
  const ctx = await mountApp(root)
  t.after(() => ctx.fiber.dispose())

  const session = makeSession('sess-real', root)
  const agent = makeAgent(ctx, session)

  const probed = await ctx.tools.execute({
    callId: 'c1',
    name: 'test_probe',
    arguments: {},
    agent,
    signal: new AbortController().signal,
  })
  assert.equal(probed.isError, false, JSON.stringify(probed.error))
  assert.equal(probed.value.framework, 'node:test')
  assert.equal(probed.value.suggestedCommand, 'node --test')

  const result = await ctx.tools.execute({
    callId: 'c2',
    name: 'test_run',
    arguments: { timeout_ms: 30_000 },
    agent,
    signal: new AbortController().signal,
  })
  // The registry validates the returned value against the declared output schema,
  // so a schema/value mismatch would surface here as isError.
  assert.equal(result.isError, false, JSON.stringify(result.error))
  const run = result.value
  assert.equal(run.kind, 'foreground')
  assert.equal(run.ok, false, `expected the failing suite to fail: ${run.outputTail}`)
  assert.equal(run.framework, 'node:test')
  assert.equal(run.command, 'node --test')
  assert.ok(run.exitCode !== 0)
  assert.ok(run.summary.failed >= 1, `summary: ${JSON.stringify(run.summary)}`)
  assert.ok(run.failures.some((failure) => failure.name === 'subtracts'), JSON.stringify(run.failures))
  assert.equal(run.sandbox.mode, 'workspace-write')
  // The raw tail reaches the model verbatim, in whichever dialect the runner printed.
  assert.match(run.outputTail, /fail 1/)
  assert.ok(run.durationMs >= 0)

  const verdict = await ctx.tools.execute({
    callId: 'c3',
    name: 'test_closure_check',
    arguments: {},
    agent,
    signal: new AbortController().signal,
  })
  assert.equal(verdict.isError, false)
  assert.equal(verdict.value.status, 'blocked')
  assert.equal(verdict.value.reason, '1 test failed')
  assert.equal(verdict.value.unresolved, false)
})

test('the gate steers a corrective message when the turn tries to close on a red suite', { timeout: 60_000 }, async (t) => {
  const root = await makeFixture({
    'package.json': '{"name":"fx","private":true}',
    'math.test.mjs': suite(2),
  })
  t.after(() => dropFixture(root))
  const ctx = await mountApp(root, { maxInterceptRounds: 1 })
  t.after(() => ctx.fiber.dispose())

  const session = makeSession('sess-gate', root)
  const agent = makeAgent(ctx, session)
  const signal = new AbortController().signal

  await ctx.tools.execute({ callId: 'g1', name: 'test_run', arguments: {}, agent, signal })

  // Dispatch the turn boundary exactly the way the agent loop does.
  const { agentEvents } = await import('@deepseek-ai/dsh-agent')
  const stop = () => agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })

  await stop()
  assert.equal(agent.steered.length, 1, 'the gate must inject a corrective message')
  const message = agent.steered[0]
  assert.match(message.content[0].text, /^\[dsh-test-closure\] 上一轮测试未通过/)
  assert.match(message.content[0].text, /subtracts/)
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.plugin, 'dsh-test-closure')
  assert.equal(message.role, 'user')

  // The budget is spent: the turn is released and the session recorded unresolved.
  await stop()
  assert.equal(agent.steered.length, 1)
  const released = await ctx.tools.execute({ callId: 'g2', name: 'test_closure_check', arguments: {}, agent, signal })
  assert.equal(released.value.unresolved, true)
})

test('fixing the suite clears the block and lets the turn close', { timeout: 60_000 }, async (t) => {
  const root = await makeFixture({
    'package.json': '{"name":"fx","private":true}',
    'math.test.mjs': suite(2),
  })
  t.after(() => dropFixture(root))
  const ctx = await mountApp(root)
  t.after(() => ctx.fiber.dispose())
  const session = makeSession('sess-fix', root)
  const agent = makeAgent(ctx, session)
  const signal = new AbortController().signal
  const call = (name, callId, args = {}) => ctx.tools.execute({ callId, name, arguments: args, agent, signal })
  const { agentEvents } = await import('@deepseek-ai/dsh-agent')
  const stop = () => agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })

  await call('test_run', 'f1')
  await stop()
  assert.equal(agent.steered.length, 1)

  // The agent "fixes" the code and re-runs; the suite is now green.
  await import('node:fs/promises').then((fs) => fs.writeFile(`${root}/math.test.mjs`, suite(1)))
  const fixed = await call('test_run', 'f2')
  assert.equal(fixed.value.ok, true, `expected a pass: ${fixed.value.outputTail}`)
  assert.deepEqual(fixed.value.summary.failed, 0)

  const verdict = await call('test_closure_check', 'f3')
  assert.equal(verdict.value.status, 'pass')
  assert.equal(verdict.value.unresolved, false)

  await stop()
  assert.equal(agent.steered.length, 1, 'a green suite must not be intercepted')
})

test('last_failed re-runs only the failing case through the real runner', { timeout: 60_000 }, async (t) => {
  const root = await makeFixture({
    'package.json': '{"name":"fx","private":true}',
    'math.test.mjs': suite(2),
  })
  t.after(() => dropFixture(root))
  const ctx = await mountApp(root)
  t.after(() => ctx.fiber.dispose())
  const agent = makeAgent(ctx, makeSession('sess-last', root))
  const signal = new AbortController().signal
  const call = (args, callId) => ctx.tools.execute({ callId, name: 'test_run', arguments: args, agent, signal })

  const first = await call({}, 'l1')
  assert.equal(first.value.ok, false)
  const second = await call({ last_failed: true }, 'l2')
  assert.match(second.value.command, /^node --test --test-name-pattern='subtracts'$/)
  assert.equal(second.value.ok, false)
  assert.ok(second.value.summary.total <= first.value.summary.total, 'the narrowed run must not grow')
})

test('the session sandbox override changes the mode the plugin resolves', { timeout: 60_000 }, async (t) => {
  const root = await makeFixture({ 'package.json': '{"name":"fx","private":true}', 'math.test.mjs': suite(1) })
  t.after(() => dropFixture(root))
  const ctx = await mountApp(root, {})
  t.after(() => ctx.fiber.dispose())
  // The deployment default is workspace-write; a logged sandbox/mode event is
  // the per-session override the resolver folds on every read.
  const session = makeSession('sess-mode', root, [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }])
  const agent = makeAgent(ctx, session)
  const signal = new AbortController().signal
  const probed = await ctx.tools.execute({ callId: 'm1', name: 'test_probe', arguments: {}, agent, signal })
  assert.equal(probed.value.sandboxMode, 'danger-full-access')
  const run = await ctx.tools.execute({ callId: 'm2', name: 'test_run', arguments: {}, agent, signal })
  assert.equal(run.value.sandbox.mode, 'danger-full-access')
})
