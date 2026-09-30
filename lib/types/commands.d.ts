/**
 * Command planning: one default command per framework, plus the `target` and
 * `last_failed` filters, expressed in the dialect each runner actually accepts.
 *
 * Every fragment is shell-quoted for a POSIX shell, because the command is
 * handed to `ctx.shell`, which runs it through `bash -c`.
 *
 * @module dsh-test-closure/commands
 */
import type { Framework } from './probe.js';
/** Everything the planner needs to build one command line. */
export interface CommandPlanInput {
    framework: Framework;
    /** The framework's base command (`probe.suggestedCommand`). */
    suggestedCommand: string;
    /** Model-supplied file/directory/node-id filters, whitespace separated. */
    target?: string | undefined;
    /** Re-run only the cases that failed in the previous run. */
    lastFailed?: boolean | undefined;
    /** Names of those cases, from the previous run's record. */
    failedNames?: readonly string[] | undefined;
    /** A full command override that replaces everything else. */
    override?: string | undefined;
}
/** One planned command plus anything the model should know about it. */
export interface CommandPlan {
    command: string;
    /** Non-fatal caveats (e.g. a filter this framework cannot express). */
    notes: string[];
}
/** Quote one fragment as a single POSIX shell word. */
export declare function shellQuote(value: string): string;
/**
 * Plan the command line for one run.
 *
 * An explicit `override` is used verbatim: it is a full replacement, so
 * `target` and `last_failed` are ignored along with the framework default.
 * @param input - framework, base command, and the caller's narrowing options.
 * @returns the command plus any caveat worth surfacing to the model.
 */
export declare function planCommand(input: CommandPlanInput): CommandPlan;
