import type { PaseoApi } from "@getpaseo/client";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { claudeCacheWriteTtlMs } from "../shared/cache";
import { providerId } from "../shared/usage";
import { defaultRoots, sessionFile } from "./speed";

/** TTL tier of the latest cache write in a Claude session log; null when none is recorded. */
export async function readClaudeCacheTtl(sessionId: string, signal: AbortSignal, roots = defaultRoots): Promise<number | null> {
  const path = await sessionFile("claude", sessionId, signal, roots);
  if (!path) return null;
  const stream = createReadStream(path, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let ttlMs: number | null = null;
  // SHORTCUT: rescans the whole session log per reading; read from a saved byte offset if long sessions make it slow.
  try {
    for await (const line of lines) {
      if (!line.includes('"cache_creation"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      // Pure cache-hit requests write nothing, so they keep the previous write's tier.
      ttlMs = claudeCacheWriteTtlMs(row?.message?.usage?.cache_creation) ?? ttlMs;
    }
  } finally { lines.close(); stream.destroy(); }
  return ttlMs;
}

export function createCacheTtlReader(signal: AbortSignal, readTtl = readClaudeCacheTtl) {
  return async ({ agentId }: { agentId: string }, { paseo }: { paseo: PaseoApi }) => {
    try {
      const ref = paseo.agents.ref(agentId);
      await ref.refresh();
      const agent = ref.current();
      const sessionId = agent?.persistence?.sessionId;
      // Only Claude logs the cache tier; other providers fall back to the client default.
      if (agent && providerId(agent.provider) === "claude" && sessionId) return { ttlMs: await readTtl(sessionId, signal) };
    } catch {
      // An unreadable log leaves the TTL unknown rather than guessing a tier.
    }
    return { ttlMs: null };
  };
}
