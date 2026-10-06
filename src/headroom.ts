import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getHudPluginDir } from './claude-config-dir.js';
import { createDebug } from './debug.js';
import { t } from './i18n/index.js';
import { formatTokens } from './utils/format.js';
import { formatUsd } from './cost.js';
import type { StdinData } from './types.js';

const debug = createDebug('headroom');

/**
 * Budget for the proxy lookup. The statusline re-renders on every interaction (debounced at ~300ms), so the request must finish well inside one refresh or the HUD itself becomes the slowest part of the render; anything slower is treated as a failure and served from cache.
 */
export const HEADROOM_TIMEOUT_MS = 500;

/**
 * Minimum interval between proxy lookups for one session. The savings numbers move at most once per request, so this cadence keeps the label current without a network round trip on every statusline refresh.
 */
export const HEADROOM_REFRESH_MS = 2000;

/**
 * How long the last good numbers survive a failing lookup before the label collapses to `headroom: down`: one refresh interval of freshness, plus this one-interval grace so a blip shows the numbers with `down` rather than blanking them the moment the cache expires.
 */
export const HEADROOM_STALE_GRACE_MS = 2 * HEADROOM_REFRESH_MS;

const HEADROOM_CACHE_DIRNAME = 'headroom-cache';
const HEADROOM_CACHE_VERSION = 1;
const HEADROOM_CACHE_MAX_BYTES = 4096;

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

const EMPTY_STATS: HeadroomStats = { tokensSaved: null, savingsPercent: null, savingsUsd: null };

/**
 * Parses one row of `GET /stats/sessions/<id>` (same shape as a per-project row: requests, tokens_saved, compression_savings_usd, savings_percent, …). Pure so it can be tested without a network.
 */
export function parseHeadroomStats(payload: unknown): HeadroomStats {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ...EMPTY_STATS };
  }
  const row = payload as Record<string, unknown>;
  const tokensSaved = readCount(row, 'tokens_saved');
  const savingsPercent = readPercent(row, 'savings_percent');
  const savingsUsd = readUsd(row, 'compression_savings_usd');
  return { tokensSaved, savingsPercent, savingsUsd };
}

function readCount(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function readPercent(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return null;
  }
  return value;
}

function readUsd(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * Builds the first-line label. `headroom 45k saved · 38% · $0.82`; a lookup failure keeps rendering the last numbers with a trailing `down` part while they are no older than one refresh interval, then collapses to `headroom: down`. Returns null when there is nothing to show.
 */
export function formatHeadroomLabel(info: HeadroomInfo): string | null {
  const parts: string[] = [];
  if (info.stats.tokensSaved !== null) {
    parts.push(`${formatTokens(info.stats.tokensSaved)} ${t('format.saved')}`);
  }
  if (info.stats.savingsPercent !== null) {
    parts.push(`${Math.round(info.stats.savingsPercent)}%`);
  }
  if (info.stats.savingsUsd !== null) {
    parts.push(formatUsd(info.stats.savingsUsd));
  }

  if (parts.length === 0) {
    return info.down ? `${t('label.headroom')}: ${t('status.headroomDown')}` : null;
  }
  const prefix = `${t('label.headroom')} ${parts.join(' · ')}`;
  return info.down ? `${prefix} · ${t('status.headroomDown')}` : prefix;
}

/**
 * Resolves the session id the proxy knows: stdin's session_id when present, else the transcript filename stem (the id the proxy derives when Claude Code does not send one).
 */
export function resolveHeadroomSessionId(stdin: StdinData): string | null {
  const sessionId = typeof stdin.session_id === 'string' ? stdin.session_id.trim() : '';
  if (sessionId) {
    return sessionId;
  }
  const transcriptPath = typeof stdin.transcript_path === 'string' ? stdin.transcript_path.trim() : '';
  if (!transcriptPath) {
    return null;
  }
  const base = path.basename(transcriptPath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  return stem.length > 0 ? stem : null;
}

/** Reads HEADROOM_PROXY_URL, normalized without a trailing slash. When set it overrides socket discovery: the operator named an http proxy, standalone of agent-shim. */
export function getHeadroomProxyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.HEADROOM_PROXY_URL?.trim();
  if (!raw) {
    return null;
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Whether any headroom daemon is reachable-by-configuration: an explicit proxy URL, or a discovered agent-shim socket. Exists so callers can skip the lookup entirely (and tests can intercept the decision through the environment) without duplicating the resolution rules.
 */
export function hasHeadroomTarget(env: NodeJS.ProcessEnv = process.env): boolean {
  return getHeadroomProxyUrl(env) !== null || readHeadroomSocketPath(env, os.homedir()) !== null;
}

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
export function readHeadroomSocketPath(env: NodeJS.ProcessEnv, homeDir: string): string | null {
  const roots = [env.AGENT_SHIM_HOME?.trim(), path.join(homeDir, '.agent-shim'), path.join(homeDir, '.claude-use')].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );
  const root = roots.find((candidate) => fs.existsSync(candidate));
  if (root === undefined) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, 'headroom', 'state.v2.json'), 'utf-8'));
    const socketPath = typeof parsed === 'object' && parsed !== null && 'socketPath' in parsed
      ? (parsed as { socketPath?: unknown }).socketPath
      : undefined;
    return typeof socketPath === 'string' && socketPath.length > 0 ? socketPath : null;
  } catch {
    // An unreadable state file means no daemon to talk to, not an error worth surfacing in a statusline.
    return null;
  }
}

/**
 * One `GET` over a unix socket, wrapped in the fetch-like shape the lookup already consumes. Node's global `fetch` cannot address a unix socket, so this goes through `node:http` with `socketPath`; a connect failure rejects exactly like a failed `fetch`, which the caller turns into `down`.
 */
function getOverSocket(socketPath: string, requestPath: string, timeoutMs: number): Promise<MinimalResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, path: requestPath, method: 'GET', headers: { accept: 'application/json', host: 'localhost' }, timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        response.on('end', () => { resolve(toMinimalResponse(response.statusCode ?? 0, Buffer.concat(chunks).toString('utf-8'))); });
      },
    );
    request.on('timeout', () => { request.destroy(); reject(new Error('socket request timed out')); });
    request.on('error', reject);
    request.end();
  });
}

/** The transport-independent core both wrappers funnel into: status plus a lazy JSON body reader. */
function toMinimalResponse(status: number, body: string): MinimalResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  };
}

/** Wraps a fetch `Response` (or any wider object) in the minimal shape the lookup consumes. */
function toMinimalFromFetch(response: Response): MinimalResponse {
  return { status: response.status, ok: response.ok, json: () => response.json() };
}

export type HeadroomDeps = {
  homeDir: () => string;
  now: () => number;
  fetchImpl: typeof fetch;
  /** Injectable socket transport for tests; the real one speaks `node:http` over `socketPath`. Optional so deps that only exercise the http path stay valid. */
  socketGetImpl?: (socketPath: string, requestPath: string, timeoutMs: number) => Promise<MinimalResponse>;
};

const defaultDeps: HeadroomDeps = {
  homeDir: () => os.homedir(),
  now: () => Date.now(),
  fetchImpl: fetch,
  socketGetImpl: getOverSocket,
};

interface HeadroomCacheFile {
  version: number;
  fetchedAt: number;
  stats: HeadroomStats;
}

function headroomCachePath(proxyUrl: string, sessionId: string, homeDir: string): string {
  const hash = createHash('sha256').update(`${proxyUrl}\n${sessionId}`).digest('hex');
  return path.join(getHudPluginDir(homeDir), HEADROOM_CACHE_DIRNAME, `${hash}.json`);
}

function readHeadroomCache(cachePath: string): HeadroomCacheFile | null {
  let fd: number | undefined;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(cachePath, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > HEADROOM_CACHE_MAX_BYTES) {
      return null;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(fd, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const cache = parsed as Partial<HeadroomCacheFile>;
    const stats = cache.stats;
    if (
      cache.version !== HEADROOM_CACHE_VERSION
      || typeof cache.fetchedAt !== 'number'
      || !Number.isFinite(cache.fetchedAt)
      || !stats || typeof stats !== 'object'
      || typeof stats.tokensSaved !== 'number' && stats.tokensSaved !== null
      || typeof stats.savingsPercent !== 'number' && stats.savingsPercent !== null
      || typeof stats.savingsUsd !== 'number' && stats.savingsUsd !== null
    ) {
      return null;
    }
    return cache as HeadroomCacheFile;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function writeHeadroomCache(cachePath: string, entry: HeadroomCacheFile): void {
  let tmpPath: string | undefined;
  let fd: number | undefined;
  try {
    const cacheDir = path.dirname(cachePath);
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(cacheDir, 0o700); } catch { /* best effort */ }
    // Write-then-rename: the status line can run concurrently across sessions, and a torn read just misses the cache, but a torn write would persist.
    tmpPath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(entry), 'utf-8');
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, cachePath);
    tmpPath = undefined;
  } catch (err) {
    // A cache write must never break the status line.
    debug('Failed to write headroom cache:', err instanceof Error ? err.message : err);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    }
  }
}

/**
 * Fetches the session's savings row from the headroom proxy, with a disk cache so the statusline only pays the network round trip once per refresh interval. A failed lookup renders `down` and, while the last good numbers are within the stale grace window, keeps them in the label. Never throws. Returns null when the proxy URL or session id is unknown.
 */
export async function fetchHeadroomStats(
  stdin: StdinData,
  deps: HeadroomDeps = defaultDeps,
): Promise<HeadroomInfo | null> {
  // The proxy is found one of two ways: HEADROOM_PROXY_URL names a standalone http proxy and overrides everything; otherwise the agent-shim-supervised daemon is discovered from its state file and spoken to over its unix socket.
  const proxyUrl = getHeadroomProxyUrl();
  const socketPath = proxyUrl === null ? readHeadroomSocketPath(process.env, deps.homeDir()) : null;
  const sessionId = resolveHeadroomSessionId(stdin);
  if ((!proxyUrl && !socketPath) || !sessionId) {
    return null;
  }

  const now = deps.now();
  const cacheKey = proxyUrl ?? `unix:${socketPath}`;
  const cachePath = headroomCachePath(cacheKey, sessionId, deps.homeDir());
  const cached = readHeadroomCache(cachePath);

  if (cached && now - cached.fetchedAt < HEADROOM_REFRESH_MS) {
    return { stats: cached.stats, down: false };
  }

  const requestPath = `/stats/sessions/${encodeURIComponent(sessionId)}`;
  debug('Headroom target:', proxyUrl !== null ? `url ${proxyUrl}` : `socket ${socketPath}`);
  try {
    const response: MinimalResponse = proxyUrl !== null
      ? toMinimalFromFetch(await deps.fetchImpl(`${proxyUrl}${requestPath}`, {
          signal: AbortSignal.timeout(HEADROOM_TIMEOUT_MS),
          headers: { accept: 'application/json' },
        }))
      : await (deps.socketGetImpl ?? getOverSocket)(socketPath as string, requestPath, HEADROOM_TIMEOUT_MS);
    if (response.status === 404) {
      // The proxy is up and answering; this session id just has no savings row yet (nothing has been recorded for it). That is "no data", not "proxy down": render nothing rather than the down label, and don't cache, so the segment appears as soon as the first row lands.
      return null;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const stats = parseHeadroomStats(await response.json());
    writeHeadroomCache(cachePath, { version: HEADROOM_CACHE_VERSION, fetchedAt: now, stats });
    return { stats, down: false };
  } catch (err) {
    debug('Headroom lookup failed:', err instanceof Error ? err.message : err);
    // Keep the last good numbers through the grace window so a blip shows them with `down`; past it they are too stale to present as current.
    const stillFresh = cached && now - cached.fetchedAt <= HEADROOM_STALE_GRACE_MS;
    return { stats: stillFresh ? cached.stats : { ...EMPTY_STATS }, down: true };
  }
}
