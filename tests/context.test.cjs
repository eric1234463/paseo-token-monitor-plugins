const { test } = require("node:test");
const assert = require("node:assert/strict");
const { estimateTokens, contextPartOf, contextTextOf, contextToolSplit, aggregateContext, contextPillLabel, hiddenOverheadTokens, isMcpToolCall } = require("../.test-build/shared/context.js");

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
  assert.equal(contextPartOf({ type: "tool_call", name: "read" }), "tools");
  assert.equal(contextPartOf({ type: "todo" }), "tasks");
  assert.equal(contextPartOf({ type: "compaction" }), "other");
  assert.equal(contextPartOf({ type: "plugin" }), "other");
});

test("mcp__ tool calls split out of built-in tool calls", () => {
  assert.equal(contextPartOf({ type: "tool_call", name: "mcp__github__search" }), "mcp");
  assert.equal(contextPartOf({ type: "tool_call", name: "MCP__server__tool" }), "mcp");
  assert.equal(contextPartOf({ type: "tool_call", name: "mcp-tool" }), "mcp");
  assert.equal(isMcpToolCall(undefined), false);
  assert.equal(isMcpToolCall("shell"), false);
  const { parts } = aggregateContext([
    { type: "tool_call", name: "read", text: "x".repeat(400) },
    { type: "tool_call", name: "mcp__github__search", text: "y".repeat(400) },
  ]);
  const byPart = Object.fromEntries(parts.map((row) => [row.part, row]));
  assert.equal(byPart.tools.items, 1);
  assert.equal(byPart.mcp.items, 1);
});

test("aggregateContext ranks per-tool totals and hidden overhead is a clamped residual", () => {
  const { topTools } = aggregateContext([
    { type: "tool_call", name: "read", text: "x".repeat(400) },
    { type: "tool_call", name: "read", text: "x".repeat(400) },
    { type: "tool_call", name: "mcp__github__search", text: "y".repeat(1200) },
    { type: "user_message", text: "hi" },
  ]);
  assert.equal(topTools[0].name, "mcp__github__search");
  assert.equal(topTools[0].calls, 1);
  assert.equal(topTools[1].name, "read");
  assert.equal(topTools[1].calls, 2);
  assert.equal(hiddenOverheadTokens(1000, 400), 600);
  assert.equal(hiddenOverheadTokens(100, 400), 0);
  assert.equal(hiddenOverheadTokens(null, 400), null);
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

test("contextToolSplit separates arguments from results per detail kind", () => {
  const shell = contextToolSplit({ type: "tool_call", name: "shell", detail: { type: "shell", command: "ls", output: "x".repeat(400) } });
  assert.match(shell.input, /ls/);
  assert.equal(shell.output.length, 400);
  const read = contextToolSplit({ type: "tool_call", name: "read", detail: { type: "read", filePath: "f", content: "y".repeat(400) } });
  assert.match(read.input, /f/);
  assert.ok(!read.input.includes("y"));
  const unknown = contextToolSplit({ type: "tool_call", name: "mcp__s__t", detail: { type: "unknown", input: { q: 1 }, output: "z".repeat(400) } });
  assert.match(unknown.input, /mcp__s__t/);
  assert.equal(unknown.output.length, 400);
  const write = contextToolSplit({ type: "tool_call", name: "write", detail: { type: "write", filePath: "f", content: "w".repeat(100) } });
  assert.equal(write.output, "");
});

test("tool parts and top tools carry input/output shares", () => {
  const read = { type: "tool_call", name: "read", text: "both", input: "f", output: "y".repeat(400) };
  const mcp = { type: "tool_call", name: "mcp__s__t", text: "z".repeat(800), input: "mcp__s__t", output: "z".repeat(800) };
  const { parts, topTools } = aggregateContext([read, mcp, { type: "user_message", text: "hi" }]);
  const byPart = Object.fromEntries(parts.map((row) => [row.part, row]));
  assert.equal(byPart.tools.inputTokens, 1);
  assert.equal(byPart.tools.outputTokens, 100);
  assert.equal(byPart.mcp.outputTokens, 200);
  assert.equal(byPart.user.inputTokens, null);
  assert.equal(topTools[0].name, "mcp__s__t");
  assert.equal(topTools[0].outputTokens, 200);
});

test("contextPillLabel prefers authoritative percent, then estimate", () => {
  assert.equal(contextPillLabel(50000, 200000, 40000), "Ctx 25%");
  assert.equal(contextPillLabel(null, null, 12345), "Ctx ~12.3K");
  assert.equal(contextPillLabel(null, null, null), "Context…");
});
