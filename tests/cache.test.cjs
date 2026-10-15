const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { claudeCacheWriteTtlMs, ONE_HOUR_CACHE_TTL_MS, FIVE_MINUTE_CACHE_TTL_MS } = require("../.test-build/shared/cache.js");
const { readClaudeCacheTtl, createCacheTtlReader } = require("../.test-build/server/cache.js");

test("cache write tier maps to its TTL and an empty write yields none", () => {
  assert.equal(claudeCacheWriteTtlMs({ ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 }), ONE_HOUR_CACHE_TTL_MS);
  assert.equal(claudeCacheWriteTtlMs({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 10 }), FIVE_MINUTE_CACHE_TTL_MS);
  for (const value of [{ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, {}, null, undefined, "1h", { ephemeral_1h_input_tokens: "10" }]) {
    assert.equal(claudeCacheWriteTtlMs(value), null);
  }
});

test("Claude session TTL follows the latest cache write and ignores later pure cache hits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "token-cache-ttl-"));
  const roots = { codex: join(directory, "codex"), claude: join(directory, "claude"), grok: join(directory, "grok") };
  const row = (h1, m5) => JSON.stringify({ type: "assistant", message: { usage: { cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 } } } });
  const signal = new AbortController().signal;
  try {
    await mkdir(join(roots.claude, "project"), { recursive: true });
    await writeFile(join(roots.claude, "project", "subscribed.jsonl"), [row(100, 0), "not json \"cache_creation\"", row(0, 0)].join("\n"));
    await writeFile(join(roots.claude, "project", "overage.jsonl"), [row(100, 0), row(0, 50), row(0, 0)].join("\n"));
    await writeFile(join(roots.claude, "project", "none.jsonl"), JSON.stringify({ type: "user" }));
    assert.equal(await readClaudeCacheTtl("subscribed", signal, roots), ONE_HOUR_CACHE_TTL_MS);
    assert.equal(await readClaudeCacheTtl("overage", signal, roots), FIVE_MINUTE_CACHE_TTL_MS);
    assert.equal(await readClaudeCacheTtl("none", signal, roots), null);
    assert.equal(await readClaudeCacheTtl("missing", signal, roots), null);
    assert.equal(await readClaudeCacheTtl("../subscribed", signal, roots), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cache TTL reader only reads Claude sessions and reports unknown on failure", async () => {
  const paseo = (agent) => ({ agents: { ref: () => ({ refresh: async () => {}, current: () => agent }) } });
  const read = createCacheTtlReader(new AbortController().signal, async (sessionId) => sessionId === "s1" ? ONE_HOUR_CACHE_TTL_MS : null);
  assert.deepEqual(await read({ agentId: "a" }, { paseo: paseo({ provider: "claude", persistence: { sessionId: "s1" } }) }), { ttlMs: ONE_HOUR_CACHE_TTL_MS });
  assert.deepEqual(await read({ agentId: "a" }, { paseo: paseo({ provider: "codex", persistence: { sessionId: "s1" } }) }), { ttlMs: null });
  assert.deepEqual(await read({ agentId: "a" }, { paseo: paseo({ provider: "claude", persistence: null }) }), { ttlMs: null });
  const failing = { agents: { ref: () => ({ refresh: async () => { throw new Error("gone"); }, current: () => null }) } };
  assert.deepEqual(await read({ agentId: "a" }, { paseo: failing }), { ttlMs: null });
});
