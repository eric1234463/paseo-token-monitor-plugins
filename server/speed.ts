import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { aggregateHistory, files, readRecords } from "./history";
import { hktDate } from "../shared/history";
import { averageSpeed, speedRpc } from "../shared/speed";
import type { SpeedReading } from "../shared/speed";
import { providerId } from "../shared/usage";
import type { SupportedProvider } from "../shared/usage";
import { createSpeedStore } from "./speed-store";

type Roots = Record<SupportedProvider, string> & { codexArchive?: string };
const defaultRoots: Roots = {
  codex: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
  codexArchive: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "archived_sessions"),
  claude: join(process.env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_HOME ?? join(homedir(), ".claude"), "projects"),
  grok: join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "sessions"),
};

async function sessionFile(provider: SupportedProvider, sessionId: string, signal: AbortSignal, roots: Roots) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) return null;
  const directories = provider === "codex" && roots.codexArchive ? [roots.codex, roots.codexArchive] : [roots[provider]];
  for (const directory of directories) for await (const path of files(directory, provider)) {
    if (signal.aborted) throw new Error("Speed reading cancelled.");
    const matches = provider === "codex" ? basename(path).endsWith(`-${sessionId}.jsonl`)
      : provider === "claude" ? basename(path) === `${sessionId}.jsonl` : basename(dirname(path)) === sessionId;
    if (matches) return path;
  }
  return null;
}

export async function readTurnOutput(provider: SupportedProvider, sessionId: string, start: number, end: number,
  signal: AbortSignal, roots: Roots = defaultRoots): Promise<number | null> {
  const path = await sessionFile(provider, sessionId, signal, roots);
  if (!path) return null;
  const records = (await readRecords(path, provider, signal)).filter((row) => row.timestamp >= start && row.timestamp <= end);
  const rows = aggregateHistory(records, hktDate(start), hktDate(end));
  if (!rows.length || rows.some((row) => row.output === null)) return null;
  const output = rows.reduce((sum, row) => sum + row.output!, 0);
  return Number.isSafeInteger(output) ? output : null;
}

export async function readCompletedSpeed(provider: SupportedProvider, sessionId: string, signal: AbortSignal,
  roots: Roots = defaultRoots): Promise<SpeedReading | null> {
  if (provider !== "codex") return null;
  const path = await sessionFile(provider, sessionId, signal, roots);
  if (!path) return null;
  const stream = createReadStream(path, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let latest: { end: number; elapsedMs: number } | undefined;
  try {
    for await (const line of lines) {
      if (!line.includes('"task_complete"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const end = Date.parse(row.timestamp);
      const elapsedMs = row.payload?.duration_ms;
      if (row.type === "event_msg" && row.payload?.type === "task_complete" && Number.isFinite(end)
        && typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs > 0) latest = { end, elapsedMs };
    }
  } finally { lines.close(); stream.destroy(); }
  if (!latest) return null;
  const output = await readTurnOutput(provider, sessionId, latest.end - latest.elapsedMs, latest.end, signal, roots);
  const tokensPerSecond = averageSpeed(output, latest.elapsedMs);
  return tokensPerSecond === null ? null : { status: "available", tokensPerSecond, outputTokens: output,
    elapsedMs: latest.elapsedMs, completedAt: new Date(latest.end).toISOString() };
}

const empty = (status: SpeedReading["status"]): SpeedReading => ({
  status, tokensPerSecond: null, outputTokens: null, elapsedMs: null, completedAt: null,
});

export function registerSpeed(server: PluginServerContext, signal: AbortSignal,
  readOutput = readTurnOutput, clock = () => ({ wall: Date.now(), monotonic: performance.now() }),
  { readCompleted = readCompletedSpeed, store = createSpeedStore(undefined, signal) } = {}) {
  const turns = new Map<string, { turnId: string | null; start: ReturnType<typeof clock>; reading: SpeedReading }>();
  const latest = new Map<string, { provider: SupportedProvider; sessionId: string; reading: SpeedReading | null }>();
  const completions = new Map<string, number>();
  let disposed = false;
  const release = [
    server.on("agent.turn_started", ({ agent, turnId }) => {
      if (!providerId(agent.provider) || signal.aborted) return;
      turns.set(agent.id, { turnId, start: clock(), reading: empty("running") });
    }),
    server.on("agent.turn_ended", async ({ agent, turnId, outcome }, { paseo }) => {
      const turn = turns.get(agent.id);
      if (signal.aborted) return;
      if (outcome.kind === "completed") completions.set(agent.id, (completions.get(agent.id) ?? 0) + 1);
      if (!turn) { if (outcome.kind === "completed") latest.delete(agent.id); return; }
      if (turn.turnId !== turnId || turn.reading.status !== "running") return;
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
        if (turn.reading.status === "available" && provider && sessionId) {
          latest.set(agent.id, { provider, sessionId, reading: turn.reading });
          await store.save(agent.id, provider, sessionId, turn.reading).catch(() => {});
        }
      } catch {
        // Missing or unreadable session usage must not become a zero-speed reading.
      }
    }),
    server.on("agent.archived", ({ agent }) => { turns.delete(agent.id); }),
  ];
  server.handle(speedRpc, async ({ agentId }, { paseo }) => {
    if (signal.aborted || disposed) return empty("waiting");
    const current = turns.get(agentId)?.reading;
    if (current?.status === "available") return current;
    try {
      const ref = paseo.agents.ref(agentId);
      await ref.refresh();
      const agent = ref.current();
      const provider = agent && providerId(agent.provider);
      const sessionId = agent?.persistence?.sessionId;
      if (provider && sessionId) {
        let saved = latest.get(agentId);
        if (!saved || saved.provider !== provider || saved.sessionId !== sessionId) {
          const version = completions.get(agentId);
          const cached = await store.read(agentId, provider, sessionId);
          const recovered = await readCompleted(provider, sessionId, signal).catch(() => null);
          const reading = recovered && (!cached || Date.parse(recovered.completedAt!) > Date.parse(cached.completedAt!)) ? recovered : cached;
          if (signal.aborted || disposed) return empty("waiting");
          if (completions.get(agentId) !== version) return latest.get(agentId)?.reading ?? cached ?? empty("waiting");
          // A completed lifecycle reading wins over an older recovery still in flight.
          saved = latest.get(agentId);
          if (!saved || saved.provider !== provider || saved.sessionId !== sessionId) {
            saved = { provider, sessionId, reading };
            latest.set(agentId, saved);
            if (reading) await store.save(agentId, provider, sessionId, reading).catch(() => {});
          }
        }
        if (saved.reading) return { ...saved.reading, status: turns.get(agentId)?.reading.status ?? (agent?.status === "running" ? "running" : "available") };
      }
    } catch {
      // Missing usage or timing stays unknown; never substitute a last-request token count.
    }
    return turns.get(agentId)?.reading ?? empty("waiting");
  });
  return () => {
    disposed = true;
    for (const remove of release) remove();
    turns.clear();
    latest.clear();
    completions.clear();
  };
}
