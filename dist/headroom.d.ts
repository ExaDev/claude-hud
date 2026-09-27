import type { StdinData } from './types.js';
/**
 * Budget for the proxy lookup. The statusline re-renders on every interaction (debounced at ~300ms), so the request must finish well inside one refresh or the HUD itself becomes the slowest part of the render; anything slower is treated as a failure and served from cache.
 */
export declare const HEADROOM_TIMEOUT_MS = 500;
/**
 * Minimum interval between proxy lookups for one session. The savings numbers move at most once per request, so this cadence keeps the label current without a network round trip on every statusline refresh.
 */
export declare const HEADROOM_REFRESH_MS = 2000;
/**
 * How long the last good numbers survive a failing lookup before the label collapses to `headroom: down`: one refresh interval of freshness, plus this one-interval grace so a blip shows the numbers with `down` rather than blanking them the moment the cache expires.
 */
export declare const HEADROOM_STALE_GRACE_MS: number;
/**
 * Savings numbers for the current session, as reported by the headroom proxy's `GET /stats/sessions/<id>` endpoint. Each field is null when the response omits it, so the label renders only what is actually present.
 */
export interface HeadroomStats {
    tokensSaved: number | null;
    savingsPercent: number | null;
    savingsUsd: number | null;
}
/**
 * What the label renders: the latest numbers plus whether the proxy was unreachable on the most recent lookup (`down`).
 */
export interface HeadroomInfo {
    stats: HeadroomStats;
    down: boolean;
}
/**
 * Parses one row of `GET /stats/sessions/<id>` (same shape as a per-project row: requests, tokens_saved, compression_savings_usd, savings_percent, …). Pure so it can be tested without a network.
 */
export declare function parseHeadroomStats(payload: unknown): HeadroomStats;
/**
 * Builds the first-line label. `headroom 45k saved · 38% · $0.82`; a lookup failure keeps rendering the last numbers with a trailing `down` part while they are no older than one refresh interval, then collapses to `headroom: down`. Returns null when there is nothing to show.
 */
export declare function formatHeadroomLabel(info: HeadroomInfo): string | null;
/**
 * Resolves the session id the proxy knows: stdin's session_id when present, else the transcript filename stem (the id the proxy derives when Claude Code does not send one).
 */
export declare function resolveHeadroomSessionId(stdin: StdinData): string | null;
/** Reads HEADROOM_PROXY_URL, normalized without a trailing slash. */
export declare function getHeadroomProxyUrl(env?: NodeJS.ProcessEnv): string | null;
export type HeadroomDeps = {
    homeDir: () => string;
    now: () => number;
    fetchImpl: typeof fetch;
};
/**
 * Fetches the session's savings row from the headroom proxy, with a disk cache so the statusline only pays the network round trip once per refresh interval. A failed lookup renders `down` and, while the last good numbers are within the stale grace window, keeps them in the label. Never throws. Returns null when the proxy URL or session id is unknown.
 */
export declare function fetchHeadroomStats(stdin: StdinData, deps?: HeadroomDeps): Promise<HeadroomInfo | null>;
//# sourceMappingURL=headroom.d.ts.map