import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  deriveAccountInfo,
  formatAccountLabel,
  isProviderSession,
  planLabel,
  readAccountInfo,
  resolveProviderLabel,
} from '../dist/account.js';

// Cache files are keyed on the source claude.json path; the expected name is derived the same way here so a regression to a fixed name fails the assertion.
function accountCacheFile(configDir, jsonPath) {
  const hash = createHash('sha256').update(jsonPath).digest('hex');
  return path.join(configDir, 'plugins', 'claude-hud', 'account-cache', `${hash}.json`);
}

function restoreEnvVar(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

const TEAM_ACCOUNT = {
  oauthAccount: {
    emailAddress: 'jmearman@sourcepulp.com',
    organizationName: 'ExaDev',
    organizationType: 'claude_team',
    seatTier: 'team_tier_1',
    userRateLimitTier: 'default_claude_team',
    organizationRateLimitTier: 'default_claude_team',
  },
};

test('planLabel maps the known organizationType and tier combinations', () => {
  const plan = (organizationType, overrides = {}) => planLabel({
    organizationType,
    seatTier: null,
    userRateLimitTier: null,
    organizationRateLimitTier: null,
    ...overrides,
  });

  assert.equal(plan('claude_max', { organizationRateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
  assert.equal(plan('claude_max', { organizationRateLimitTier: 'default_claude_max_5x' }), 'Max 5x');
  assert.equal(plan('claude_max', { userRateLimitTier: 'default_claude_max_5x' }), 'Max 5x');
  assert.equal(plan('claude_max'), 'Max');
  assert.equal(plan('claude_pro'), 'Pro');
  assert.equal(plan('claude_team', { seatTier: 'team_standard' }), 'Team Standard');
  assert.equal(plan('claude_team', { seatTier: 'team_tier_1' }), 'Team Premium');
  assert.equal(plan('claude_team', { seatTier: 'anything_else' }), 'Team');
  assert.equal(plan('claude_enterprise'), 'Enterprise');
  // Unmapped organizationType values stay visible as-is instead of hiding.
  assert.equal(plan('claude_starter'), 'claude_starter');
  assert.equal(plan(null), null);
});

test('deriveAccountInfo reads the oauthAccount fields and sanitises values', () => {
  assert.deepEqual(deriveAccountInfo(TEAM_ACCOUNT), {
    emailAddress: 'jmearman@sourcepulp.com',
    organizationName: 'ExaDev',
    plan: 'Team Premium',
  });
  assert.deepEqual(deriveAccountInfo({}), { emailAddress: null, organizationName: null, plan: null });
  assert.deepEqual(deriveAccountInfo('junk'), { emailAddress: null, organizationName: null, plan: null });
  // Control characters must not reach the terminal.
  assert.equal(deriveAccountInfo({
    oauthAccount: { emailAddress: 'evil\x1b[31m@example.com', organizationType: 'claude_pro' },
  }).emailAddress, 'evil@example.com');
});

test('isProviderSession and resolveProviderLabel follow the auth env vars', () => {
  assert.equal(isProviderSession({}), false);
  assert.equal(isProviderSession({ ANTHROPIC_AUTH_TOKEN: 'tok' }), true);
  assert.equal(isProviderSession({ ANTHROPIC_API_KEY: 'sk-test' }), true);
  assert.equal(isProviderSession({ ANTHROPIC_API_KEY: '  ' }), false);

  assert.equal(resolveProviderLabel({}), null);
  assert.equal(resolveProviderLabel({ CLAUDE_USE_PROVIDER: 'openrouter' }), 'openrouter');
  assert.equal(
    resolveProviderLabel({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1' }),
    'openrouter.ai',
  );
  assert.equal(resolveProviderLabel({ ANTHROPIC_BASE_URL: 'not a url' }), null);
  assert.equal(
    resolveProviderLabel({ CLAUDE_USE_PROVIDER: 'openrouter', ANTHROPIC_BASE_URL: 'https://example.com' }),
    'openrouter',
  );
});

test('formatAccountLabel joins email, organisation, and plan; provider sessions render the provider alone', () => {
  const account = deriveAccountInfo(TEAM_ACCOUNT);
  assert.equal(formatAccountLabel(account, null), 'jmearman@sourcepulp.com · ExaDev · Team Premium');
  assert.equal(
    formatAccountLabel({ emailAddress: 'a@b.com', organizationName: null, plan: 'Pro' }, null),
    'a@b.com · Pro',
  );
  assert.equal(formatAccountLabel(null, 'openrouter'), 'openrouter');
  assert.equal(formatAccountLabel(null, null), null);
  assert.equal(formatAccountLabel(EMPTY(), null), null);
});

function EMPTY() {
  return { emailAddress: null, organizationName: null, plan: null };
}

test('readAccountInfo reads the in-config-dir .claude.json and caches the derived fields', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-account-'));
  const configDir = path.join(dir, '.claude');
  const originals = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  const fsSync = await import('node:fs');

  try {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    fsSync.mkdirSync(configDir, { recursive: true });
    const jsonPath = path.join(configDir, '.claude.json');
    await writeFile(jsonPath, JSON.stringify(TEAM_ACCOUNT), 'utf8');

    assert.deepEqual(readAccountInfo(), {
      emailAddress: 'jmearman@sourcepulp.com',
      organizationName: 'ExaDev',
      plan: 'Team Premium',
    });

    const cacheFile = accountCacheFile(configDir, jsonPath);
    assert.ok(fsSync.existsSync(cacheFile), 'first read must write a cache entry');
    assert.equal(fsSync.statSync(path.dirname(cacheFile)).mode & 0o777, 0o700);
    assert.equal(fsSync.statSync(cacheFile).mode & 0o777, 0o600);
    assert.equal(
      fsSync.existsSync(path.join(configDir, 'plugins', 'claude-hud', 'account-cache', 'account.json')),
      false,
      'the unkeyed legacy cache name must not be written',
    );
  } finally {
    for (const [name, value] of Object.entries(originals)) {
      restoreEnvVar(name, value);
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('readAccountInfo returns null for provider sessions and missing files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-account-none-'));
  const originals = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };

  try {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'missing');
    assert.equal(readAccountInfo(), null);

    // A lingering oauthAccount must not show for a token/API-key session.
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, '.claude');
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', '.claude.json'), JSON.stringify(TEAM_ACCOUNT), 'utf8');
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
    assert.equal(readAccountInfo(), null);
  } finally {
    for (const [name, value] of Object.entries(originals)) {
      restoreEnvVar(name, value);
    }
    await rm(dir, { recursive: true, force: true });
  }
});

const GMAIL_ACCOUNT = {
  oauthAccount: {
    emailAddress: 'joseph.mearman@gmail.com',
    organizationName: null,
    organizationType: 'claude_pro',
  },
};

// claude-use symlinks one plugins dir across identities, so both config dirs below resolve the SAME physical claude-hud cache directory while reading different .claude.json files. A fixed cache name there is last-writer-wins and every identity's status line shows whichever account rendered last.
test('readAccountInfo gives each config dir its own cache file when identities share a plugins dir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-account-shared-'));
  const configDirA = path.join(dir, 'identity-a', '.claude');
  const configDirB = path.join(dir, 'identity-b', '.claude');
  const sharedPlugins = path.join(dir, 'shared-plugins');
  const originals = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  const fsSync = await import('node:fs');

  try {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    await mkdir(configDirA, { recursive: true });
    await mkdir(configDirB, { recursive: true });
    await mkdir(path.join(sharedPlugins, 'claude-hud', 'account-cache'), { recursive: true });

    const jsonPathA = path.join(configDirA, '.claude.json');
    const jsonPathB = path.join(configDirB, '.claude.json');
    await writeFile(jsonPathA, JSON.stringify(TEAM_ACCOUNT), 'utf8');
    await writeFile(jsonPathB, JSON.stringify(GMAIL_ACCOUNT), 'utf8');

    // The legacy fixed-name cache from an older version, sitting in the shared dir.
    const legacyFile = path.join(sharedPlugins, 'claude-hud', 'account-cache', 'account.json');
    await writeFile(legacyFile, '{"version":1,"emailAddress":"stale@shared.test"}', 'utf8');

    fsSync.symlinkSync(sharedPlugins, path.join(configDirA, 'plugins'), 'dir');
    fsSync.symlinkSync(sharedPlugins, path.join(configDirB, 'plugins'), 'dir');

    process.env.CLAUDE_CONFIG_DIR = configDirA;
    assert.deepEqual(readAccountInfo(), {
      emailAddress: 'jmearman@sourcepulp.com',
      organizationName: 'ExaDev',
      plan: 'Team Premium',
    });

    process.env.CLAUDE_CONFIG_DIR = configDirB;
    assert.deepEqual(readAccountInfo(), {
      emailAddress: 'joseph.mearman@gmail.com',
      organizationName: null,
      plan: 'Pro',
    });

    const cacheA = path.join(sharedPlugins, 'claude-hud', 'account-cache', `${createHash('sha256').update(jsonPathA).digest('hex')}.json`);
    const cacheB = path.join(sharedPlugins, 'claude-hud', 'account-cache', `${createHash('sha256').update(jsonPathB).digest('hex')}.json`);
    assert.ok(fsSync.existsSync(cacheA), 'identity A must have its own keyed cache file');
    assert.ok(fsSync.existsSync(cacheB), 'identity B must have its own keyed cache file');
    assert.notEqual(cacheA, cacheB);
    assert.equal(JSON.parse(fsSync.readFileSync(cacheA, 'utf8')).emailAddress, 'jmearman@sourcepulp.com');
    assert.equal(JSON.parse(fsSync.readFileSync(cacheB, 'utf8')).emailAddress, 'joseph.mearman@gmail.com');

    // Reading B must not have clobbered A's entry, and the legacy file is gone.
    process.env.CLAUDE_CONFIG_DIR = configDirA;
    assert.equal(readAccountInfo().emailAddress, 'jmearman@sourcepulp.com');
    assert.equal(fsSync.existsSync(legacyFile), false, 'the legacy fixed-name cache must be removed');
  } finally {
    for (const [name, value] of Object.entries(originals)) {
      restoreEnvVar(name, value);
    }
    await rm(dir, { recursive: true, force: true });
  }
});
