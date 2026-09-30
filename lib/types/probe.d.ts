/** A detectable test framework, plus the "nothing matched" case. */
export type Framework = 'vitest' | 'jest' | 'npm-test' | 'pytest' | 'node:test' | 'unknown';
/** Every framework the probe can name, in priority order. */
export declare const FRAMEWORKS: readonly ["vitest", "jest", "npm-test", "pytest", "node:test"];
/** The probe's structured conclusion. */
export interface ProbeResult {
    /** Detected framework, or `unknown` when nothing matched. */
    framework: Framework;
    /** Workspace-relative path of the framework's config file; empty when none was found. */
    configPath: string;
    /** Workspace-relative test files, framework-filtered and sorted. */
    testFiles: string[];
    /** The command the probe would run for this framework; empty when unknown. */
    suggestedCommand: string;
}
/** Maximum number of test files reported to the model. */
export declare const MAX_TEST_FILES = 200;
/** The default command per framework, appended with targets by `commands.ts`. */
export declare const SUGGESTED_COMMANDS: Readonly<Record<Framework, string>>;
/**
 * Probe one workspace for its test framework.
 * @param workingDir - absolute directory to scan (normally the session workspace root).
 * @returns the structured probe result, never throwing for an unreadable workspace.
 */
export declare function probeTests(workingDir: string): Promise<ProbeResult>;
