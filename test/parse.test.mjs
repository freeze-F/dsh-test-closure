import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTests, stripAnsi } from '../lib/parse.js'

const VITEST = `
 RUN  v2.1.8 /project

 ✓ src/sum.test.ts (2 tests) 5ms
 ❯ src/login.test.ts (2 tests | 1 failed) 12ms
   × test_login_redirect 8ms
     → expected 200 to be 302 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/login.test.ts > login > test_login_redirect
AssertionError: expected 200 to be 302 // Object.is equality

- Expected
+ Received

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 3 passed (4)
   Start at  10:00:00
   Duration  1.20s
`

const JEST = `
FAIL src/login.test.js
  ● login › test_login_redirect

    expect(received).toBe(expected) // Object.is equality

    Expected: 302
    Received: 200

      12 |   expect(res.status).toBe(302)
         |                      ^

      at Object.<anonymous> (src/login.test.js:12:24)

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 3 passed, 4 total
Snapshots:   0 total
Time:        1.42 s
Ran all test suites.
`

const PYTEST = `
============================= test session starts ==============================
platform linux -- Python 3.11.9, pytest-8.3.3, pluggy-1.5.0
rootdir: /project
collected 12 items

tests/test_login.py ..F........                                          [ 75%]

=================================== FAILURES ===================================
___________________________ test_login_redirect ____________________________

client = <FlaskClient <Flask 'app'>>

    def test_login_redirect(client):
        response = client.get("/login")
>       assert response.status_code == 302
E       AssertionError: expected 302, got 200

tests/test_login.py:12: AssertionError
=========================== short test summary info ============================
FAILED tests/test_login.py::test_login_redirect - AssertionError: expected 302, got 200
========================= 1 failed, 11 passed in 3.20s =========================
`

const NODE_TAP = `
TAP version 13
# Subtest: math
    ok 1 - adds
    not ok 2 - subtracts
      ---
      duration_ms: 0.6
      type: 'test'
      location: '/project/math.test.js:5:3'
      failureType: 'testCodeFailure'
      error: '1 !== 2'
      code: 'ERR_ASSERTION'
      ...
    1..2
not ok 1 - math
  ---
  duration_ms: 12.3
  ...
1..1
# tests 2
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 45.6
`


// Captured verbatim from `node --test` (Node 26, non-TTY): the default reporter,
// which counts with an «ℹ» bullet and repeats the failures under a heading.
const NODE_DEFAULT = `✔ adds (7.873437ms)
✖ subtracts (4.482813ms)
ℹ tests 2
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 585.455729

✖ failing tests:

test at math.test.mjs:5:1
✖ subtracts (4.482813ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  1 !== 2
  
      at TestContext.<anonymous> (file:///project/math.test.mjs:5:34)
      at Test.runInAsyncScope (node:async_hooks:226:14)
  {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 1,
    expected: 2,
    operator: 'strictEqual',
    diff: 'simple'
  }
`

test('strips ANSI escapes without touching markers', () => {
  assert.equal(stripAnsi('\u001B[31m×\u001B[39m a'), '× a')
})

test('vitest: counts, failure name and message', () => {
  const parsed = parseTests('vitest', VITEST, '')
  assert.deepEqual(parsed.summary, { total: 4, passed: 3, failed: 1, skipped: 0 })
  assert.equal(parsed.failures.length, 1)
  assert.equal(parsed.failures[0].name, 'src/login.test.ts > login > test_login_redirect')
  assert.match(parsed.failures[0].message, /^AssertionError: expected 200 to be 302/)
  assert.doesNotMatch(parsed.failures[0].message, /Test Files/)
})

test('vitest: a fully green run reports no failures', () => {
  const green = ' Test Files  2 passed (2)\n      Tests  4 passed (4)\n'
  const parsed = parseTests('vitest', green, '')
  assert.deepEqual(parsed.summary, { total: 4, passed: 4, failed: 0, skipped: 0 })
  assert.deepEqual(parsed.failures, [])
})

test('jest: counts, failure name and message', () => {
  const parsed = parseTests('jest', JEST, '')
  assert.deepEqual(parsed.summary, { total: 4, passed: 3, failed: 1, skipped: 0 })
  assert.equal(parsed.failures.length, 1)
  assert.equal(parsed.failures[0].name, 'login › test_login_redirect')
  assert.match(parsed.failures[0].message, /expect\(received\)\.toBe\(expected\)/)
  assert.doesNotMatch(parsed.failures[0].message, /Test Suites/)
})

test('pytest: counts, node id and inline message', () => {
  const parsed = parseTests('pytest', PYTEST, '')
  assert.deepEqual(parsed.summary, { total: 12, passed: 11, failed: 1, skipped: 0 })
  assert.equal(parsed.failures.length, 1)
  assert.equal(parsed.failures[0].name, 'tests/test_login.py::test_login_redirect')
  assert.equal(parsed.failures[0].message, 'AssertionError: expected 302, got 200')
})

test('pytest: falls back to the traceback section when the short summary has no message', () => {
  const short = 'FAILED tests/test_login.py::test_login_redirect\n========================= 1 failed in 3.20s =========================\n'
  const parsed = parseTests('pytest', PYTEST.replace(/FAILED .*\n/, '') + short, '')
  assert.equal(parsed.failures[0].message, 'AssertionError: expected 302, got 200')
})

test('node:test (tap): counts and failing case', () => {
  const parsed = parseTests('node:test', NODE_TAP, '')
  assert.deepEqual(parsed.summary, { total: 2, passed: 1, failed: 1, skipped: 0 })
  assert.ok(parsed.failures.some((failure) => failure.name === 'subtracts'))
  const failing = parsed.failures.find((failure) => failure.name === 'subtracts')
  assert.match(failing.message, /1 !== 2/)
})

test('npm-test: the cascade identifies a wrapped runner it was not told about', () => {
  const parsed = parseTests('npm-test', JEST, '')
  assert.deepEqual(parsed.summary, { total: 4, passed: 3, failed: 1, skipped: 0 })
})

test('unrecognizable output yields an empty parse instead of throwing', () => {
  const parsed = parseTests('vitest', 'boom: something went wrong', '')
  assert.deepEqual(parsed.summary, { total: 0, passed: 0, failed: 0, skipped: 0 })
  assert.deepEqual(parsed.failures, [])
})

test('stderr is parsed too: a runner that reports there is still understood', () => {
  const parsed = parseTests('pytest', '', PYTEST)
  assert.equal(parsed.summary.failed, 1)
})

test('node:test (default reporter): ℹ counters and the de-duplicated failure block', () => {
  const parsed = parseTests('node:test', NODE_DEFAULT, '')
  assert.deepEqual(parsed.summary, { total: 2, passed: 1, failed: 1, skipped: 0 })
  // The failure appears twice in this reporter's output; it must be reported once.
  assert.equal(parsed.failures.length, 1)
  assert.equal(parsed.failures[0].name, 'subtracts')
  assert.equal(parsed.failures[0].message, 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: | 1 !== 2')
})

test('node:test (default reporter): a green run reports no failures', () => {
  const green = '\u2714 adds (1ms)\n\u2139 tests 1\n\u2139 pass 1\n\u2139 fail 0\n'
  const parsed = parseTests('node:test', green, '')
  assert.deepEqual(parsed.summary, { total: 1, passed: 1, failed: 0, skipped: 0 })
  assert.deepEqual(parsed.failures, [])
})
