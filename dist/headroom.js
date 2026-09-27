import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getHudPluginDir } from './claude-config-dir.js';
import { createDebug } from './debug.js';
import { t } from './i18n/index.js';
import { formatTokens } from './utils/format.js';
import { formatUsd } from './cost.js';
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
const EMPTY_STATS = { tokensSaved: null, savingsPercent: null, savingsUsd: null };
/**
 * Parses one row of `GET /stats/sessions/<id>` (same shape as a per-project row: requests, tokens_saved, compression_savings_usd, savings_percent, …). Pure so it can be tested without a network.
 */
export function parseHeadroomStats(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ...EMPTY_STATS };
    }
    const row = payload;
    const tokensSaved = readCount(row, 'tokens_saved');
    const savingsPercent = readPercent(row, 'savings_percent');
    const savingsUsd = readUsd(row, 'compression_savings_usd');
    return { tokensSaved, savingsPercent, savingsUsd };
}
function readCount(row, key) {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return null;
    }
    return Math.floor(value);
}
function readPercent(row, key) {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        return null;
    }
    return value;
}
function readUsd(row, key) {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return null;
    }
    return value;
}
/**
 * Builds the first-line label. `headroom 45k saved · 38% · $0.82`; a lookup failure keeps rendering the last numbers with a trailing `down` part while they are no older than one refresh interval, then collapses to `headroom: down`. Returns null when there is nothing to show.
 */
export function formatHeadroomLabel(info) {
    const parts = [];
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
export function resolveHeadroomSessionId(stdin) {
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
/** Reads HEADROOM_PROXY_URL, normalized without a trailing slash. */
export function getHeadroomProxyUrl(env = process.env) {
    const raw = env.HEADROOM_PROXY_URL?.trim();
    if (!raw) {
        return null;
    }
    return raw.replace(/\/+$/, '');
}
const defaultDeps = {
    homeDir: () => os.homedir(),
    now: () => Date.now(),
    fetchImpl: fetch,
};
function headroomCachePath(proxyUrl, sessionId, homeDir) {
    const hash = createHash('sha256').update(`${proxyUrl}\n${sessionId}`).digest('hex');
    return path.join(getHudPluginDir(homeDir), HEADROOM_CACHE_DIRNAME, `${hash}.json`);
}
function readHeadroomCache(cachePath) {
    let fd;
    try {
        const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
        fd = fs.openSync(cachePath, flags);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size <= 0 || stat.size > HEADROOM_CACHE_MAX_BYTES) {
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(fd, 'utf-8'));
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        const cache = parsed;
        const stats = cache.stats;
        if (cache.version !== HEADROOM_CACHE_VERSION
            || typeof cache.fetchedAt !== 'number'
            || !Number.isFinite(cache.fetchedAt)
            || !stats || typeof stats !== 'object'
            || typeof stats.tokensSaved !== 'number' && stats.tokensSaved !== null
            || typeof stats.savingsPercent !== 'number' && stats.savingsPercent !== null
            || typeof stats.savingsUsd !== 'number' && stats.savingsUsd !== null) {
            return null;
        }
        return cache;
    }
    catch {
        return null;
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { /* best effort */ }
        }
    }
}
function writeHeadroomCache(cachePath, entry) {
    let tmpPath;
    let fd;
    try {
        const cacheDir = path.dirname(cachePath);
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        try {
            fs.chmodSync(cacheDir, 0o700);
        }
        catch { /* best effort */ }
        // Write-then-rename: the status line can run concurrently across sessions, and a torn read just misses the cache, but a torn write would persist.
        tmpPath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        fd = fs.openSync(tmpPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(entry), 'utf-8');
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmpPath, cachePath);
        tmpPath = undefined;
    }
    catch (err) {
        // A cache write must never break the status line.
        debug('Failed to write headroom cache:', err instanceof Error ? err.message : err);
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { /* best effort */ }
        }
        if (tmpPath) {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { /* best effort */ }
        }
    }
}
/**
 * Fetches the session's savings row from the headroom proxy, with a disk cache so the statusline only pays the network round trip once per refresh interval. A failed lookup renders `down` and, while the last good numbers are within the stale grace window, keeps them in the label. Never throws. Returns null when the proxy URL or session id is unknown.
 */
export async function fetchHeadroomStats(stdin, deps = defaultDeps) {
    const proxyUrl = getHeadroomProxyUrl();
    const sessionId = resolveHeadroomSessionId(stdin);
    if (!proxyUrl || !sessionId) {
        return null;
    }
    const now = deps.now();
    const cachePath = headroomCachePath(proxyUrl, sessionId, deps.homeDir());
    const cached = readHeadroomCache(cachePath);
    if (cached && now - cached.fetchedAt < HEADROOM_REFRESH_MS) {
        return { stats: cached.stats, down: false };
    }
    const url = `${proxyUrl}/stats/sessions/${encodeURIComponent(sessionId)}`;
    try {
        const response = await deps.fetchImpl(url, {
            signal: AbortSignal.timeout(HEADROOM_TIMEOUT_MS),
            headers: { accept: 'application/json' },
        });
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
    }
    catch (err) {
        debug('Headroom lookup failed:', err instanceof Error ? err.message : err);
        // Keep the last good numbers through the grace window so a blip shows them with `down`; past it they are too stale to present as current.
        const stillFresh = cached && now - cached.fetchedAt <= HEADROOM_STALE_GRACE_MS;
        return { stats: stillFresh ? cached.stats : { ...EMPTY_STATS }, down: true };
    }
}
//# sourceMappingURL=headroom.js.map