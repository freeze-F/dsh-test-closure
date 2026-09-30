/**
 * Per-session closure state: the most recent run record, the per-turn
 * interception counter, and the "unresolved" marker a released-but-still-red
 * session carries.
 *
 * State is keyed by session id and owned by one plugin instance, so it
 * disappears with the plugin fiber. The counter is stored per session but
 * *read* per turn: `agent/turn-stopping` fires once per turn that is about to
 * close, and a fresh turn must start with a fresh interception budget — a
 * single session-lifetime budget would silently release every later turn.
 *
 * @module dsh-test-closure/closure
 */
import type { TestFailure, TestSummary } from './parse.js';
import type { Framework } from './probe.js';
/** Everything one `test_run` observed, in canonical JSON form. */
export interface RunRecord {
    ok: boolean;
    framework: Framework;
    command: string;
    exitCode: number | null;
    durationMs: number;
    summary: TestSummary;
    failures: TestFailure[];
    outputTail: string;
    timedOut: boolean;
    aborted: boolean;
    sandboxMode: string;
    sandboxDenied: boolean;
    at: number;
}
/** The gate's verdict for one session. */
export type ClosureVerdict = {
    status: 'pass';
    ran: boolean;
    unresolved: boolean;
    reason: string;
    failures: TestFailure[];
} | {
    status: 'blocked';
    ran: true;
    unresolved: boolean;
    reason: string;
    failures: TestFailure[];
};
/** Why a run did not pass, in one short line. */
export declare function failureReason(record: RunRecord): string;
/** Mutable closure state for one plugin instance. */
export declare class ClosureState {
    private readonly runs;
    private readonly budgets;
    private readonly unresolved;
    /**
     * Store the outcome of one run. A passing run clears the session's
     * `unresolved` marker: the session has demonstrably converged, so the stale
     * "we gave up on this" label must not outlive the evidence for it.
     * @param key - session key.
     * @param record - the completed run.
     */
    record(key: string, record: RunRecord): void;
    /** The most recent record for one session. */
    last(key: string): RunRecord | undefined;
    /** How many times this session's current turn has already been intercepted. */
    interceptCount(key: string, turn: number): number;
    /**
     * Charge one interception to a session's current turn.
     * @returns the new count for that turn.
     */
    bumpIntercept(key: string, turn: number): number;
    /** Mark a session as released while still failing. */
    markUnresolved(key: string, reason: string): void;
    /** Whether a session was already released unresolved. */
    isUnresolved(key: string): boolean;
    /** The recorded reason for an unresolved session, when there is one. */
    unresolvedReason(key: string): string;
    /**
     * Decide whether one session may close its turn.
     *
     * A session with no recorded run passes: the gate only ever withholds
     * completion on evidence, never on the absence of it.
     * @param key - session key.
     * @returns the verdict the gate and `test_closure_check` share.
     */
    verdict(key: string): ClosureVerdict;
    /** Drop every trace of one session (its disposal boundary). */
    forget(key: string): void;
    /** Number of sessions currently tracked; used by tests and diagnostics. */
    get size(): number;
}
