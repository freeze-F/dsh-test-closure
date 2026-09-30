import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planCommand, shellQuote } from '../lib/commands.js'

test('shell-quotes words that need it', () => {
  assert.equal(shellQuote('plain'), "'plain'")
  assert.equal(shellQuote("it's"), "'it'\\''s'")
})

test('an override replaces the whole command line and reports the dropped filters', () => {
  const plan = planCommand({
    framework: 'vitest',
    suggestedCommand: 'npx vitest run',
    override: 'node --test',
    target: 'src',
    lastFailed: true,
  })
  assert.equal(plan.command, 'node --test')
  assert.equal(plan.notes.length, 1)
})

test('no detected framework asks for an explicit command', () => {
  const plan = planCommand({ framework: 'unknown', suggestedCommand: '' })
  assert.equal(plan.command, '')
  assert.match(plan.notes[0], /no test framework detected/)
})

test('targets are appended as quoted path filters', () => {
  const plan = planCommand({ framework: 'vitest', suggestedCommand: 'npx vitest run', target: 'src/a.test.ts src/b.test.ts' })
  assert.equal(plan.command, "npx vitest run 'src/a.test.ts' 'src/b.test.ts'")
})

test('last_failed uses each runner dialect', () => {
  const names = ['login redirects', 'sums']
  assert.equal(
    planCommand({ framework: 'vitest', suggestedCommand: 'npx vitest run', lastFailed: true, failedNames: names }).command,
    "npx vitest run -t 'login redirects|sums'",
  )
  assert.equal(
    planCommand({ framework: 'jest', suggestedCommand: 'npx jest', lastFailed: true, failedNames: names }).command,
    "npx jest -t 'login redirects|sums'",
  )
  assert.equal(
    planCommand({ framework: 'pytest', suggestedCommand: 'python -m pytest -q', lastFailed: true, failedNames: names }).command,
    "python -m pytest -q -k 'login redirects or sums'",
  )
  assert.equal(
    planCommand({ framework: 'node:test', suggestedCommand: 'node --test', lastFailed: true, failedNames: ['sums'] }).command,
    "node --test --test-name-pattern='sums'",
  )
})

test('regex metacharacters in a case name are literal in the filter', () => {
  const plan = planCommand({
    framework: 'vitest',
    suggestedCommand: 'npx vitest run',
    lastFailed: true,
    failedNames: ['a (b) [c]'],
  })
  assert.equal(plan.command, "npx vitest run -t 'a \\(b\\) \\[c\\]'")
})

test('a runner that cannot filter by name degrades to the full suite with a note', () => {
  const plan = planCommand({ framework: 'npm-test', suggestedCommand: 'npm test', lastFailed: true, failedNames: ['x'] })
  assert.equal(plan.command, 'npm test')
  assert.match(plan.notes[0], /cannot filter by test name/)
})

test('targets are ignored when they are empty or whitespace', () => {
  const plan = planCommand({ framework: 'pytest', suggestedCommand: 'python -m pytest -q', target: '   ' })
  assert.equal(plan.command, 'python -m pytest -q')
})
