const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cacheRatio, quotaWindows, remaining, pillLabel, providerId, formatHkt } = require("../.test-build/shared/usage.js");
const { parseClaudeUsage, fetchClaudeUsage } = require("../.test-build/server/claude.js");
const { createCacheStore } = require("../.test-build/client/cache.js");

test("missing windows stay unknown, while an exhausted quota remains zero", () => {
  const usage = { status: "available", windows: [{ id: "weekly", remainingPct: 0 }] };
  assert.equal(quotaWindows(usage).fiveHour, null);
  assert.equal(remaining(quotaWindows(usage).weekly), 0);
  assert.equal(pillLabel(usage), "5h — · Week 0% left");
  assert.equal(pillLabel({ status: "unavailable", windows: [] }), "5h — · Week —");
});

test("remaining percentage derives from used, and invalid numbers stay unknown", () => {
  assert.equal(remaining({ usedPct: 16 }), 84);
  assert.equal(remaining({ usedPct: 0 }), 100);
  assert.equal(remaining({ usedPct: 120 }), 0);
  assert.equal(remaining({ remainingPct: NaN, usedPct: Infinity }), null);
  assert.equal(remaining({ remainingPct: null, usedPct: null }), null);
});

test("a provider error cannot turn an old reading into a current quota", () => {
  assert.equal(pillLabel({ status: "error", windows: [{ id: "session", usedPct: 0 }] }), "5h — · Week —");
});

test("cache ratio follows provider token semantics and preserves a reported zero", () => {
  assert.equal(cacheRatio("codex", { inputTokens: 1000, cachedInputTokens: 800 }), 80);
  assert.equal(cacheRatio("claude", { inputTokens: 200, cachedInputTokens: 800 }), 80);
  assert.equal(cacheRatio("claude", { inputTokens: 0, cachedInputTokens: 800 }), 100);
  assert.equal(cacheRatio("codex", { inputTokens: 1000, cachedInputTokens: 0 }), 0);
});

test("unknown or inconsistent cache counters never imply zero cache hits", () => {
  for (const usage of [undefined, {}, { inputTokens: 1000 },
    { inputTokens: 0, cachedInputTokens: 0 }, { inputTokens: -1, cachedInputTokens: 0 },
    { inputTokens: Infinity, cachedInputTokens: 100 }, { inputTokens: 1000, cachedInputTokens: NaN },
    { inputTokens: 1000, cachedInputTokens: -1 }, { inputTokens: 1000, cachedInputTokens: 1001 }]) {
    assert.equal(cacheRatio("codex", usage), null);
  }
  assert.equal(cacheRatio("grok", { inputTokens: 1000, cachedInputTokens: 800 }), null);
  assert.equal(cacheRatio(null, { inputTokens: 1000, cachedInputTokens: 800 }), null);
});

test("agent usage updates notify the pill and popover without retaining missing counters", () => {
  const store = createCacheStore();
  let updates = 0;
  const release = store.subscribe(() => { updates++; });
  const agent = { provider: "codex", lastUsage: { inputTokens: 1000, cachedInputTokens: 800 } };
  assert.equal(store.getSnapshot(), null);
  store.update(agent);
  assert.equal(store.getSnapshot(), 80);
  assert.equal(updates, 1);
  store.update(agent);
  assert.equal(updates, 1);
  store.update({ provider: "codex" });
  assert.equal(store.getSnapshot(), null);
  assert.equal(updates, 2);
  release();
  store.update(agent);
  assert.equal(updates, 2);
});

test("provider/model selections match exactly and reset times display in HKT", () => {
  assert.equal(providerId("codex/gpt-6-sol"), "codex");
  assert.equal(providerId("claude"), "claude");
  assert.equal(providerId("grok/grok-code"), "grok");
  assert.equal(providerId("pi/grok"), null);
  assert.equal(formatHkt("2026-09-30T04:04:33.000Z"), "30 Sep, 12:04 HKT");
  assert.equal(formatHkt("invalid"), "Not provided");
});

test("Claude's real usage percentages and model windows are retained", () => {
  const result = parseClaudeUsage({
    five_hour: { utilization: 16, resets_at: "2026-09-30T04:00:00Z" },
    seven_day: { utilization: 66, resets_at: "2026-10-04T02:00:00Z" },
    seven_day_opus: { utilization: 90, resets_at: null },
  });
  assert.equal(result.status, "available");
  assert.equal(remaining(quotaWindows(result).fiveHour), 84);
  assert.equal(remaining(quotaWindows(result).weekly), 34);
  assert.equal(result.windows[2].label, "Weekly · Opus");
  assert.equal(parseClaudeUsage({ five_hour: null, seven_day: null }).windows.length, 0);
  assert.throws(() => parseClaudeUsage({ five_hour: { utilization: "16" } }));
});

test("Claude auth failure produces an unavailable reading and never returns credentials", async () => {
  const result = await fetchClaudeUsage("test-secret", async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(options.headers.Authorization, "Bearer test-secret");
    return { status: 401, ok: false };
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.windows.length, 0);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});
