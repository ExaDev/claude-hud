import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseHeadroomStats,
  formatHeadroomLabel,
  resolveHeadroomSessionId,
  getHeadroomProxyUrl,
  fetchHeadroomStats,
  HEADROOM_REFRESH_MS,
  HEADROOM_STALE_GRACE_MS,
} from '../dist/headroom.js';
import { setLanguage } from '../dist/i18n/index.js';

function restoreEnvVar(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

const SAMPLE_ROW = {
  requests: 12,
  tokens_saved: 456789,
  compression_savings_usd: 1.25,
  total_input_tokens: 320000,
  total_input_cost_usd: 2.1,
  savings_percent: 58.8,
};

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

test('parseHeadroomStats reads a per-session row and tolerates partial or junk payloads', () => {
  assert.deepEqual(parseHeadroomStats(SAMPLE_ROW), {
    tokensSaved: 456789,
    savingsPercent: 58.8,
    savingsUsd: 1.25,
  });
  // Only the fields present are kept.
  assert.deepEqual(parseHeadroomStats({ tokens_saved: 10 }), {
    tokensSaved: 10,
    savingsPercent: null,
    savingsUsd: null,
  });
  // Out-of-range and non-numeric values drop to null rather than rendering.
  assert.deepEqual(parseHeadroomStats({ tokens_saved: -1, savings_percent: 140, compression_savings_usd: 'x' }), {
    tokensSaved: null,
    savingsPercent: null,
    savingsUsd: null,
  });
  assert.deepEqual(parseHeadroomStats('junk'), { tokensSaved: null, savingsPercent: null, savingsUsd: null });
});

test('formatHeadroomLabel renders numbers, the down state, and nothing for an empty row', () => {
  setLanguage('en');
  assert.equal(
    formatHeadroomLabel({ stats: parseHeadroomStats(SAMPLE_ROW), down: false }),
    'headroom 457k saved · 59% · $1.25',
  );
  // A failed lookup keeps the last good numbers with a trailing down part.
  assert.equal(
    formatHeadroomLabel({ stats: parseHeadroomStats(SAMPLE_ROW), down: true }),
    'headroom 457k saved · 59% · $1.25 · down',
  );
  // Fully stale: numbers are dropped, the label never goes silent.
  assert.equal(
    formatHeadroomLabel({ stats: { tokensSaved: null, savingsPercent: null, savingsUsd: null }, down: true }),
    'headroom: down',
  );
  // A successful lookup with no usable fields renders nothing.
  assert.equal(
    formatHeadroomLabel({ stats: { tokensSaved: null, savingsPercent: null, savingsUsd: null }, down: false }),
    null,
  );
});

test('formatHeadroomLabel translates the label parts', () => {
  setLanguage('zh-Hans');
  try {
    assert.equal(
      formatHeadroomLabel({ stats: parseHeadroomStats(SAMPLE_ROW), down: false }),
      'headroom 457k 已节省 · 59% · $1.25',
    );
    assert.equal(
      formatHeadroomLabel({ stats: { tokensSaved: null, savingsPercent: null, savingsUsd: null }, down: true }),
      'headroom: 不可用',
    );
  } finally {
    setLanguage('en');
  }
});

test('resolveHeadroomSessionId prefers session_id and falls back to the transcript stem', () => {
  assert.equal(resolveHeadroomSessionId({ session_id: 'abc-123' }), 'abc-123');
  assert.equal(resolveHeadroomSessionId({ session_id: '  ' , transcript_path: '/tmp/sessions/def-456.jsonl' }), 'def-456');
  assert.equal(resolveHeadroomSessionId({ transcript_path: '/tmp/no-ext-session' }), 'no-ext-session');
  assert.equal(resolveHeadroomSessionId({}), null);
});

test('getHeadroomProxyUrl requires the env var and drops trailing slashes', () => {
  assert.equal(getHeadroomProxyUrl({}), null);
  assert.equal(getHeadroomProxyUrl({ HEADROOM_PROXY_URL: '   ' }), null);
  assert.equal(getHeadroomProxyUrl({ HEADROOM_PROXY_URL: 'http://127.0.0.1:8080/' }), 'http://127.0.0.1:8080');
});

test('fetchHeadroomStats fetches, caches, and serves the cache within the refresh interval', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-headroom-'));
  const originalUrl = process.env.HEADROOM_PROXY_URL;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let now = 1_000_000;
  let calls = 0;
  const deps = {
    homeDir: () => dir,
    now: () => now,
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url, 'http://127.0.0.1:8080/stats/sessions/sess-1');
      return jsonResponse(SAMPLE_ROW);
    },
  };

  // The cache lives under getHudPluginDir, which honours CLAUDE_CONFIG_DIR when set; without pinning it to the temp dir the test would read and write the developer's real plugin cache (claude-use always exports the variable).
  process.env.CLAUDE_CONFIG_DIR = dir;

  try {
    process.env.HEADROOM_PROXY_URL = 'http://127.0.0.1:8080';
    const first = await fetchHeadroomStats({ session_id: 'sess-1' }, deps);
    assert.deepEqual(first, { stats: parseHeadroomStats(SAMPLE_ROW), down: false });

    // Within the refresh interval the cache serves without another fetch.
    now += HEADROOM_REFRESH_MS - 1;
    const second = await fetchHeadroomStats({ session_id: 'sess-1' }, deps);
    assert.equal(second.down, false);
    assert.equal(calls, 1);

    // Past the interval a fresh fetch happens and rewrites the cache.
    now += HEADROOM_REFRESH_MS;
    const third = await fetchHeadroomStats({ session_id: 'sess-1' }, deps);
    assert.equal(third.down, false);
    assert.equal(calls, 2);
  } finally {
    restoreEnvVar('HEADROOM_PROXY_URL', originalUrl);
    restoreEnvVar('CLAUDE_CONFIG_DIR', originalConfigDir);
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchHeadroomStats renders down, keeping recent numbers then dropping stale ones', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-headroom-down-'));
  const originalUrl = process.env.HEADROOM_PROXY_URL;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let now = 1_000_000;
  let ok = true;
  const deps = {
    homeDir: () => dir,
    now: () => now,
    fetchImpl: async () => {
      if (!ok) {
        return jsonResponse({ error: 'boom' }, { ok: false, status: 500 });
      }
      return jsonResponse(SAMPLE_ROW);
    },
  };

  // Same isolation as above: the grace-window cache reads must not touch the real plugin dir.
  process.env.CLAUDE_CONFIG_DIR = dir;

  try {
    process.env.HEADROOM_PROXY_URL = 'http://127.0.0.1:8080';
    assert.equal((await fetchHeadroomStats({ session_id: 'sess-1' }, deps)).down, false);

    // The cache goes stale, the proxy is down: numbers stay for one grace interval alongside the down marker.
    now += HEADROOM_REFRESH_MS;
    ok = false;
    const recent = await fetchHeadroomStats({ session_id: 'sess-1' }, deps);
    assert.equal(recent.down, true);
    assert.equal(recent.stats.tokensSaved, 456789);

    // Past the grace window only the down marker survives.
    now += HEADROOM_STALE_GRACE_MS;
    const stale = await fetchHeadroomStats({ session_id: 'sess-1' }, deps);
    assert.equal(stale.down, true);
    assert.equal(stale.stats.tokensSaved, null);
  } finally {
    restoreEnvVar('HEADROOM_PROXY_URL', originalUrl);
    restoreEnvVar('CLAUDE_CONFIG_DIR', originalConfigDir);
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchHeadroomStats returns null without a proxy URL or session id', async () => {
  const originalUrl = process.env.HEADROOM_PROXY_URL;
  let calls = 0;
  const deps = {
    homeDir: () => '/unused',
    now: () => 0,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(SAMPLE_ROW);
    },
  };

  try {
    delete process.env.HEADROOM_PROXY_URL;
    assert.equal(await fetchHeadroomStats({ session_id: 'sess-1' }, deps), null);

    process.env.HEADROOM_PROXY_URL = 'http://127.0.0.1:8080';
    assert.equal(await fetchHeadroomStats({}, deps), null);
    assert.equal(calls, 0);
  } finally {
    restoreEnvVar('HEADROOM_PROXY_URL', originalUrl);
  }
});
