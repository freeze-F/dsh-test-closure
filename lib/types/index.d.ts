import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
/** Plugin name, also the source label of every message this plugin injects. */
export declare const name = "dsh-test-closure";
/**
 * Hard dependencies. `tools` is where the three tools are registered; `shell`
 * is the execution seam the built-in `bash` tool uses, so this plugin inherits
 * its sandboxing and process management instead of spawning anything itself;
 * `sandboxPolicy` is the resolver that turns the calling session into the
 * effective mode and workspace root.
 */
export declare const inject: string[];
/** Configuration accepted from `cordis.yml` / `cordis.patch.yml`. */
export interface Config {
    /** Maximum corrective interceptions per turn before the turn is released. */
    maxInterceptRounds?: number;
    /** Timeout applied when a call does not pass `timeout_ms`. */
    defaultTimeoutMs?: number;
    /** Characters of raw runner output kept and returned as `outputTail`. */
    summaryTailChars?: number;
    /** Master switch: `false` contributes no tools and no gate. */
    enabled?: boolean;
}
/** Runtime configuration schema — validated by the loader before `apply`. */
export declare const Config: z<Config>;
/** The same configuration with every field resolved and validated. */
export interface ResolvedSettings {
    maxInterceptRounds: number;
    defaultTimeoutMs: number;
    summaryTailChars: number;
    enabled: boolean;
}
/**
 * Apply defaults and refuse values this plugin could not act on. The schema
 * already rejected non-numbers; what it cannot express is "positive" and
 * "integral", and a negative budget would silently disable interception.
 * @param config - loader-validated configuration, possibly empty.
 * @returns the complete, validated settings.
 * @throws Error naming every offending field at once.
 */
export declare function resolveSettings(config?: Config): ResolvedSettings;
/**
 * Load the plugin.
 * @param ctx - plugin context; every registration below is an effect disposed with it.
 * @param config - loader-validated configuration.
 */
export declare function apply(ctx: Context, config?: Config): void;
