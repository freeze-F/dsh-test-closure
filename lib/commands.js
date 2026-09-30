/** Quote one fragment as a single POSIX shell word. */
export function shellQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
/** Quote one fragment as a literal inside a runner's regular-expression filter. */
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Build the filter fragment that narrows a run to the previously failing cases.
 * @param framework - runner whose dialect applies.
 * @param names - failing case names from the previous record.
 * @returns the fragment, or `undefined` when the runner cannot express it.
 */
function filterFragment(framework, names) {
    const nonEmpty = names.map((name) => name.trim()).filter((name) => name !== '');
    if (nonEmpty.length === 0)
        return undefined;
    const alternation = nonEmpty.map(escapeRegex).join('|');
    switch (framework) {
        case 'vitest':
        case 'jest':
            // Both accept a regular expression of test names.
            return `-t ${shellQuote(alternation)}`;
        case 'pytest':
            // `-k` takes a python-ish boolean expression rather than a regex.
            return `-k ${shellQuote(nonEmpty.map(escapeRegex).join(' or '))}`;
        case 'node:test':
            return `--test-name-pattern=${shellQuote(alternation)}`;
        default:
            return undefined;
    }
}
/** Split a whitespace-separated target string into individual shell words. */
function targetWords(target) {
    if (target === undefined)
        return [];
    return target.split(/\s+/).filter((word) => word !== '');
}
/**
 * Plan the command line for one run.
 *
 * An explicit `override` is used verbatim: it is a full replacement, so
 * `target` and `last_failed` are ignored along with the framework default.
 * @param input - framework, base command, and the caller's narrowing options.
 * @returns the command plus any caveat worth surfacing to the model.
 */
export function planCommand(input) {
    const notes = [];
    const override = input.override?.trim();
    if (override !== undefined && override !== '') {
        if (input.target !== undefined || input.lastFailed === true)
            notes.push('command override given: target and last_failed were ignored');
        return { command: override, notes };
    }
    const base = input.suggestedCommand.trim();
    if (base === '') {
        return { command: '', notes: ['no test framework detected; pass `command` explicitly or set up a test runner'] };
    }
    const fragments = [base];
    if (input.lastFailed === true) {
        const filter = filterFragment(input.framework, input.failedNames ?? []);
        if (filter === undefined) {
            if ((input.failedNames ?? []).length > 0)
                notes.push(`${input.framework} cannot filter by test name: re-running the full suite`);
            else
                notes.push('last_failed requested but the previous run recorded no failing case names');
        }
        else {
            fragments.push(filter);
        }
    }
    const words = targetWords(input.target);
    if (words.length > 0) {
        fragments.push(...words.map(shellQuote));
        if (input.framework === 'vitest' || input.framework === 'jest') {
            notes.push('targets are passed as path filters; vitest/jest do not accept a bare test name there');
        }
    }
    return { command: fragments.join(' '), notes };
}
