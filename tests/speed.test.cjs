const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { averageSpeed, speedLabel } = require("../.test-build/shared/speed.js");
const { readTurnOutput, registerSpeed } = require("../.test-build/server/speed.js");

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

function monitor(readOutput) {
  const handlers = new Map();
  let query;
  let time = { wall: 100000, monotonic: 1000 };
  const lifetime = new AbortController();
  const remove = registerSpeed({
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    handle(_contract, handler) { query = handler; },
  }, lifetime.signal, readOutput, () => ({ ...time }));
  const agent = { id: "agent-one", provider: "codex" };
  const context = { paseo: { agents: { ref() { return { refresh: async () => {}, current: () => ({ persistence: { sessionId: "session-one" } }) }; } } } };
  return {
    setTime(value) { time = value; },
    read: () => query({ agentId: agent.id }),
    start: (turnId = "turn-one") => handlers.get("agent.turn_started")({ agent, turnId }),
    end: (kind = "completed", turnId = "turn-one") => handlers.get("agent.turn_ended")({ agent, turnId, outcome: { kind } }, context),
    archive: () => handlers.get("agent.archived")({ agent }),
    remove, handlers, lifetime,
  };
}

test("lifecycle measurement includes waits, clears on new turns and uses monotonic elapsed time", async () => {
  const m = monitor(async (...args) => { assert.deepEqual(args.slice(0, 4), ["codex", "session-one", 100000, 107000]); return 300; });
  assert.equal(m.read().status, "waiting");
  m.start();
  assert.equal(m.read().tokensPerSecond, null);
  m.setTime({ wall: 107000, monotonic: 7000 });
  await m.end();
  assert.equal(m.read().tokensPerSecond, 50);
  assert.equal(m.read().elapsedMs, 6000);
  assert.equal(m.read().outputTokens, 300);
  m.start("turn-two");
  assert.equal(m.read().tokensPerSecond, null);
  await m.end("completed", "turn-one");
  assert.equal(m.read().status, "running");
  await m.end("canceled", "turn-two");
  assert.equal(m.read().status, "unavailable");
  m.archive();
  assert.equal(m.read().status, "waiting");
  m.remove();
  assert.equal(m.handlers.size, 0);
});

test("unobserved, failed, missing and unreadable turns do not report zero throughput", async () => {
  for (const read of [async () => null, async () => { throw new Error("unreadable"); }]) {
    const m = monitor(read);
    await m.end();
    assert.equal(m.read().status, "waiting");
    m.start();
    m.setTime({ wall: 106000, monotonic: 7000 });
    await m.end();
    assert.equal(m.read().status, "unavailable");
    assert.equal(m.read().tokensPerSecond, null);
    m.start();
    await m.end("failed");
    assert.equal(m.read().tokensPerSecond, null);
    m.remove();
  }
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
  assert.equal(m.read().status, "running");
  const unloading = m.end("completed", "turn-two");
  await Promise.resolve();
  m.lifetime.abort();
  m.remove();
  resolve(300);
  await unloading;
  assert.equal(m.read().status, "waiting");
});
