import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getClaudeConfigJsonPath, getHudPluginDir } from './claude-config-dir.js';
import { sanitizeDisplayText } from './utils/sanitize.js';
const EMPTY_ACCOUNT_INFO = { emailAddress: null, organizationName: null, plan: null };
const ACCOUNT_VALUE_MAX_LEN = 128;
function hasNonEmptyEnv(env, name) {
    return typeof env[name] === 'string' && env[name].trim().length > 0;
}
/** True when the session authenticates with a token/API key instead of OAuth. */
export function isProviderSession(env = process.env) {
    return hasNonEmptyEnv(env, 'ANTHROPIC_AUTH_TOKEN') || hasNonEmptyEnv(env, 'ANTHROPIC_API_KEY');
}
// Strip ANSI sequences and control/bidi characters so values from claude.json can never smuggle escape sequences into the terminal.
function sanitizeValue(value) {
    return sanitizeDisplayText(value).trim().slice(0, ACCOUNT_VALUE_MAX_LEN);
}
function readString(obj, key) {
    const value = obj[key];
    if (typeof value !== 'string') {
        return null;
    }
    const sanitized = sanitizeValue(value);
    return sanitized.length > 0 ? sanitized : null;
}
/** Extracts a multiplier suffix from a rate-limit tier: "default_claude_max_20x" → "20x". */
function extractTierSuffix(rateLimitTier) {
    const match = /_(\d+x)$/i.exec(rateLimitTier);
    return match ? match[1] : null;
}
/**
 * Maps the oauthAccount plan fields to a display label. Unmapped organizationType values render raw so an unexpected plan stays visible instead of silently disappearing.
 */
export function planLabel(account) {
    switch (account.organizationType) {
        case 'claude_max': {
            const tier = extractTierSuffix(account.organizationRateLimitTier ?? '')
                ?? extractTierSuffix(account.userRateLimitTier ?? '');
            return tier ? `Max ${tier}` : 'Max';
        }
        case 'claude_pro':
            return 'Pro';
        case 'claude_team': {
            if (account.seatTier === 'team_standard') {
                return 'Team Standard';
            }
            if (account.seatTier === 'team_tier_1') {
                return 'Team Premium';
            }
            return 'Team';
        }
        case 'claude_enterprise':
            return 'Enterprise';
        default:
            return account.organizationType;
    }
}
/**
 * Derives account info from the parsed contents of claude.json. Pure so it can be tested without touching the filesystem.
 */
export function deriveAccountInfo(claudeJson) {
    const root = (claudeJson && typeof claudeJson === 'object')
        ? claudeJson
        : null;
    const account = (root?.oauthAccount && typeof root.oauthAccount === 'object')
        ? root.oauthAccount
        : null;
    if (!account) {
        return EMPTY_ACCOUNT_INFO;
    }
    const plan = planLabel({
        organizationType: readString(account, 'organizationType'),
        seatTier: readString(account, 'seatTier'),
        userRateLimitTier: readString(account, 'userRateLimitTier'),
        organizationRateLimitTier: readString(account, 'organizationRateLimitTier'),
    });
    return {
        emailAddress: readString(account, 'emailAddress'),
        organizationName: readString(account, 'organizationName'),
        plan,
    };
}
/**
 * Label for a provider (non-OAuth) session: the explicit provider name when set, else the API host, else nothing (the segment hides).
 */
export function resolveProviderLabel(env = process.env) {
    const provider = env.CLAUDE_USE_PROVIDER?.trim();
    if (provider) {
        return sanitizeValue(provider);
    }
    const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
    if (baseUrl) {
        try {
            const hostname = new URL(baseUrl).hostname;
            return hostname.length > 0 ? hostname : null;
        }
        catch {
            return null;
        }
    }
    return null;
}
/**
 * Joins the account fields into one first-line label: "email · organisation · plan". Provider sessions render the provider label alone. Returns null when there is nothing to show.
 */
export function formatAccountLabel(account, providerLabel) {
    const parts = providerLabel
        ? [providerLabel]
        : [account?.emailAddress, account?.organizationName, account?.plan];
    const visible = parts.filter((part) => typeof part === 'string' && part.length > 0);
    return visible.length > 0 ? visible.join(' · ') : null;
}
// The cache filename is keyed on the source claude.json path (full sha256 hex, same style as the config cache in config-reader.ts). Several CLAUDE_CONFIG_DIRs can share one physical plugins dir (claude-use symlinks it across identities), where a fixed name is last-writer-wins and every identity's status line shows whichever account rendered last. Keying on the source path also keeps a set CLAUDE_CONFIG_DIR=<dir> and an unset variable on separate entries even when both resolve the same plugin dir, because they read different claude.json files.
function accountCachePath(homeDir, configJsonPath) {
    const hash = createHash('sha256').update(configJsonPath).digest('hex');
    return path.join(getHudPluginDir(homeDir), ACCOUNT_CACHE_DIRNAME, `${hash}.json`);
}
// Remove the pre-0.9.3 fixed-name cache once, if present. In a shared plugins dir it holds whichever identity wrote last, so it is dead weight at best.
function removeLegacyAccountCache(homeDir) {
    try {
        const legacyPath = path.join(getHudPluginDir(homeDir), ACCOUNT_CACHE_DIRNAME, ACCOUNT_LEGACY_CACHE_FILENAME);
        if (fs.existsSync(legacyPath)) {
            fs.unlinkSync(legacyPath);
        }
    }
    catch {
        // Best effort: cleanup must never break the status line.
    }
}
const ACCOUNT_CACHE_DIRNAME = 'account-cache';
const ACCOUNT_LEGACY_CACHE_FILENAME = 'account.json';
const ACCOUNT_CACHE_VERSION = 1;
const ACCOUNT_CACHE_MAX_BYTES = 4096;
function normalizeCachedValue(value) {
    if (value === null)
        return null;
    if (typeof value !== 'string' || value.length === 0 || value.length > ACCOUNT_VALUE_MAX_LEN) {
        return undefined;
    }
    return sanitizeValue(value) === value ? value : undefined;
}
function readAccountCache(homeDir, configJsonPath) {
    let fd;
    try {
        const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
        fd = fs.openSync(accountCachePath(homeDir, configJsonPath), flags);
        const cacheStat = fs.fstatSync(fd);
        if (!cacheStat.isFile() || cacheStat.size <= 0 || cacheStat.size > ACCOUNT_CACHE_MAX_BYTES) {
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(fd, 'utf-8'));
        const record = parsed && typeof parsed === 'object'
            ? parsed
            : null;
        const emailAddress = record ? normalizeCachedValue(record.emailAddress) : undefined;
        const organizationName = record ? normalizeCachedValue(record.organizationName) : undefined;
        const plan = record ? normalizeCachedValue(record.plan) : undefined;
        if (!record
            || record.version !== ACCOUNT_CACHE_VERSION
            || typeof record.mtimeMs !== 'number'
            || typeof record.ctimeMs !== 'number'
            || typeof record.size !== 'number'
            || typeof record.dev !== 'number'
            || typeof record.ino !== 'number'
            || emailAddress === undefined
            || organizationName === undefined
            || plan === undefined) {
            return null;
        }
        return { ...parsed, emailAddress, organizationName, plan };
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
function writeAccountCache(homeDir, configJsonPath, entry) {
    let tmpPath;
    let fd;
    try {
        const cachePath = accountCachePath(homeDir, configJsonPath);
        const cacheDir = path.dirname(cachePath);
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        const dirStat = fs.lstatSync(cacheDir);
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
            return;
        try {
            fs.chmodSync(cacheDir, 0o700);
        }
        catch { /* best effort */ }
        // Write-then-rename: the status line can run concurrently across sessions, and a torn read would just miss the cache, but a torn WRITE would persist.
        tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
        fd = fs.openSync(tmpPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(entry), 'utf-8');
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmpPath, cachePath);
        tmpPath = undefined;
        try {
            fs.chmodSync(cachePath, 0o600);
        }
        catch { /* best effort */ }
    }
    catch {
        // A cache write must never break the status line.
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
 * Reads OAuth account info for the current login. Never throws. Provider (token/API key) sessions return null: the oauthAccount block can linger after switching away from OAuth, so it must not be shown for them.
 *
 * claude.json is the user's entire CLI config and grows with project history, so as in auth.ts the derived fields are cached against the file's (mtimeMs, ctimeMs, size, dev, ino) identity, making the steady-state cost a stat plus a ~100-byte read.
 */
export function readAccountInfo() {
    if (isProviderSession()) {
        return null;
    }
    const homeDir = os.homedir();
    const configJsonPath = getClaudeConfigJsonPath(homeDir);
    removeLegacyAccountCache(homeDir);
    let stat;
    try {
        stat = fs.statSync(configJsonPath);
    }
    catch {
        return null;
    }
    const cached = readAccountCache(homeDir, configJsonPath);
    if (cached
        && cached.mtimeMs === stat.mtimeMs
        && cached.ctimeMs === stat.ctimeMs
        && cached.size === stat.size
        && cached.dev === stat.dev
        && cached.ino === stat.ino) {
        return { emailAddress: cached.emailAddress, organizationName: cached.organizationName, plan: cached.plan };
    }
    try {
        const content = fs.readFileSync(configJsonPath, 'utf-8');
        const info = deriveAccountInfo(JSON.parse(content));
        writeAccountCache(homeDir, configJsonPath, {
            version: ACCOUNT_CACHE_VERSION,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            size: stat.size,
            dev: stat.dev,
            ino: stat.ino,
            emailAddress: info.emailAddress,
            organizationName: info.organizationName,
            plan: info.plan,
        });
        return info;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=account.js.map