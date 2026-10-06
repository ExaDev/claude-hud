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
/** Reads HEADROOM_PROXY_URL, normalized without a trailing slash. When set it overrides socket discovery: the operator named an http proxy, standalone of agent-shim. */
export declare function getHeadroomProxyUrl(env?: NodeJS.ProcessEnv): string | null;
/**
 * Whether any headroom daemon is reachable-by-configuration: an explicit proxy URL, or a discovered agent-shim socket. Exists so callers can skip the lookup entirely (and tests can intercept the decision through the environment) without duplicating the resolution rules.
 */
export declare function hasHeadroomTarget(env?: NodeJS.ProcessEnv): boolean;
/**
 * The minimal fetch-like result the lookup needs, so the http and unix-socket transports are interchangeable behind one shape.
 */
interface MinimalResponse {
    status: number;
    ok: boolean;
    json(): Promise<unknown>;
}
/**
 * Reads the unix socket the agent-shim-supervised headroom daemon listens on, from the state file its supervisor writes (`headroom/state.v2.json`, field `socketPath`). The root is chosen the way agent-shim itself resolves it: `AGENT_SHIM_HOME` when set, else the first of `~/.agent-shim` and the pre-rename `~/.claude-use` that exists, with no fall-through past an existing root, because agent-shim uses the legacy root only in the absence of the current one. Returns null when the resolved root has no state file with a socket path, which means no supervised daemon exists to talk to and the segment stays hidden (distinct from a dead socket, which renders `down`).
 */
export declare function readHeadroomSocketPath(env: NodeJS.ProcessEnv, homeDir: string): string | null;
export type HeadroomDeps = {
    homeDir: () => string;
    now: () => number;
    fetchImpl: typeof fetch;
    /** Injectable socket transport for tests; the real one speaks `node:http` over `socketPath`. Optional so deps that only exercise the http path stay valid. */
    socketGetImpl?: (socketPath: string, requestPath: string, timeoutMs: number) => Promise<MinimalResponse>;
};
/**
 * Fetches the session's savings row from the headroom proxy, with a disk cache so the statusline only pays the network round trip once per refresh interval. A failed lookup renders `down` and, while the last good numbers are within the stale grace window, keeps them in the label. Never throws. Returns null when the proxy URL or session id is unknown.
 */
export declare function fetchHeadroomStats(stdin: StdinData, deps?: HeadroomDeps): Promise<HeadroomInfo | null>;
export {};
//# sourceMappingURL=headroom.d.ts.map