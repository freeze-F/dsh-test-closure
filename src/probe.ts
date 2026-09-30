/**
 * Workspace test-framework probing.
 *
 * The probe is deliberately read-only and bounded: it walks the workspace with
 * a breadth-first scan (so root-level config files are always visited first),
 * never follows symlinked directories, skips vendor/build directories, and
 * stops after a fixed entry budget. It never executes a project script — every
 * conclusion comes from files on disk.
 *
 * Framework priority (first match wins, exactly as specified by the closure
 * contract):
 *   1. `package.json` declares `vitest`
 *   2. `package.json` declares `jest`
 *   3. `package.json` has a `scripts.test` entry
 *   4. `pyproject.toml` / `pytest.ini` / `conftest.py` (pytest markers)
 *   5. a `test/`-style directory or `*.test.*` / `*.spec.*` files (node:test)
 *
 * @module dsh-test-closure/probe
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

/** A detectable test framework, plus the "nothing matched" case. */
export type Framework = 'vitest' | 'jest' | 'npm-test' | 'pytest' | 'node:test' | 'unknown'

/** Every framework the probe can name, in priority order. */
export const FRAMEWORKS = ['vitest', 'jest', 'npm-test', 'pytest', 'node:test'] as const

/** The probe's structured conclusion. */
export interface ProbeResult {
  /** Detected framework, or `unknown` when nothing matched. */
  framework: Framework
  /** Workspace-relative path of the framework's config file; empty when none was found. */
  configPath: string
  /** Workspace-relative test files, framework-filtered and sorted. */
  testFiles: string[]
  /** The command the probe would run for this framework; empty when unknown. */
  suggestedCommand: string
}

/** Directories that never contain the project's own tests. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  'site-packages',
  'target',
  'vendor',
  '.idea',
  '.vscode',
])

/** `*.test.*` / `*.spec.*` for every JavaScript/TypeScript flavor. */
const JS_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
/** pytest's two default collection patterns. */
const PY_TEST_FILE = /^(?:test_.*|.*_test)\.py$/
/** Directory names that mark a conventional test root. */
const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'spec'])

/** Maximum directory entries inspected by one scan. */
const SCAN_ENTRY_BUDGET = 6000
/** Maximum directory depth inspected by one scan. */
const SCAN_MAX_DEPTH = 8
/** Maximum number of test files reported to the model. */
export const MAX_TEST_FILES = 200

/** The default command per framework, appended with targets by `commands.ts`. */
export const SUGGESTED_COMMANDS: Readonly<Record<Framework, string>> = {
  vitest: 'npx vitest run',
  jest: 'npx jest',
  'npm-test': 'npm test',
  pytest: 'python -m pytest -q',
  'node:test': 'node --test',
  unknown: '',
}

/** Config candidates per framework, most specific first. */
const CONFIG_CANDIDATES: Readonly<Record<Framework, readonly string[]>> = {
  vitest: ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs', 'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'],
  jest: ['jest.config.ts', 'jest.config.mts', 'jest.config.cts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json'],
  'npm-test': ['package.json'],
  pytest: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py'],
  'node:test': [],
  unknown: [],
}

/** pytest marker files, in the order that names the most specific config first. */
const PYTEST_MARKERS = ['pytest.ini', 'conftest.py', 'pyproject.toml', 'setup.cfg', 'tox.ini'] as const

interface ScanResult {
  /** Workspace-relative POSIX paths of every file inspected. */
  readonly paths: ReadonlySet<string>
  /** Whether a conventional test directory was seen. */
  readonly hasTestDir: boolean
}

/**
 * Breadth-first, budgeted walk of one workspace.
 * @param root - absolute workspace directory.
 * @returns the inspected relative paths and whether a test directory exists.
 */
async function scanWorkspace(root: string): Promise<ScanResult> {
  const paths = new Set<string>()
  let hasTestDir = false
  let budget = SCAN_ENTRY_BUDGET
  const queue: { dir: string; depth: number }[] = [{ dir: '', depth: 0 }]
  while (queue.length > 0 && budget > 0) {
    const current = queue.shift()
    if (current === undefined) break
    let entries
    try {
      entries = await readdir(join(root, current.dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (budget-- <= 0) break
      const relative = current.dir === '' ? entry.name : posix.join(current.dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') && entry.name !== '.github') continue
        if (TEST_DIR_NAMES.has(entry.name)) hasTestDir = true
        if (current.depth < SCAN_MAX_DEPTH) queue.push({ dir: relative, depth: current.depth + 1 })
        continue
      }
      if (entry.isFile()) paths.add(relative)
    }
  }
  return { paths, hasTestDir }
}

/** Read one JSON object, returning `undefined` for a missing, unreadable, or non-object file. */
async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Every dependency name declared by one `package.json`, regardless of section. */
function declaredDependencies(pkg: Record<string, unknown> | undefined): Set<string> {
  const names = new Set<string>()
  if (pkg === undefined) return names
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const value = pkg[section]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    for (const name of Object.keys(value)) names.add(name)
  }
  return names
}

/** The first candidate config path that exists in the scanned file set. */
function pickConfig(framework: Framework, paths: ReadonlySet<string>): string {
  for (const candidate of CONFIG_CANDIDATES[framework]) if (paths.has(candidate)) return candidate
  return ''
}

/** Test files whose extension matches what the framework actually collects. */
function filterTestFiles(framework: Framework, paths: ReadonlySet<string>): string[] {
  const js: string[] = []
  const py: string[] = []
  for (const path of paths) {
    const base = path.slice(path.lastIndexOf('/') + 1)
    if (JS_TEST_FILE.test(base)) js.push(path)
    else if (PY_TEST_FILE.test(base)) py.push(path)
  }
  js.sort()
  py.sort()
  if (framework === 'pytest') return py
  if (framework === 'vitest' || framework === 'jest' || framework === 'node:test') return js
  return [...js, ...py]
}

/**
 * Probe one workspace for its test framework.
 * @param workingDir - absolute directory to scan (normally the session workspace root).
 * @returns the structured probe result, never throwing for an unreadable workspace.
 */
export async function probeTests(workingDir: string): Promise<ProbeResult> {
  const scan = await scanWorkspace(workingDir)
  const pkg = await readJsonObject(join(workingDir, 'package.json'))
  const dependencies = declaredDependencies(pkg)
  const scripts = pkg?.['scripts']
  const hasTestScript =
    scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts) &&
    typeof (scripts as Record<string, unknown>)['test'] === 'string' &&
    ((scripts as Record<string, unknown>)['test'] as string).trim() !== ''

  const jsTestFiles = filterTestFiles('node:test', scan.paths)
  const pyTestFiles = filterTestFiles('pytest', scan.paths)
  const pytestMarker = PYTEST_MARKERS.find((marker) => scan.paths.has(marker))

  let framework: Framework
  if (dependencies.has('vitest')) framework = 'vitest'
  else if (dependencies.has('jest')) framework = 'jest'
  else if (hasTestScript) framework = 'npm-test'
  else if (pytestMarker !== undefined) framework = 'pytest'
  else if (jsTestFiles.length > 0) framework = 'node:test'
  // Only Python tests are on disk and nothing declares pytest: rule 5's
  // "a test/ directory" would otherwise answer `node:test`, which collects no
  // Python file at all. Naming pytest is the only answer that runs them.
  else if (pyTestFiles.length > 0) framework = 'pytest'
  else if (scan.hasTestDir) framework = 'node:test'
  else framework = 'unknown'

  const testFiles = filterTestFiles(framework, scan.paths).slice(0, MAX_TEST_FILES)
  const configPath =
    framework === 'jest' && pickConfig(framework, scan.paths) === '' && pkg?.['jest'] !== undefined
      ? 'package.json'
      : pickConfig(framework, scan.paths)

  return {
    framework,
    configPath,
    testFiles,
    suggestedCommand: SUGGESTED_COMMANDS[framework],
  }
}
