/**
 * Test-output parsing for the five probed frameworks.
 *
 * Every parser turns raw runner output into the same structured shape, so the
 * closure gate never has to know which runner produced it. Parsers are
 * total: an unrecognizable output yields an empty summary rather than
 * throwing, and `ok` is always decided by the exit status, not by a parse.
 *
 * @module dsh-test-closure/parse
 */
import type { Framework } from './probe.js';
/** One failed test case, already clipped for model consumption. */
export interface TestFailure {
    /** Test name, node id, or `file > suite > name` path. */
    name: string;
    /** The runner's message for that failure; empty when the parser found none. */
    message: string;
}
/** Aggregate counts for one run. */
export interface TestSummary {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
}
/** What one parser recovered from a run's output. */
export interface ParsedRun {
    summary: TestSummary;
    failures: TestFailure[];
}
/** Maximum characters kept per failure message. */
export declare const FAILURE_MESSAGE_CHARS = 600;
/** An empty parse result. */
export declare const EMPTY_PARSE: ParsedRun;
/** Remove ANSI SGR/erase sequences so markers like `×` survive intact. */
export declare function stripAnsi(text: string): string;
/** Vitest's default reporter: `Tests  2 failed | 10 passed (12)` plus a `Failed Tests` section. */
export declare function parseVitest(text: string): ParsedRun;
/** Jest's default reporter: `Tests:  2 failed, 10 passed, 12 total` plus `● name` blocks. */
export declare function parseJest(text: string): ParsedRun;
/** pytest: `===== 2 failed, 10 passed, 1 skipped in 3.20s =====` plus `FAILED nodeid - message`. */
export declare function parsePytest(text: string): ParsedRun;
/**
 * node:test, in both of the shapes this runner actually prints.
 *
 * The TAP reporter writes `# tests 12` counters and `not ok N - name` blocks;
 * the default reporter writes the same counters with an `ℹ` bullet, `✖ name`
 * markers, and — importantly — the failures TWICE: inline after each test, and
 * again under a `✖ failing tests:` heading. Only the second block is
 * authoritative, so the scan starts below that heading when it is present.
 */
export declare function parseNodeTest(text: string): ParsedRun;
/**
 * Parse one run's output.
 *
 * The framework's own parser is tried first; when it recovers nothing (a
 * wrapper printed another runner's report, or `npm-test` hides which runner
 * ran), every other parser is tried and the richest result wins. Exit status
 * is never consulted here — `ok` belongs to the caller.
 * @param framework - the framework the run was launched as.
 * @param stdout - collected stdout (already a tail when truncated).
 * @param stderr - collected stderr.
 * @returns the recovered summary and failures.
 */
export declare function parseTests(framework: Framework, stdout: string, stderr: string): ParsedRun;
