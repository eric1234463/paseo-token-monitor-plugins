const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { averageSpeed, speedLabel } = require("../.test-build/shared/speed.js");
const { readTurnOutput, readCompletedSpeed, registerSpeed } = require("../.test-build/server/speed.js");

test("Codex completed speed recovers after reload from exact duration and all output requests, ignoring a later running turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "token-speed-recovery-"));
  const roots = { codex: join(directory, "sessions"), codexArchive: join(directory, "archive"), claude: join(directory, "claude"), grok: join(directory, "grok") };
  const at = Date.parse("2026-09-30T01:00:00Z");
  const event = (offset, payload) => JSON.stringify({ type: "event_msg", timestamp: new Date(at + offset).toISOString(), payload });
  const tokens = (output, lastOutput) => ({ type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: output },
    last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: lastOutput } } });
  try {
    await mkdir(roots.codexArchive);
    await writeFile(join(roots.codexArchive, "rollout-session-one.jsonl"), [
      event(0, { type: "task_started", turn_id: "old" }),
      event(1000, tokens(30, 30)), event(5000, tokens(100, 70)),
      event(6000, { type: "task_complete", turn_id: "old", duration_ms: 6000, started_at: at / 1000, completed_at: at / 1000 + 6 }),
      event(7000, { type: "task_started", turn_id: "new" }), event(8000, tokens(300, 200)),
    ].join("\n"));
    const result = await readCompletedSpeed("codex", "session-one", new AbortController().signal, roots);
    assert.equal(result.outputTokens, 100);
    assert.equal(result.elapsedMs, 6000);
    assert.equal(result.tokensPerSecond, 100 / 6);
    assert.equal(result.completedAt, new Date(at + 6000).toISOString());
    assert.equal(await readCompletedSpeed("codex", "../session-one", new AbortController().signal, roots), null);
    assert.equal(await readCompletedSpeed("claude", "session-one", new AbortController().signal, roots), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("completed speed cache survives a new monitor and rejects corrupt data or another provider session", async () => {
  const { createSpeedStore } = require("../.test-build/server/speed-store.js");
  const directory = await mkdtemp(join(tmpdir(), "token-speed-store-"));
  const reading = { status: "available", outputTokens: 300, elapsedMs: 6000, tokensPerSecond: 50, completedAt: "2026-09-30T01:00:06Z" };
  try {
    await createSpeedStore(directory).save("agent-one", "claude", "session-one", reading);
    const restored = createSpeedStore(directory);
    assert.deepEqual(await restored.read("agent-one", "claude", "session-one"), reading);
    assert.equal(await restored.read("agent-one", "codex", "session-one"), null);
    assert.equal(await restored.read("agent-one", "claude", "session-two"), null);
    assert.equal(await restored.read("../agent-one", "claude", "session-one"), null);
    const newer = { ...reading, outputTokens: 600, tokensPerSecond: 100, completedAt: "2026-09-30T01:01:06Z" };
    await Promise.all([restored.save("agent-one", "claude", "session-one", reading), restored.save("agent-one", "claude", "session-one", newer)]);
    assert.deepEqual(await restored.read("agent-one", "claude", "session-one"), newer);
    await writeFile(join(directory, "agent-one.json"), "invalid JSON");
    assert.equal(await restored.read("agent-one", "claude", "session-one"), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("turn throughput uses output only and preserves reported zero without inventing missing data", () => {
  assert.equal(averageSpeed(300, 6000), 50);
  assert.equal(averageSpeed(0, 6000), 0);
  for (const [output, elapsed] of [[null, 6000], [-1, 6000], [1.5, 6000], [Infinity, 6000], [30, 0], [30, -1], [30, Infinity]]) {
    assert.equal(averageSpeed(output, elapsed), null);
  }
  assert.equal(speedLabel(null), "Avg — tok/s");
  assert.equal(speedLabel(50.125), "Avg 50.1 tok/s");
});

test("matching session and exact turn timestamps count every request once across all supported providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "token-speed-"));
  const roots = Object.fromEntries(["codex", "claude", "grok"].map((provider) => [provider, join(directory, provider)]));
  const start = Date.parse("2026-09-30T01:00:00Z");
  const end = start + 60000;
  const token = (offset, output) => ({ type: "event_msg", timestamp: new Date(start + offset).toISOString(), payload: {
    type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: output },
      last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 } },
  } });
  const assistant = (id, offset, output) => ({ type: "assistant", timestamp: new Date(start + offset).toISOString(), message: {
    id, model: "claude-sonnet", usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output },
  } });
  try {
    for (const root of Object.values(roots)) await mkdir(root);
    await writeFile(join(roots.codex, "rollout-session-one.jsonl"), [token(-1000, 100), token(1000, 150), token(2000, 150), token(60000, 200), token(61000, 300)].map(JSON.stringify).join("\n"));
    await writeFile(join(roots.codex, "rollout-other-session.jsonl"), JSON.stringify(token(1000, 1000000)));
    await writeFile(join(roots.claude, "session-one.jsonl"), [assistant("old", -1000, 99), assistant("a", 1000, 10), assistant("a", 2000, 30), assistant("b", 60000, 20), assistant("later", 61000, 99)].map(JSON.stringify).join("\n"));
    await mkdir(join(roots.grok, "session-one"));
    const grok = { turns: [-1000, 1000, 61000].map((offset) => ({ endedAt: new Date(start + offset).toISOString(), modelUsage: {
      "grok-one": { inputTokens: 100, cachedReadTokens: 0, outputTokens: 20 },
      "grok-two": { inputTokens: 100, cachedReadTokens: 0, outputTokens: 30 },
    } })) };
    await writeFile(join(roots.grok, "session-one", "usage.json"), JSON.stringify(grok));
    const signal = new AbortController().signal;
    assert.equal(await readTurnOutput("codex", "session-one", start, end, signal, roots), 100);
    assert.equal(await readTurnOutput("claude", "session-one", start, end, signal, roots), 50);
    assert.equal(await readTurnOutput("grok", "session-one", start, end, signal, roots), 50);
    assert.equal(await readTurnOutput("codex", "missing", start, end, signal, roots), null);
    assert.equal(await readTurnOutput("codex", "../session-one", start, end, signal, roots), null);
    assert.equal(await readTurnOutput("codex", "session-one", end + 100000, end + 200000, signal, roots), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function monitor(readOutput, options = {}) {
  const handlers = new Map();
  let query;
  let time = { wall: 100000, monotonic: 1000 };
  let activeTurn = null;
  const saved = new Map();
  const lifetime = new AbortController();
  const remove = registerSpeed({
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    handle(_contract, handler) { query = handler; },
  }, lifetime.signal, readOutput, () => ({ ...time }), {
    readCompleted: async () => null,
    store: { read: async (id) => saved.get(id) ?? null, save: async (id, _provider, _session, reading) => { saved.set(id, reading); } },
    ...options,
  });
  const agent = { id: "agent-one", provider: "codex" };
  const context = { paseo: { agents: { ref() { return { refresh: async () => {}, current: () => ({ provider: "codex", status: activeTurn ? "running" : "idle", activeTurn, persistence: { sessionId: "session-one" } }) }; } } } };
  return {
    setTime(value) { time = value; },
    read: () => query({ agentId: agent.id }, context),
    start: (turnId = "turn-one") => { activeTurn = { turnId, startedAt: new Date(time.wall).toISOString() }; handlers.get("agent.turn_started")({ agent, turnId }); },
    end: (kind = "completed", turnId = "turn-one") => { if (activeTurn?.turnId === turnId) activeTurn = null; return handlers.get("agent.turn_ended")({ agent, turnId, outcome: { kind } }, context); },
    archive: () => handlers.get("agent.archived")({ agent }),
    remove, handlers, lifetime,
  };
}

test("lifecycle measurement includes waits, retains the completed reading on new turns and uses monotonic elapsed time", async () => {
  const m = monitor(async (...args) => { assert.deepEqual(args.slice(0, 4), ["codex", "session-one", 100000, 107000]); return 300; });
  assert.equal((await m.read()).status, "waiting");
  m.start();
  assert.equal((await m.read()).tokensPerSecond, null);
  m.setTime({ wall: 107000, monotonic: 7000 });
  await m.end();
  assert.equal((await m.read()).tokensPerSecond, 50);
  assert.equal((await m.read()).elapsedMs, 6000);
  assert.equal((await m.read()).outputTokens, 300);
  m.start("turn-two");
  assert.equal((await m.read()).tokensPerSecond, 50);
  assert.equal((await m.read()).completedAt, new Date(107000).toISOString());
  await m.end("completed", "turn-one");
  assert.equal((await m.read()).status, "running");
  await m.end("canceled", "turn-two");
  assert.equal((await m.read()).status, "unavailable");
  m.archive();
  assert.equal((await m.read()).tokensPerSecond, 50);
  m.remove();
  assert.equal(m.handlers.size, 0);
});

test("unobserved, failed, missing and unreadable turns do not report zero throughput", async () => {
  for (const read of [async () => null, async () => { throw new Error("unreadable"); }]) {
    const m = monitor(read);
    await m.end();
    assert.equal((await m.read()).status, "waiting");
    m.start();
    m.setTime({ wall: 106000, monotonic: 7000 });
    await m.end();
    assert.equal((await m.read()).status, "unavailable");
    assert.equal((await m.read()).tokensPerSecond, null);
    m.start();
    await m.end("failed");
    assert.equal((await m.read()).tokensPerSecond, null);
    m.remove();
  }
});

test("running turns retain the last completed speed until a new completed measurement replaces it", async () => {
  let output = 360;
  const previous = { status: "available", outputTokens: 300, elapsedMs: 6000, tokensPerSecond: 50, completedAt: "2026-09-30T01:00:06Z" };
  const m = monitor(async () => output, { readCompleted: async () => previous });
  assert.equal((await m.read()).tokensPerSecond, 50);
  m.start();
  m.setTime({ wall: 106000, monotonic: 7000 });
  let reading = await m.read();
  assert.equal(reading.status, "running");
  assert.equal(reading.tokensPerSecond, 50);
  assert.equal(reading.completedAt, previous.completedAt);
  m.setTime({ wall: 112000, monotonic: 13000 });
  assert.equal((await m.read()).tokensPerSecond, 50);
  await m.end();
  reading = await m.read();
  assert.equal(reading.tokensPerSecond, 30);
  assert.equal(reading.completedAt, new Date(112000).toISOString());
  m.remove();
});

test("unobserved completed turns recover through the speed RPC without starting another turn", async () => {
  let previous = { status: "available", outputTokens: 100, elapsedMs: 5000, tokensPerSecond: 20, completedAt: "2026-09-30T01:00:05Z" };
  const m = monitor(async () => null, { readCompleted: async () => previous });
  assert.deepEqual(await m.read(), previous);
  previous = { ...previous, outputTokens: 200, tokensPerSecond: 40, completedAt: "2026-09-30T01:01:05Z" };
  await m.end(); // The plugin reloaded during this turn, so its start was not observed.
  assert.deepEqual(await m.read(), previous);
  m.remove();
});

test("a valid saved reading remains available when native recovery or cache writing fails", async () => {
  const reading = { status: "available", outputTokens: 100, elapsedMs: 5000, tokensPerSecond: 20, completedAt: "2026-09-30T01:00:05Z" };
  const m = monitor(async () => 300, {
    readCompleted: async () => { throw new Error("session unreadable"); },
    store: { read: async () => reading, save: async () => { throw new Error("disk full"); } },
  });
  assert.deepEqual(await m.read(), reading);
  m.start(); m.setTime({ wall: 106000, monotonic: 7000 }); await m.end();
  assert.equal((await m.read()).tokensPerSecond, 50);
  m.remove();
});

test("a completion during slow recovery cannot cache an older native reading", async () => {
  const old = { status: "available", outputTokens: 100, elapsedMs: 5000, tokensPerSecond: 20, completedAt: "2026-09-30T01:00:05Z" };
  const newer = { ...old, outputTokens: 200, tokensPerSecond: 40, completedAt: "2026-09-30T01:01:05Z" };
  let resolve, first = true;
  const m = monitor(async () => null, { readCompleted: () => first ? (first = false, new Promise(done => { resolve = done; })) : Promise.resolve(newer) });
  const pending = m.read();
  while (!resolve) await Promise.resolve();
  await m.end();
  resolve(old); await pending;
  assert.deepEqual(await m.read(), newer);
  m.remove();
});

test("a slow reading from an older turn cannot overwrite a newer turn or survive unload", async () => {
  let resolve;
  const m = monitor(() => new Promise((done) => { resolve = done; }));
  m.start();
  m.setTime({ wall: 106000, monotonic: 7000 });
  const finishing = m.end();
  await Promise.resolve();
  m.start("turn-two");
  resolve(300);
  await finishing;
  assert.equal((await m.read()).status, "running");
  const unloading = m.end("completed", "turn-two");
  await Promise.resolve();
  m.lifetime.abort();
  m.remove();
  resolve(300);
  await unloading;
  assert.equal((await m.read()).status, "waiting");
});
