const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cacheRatio, quotaWindows, remaining, used, pillLabel, gatewayReasons, isGatewayTripped, gatewayPillLabel, GATEWAY_FIVE_HOUR_USED_PCT, GATEWAY_WEEKLY_USED_PCT, tokenPillLabel, cachePillLabel, providerId, formatHkt, PROMPT_CACHE_TTL_MS, cacheRemainingMs, formatCountdown } = require("../.test-build/shared/usage.js");
const { HANDOFF_FILENAME, buildHandoffPrompt, handoffTriggerSummary } = require("../.test-build/shared/handoff.js");
const { parseClaudeUsage, fetchClaudeUsage } = require("../.test-build/server/claude.js");
const { createCacheStore } = require("../.test-build/client/cache.js");

test("missing windows stay unknown, while an exhausted quota remains zero", () => {
  const usage = { status: "available", windows: [{ id: "weekly", remainingPct: 0 }] };
  assert.equal(quotaWindows(usage).fiveHour, null);
  assert.equal(remaining(quotaWindows(usage).weekly), 0);
  assert.equal(pillLabel(usage), "5h — · W 0%");
  assert.equal(pillLabel({ status: "unavailable", windows: [] }), "5h — · W —");
});

test("remaining percentage derives from used, and invalid numbers stay unknown", () => {
  assert.equal(remaining({ usedPct: 16 }), 84);
  assert.equal(remaining({ usedPct: 0 }), 100);
  assert.equal(remaining({ usedPct: 120 }), 0);
  assert.equal(remaining({ remainingPct: NaN, usedPct: Infinity }), null);
  assert.equal(remaining({ remainingPct: null, usedPct: null }), null);
});

test("a provider error cannot turn an old reading into a current quota", () => {
  assert.equal(pillLabel({ status: "error", windows: [{ id: "session", usedPct: 0 }] }), "5h — · W —");
});

test("separate labels preserve unknown and zero metrics within the host's compact pill width", () => {
  assert.equal(tokenPillLabel(null, null), "C— —tok/s");
  assert.equal(tokenPillLabel(0, 0), "C0% 0tok/s");
  assert.equal(tokenPillLabel(80, 27.56), "C80% 27.6tok/s");
  for (const cache of [null, 0, 100]) for (const speed of [null, 0, 9.99, 99.99, 999, 12345]) {
    assert.ok(tokenPillLabel(cache, speed).length <= 14);
  }
});

test("separate cache pill keeps countdown, expired and unknown labels compact", () => {
  assert.equal(cachePillLabel(272_000), "Cache 4:32");
  assert.equal(cachePillLabel(5_000), "Cache 0:05");
  assert.equal(cachePillLabel(0), "Cache Expired");
  assert.equal(cachePillLabel(-1_000), "Cache Expired");
  assert.equal(cachePillLabel(null), "Cache —");
  for (const remainingMs of [null, 300_000, 5_000, 0, -1_000]) {
    assert.ok(cachePillLabel(remainingMs).length <= 14);
  }
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
  assert.deepEqual(store.getSnapshot(), { ratio: null, updatedAtMs: null });
  store.update(agent, 1_000);
  assert.deepEqual(store.getSnapshot(), { ratio: 80, updatedAtMs: 1_000 });
  assert.equal(updates, 1);
  store.update(agent, 1_000);
  assert.equal(updates, 1);
  store.update({ provider: "codex" }, 2_000);
  assert.deepEqual(store.getSnapshot(), { ratio: null, updatedAtMs: null });
  assert.equal(updates, 2);
  release();
  store.update(agent, 3_000);
  assert.equal(updates, 2);
});

test("prompt cache countdown follows a 5-minute idle TTL", () => {
  assert.equal(PROMPT_CACHE_TTL_MS, 5 * 60 * 1000);
  assert.equal(cacheRemainingMs(1_000, 1_000 + 60_000), PROMPT_CACHE_TTL_MS - 60_000);
  assert.equal(cacheRemainingMs(1_000, 1_000 + PROMPT_CACHE_TTL_MS), 0);
  assert.ok(cacheRemainingMs(1_000, 1_000 + PROMPT_CACHE_TTL_MS + 1_000) < 0);
  assert.equal(cacheRemainingMs(null, Date.now()), null);
  assert.equal(formatCountdown(5 * 60 * 1000), "5:00");
  assert.equal(formatCountdown(61_000), "1:01");
  assert.equal(formatCountdown(5_000), "0:05");
  assert.equal(formatCountdown(-1_000), "0:00");
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

test("gateway trips at 90% on 5-hour but 95% on weekly", () => {
  assert.equal(GATEWAY_FIVE_HOUR_USED_PCT, 90);
  assert.equal(GATEWAY_WEEKLY_USED_PCT, 95);
  const at = (fiveHourUsed, weeklyUsed) => ({
    status: "available",
    windows: [
      { id: "session", usedPct: fiveHourUsed },
      { id: "weekly", usedPct: weeklyUsed },
    ],
  });
  assert.deepEqual(gatewayReasons(at(90, 0)), ["5-hour"]);
  assert.deepEqual(gatewayReasons(at(89, 0)), []);
  assert.deepEqual(gatewayReasons(at(0, 95)), ["Weekly"]);
  assert.deepEqual(gatewayReasons(at(0, 94)), []);
  assert.deepEqual(gatewayReasons(at(90, 95)), ["5-hour", "Weekly"]);
  assert.equal(isGatewayTripped(at(90, 0)), true);
  assert.equal(isGatewayTripped(at(0, 94)), false);
  assert.equal(isGatewayTripped({ status: "unavailable", windows: [] }), false);
  assert.equal(isGatewayTripped(null), false);
  assert.ok(gatewayPillLabel(at(90, 0)).startsWith("\u26A0 "));
  assert.equal(gatewayPillLabel(at(0, 0)), pillLabel(at(0, 0)));
  assert.equal(used(quotaWindows(at(90, 0)).fiveHour), 90);
});

test("handoff prompt instructs a workspace file save with trigger context", () => {
  assert.equal(HANDOFF_FILENAME, "HANDOFF.md");
  const usage = {
    status: "available",
    windows: [
      { id: "session", usedPct: 92, resetsAt: "2026-10-07T08:00:00Z" },
      { id: "weekly", usedPct: 10 },
    ],
  };
  const prompt = buildHandoffPrompt(usage);
  assert.ok(prompt.includes(HANDOFF_FILENAME));
  assert.ok(prompt.includes("STOP"));
  assert.ok(prompt.includes("How to resume"));
  assert.ok(handoffTriggerSummary(usage).includes("5-hour"));
  assert.equal(handoffTriggerSummary(null), "Usage is below the gateway threshold.");
});
