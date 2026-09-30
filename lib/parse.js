/** Maximum characters kept per failure message. */
export const FAILURE_MESSAGE_CHARS = 600;
/** An empty parse result. */
export const EMPTY_PARSE = {
    summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
    failures: [],
};
/** Remove ANSI SGR/erase sequences so markers like `×` survive intact. */
export function stripAnsi(text) {
    // eslint-disable-next-line no-control-regex -- matching the escape byte is the point
    return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}
/** Collapse one failure body into a single bounded, single-line message. */
function clipMessage(lines) {
    const parts = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        parts.push(trimmed);
        if (parts.length === 3)
            break;
    }
    const joined = parts.join(' | ');
    return joined.length > FAILURE_MESSAGE_CHARS ? `${joined.slice(0, FAILURE_MESSAGE_CHARS)}…` : joined;
}
/** Parse a runner's count fragment (`2 failed | 10 passed (12)`) into a summary. */
function countsFrom(fragment, failingWords = ['failed']) {
    const count = (word) => {
        const match = new RegExp(`(\\d+)\\s+${word}\\b`).exec(fragment);
        return match === null ? 0 : Number(match[1]);
    };
    let failed = 0;
    for (const word of failingWords)
        failed += count(word);
    const passed = count('passed');
    const skipped = count('skipped') + count('todo') + count('xfailed');
    const explicitTotal = /\((\d+)\)/.exec(fragment);
    const namedTotal = count('total');
    const total = explicitTotal !== null ? Number(explicitTotal[1]) : namedTotal > 0 ? namedTotal : passed + failed + skipped;
    return { total, passed, failed, skipped };
}
/**
 * A line that belongs to the RUN summary rather than to a failure body. A
 * reporter prints these directly after the last failure block, so a body scan
 * that does not stop here reports the summary as part of the failure message.
 */
function isReportFooter(line) {
    if (/^[\u2500\u2501\u2502\u23AF=_-]{3,}\s*$/.test(line.trim()))
        return true;
    if (/^\s*\u2139\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/.test(line))
        return true;
    return /^\s*(?:[\u2502|]\s*)?(?:Test Files|Test Suites|Tests|Snapshots|Time|Duration|Start at|Ran all test suites)\b/.test(line);
}
/** True when a parse recovered anything at all. */
function foundAnything(parsed) {
    return parsed.summary.total > 0 || parsed.failures.length > 0;
}
/** Vitest's default reporter: `Tests  2 failed | 10 passed (12)` plus a `Failed Tests` section. */
export function parseVitest(text) {
    const summaryMatch = /^[│|\s]*Tests\s+(.+)$/m.exec(text);
    const summary = summaryMatch === null
        ? { total: 0, passed: 0, failed: 0, skipped: 0 }
        : countsFrom(summaryMatch[1] ?? '');
    const failures = [];
    const lines = text.split('\n');
    const sectionStart = lines.findIndex((line) => /Failed Tests\s+\d+/.test(line));
    const scanFrom = sectionStart === -1 ? 0 : sectionStart;
    for (let index = scanFrom; index < lines.length; index++) {
        const header = /^[│|\s]*FAIL\s+(.+?)\s*$/.exec(lines[index] ?? '');
        if (header === null)
            continue;
        const body = [];
        for (let next = index + 1; next < lines.length; next++) {
            const line = lines[next] ?? '';
            if (/^[│|\s]*FAIL\s+/.test(line) || /^\s*[×✗]\s+/.test(line))
                break;
            if (isReportFooter(line))
                break;
            body.push(line);
        }
        failures.push({ name: (header[1] ?? '').trim(), message: clipMessage(body) });
    }
    if (failures.length === 0) {
        // Compact reporter fallback: `× name 5ms` followed by `→ message`.
        for (let index = 0; index < lines.length; index++) {
            const marker = /^\s*[×✗]\s+(.+?)\s*$/.exec(lines[index] ?? '');
            if (marker === null)
                continue;
            const arrow = /^\s*[→➜]\s*(.+?)\s*$/.exec(lines[index + 1] ?? '');
            failures.push({ name: (marker[1] ?? '').replace(/\s+\d+(?:\.\d+)?ms$/, '').trim(), message: arrow === null ? '' : clipMessage([arrow[1] ?? '']) });
        }
    }
    return { summary, failures };
}
/** Jest's default reporter: `Tests:  2 failed, 10 passed, 12 total` plus `● name` blocks. */
export function parseJest(text) {
    const summaryMatch = /^[\s│|]*Tests:\s+(.+)$/m.exec(text);
    const summary = summaryMatch === null ? { total: 0, passed: 0, failed: 0, skipped: 0 } : countsFrom(summaryMatch[1] ?? '');
    const failures = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const header = /^\s*●\s+(.+?)\s*$/.exec(lines[index] ?? '');
        if (header === null)
            continue;
        const body = [];
        for (let next = index + 1; next < lines.length; next++) {
            const line = lines[next] ?? '';
            if (/^\s*●\s+/.test(line))
                break;
            if (/^\s*at\s/.test(line))
                break;
            if (isReportFooter(line))
                break;
            body.push(line);
        }
        failures.push({ name: (header[1] ?? '').trim(), message: clipMessage(body) });
    }
    if (failures.length === 0) {
        for (const line of lines) {
            const marker = /^\s*✕\s+(.+?)\s*$/.exec(line);
            if (marker !== null)
                failures.push({ name: (marker[1] ?? '').replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)$/, '').trim(), message: '' });
        }
    }
    return { summary, failures };
}
/** pytest section blocks (`_____ test_name _____`) indexed by their header text. */
function pytestSections(text) {
    const sections = new Map();
    let current;
    let body = [];
    for (const line of text.split('\n')) {
        const header = /^_{2,}\s+(.+?)\s+_{2,}$/.exec(line);
        if (header !== null) {
            if (current !== undefined)
                sections.set(current, body);
            current = header[1] ?? '';
            body = [];
            continue;
        }
        if (current !== undefined)
            body.push(line);
    }
    if (current !== undefined)
        sections.set(current, body);
    return sections;
}
/** The last `E ` assertion line of one pytest section, which is where the message lives. */
function pytestSectionMessage(body) {
    if (body === undefined)
        return '';
    const errors = body.filter((line) => /^E\s+/.test(line));
    if (errors.length > 0)
        return clipMessage([(errors[errors.length - 1] ?? '').replace(/^E\s+/, '')]);
    const nonEmpty = body.filter((line) => line.trim() !== '');
    return clipMessage(nonEmpty.slice(-1));
}
/** pytest: `===== 2 failed, 10 passed, 1 skipped in 3.20s =====` plus `FAILED nodeid - message`. */
export function parsePytest(text) {
    let summary = { total: 0, passed: 0, failed: 0, skipped: 0 };
    const summaryLines = text.split('\n').filter((line) => /^=+.*=+$/.test(line.trim()) && /\bin\b/.test(line));
    const lastSummary = summaryLines[summaryLines.length - 1];
    if (lastSummary !== undefined)
        summary = countsFrom(lastSummary, ['failed', 'error', 'errors']);
    else if (/\bno tests ran\b/.test(text))
        summary = { total: 0, passed: 0, failed: 0, skipped: 0 };
    const sections = pytestSections(text);
    const failures = [];
    const shortSummary = /^(FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.*))?$/gm;
    for (let match = shortSummary.exec(text); match !== null; match = shortSummary.exec(text)) {
        const name = match[2] ?? '';
        const inline = (match[3] ?? '').trim();
        let message = inline === '' ? '' : clipMessage([inline]);
        if (message === '') {
            const leaf = name.slice(name.indexOf('::') + 2).split('::').pop() ?? name;
            const key = [...sections.keys()].reverse().find((candidate) => candidate.endsWith(leaf));
            message = pytestSectionMessage(key === undefined ? undefined : sections.get(key));
        }
        failures.push({ name, message });
    }
    return { summary, failures };
}
/**
 * node:test, in both of the shapes this runner actually prints.
 *
 * The TAP reporter writes `# tests 12` counters and `not ok N - name` blocks;
 * the default reporter writes the same counters with an `ℹ` bullet, `✖ name`
 * markers, and — importantly — the failures TWICE: inline after each test, and
 * again under a `✖ failing tests:` heading. Only the second block is
 * authoritative, so the scan starts below that heading when it is present.
 */
export function parseNodeTest(text) {
    const number = (key) => {
        const match = new RegExp(`^[#\u2139]\\s*${key}\\s+(\\d+)\\s*$`, 'm').exec(text);
        return match === null ? 0 : Number(match[1]);
    };
    const summary = {
        total: number('tests'),
        passed: number('pass'),
        failed: number('fail'),
        skipped: number('skipped') + number('todo'),
    };
    const lines = text.split('\n');
    const summaryHeader = lines.findIndex((line) => /^[\u2716\u2717]\s+failing tests:\s*$/.test(line.trim()));
    const failures = [];
    for (let index = summaryHeader === -1 ? 0 : summaryHeader + 1; index < lines.length; index++) {
        const line = lines[index] ?? '';
        const tap = /^\s*not ok \d+\s+-\s+(.+?)\s*$/.exec(line);
        const spec = /^\s*[\u2716\u2717]\s+(.+?)(?:\s*\(\d+(?:\.\d+)?ms\))?\s*$/.exec(line);
        const header = tap ?? spec;
        if (header === null)
            continue;
        const name = (header[1] ?? '').trim();
        if (name === 'failing tests:' || name === '')
            continue;
        const body = [];
        for (let next = index + 1; next < lines.length; next++) {
            const bodyLine = lines[next] ?? '';
            if (/^\s*not ok \d+\s+-/.test(bodyLine) || /^\s*ok \d+\s+-/.test(bodyLine) || /^\s*[\u2716\u2717]\s+/.test(bodyLine))
                break;
            // TAP diagnostics: `---` opens the block, `...` terminates it.
            if (/^\s*\.\.\.\s*$/.test(bodyLine))
                break;
            // The first stack frame ends the message; the frames and the trailing
            // diagnostics object are not part of what the agent needs to read.
            if (/^\s*at\s/.test(bodyLine))
                break;
            if (/^\s*(?:---|duration_ms:|type:|location:|failureType:|code:|stack:|name:|expected:|actual:|operator:|errored:)/.test(bodyLine))
                continue;
            if (isReportFooter(bodyLine))
                break;
            body.push(bodyLine.replace(/^\s*(?:error|message):\s*(?:\|-?)?\s*/, ''));
        }
        failures.push({ name, message: clipMessage(body) });
    }
    return { summary, failures };
}
/** Every parser, in the cascade order used when the framework is unknown. */
const ALL_PARSERS = [
    ['vitest', parseVitest],
    ['jest', parseJest],
    ['pytest', parsePytest],
    ['node:test', parseNodeTest],
];
/** The parser for one framework, when that framework has a dedicated one. */
function parserFor(framework) {
    switch (framework) {
        case 'vitest':
            return parseVitest;
        case 'jest':
            return parseJest;
        case 'pytest':
            return parsePytest;
        case 'node:test':
            return parseNodeTest;
        default:
            return undefined;
    }
}
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
export function parseTests(framework, stdout, stderr) {
    const text = stripAnsi(`${stdout}\n${stderr}`);
    const attempts = [];
    const preferred = parserFor(framework);
    if (preferred !== undefined)
        attempts.push(preferred);
    for (const [, parser] of ALL_PARSERS)
        if (parser !== preferred)
            attempts.push(parser);
    let best;
    for (const attempt of attempts) {
        let parsed;
        try {
            parsed = attempt(text);
        }
        catch {
            continue;
        }
        if (!foundAnything(parsed))
            continue;
        if (preferred !== undefined && attempt === preferred)
            return parsed;
        const bestScore = best === undefined ? -1 : best.summary.total * 1000 + best.failures.length;
        if (parsed.summary.total * 1000 + parsed.failures.length > bestScore)
            best = parsed;
    }
    return best ?? { summary: { ...EMPTY_PARSE.summary }, failures: [] };
}
