# dsh-test-closure

A closed loop for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
**probe the test framework → run the suite → summarize structurally → block turn
completion while it is still red → retry → release or mark the session
unresolved.**

The plugin is a Cordis plugin bundle. It contributes three model tools and one
turn-stopping gate, and it owns no service of its own.

## What it contributes

| Row | Kind | Purpose |
|---|---|---|
| `test_probe` | tool | Detect vitest / jest / an npm test script / pytest / node:test, without running anything |
| `test_run` | tool | Run the suite under the session sandbox policy, return counts + per-case failures + an output tail |
| `test_closure_check` | tool | Report whether this session satisfies the completion condition |
| `agent/turn-stopping` listener | gate | Steer a corrective message back into the agent while the last run is red |

## Install

Into a profile (this is what makes the row part of the composition):

```sh
dsh plugin --profile web add /absolute/path/to/dsh-test-closure
```

Then list it as a bundle layer in the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-test-closure"]
    }
  }
}
```

The bundle layer inserts one row over whatever composition it is stacked onto,
so nothing else has to be edited. Address the row by id from a later layer to
reconfigure or disable it — a patch replaces a row's whole `config`, so restate
every field you need:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: dsh-test-closure
  disabled: true

- id: dsh-test-closure
  config:
    maxInterceptRounds: 1
    summaryTailChars: 4000
```

### Which plane it belongs to

The patch inserts the row at the bundle layer, i.e. the **host composition**:
the plugin publishes no service, so it cannot collide with a second session, and
its turn-stopping listener is a single process-wide listener keyed by session id.
It is equally usable from an agent preset — it is a pure consumer of `tools`,
`shell`, and `sandboxPolicy`, so it needs no `isolate` realm — but a preset-local
copy would give each session its own closure state, which is only interesting if
you want per-preset testing policy rather than per-deployment.

## Configuration

Validated by the loader before `apply` runs; anything the schema cannot express
(integrality, positivity) is rejected in `apply` with a message naming every
offending field.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `maxInterceptRounds` | integer ≥ 0 | `2` | Corrective interceptions allowed **per turn** |
| `defaultTimeoutMs` | integer ≥ 1 | `120000` | Timeout when a call omits `timeout_ms` |
| `summaryTailChars` | integer ≥ 0 | `3000` | Characters of raw output kept as `outputTail` |
| `enabled` | boolean | `true` | Master switch: `false` contributes no tools and no gate |

## The loop

```
test_probe        → framework, config path, test files, suggested command
test_run          → { ok, summary{total,passed,failed,skipped}, failures[], outputTail }
   ↓ red
agent/turn-stopping ── gate ──▶ agent.steer("…请修复后重新运行 test_run 验证。")
   ↓ the loop re-reads its next-step inbox and runs another step
test_run again    → green → test_closure_check passes → the turn closes
   ↓ still red after `maxInterceptRounds`
turn released, session marked `unresolved`
```

### How the interception actually works

`agent/turn-stopping` is a **serial** event: its listeners run in order and its
return value is not a veto. The documented objection channel is
`agent.steer(message)` — the loop re-reads its next-step inbox immediately after
the dispatch and runs another step when a listener put something there. The
injected message carries the plugin source tag
(`{kind:'plugin', plugin:'dsh-test-closure', form:'notice'}`), so it renders as
a plugin notice rather than as a user prompt.

### Budget semantics

The budget is counted **per turn**, not per session — the contract says "each
turn may be intercepted at most `maxInterceptRounds` times". A session-lifetime
budget would mean two unlucky turns early in a long session silently disable the
gate for the rest of it.

`unresolved` is therefore a **record**, not a switch: it reports that a turn
ended still red after its budget was spent, and it is surfaced by
`test_closure_check`. A later turn gets a fresh budget; a passing run is what
clears the marker. Within any single turn the gate can never loop, because the
budget bounds it and a new turn requires new input.

### What the gate does *not* do

It never guesses. A session with no recorded run passes: the gate withholds
completion only on evidence of failure. It also does not watch the filesystem —
if code changes after a green run without re-running the tests, the recorded
verdict stays green until the next `test_run`.

## Sandbox compliance

`test_run` does not spawn anything itself. It resolves the calling session's
policy through `ctx.sandboxPolicy.resolve({ session })` and hands the command to
`ctx.shell` — the same seam, policy, process management, and output budget the
built-in `bash` tool uses:

```ts
const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
await ctx.shell.run(ctx.shell.resolve({
  command, workdir: policy.workspaceRoot, timeoutMs,
  dshEnv: ctx.shellEnv.collect(exec),
  sandboxPolicy: policy,
  signal: exec.signal,
}))
```

Resolution priority is the policy owner's: an explicitly approved mode beats the
session's last `sandbox/mode` event, which beats the deployment default. The
workspace root and the confinement are read from the same resolved object, so
they cannot disagree. The resulting policy mode is reported on every run
(`sandbox.mode`), and a sandbox denial is reported as such rather than as a test
failure.

The probe only reads: it walks the workspace breadth-first with an entry budget,
never follows symlinked directories, and skips `node_modules`, build output, and
virtualenv directories.

## Framework detection

First match wins:

1. `package.json` declares `vitest`
2. `package.json` declares `jest`
3. `package.json` has a `scripts.test` entry
4. pytest markers (`pyproject.toml`, `pytest.ini`, `conftest.py`, `setup.cfg`, `tox.ini`)
5. `*.test.*` / `*.spec.*` files, or a `test/`-style directory

One documented refinement: when only Python test files exist and nothing declares
pytest, the probe answers `pytest` rather than `node:test`. Rule 5 would name a
runner that collects no Python file at all.

## Output parsing

Each runner's default and compact reporters are parsed:

| Framework | Counters | Failures |
|---|---|---|
| vitest | `Tests  1 failed \| 3 passed (4)` | `FAIL file > name` blocks, `× name` + `→ message` |
| jest | `Tests: 1 failed, 3 passed, 4 total` | `● name` blocks, `✕ name` |
| pytest | `===== 1 failed, 11 passed in 3.2s =====` | `FAILED nodeid - message`, traceback sections |
| node:test | `# tests 2` (TAP) and `ℹ tests 2` (default reporter) | `not ok N - name` (TAP), `✖ name` under `✖ failing tests:` |

Parsing is total — unrecognizable output yields empty counts instead of
throwing — and `ok` is decided by the process outcome, never by a parse:
`ok = !timedOut && !aborted && exitCode === 0 && failed === 0`.

## `test_run` parameters

| Parameter | Meaning |
|---|---|
| `framework` | Override detection: `vitest` / `jest` / `npm-test` / `pytest` / `node:test` |
| `target` | Space-separated paths or node ids appended to the command |
| `last_failed` | Re-run only the cases the previous run reported as failing |
| `command` | Full command override, run verbatim; ignores `target` and `last_failed` |
| `timeout_ms` | Timeout for this run (defaults to `defaultTimeoutMs`) |
| `run_in_background` | Start the suite as a job and return its id |

`last_failed` is expressed in each runner's own dialect: `-t <regex>` for
vitest/jest, `-k <expr>` for pytest, `--test-name-pattern` for node:test. A
runner that cannot filter by name (`npm-test`) degrades to the full suite and
says so in `notes`.

Known limits, all reported through `notes` rather than silently ignored:

- `target` values are passed as **path filters**; vitest and jest do not accept
  a bare test name there.
- A background run records its result when the job settles, so the gate sees it
  one job-poll later, and its `outputTail` is assembled from the job's stream
  reads.

## Development

```sh
npm install     # dev dependencies, including TypeScript
npm run build   # tsc: src/ → lib/, declarations to lib/types/
npm test        # node --test test/*.test.mjs
```

The test suite has three layers:

- **unit** — parsing (fixtures captured from real runners), probing, command
  planning, closure state;
- **integration** — the real `apply` against a stub context, so `defineTool`
  compiles both schemas for real and the gate is driven with a fake agent;
- **real runtime** — an actual Cordis application (real tool registry, real
  `ctx.shell`, real subprocess backend, real `ctx.sandboxPolicy`) running an
  actual test suite in a temporary workspace, including the mount → red run →
  interception → fix → green → turn closes sequence.

### Setup notes

`lib/` is committed, because a profile installs this package by path or URL and
must find built output. Run `npm run build` and commit the result whenever
`src/` changes.

The runtime packages are **peer** dependencies and are never bundled: at run
time they resolve from the dsh installation's shared module fallback
(`$DSH_HOME/profiles/node_modules`). `npm install` fetches the newest release
matching each declared range, which is the ordinary way to get a build. To
type-check against the exact versions one deployment loads instead, point
`node_modules/@deepseek-ai` at that installation's own
`node_modules/@deepseek-ai` — that is what this working copy does.

The plugin needs `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`,
`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-shell`, `@deepseek-ai/dsh-sandbox-policy`
and `@deepseek-ai/schemastery` at runtime; they are declared as peer
dependencies and resolve from the dsh installation's shared module fallback
(`$DSH_HOME/profiles/node_modules`), not from this package.
