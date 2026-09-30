const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { dateBounds, periodRange, dailySeries } = require("../.test-build/shared/history.js");
const { claudeRecord, codexParser, grokRecords, aggregateHistory, aggregateDailyHistory, createHistoryReader } = require("../.test-build/server/history.js");

const claude = (id, at, output = 10, model = "claude-sonnet") => ({
  type: "assistant", timestamp: at,
  message: { id, model, usage: { input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 150, output_tokens: output } },
});
const codex = (at, input, cached, output, last = { input_tokens: input, cached_input_tokens: cached, output_tokens: output }) => ({
  type: "event_msg", timestamp: at, payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, last_token_usage: last,
  } },
});

test("HKT ranges are inclusive, weekly is the latest seven days, and months have real lengths", () => {
  assert.deepEqual(periodRange("daily", "2026-09-30"), { from: "2026-09-30", to: "2026-09-30" });
  assert.deepEqual(periodRange("weekly", "2026-09-30"), { from: "2026-09-24", to: "2026-09-30" });
  assert.deepEqual(periodRange("weekly", "2026-09-30", -1), { from: "2026-09-17", to: "2026-09-23" });
  assert.deepEqual(periodRange("weekly", "2026-01-03"), { from: "2025-12-28", to: "2026-01-03" });
  assert.deepEqual(periodRange("monthly", "2026-01-31", 1), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(periodRange("monthly", "2024-02-02"), { from: "2024-02-01", to: "2024-02-29" });
  assert.deepEqual(dateBounds("2026-09-30", "2026-09-30"), {
    start: Date.parse("2026-09-29T16:00:00Z"), end: Date.parse("2026-09-30T16:00:00Z"),
  });
  assert.throws(() => dateBounds("2026-02-30", "2026-03-01"));
  assert.throws(() => dateBounds("2026-10-01", "2026-09-01"));
});

test("daily totals use HKT dates, combine models, deduplicate records and include cache only once", () => {
  const records = [
    claudeRecord(claude("before", "2026-09-28T15:59:59Z", 999)),
    claudeRecord(claude("a", "2026-09-28T16:00:00Z", 10)),
    claudeRecord(claude("a", "2026-09-28T16:01:00Z", 30)),
    claudeRecord(claude("b", "2026-09-29T15:59:59Z", 20, "claude-opus")),
    claudeRecord(claude("c", "2026-09-29T16:00:00Z", 40)),
    claudeRecord(claude("after", "2026-09-30T16:00:00Z", 999)),
    ...grokRecords({ turns: [{ endedAt: "2026-09-29T16:00:00Z", modelUsage: {
      "grok-test": { inputTokens: 100, cachedReadTokens: 80, outputTokens: 10 },
    } }] }),
  ];
  const days = aggregateDailyHistory([...records, ...records], "2026-09-29", "2026-09-30");
  const points = dailySeries(days, "claude", "2026-09-29", "2026-09-30", true);
  assert.deepEqual(points.map(row => [row.input, row.cacheInput, row.output, row.totalTokens]), [
    [100, 300, 50, 450], [50, 150, 40, 240],
  ]);
  const claudeDays = days.filter(row => row.provider === "claude");
  assert.deepEqual(claudeDays.map(row => [row.date, row.totalInput, row.output, row.totalTokens]), [
    ["2026-09-29", 400, 50, 450], ["2026-09-30", 200, 40, 240],
  ]);
  assert.equal(days.find(row => row.provider === "grok").totalTokens, 110);
  const rows = aggregateHistory(records, "2026-09-29", "2026-09-30").filter(row => row.provider === "claude");
  assert.equal(claudeDays.reduce((sum, row) => sum + row.totalTokens, 0), rows.reduce((sum, row) => sum + row.totalInput + row.output, 0));
});

test("daily chart fills all calendar days, isolates provider tabs, and preserves missing counters or coverage", () => {
  const incomplete = claude("unknown", "2026-09-29T16:00:00Z");
  delete incomplete.message.usage.cache_read_input_tokens;
  const days = aggregateDailyHistory([claudeRecord(incomplete)], "2026-09-29", "2026-09-30");
  assert.equal(days[0].totalTokens, null);
  assert.deepEqual(dailySeries(days, "claude", "2026-09-29", "2026-09-30", true).map(({ date, totalTokens }) => ({ date, totalTokens })), [
    { date: "2026-09-29", totalTokens: 0 }, { date: "2026-09-30", totalTokens: null },
  ]);
  assert.deepEqual(dailySeries(days, "grok", "2026-09-29", "2026-09-30", false).map(({ date, totalTokens }) => ({ date, totalTokens })), [
    { date: "2026-09-29", totalTokens: null }, { date: "2026-09-30", totalTokens: null },
  ]);
  assert.deepEqual(dailySeries(days, "grok", "2026-09-29", "2026-09-29", true)[0], {
    date: "2026-09-29", input: 0, cacheInput: 0, output: 0, totalTokens: 0,
  });
  assert.equal(dailySeries(days, "grok", "2026-09-29", "2026-09-29", false)[0].cacheInput, null);
  assert.equal(dailySeries(days, "claude", "2026-09-30", "2026-09-30", true)[0].cacheInput, null);
  assert.equal(dailySeries([], "codex", "2024-02-01", "2024-02-29", true).length, 29);
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
    assert.equal(first.days[0].totalTokens, 210);
    assert.equal(first.sources.find(s => s.provider === "codex").status, "missing");
    assert.equal(first.sources.find(s => s.provider === "grok").status, "error");
    await writeFile(file, JSON.stringify(claude("first", "2026-09-30T01:00:00Z", 40)) + "\n");
    assert.equal((await read({ from: "2026-09-30", to: "2026-09-30" })).rows[0].output, 40);
    assert.equal((await read({ from: "2026-09-30", to: "2026-09-30" })).days[0].totalTokens, 240);
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
