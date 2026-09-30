const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { dateBounds, periodRange } = require("../.test-build/shared/history.js");
const { claudeRecord, codexParser, grokRecords, aggregateHistory, createHistoryReader } = require("../.test-build/server/history.js");

const claude = (id, at, output = 10, model = "claude-sonnet") => ({
  type: "assistant", timestamp: at,
  message: { id, model, usage: { input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 150, output_tokens: output } },
});
const codex = (at, input, cached, output, last = { input_tokens: input, cached_input_tokens: cached, output_tokens: output }) => ({
  type: "event_msg", timestamp: at, payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, last_token_usage: last,
  } },
});

test("HKT ranges are inclusive calendar dates, weekly starts Monday, and months have real lengths", () => {
  assert.deepEqual(periodRange("daily", "2026-09-30"), { from: "2026-09-30", to: "2026-09-30" });
  assert.deepEqual(periodRange("weekly", "2026-09-30"), { from: "2026-09-28", to: "2026-10-04" });
  assert.deepEqual(periodRange("monthly", "2026-01-31", 1), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(periodRange("monthly", "2024-02-02"), { from: "2024-02-01", to: "2024-02-29" });
  assert.deepEqual(dateBounds("2026-09-30", "2026-09-30"), {
    start: Date.parse("2026-09-29T16:00:00Z"), end: Date.parse("2026-09-30T16:00:00Z"),
  });
  assert.throws(() => dateBounds("2026-02-30", "2026-03-01"));
  assert.throws(() => dateBounds("2026-10-01", "2026-09-01"));
});

test("Claude includes cache writes as non-cache-read input and deduplicates streaming/forked messages", () => {
  const first = claudeRecord(claude("msg-1", "2026-09-30T01:00:00Z"));
  const last = claudeRecord(claude("msg-1", "2026-09-30T01:00:01Z", 30));
  const rows = aggregateHistory([first, last, last], "2026-09-30", "2026-09-30");
  assert.deepEqual(rows, [{ provider: "claude", model: "claude-sonnet", input: 50, cacheInput: 150, totalInput: 200, output: 30 }]);
  assert.equal(claudeRecord(claude("error", "2026-09-30T01:00:00Z", 0, "<synthetic>")), null);
});

test("Codex cumulative snapshots count deltas once and attribute model changes to the right request", () => {
  const parse = codexParser();
  parse({ type: "turn_context", payload: { model: "gpt-one" } });
  const first = parse(codex("2026-09-30T01:00:00Z", 200, 150, 10));
  assert.equal(parse(codex("2026-09-30T01:00:01Z", 200, 150, 10)), null);
  parse({ type: "turn_context", payload: { model: "gpt-two" } });
  const second = parse(codex("2026-09-30T01:00:02Z", 500, 350, 30));
  const rows = aggregateHistory([first, first, second], "2026-09-30", "2026-09-30");
  assert.equal(rows.find(r => r.model === "gpt-one").totalInput, 200);
  assert.equal(rows.find(r => r.model === "gpt-two").totalInput, 300);
  assert.equal(rows.find(r => r.model === "gpt-two").input, 100);
  const reset = parse(codex("2026-09-30T01:00:03Z", 100, 80, 5));
  assert.equal(reset.totalInput, 100);
});

test("a fork's inherited Codex total is not billed as a new request", () => {
  const parse = codexParser();
  const row = parse(codex("2026-09-30T01:00:00Z", 10000, 9000, 500, { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5 }));
  assert.equal(row.totalInput, 100);
  assert.equal(row.input, 20);
});

test("Grok splits modelUsage and ignores session totals so completed turns are not double-counted", () => {
  const rows = grokRecords({ session: { inputTokens: 999999 }, turns: [{ endedAt: "2026-09-30T01:00:00Z", modelUsage: {
    "grok-one": { inputTokens: 200, cachedReadTokens: 150, outputTokens: 10 },
    "grok-two": { inputTokens: 100, cachedReadTokens: 0, outputTokens: 20 },
  } }] });
  const totals = aggregateHistory([...rows, ...rows], "2026-09-30", "2026-09-30");
  assert.equal(totals.length, 2);
  assert.equal(totals.find(r => r.model === "grok-one").input, 50);
  assert.equal(totals.find(r => r.model === "grok-two").cacheInput, 0);
  assert.throws(() => grokRecords({}));
});

test("date filtering uses HKT boundaries and incomplete counters stay unknown without losing output", () => {
  const records = [
    claudeRecord(claude("before", "2026-09-29T15:59:59Z")),
    claudeRecord(claude("start", "2026-09-29T16:00:00Z")),
    claudeRecord(claude("end", "2026-09-30T16:00:00Z")),
  ];
  assert.equal(aggregateHistory(records, "2026-09-30", "2026-09-30")[0].totalInput, 200);
  const incomplete = claude("unknown", "2026-09-30T02:00:00Z");
  delete incomplete.message.usage.cache_read_input_tokens;
  const result = aggregateHistory([records[1], claudeRecord(incomplete)], "2026-09-30", "2026-09-30")[0];
  assert.equal(result.cacheInput, null);
  assert.equal(result.totalInput, null);
  assert.equal(result.output, 20);
});

test("history reader reloads changed files, removes deleted data, and reports malformed/missing sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-history-test-"));
  const roots = { claude: join(directory, "claude"), codex: join(directory, "codex"), grok: join(directory, "grok") };
  try {
    await mkdir(roots.claude);
    await mkdir(roots.grok);
    const file = join(roots.claude, "session.jsonl");
    await writeFile(file, JSON.stringify(claude("first", "2026-09-30T01:00:00Z")) + "\n{unfinished");
    await writeFile(join(roots.grok, "usage.json"), "{}");
    const read = createHistoryReader(new AbortController().signal, roots);
    const first = await read({ from: "2026-09-30", to: "2026-09-30" });
    assert.equal(first.rows[0].output, 10);
    assert.equal(first.sources.find(s => s.provider === "codex").status, "missing");
    assert.equal(first.sources.find(s => s.provider === "grok").status, "error");
    await writeFile(file, JSON.stringify(claude("first", "2026-09-30T01:00:00Z", 40)) + "\n");
    assert.equal((await read({ from: "2026-09-30", to: "2026-09-30" })).rows[0].output, 40);
    await rm(file);
    assert.equal((await read({ from: "2026-09-30", to: "2026-09-30" })).rows.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Codex archived history is included without counting replayed active logs again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-history-archive-test-"));
  const roots = { claude: join(directory, "missing-claude"), codex: join(directory, "active"), grok: join(directory, "missing-grok"), codexArchive: join(directory, "archive") };
  try {
    await mkdir(roots.codex); await mkdir(roots.codexArchive);
    const log = JSON.stringify({ type: "turn_context", payload: { model: "gpt-test" } }) + "\n"
      + JSON.stringify(codex("2026-09-30T01:00:00Z", 200, 150, 10)) + "\n";
    await writeFile(join(roots.codex, "active.jsonl"), log);
    await writeFile(join(roots.codexArchive, "archived.jsonl"), log);
    const result = await createHistoryReader(new AbortController().signal, roots)({ from: "2026-09-30", to: "2026-09-30" });
    assert.equal(result.rows[0].totalInput, 200);
    assert.equal(result.sources.find(s => s.provider === "codex").files, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
