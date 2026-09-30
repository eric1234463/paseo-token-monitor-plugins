import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { speedRpc } from "../shared/speed";
import type { SpeedReading } from "../shared/speed";
import type { SupportedProvider } from "../shared/usage";

const saved = z.object({ provider: z.enum(["claude", "codex", "grok"]), sessionId: z.string(),
  reading: speedRpc.output.refine((value) => value.status === "available" && value.outputTokens !== null
    && value.elapsedMs !== null && value.tokensPerSecond !== null && value.completedAt !== null && Number.isFinite(Date.parse(value.completedAt))),
});

export function createSpeedStore(directory = join(homedir(), ".cache", "paseo-token-monitor-plugins", "speed"), signal?: AbortSignal) {
  const valid = (agentId: string) => /^[a-zA-Z0-9_-]{1,200}$/.test(agentId);
  const writes = new Map<string, Promise<void>>();
  return {
    async read(agentId: string, provider: SupportedProvider, sessionId: string): Promise<SpeedReading | null> {
      if (!valid(agentId) || signal?.aborted) return null;
      try {
        const value = saved.parse(JSON.parse(await readFile(join(directory, `${agentId}.json`), "utf8")));
        return value.provider === provider && value.sessionId === sessionId ? value.reading : null;
      } catch { return null; }
    },
    async save(agentId: string, provider: SupportedProvider, sessionId: string, reading: SpeedReading) {
      if (!valid(agentId) || signal?.aborted) return;
      const value = saved.parse({ provider, sessionId, reading });
      const pending = (writes.get(agentId) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (signal?.aborted) return;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${agentId}.json`);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(value), { mode: 0o600, signal });
          if (!signal?.aborted) await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
      });
      writes.set(agentId, pending);
      try { await pending; } finally { if (writes.get(agentId) === pending) writes.delete(agentId); }
    },
  };
}
