import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { aggregateHistory, files, readRecords } from "./history";
import { hktDate } from "../shared/history";
import { averageSpeed, speedRpc } from "../shared/speed";
import type { SpeedReading } from "../shared/speed";
import { providerId } from "../shared/usage";
import type { SupportedProvider } from "../shared/usage";

export async function readTurnOutput(provider: SupportedProvider, sessionId: string, start: number, end: number,
  signal: AbortSignal, roots: Record<SupportedProvider, string> = {
    codex: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
    claude: join(process.env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_HOME ?? join(homedir(), ".claude"), "projects"),
    grok: join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "sessions"),
  }): Promise<number | null> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) return null;
  for await (const path of files(roots[provider], provider)) {
    if (signal.aborted) throw new Error("Speed reading cancelled.");
    const matches = provider === "codex" ? basename(path).endsWith(`-${sessionId}.jsonl`)
      : provider === "claude" ? basename(path) === `${sessionId}.jsonl` : basename(dirname(path)) === sessionId;
    if (!matches) continue;
    const records = (await readRecords(path, provider, signal)).filter((row) => row.timestamp >= start && row.timestamp <= end);
    const rows = aggregateHistory(records, hktDate(start), hktDate(end));
    if (!rows.length || rows.some((row) => row.output === null)) return null;
    const output = rows.reduce((sum, row) => sum + row.output!, 0);
    return Number.isSafeInteger(output) ? output : null;
  }
  return null;
}

const empty = (status: SpeedReading["status"]): SpeedReading => ({
  status, tokensPerSecond: null, outputTokens: null, elapsedMs: null, completedAt: null,
});

export function registerSpeed(server: PluginServerContext, signal: AbortSignal,
  readOutput = readTurnOutput, clock = () => ({ wall: Date.now(), monotonic: performance.now() })) {
  const turns = new Map<string, { turnId: string | null; start: ReturnType<typeof clock>; reading: SpeedReading }>();
  const release = [
    server.on("agent.turn_started", ({ agent, turnId }) => {
      if (!providerId(agent.provider) || signal.aborted) return;
      turns.set(agent.id, { turnId, start: clock(), reading: empty("running") });
    }),
    server.on("agent.turn_ended", async ({ agent, turnId, outcome }, { paseo }) => {
      const turn = turns.get(agent.id);
      if (!turn || turn.turnId !== turnId || turn.reading.status !== "running" || signal.aborted) return;
      const end = clock();
      turn.reading = empty("unavailable");
      if (outcome.kind !== "completed") return;
      try {
        const ref = paseo.agents.ref(agent.id);
        await ref.refresh();
        const sessionId = ref.current()?.persistence?.sessionId;
        const provider = providerId(agent.provider);
        const output = sessionId && provider ? await readOutput(provider, sessionId, turn.start.wall, end.wall, signal) : null;
        const elapsedMs = end.monotonic - turn.start.monotonic;
        const tokensPerSecond = averageSpeed(output, elapsedMs);
        if (turns.get(agent.id) !== turn || signal.aborted) return;
        turn.reading = tokensPerSecond === null ? empty("unavailable") : {
          status: "available", tokensPerSecond, outputTokens: output,
          elapsedMs, completedAt: new Date(end.wall).toISOString(),
        };
      } catch {
        // Missing or unreadable session usage must not become a zero-speed reading.
      }
    }),
    server.on("agent.archived", ({ agent }) => { turns.delete(agent.id); }),
  ];
  server.handle(speedRpc, ({ agentId }) => turns.get(agentId)?.reading ?? empty("waiting"));
  return () => {
    for (const remove of release) remove();
    turns.clear();
  };
}
