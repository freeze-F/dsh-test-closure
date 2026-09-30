/** Why a run did not pass, in one short line. */
export function failureReason(record) {
    if (record.timedOut)
        return `test run timed out after ${record.durationMs}ms`;
    if (record.aborted)
        return 'test run was aborted';
    const failed = record.summary.failed;
    if (failed > 0)
        return `${failed} test${failed === 1 ? '' : 's'} failed`;
    if (record.sandboxDenied)
        return `test command was denied by the ${record.sandboxMode} sandbox`;
    return `test command exited with code ${record.exitCode === null ? 'null (killed by signal)' : record.exitCode}`;
}
/** Mutable closure state for one plugin instance. */
export class ClosureState {
    runs = new Map();
    budgets = new Map();
    unresolved = new Map();
    /**
     * Store the outcome of one run. A passing run clears the session's
     * `unresolved` marker: the session has demonstrably converged, so the stale
     * "we gave up on this" label must not outlive the evidence for it.
     * @param key - session key.
     * @param record - the completed run.
     */
    record(key, record) {
        this.runs.set(key, record);
        if (record.ok)
            this.unresolved.delete(key);
    }
    /** The most recent record for one session. */
    last(key) {
        return this.runs.get(key);
    }
    /** How many times this session's current turn has already been intercepted. */
    interceptCount(key, turn) {
        const budget = this.budgets.get(key);
        return budget !== undefined && budget.turn === turn ? budget.count : 0;
    }
    /**
     * Charge one interception to a session's current turn.
     * @returns the new count for that turn.
     */
    bumpIntercept(key, turn) {
        const current = this.interceptCount(key, turn);
        const next = current + 1;
        this.budgets.set(key, { turn, count: next });
        return next;
    }
    /** Mark a session as released while still failing. */
    markUnresolved(key, reason) {
        this.unresolved.set(key, reason);
    }
    /** Whether a session was already released unresolved. */
    isUnresolved(key) {
        return this.unresolved.has(key);
    }
    /** The recorded reason for an unresolved session, when there is one. */
    unresolvedReason(key) {
        return this.unresolved.get(key) ?? '';
    }
    /**
     * Decide whether one session may close its turn.
     *
     * A session with no recorded run passes: the gate only ever withholds
     * completion on evidence, never on the absence of it.
     * @param key - session key.
     * @returns the verdict the gate and `test_closure_check` share.
     */
    verdict(key) {
        const record = this.runs.get(key);
        const unresolved = this.unresolved.has(key);
        if (record === undefined)
            return { status: 'pass', ran: false, unresolved, reason: '', failures: [] };
        if (record.ok)
            return { status: 'pass', ran: true, unresolved, reason: '', failures: [] };
        return {
            status: 'blocked',
            ran: true,
            unresolved,
            reason: failureReason(record),
            failures: record.failures.map((failure) => ({ ...failure })),
        };
    }
    /** Drop every trace of one session (its disposal boundary). */
    forget(key) {
        this.runs.delete(key);
        this.budgets.delete(key);
        this.unresolved.delete(key);
    }
    /** Number of sessions currently tracked; used by tests and diagnostics. */
    get size() {
        return new Set([...this.runs.keys(), ...this.budgets.keys(), ...this.unresolved.keys()]).size;
    }
}
