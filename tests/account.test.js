import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
    await writeFile(path.join(configDir, '.claude.json'), JSON.stringify(TEAM_ACCOUNT), 'utf8');

    assert.deepEqual(readAccountInfo(), {
      emailAddress: 'jmearman@sourcepulp.com',
      organizationName: 'ExaDev',
      plan: 'Team Premium',
    });

    const cacheFile = path.join(configDir, 'plugins', 'claude-hud', 'account-cache', 'account.json');
    assert.ok(fsSync.existsSync(cacheFile), 'first read must write a cache entry');
    assert.equal(fsSync.statSync(path.dirname(cacheFile)).mode & 0o777, 0o700);
    assert.equal(fsSync.statSync(cacheFile).mode & 0o777, 0o600);
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
