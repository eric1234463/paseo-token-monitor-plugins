const { test } = require("node:test");
const assert = require("node:assert/strict");
const { estimateTokens, contextPartOf, contextTextOf, aggregateContext, contextPillLabel } = require("../.test-build/shared/context.js");

test("estimateTokens uses ~4 chars per token with a minimum of one", () => {
  assert.equal(estimateTokens(""), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("x".repeat(400)), 100);
});

test("timeline types map to context parts", () => {
  assert.equal(contextPartOf({ type: "user_message" }), "user");
  assert.equal(contextPartOf({ type: "assistant_message" }), "assistant");
  assert.equal(contextPartOf({ type: "reasoning" }), "reasoning");
  assert.equal(contextPartOf({ type: "tool_call" }), "tools");
  assert.equal(contextPartOf({ type: "todo" }), "tasks");
  assert.equal(contextPartOf({ type: "compaction" }), "other");
  assert.equal(contextPartOf({ type: "plugin" }), "other");
});

test("contextTextOf extracts visible text per item kind", () => {
  assert.equal(contextTextOf({ type: "user_message", text: "hello" }), "hello");
  assert.equal(contextTextOf({ type: "reasoning", text: "thinking" }), "thinking");
  assert.equal(contextTextOf({ type: "todo", items: [{ text: "a" }, { text: "b" }] }), "a\nb");
  assert.match(contextTextOf({ type: "tool_call", name: "read", detail: { type: "read", filePath: "x" } }), /read/);
});

test("aggregateContext shares sum to ~100 and empty input yields null shares", () => {
  const { parts, estimatedTokens, itemCount } = aggregateContext([
    { type: "user_message", text: "x".repeat(400) },
    { type: "tool_call", text: "y".repeat(400) },
    { type: "tool_call", text: "z".repeat(400) },
  ]);
  assert.equal(itemCount, 3);
  assert.equal(estimatedTokens, 300);
  const byPart = Object.fromEntries(parts.map((row) => [row.part, row]));
  assert.equal(byPart.user.sharePct, 33.3);
  assert.equal(byPart.tools.sharePct, 66.7);
  assert.equal(byPart.tools.items, 2);
  const total = parts.reduce((sum, row) => sum + (row.sharePct ?? 0), 0);
  assert.ok(Math.abs(total - 100) < 0.2, `shares sum to ${total}`);
  const empty = aggregateContext([]);
  assert.equal(empty.estimatedTokens, 0);
  assert.ok(empty.parts.every((row) => row.sharePct === null));
});

test("contextPillLabel prefers authoritative percent, then estimate", () => {
  assert.equal(contextPillLabel(50000, 200000, 40000), "Ctx 25%");
  assert.equal(contextPillLabel(null, null, 12345), "Ctx ~12.3K");
  assert.equal(contextPillLabel(null, null, null), "Context…");
});
