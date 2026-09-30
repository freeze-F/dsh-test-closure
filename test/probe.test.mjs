import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeTests } from '../lib/probe.js'
import { dropFixture, makeFixture } from './fixture.mjs'

const pkg = (value) => JSON.stringify(value, null, 2)

test('detects vitest from devDependencies and names its config', async (t) => {
  const root = await makeFixture({
    'package.json': pkg({ devDependencies: { vitest: '^2.0.0' } }),
    'vitest.config.ts': 'export default {}',
    'src/a.test.ts': '',
    'src/b.ts': '',
  })
  t.after(() => dropFixture(root))
  const probe = await probeTests(root)
  assert.equal(probe.framework, 'vitest')
  assert.equal(probe.configPath, 'vitest.config.ts')
  assert.deepEqual(probe.testFiles, ['src/a.test.ts'])
  assert.equal(probe.suggestedCommand, 'npx vitest run')
})

test('detects jest and accepts a jest key in package.json as its config', async (t) => {
  const root = await makeFixture({
    'package.json': pkg({ devDependencies: { jest: '^29.0.0' }, jest: { testEnvironment: 'node' } }),
    'sum.spec.js': '',
  })
  t.after(() => dropFixture(root))
  const probe = await probeTests(root)
  assert.equal(probe.framework, 'jest')
  assert.equal(probe.configPath, 'package.json')
  assert.deepEqual(probe.testFiles, ['sum.spec.js'])
})

test('falls back to an npm test script when no runner is declared', async (t) => {
  const root = await makeFixture({ 'package.json': pkg({ scripts: { test: 'node --test' } }) })
  t.after(() => dropFixture(root))
  const probe = await probeTests(root)
  assert.equal(probe.framework, 'npm-test')
  assert.equal(probe.configPath, 'package.json')
  assert.equal(probe.suggestedCommand, 'npm test')
})

test('detects pytest from its markers and filters to python test files', async (t) => {
  const root = await makeFixture({
    'pyproject.toml': '[tool.pytest.ini_options]\n',
    'conftest.py': '',
    'tests/test_login.py': '',
    'tests/helpers.py': '',
    'web/a.test.ts': '',
  })
  t.after(() => dropFixture(root))
  const probe = await probeTests(root)
  assert.equal(probe.framework, 'pytest')
  assert.equal(probe.configPath, 'pyproject.toml')
  assert.deepEqual(probe.testFiles, ['tests/test_login.py'])
  assert.equal(probe.suggestedCommand, 'python -m pytest -q')
})

test('detects node:test from a test directory alone', async (t) => {
  const root = await makeFixture({ 'test/alpha.js': '', 'src/lib.js': '' })
  t.after(() => dropFixture(root))
  const probe = await probeTests(root)
  assert.equal(probe.framework, 'node:test')
  assert.equal(probe.suggestedCommand, 'node --test')
})

test('detects node:test from *.test.* files', async (t) => {
  const root = await makeFixture({ 'lib/math.test.mjs': '' })
  t.after(() => dropFixture(root))
  const probe = await probeTests(root)
  assert.equal(probe.framework, 'node:test')
  assert.deepEqual(probe.testFiles, ['lib/math.test.mjs'])
})

test('names pytest rather than node:test when only python tests exist', async (t) => {
  const root = await makeFixture({ 'tests/test_alpha.py': '' })
  t.after(() => dropFixture(root))
  const probe = await probeTests(root)
  assert.equal(probe.framework, 'pytest')
})

test('reports unknown for a workspace with no tests at all', async (t) => {
  const root = await makeFixture({ 'src/index.ts': '' })
  t.after(() => dropFixture(root))
  const probe = await probeTests(root)
  assert.equal(probe.framework, 'unknown')
  assert.equal(probe.suggestedCommand, '')
  assert.deepEqual(probe.testFiles, [])
})

test('honours the documented priority: vitest beats an npm test script and pytest markers', async (t) => {
  const root = await makeFixture({
    'package.json': pkg({ devDependencies: { vitest: '^2.0.0' }, scripts: { test: 'vitest run' } }),
    'pyproject.toml': '[tool.pytest.ini_options]\n',
  })
  t.after(() => dropFixture(root))
  const probe = await probeTests(root)
  assert.equal(probe.framework, 'vitest')
})

test('never descends into vendor directories', async (t) => {
  const root = await makeFixture({
    'node_modules/jest/package.json': pkg({ name: 'jest' }),
    'node_modules/jest/a.test.js': '',
    'src/real.test.js': '',
  })
  t.after(() => dropFixture(root))
  const probe = await probeTests(root)
  assert.equal(probe.framework, 'node:test')
  assert.deepEqual(probe.testFiles, ['src/real.test.js'])
})

test('an unreadable workspace yields unknown instead of throwing', async () => {
  const probe = await probeTests('/definitely/not/a/directory')
  assert.equal(probe.framework, 'unknown')
})
