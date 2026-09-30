import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClosureState, failureReason } from '../lib/closure.js'

/** A minimal run record; only the fields a verdict reads are meaningful. */
function record(overrides = {}) {
  return {
    ok: false,
    framework: 'pytest',
    command: 'python -m pytest -q',
    exitCode: 1,
    durationMs: 3200,
    summary: { total: 12, passed: 10, failed: 2, skipped: 0 },
    failures: [{ name: 'test_login_redirect', message: 'AssertionError: expected 302, got 200' }],
    outputTail: '...',
    timedOut: false,
    aborted: false,
    sandboxMode: 'workspace-write',
    sandboxDenied: false,
    at: 0,
    ...overrides,
  }
}

test('a session with no recorded run passes: the gate only acts on evidence', () => {
  const state = new ClosureState()
  const verdict = state.verdict('s1')
  assert.equal(verdict.status, 'pass')
  assert.equal(verdict.ran, false)
})

test('a failing run blocks with its reason and failures', () => {
  const state = new ClosureState()
  state.record('s1', record())
  const verdict = state.verdict('s1')
  assert.equal(verdict.status, 'blocked')
  assert.equal(verdict.reason, '2 tests failed')
  assert.deepEqual(verdict.failures, [{ name: 'test_login_redirect', message: 'AssertionError: expected 302, got 200' }])
})

test('a passing run clears the block and any unresolved marker', () => {
  const state = new ClosureState()
  state.record('s1', record())
  state.markUnresolved('s1', '2 tests failed')
  assert.equal(state.isUnresolved('s1'), true)
  state.record('s1', record({ ok: true, exitCode: 0, summary: { total: 12, passed: 12, failed: 0, skipped: 0 }, failures: [] }))
  assert.equal(state.verdict('s1').status, 'pass')
  assert.equal(state.isUnresolved('s1'), false)
})

test('reasons name the actual cause', () => {
  assert.equal(failureReason(record({ timedOut: true })), 'test run timed out after 3200ms')
  assert.equal(failureReason(record({ summary: { total: 0, passed: 0, failed: 0, skipped: 0 } })), 'test command exited with code 1')
  assert.equal(
    failureReason(record({ sandboxDenied: true, summary: { total: 0, passed: 0, failed: 0, skipped: 0 } })),
    'test command was denied by the workspace-write sandbox',
  )
})

test('the interception budget is per turn, not per session', () => {
  const state = new ClosureState()
  assert.equal(state.interceptCount('s1', 1), 0)
  assert.equal(state.bumpIntercept('s1', 1), 1)
  assert.equal(state.bumpIntercept('s1', 1), 2)
  assert.equal(state.interceptCount('s1', 1), 2)
  // A new turn starts with a fresh budget.
  assert.equal(state.interceptCount('s1', 2), 0)
  assert.equal(state.bumpIntercept('s1', 2), 1)
})

test('state is keyed per session', () => {
  const state = new ClosureState()
  state.record('s1', record())
  state.bumpIntercept('s1', 1)
  // A session that never ran anything is untouched: reading it must not
  // create state, and it must not inherit another session's verdict.
  assert.equal(state.verdict('s2').status, 'pass')
  assert.equal(state.verdict('s2').ran, false)
  assert.equal(state.interceptCount('s2', 1), 0)
  assert.equal(state.size, 1)
  state.record('s2', record({ ok: true, exitCode: 0, failures: [] }))
  assert.equal(state.size, 2)
  assert.equal(state.verdict('s1').status, 'blocked')
  assert.equal(state.verdict('s2').status, 'pass')
})

test('forget drops a disposed session entirely', () => {
  const state = new ClosureState()
  state.record('s1', record())
  state.bumpIntercept('s1', 1)
  state.markUnresolved('s1', 'why')
  state.forget('s1')
  assert.equal(state.size, 0)
  assert.equal(state.verdict('s1').ran, false)
  assert.equal(state.verdict('s1').unresolved, false)
})
