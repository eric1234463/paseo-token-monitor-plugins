import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { dateBounds, hktDate } from "../shared/history";
import type { HistoryReport, TokenTotals } from "../shared/history";
import type { SupportedProvider } from "../shared/usage";

export type UsageRecord = TokenTotals & { id: string; provider: SupportedProvider; model: string; timestamp: number };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const plus = (a: number | null, b: number | null) => a === null || b === null ? null : count(a + b);
const minus = (a: number | null, b: number | null) => a === null || b === null ? null : count(a - b);
const modelName = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200 ? value : "Unknown model";
const timestamp = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;

function record(provider: SupportedProvider, model: unknown, time: unknown, totals: TokenTotals, id?: string): UsageRecord | null {
  const at = timestamp(time);
  if (!Number.isFinite(at) || Object.values(totals).every((value) => value === null || value === 0)) return null;
  const name = modelName(model);
  // SHORTCUT: fingerprint dedup for providers without request IDs; use request IDs when exposed.
  return { provider, model: name, timestamp: at, ...totals, id: id ?? `${provider}:${name}:${at}:${Object.values(totals).join(":")}` };
}

export function claudeRecord(value: unknown): UsageRecord | null {
  const row = object(value);
  const message = object(row.message);
  if (row.type !== "assistant" || message.model === "<synthetic>" || !message.usage) return null;
  const usage = object(message.usage);
  const input = plus(count(usage.input_tokens), count(usage.cache_creation_input_tokens));
  const cacheInput = count(usage.cache_read_input_tokens);
  return record("claude", message.model, row.timestamp, {
    input, cacheInput, totalInput: plus(input, cacheInput), output: count(usage.output_tokens),
  }, typeof message.id === "string" ? `claude:${message.id}` : undefined);
}

export function codexParser() {
  let model: unknown;
  let previous: { input: number | null; cached: number | null; output: number | null } | undefined;
  return (value: unknown): UsageRecord | null => {
    const row = object(value);
    const payload = object(row.payload);
    if (row.type === "turn_context") model = payload.model;
    if (row.type !== "event_msg" || payload.type !== "token_count") return null;
    const info = object(payload.info);
    if (!info.total_token_usage) return null;
    const total = object(info.total_token_usage);
    const current = { input: count(total.input_tokens), cached: count(total.cached_input_tokens), output: count(total.output_tokens) };
    if (previous && current.input === previous.input && current.cached === previous.cached && current.output === previous.output) return null;
    const last = object(info.last_token_usage);
    const reset = !previous || (current.input !== null && previous.input !== null && current.input < previous.input)
      || (current.cached !== null && previous.cached !== null && current.cached < previous.cached)
      || (current.output !== null && previous.output !== null && current.output < previous.output);
    const totalInput = reset ? count(last.input_tokens) : minus(current.input, previous!.input);
    const cacheInput = reset ? count(last.cached_input_tokens) : minus(current.cached, previous!.cached);
    const output = reset ? count(last.output_tokens) : minus(current.output, previous!.output);
    previous = current;
    return record("codex", model, row.timestamp, { input: minus(totalInput, cacheInput), cacheInput, totalInput, output });
  };
}

export function grokRecords(value: unknown): UsageRecord[] {
  const turns = object(value).turns;
  if (!Array.isArray(turns)) throw new Error("Invalid Grok usage file.");
  const records: UsageRecord[] = [];
  for (const value of turns) {
    const turn = object(value);
    for (const [model, value] of Object.entries(object(turn.modelUsage))) {
      const usage = object(value);
      const totalInput = count(usage.inputTokens);
      const cacheInput = count(usage.cachedReadTokens);
      const reading = record("grok", model, turn.endedAt, {
        input: minus(totalInput, cacheInput), cacheInput, totalInput, output: count(usage.outputTokens),
      });
      if (reading) records.push(reading);
    }
  }
  return records;
}

function uniqueRecords(records: Iterable<UsageRecord>) {
  const unique = new Map<string, UsageRecord>();
  for (const row of records) {
    const old = unique.get(row.id);
    if (!old || (row.output ?? -1) > (old.output ?? -1)) unique.set(row.id, row);
  }
  return unique.values();
}

export function aggregateHistory(records: Iterable<UsageRecord>, from: string, to: string): HistoryReport["rows"] {
  const { start, end } = dateBounds(from, to);
  const totals = new Map<string, HistoryReport["rows"][number]>();
  for (const row of uniqueRecords(records)) {
    if (row.timestamp < start || row.timestamp >= end) continue;
    const key = `${row.provider}:${row.model}`;
    const total = totals.get(key);
    if (!total) totals.set(key, { provider: row.provider, model: row.model, input: row.input, cacheInput: row.cacheInput, totalInput: row.totalInput, output: row.output });
    else for (const field of ["input", "cacheInput", "totalInput", "output"] as const) total[field] = plus(total[field], row[field]);
  }
  return [...totals.values()].sort((a, b) => a.provider.localeCompare(b.provider) || (b.totalInput ?? -1) - (a.totalInput ?? -1) || a.model.localeCompare(b.model));
}

export function aggregateDailyHistory(records: Iterable<UsageRecord>, from: string, to: string): HistoryReport["days"] {
  const { start, end } = dateBounds(from, to);
  const totals = new Map<string, HistoryReport["days"][number]>();
  for (const row of uniqueRecords(records)) {
    if (row.timestamp < start || row.timestamp >= end) continue;
    const date = hktDate(row.timestamp);
    const key = `${row.provider}:${date}`;
    const total = totals.get(key);
    if (!total) totals.set(key, { provider: row.provider, date,
      input: row.input, cacheInput: row.cacheInput, totalInput: row.totalInput, output: row.output,
      totalTokens: plus(row.totalInput, row.output),
    });
    else {
      for (const field of ["input", "cacheInput", "totalInput", "output"] as const) total[field] = plus(total[field], row[field]);
      total.totalTokens = plus(total.totalInput, total.output);
    }
  }
  return [...totals.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.date.localeCompare(b.date));
}

export async function* files(directory: string, provider: SupportedProvider): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const item of entries) {
    const path = join(directory, item.name);
    if (item.isDirectory()) yield* files(path, provider);
    else if (item.isFile() && (provider === "grok" ? item.name === "usage.json" : item.name.endsWith(".jsonl"))) yield path;
  }
}

export async function readRecords(path: string, provider: SupportedProvider, signal: AbortSignal): Promise<UsageRecord[]> {
  if (provider === "grok") return grokRecords(JSON.parse(await readFile(path, { encoding: "utf8", signal })));
  const stream = createReadStream(path, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const parse = provider === "codex" ? codexParser() : claudeRecord;
  const records: UsageRecord[] = [];
  try {
    for await (const line of lines) {
      if (!(provider === "codex" ? /"(turn_context|token_count)"/.test(line) : /"assistant"/.test(line))) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; } // An active JSONL file can end with an unfinished line.
      const row = parse(value);
      if (row) records.push(row);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return records;
}

export function createHistoryReader(signal: AbortSignal, roots: Record<SupportedProvider, string> & { codexArchive?: string } = {
  codex: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
  codexArchive: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "archived_sessions"),
  claude: join(process.env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_HOME ?? join(homedir(), ".claude"), "projects"),
  grok: join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "sessions"),
}) {
  const checkAborted = () => { if (signal.aborted) throw new Error("History scan cancelled."); };
  // SHORTCUT: cache whole files by mtime/size; incremental byte offsets if large sessions make refresh slow.
  const cache = new Map<string, { mtime: number; size: number; records: UsageRecord[] }>();
  let scan: Promise<{ records: UsageRecord[]; sources: HistoryReport["sources"] }> | undefined;
  const load = async () => {
    const records: UsageRecord[] = [];
    const sources: HistoryReport["sources"] = [];
    const retained = new Set<string>();
    for (const provider of ["claude", "codex", "grok"] as const) {
      let found = 0;
      let failed = 0;
      let available = 0;
      let missing = false;
      try {
        const directories = provider === "codex" && roots.codexArchive ? [roots.codex, roots.codexArchive] : [roots[provider]];
        for (const directory of directories) for await (const path of files(directory, provider)) {
          checkAborted();
          found++;
          retained.add(path);
          try {
            const info = await stat(path);
            let entry = cache.get(path);
            if (!entry || entry.mtime !== info.mtimeMs || entry.size !== info.size) {
              entry = { mtime: info.mtimeMs, size: info.size, records: await readRecords(path, provider, signal) };
              cache.set(path, entry);
            }
            available += entry.records.length;
            for (const record of entry.records) records.push(record);
          } catch {
            checkAborted();
            cache.delete(path);
            failed++;
          }
        }
      } catch (error) {
        checkAborted();
        missing = (error as NodeJS.ErrnoException).code === "ENOENT" && found === 0;
        if (!missing) failed++;
      }
      sources.push({ provider, files: found,
        status: missing ? "missing" : failed ? (available ? "partial" : "error") : available ? "available" : "missing",
        message: failed ? `${failed} history files could not be read; totals may be incomplete.`
          : !available ? "No readable token usage history found on this host."
          : provider === "grok" ? "Saved completed turns only; older sessions may not have usage.json."
          : "Retained local session logs, including CLI sessions outside Paseo.",
      });
    }
    for (const path of cache.keys()) if (!retained.has(path)) cache.delete(path);
    return { records, sources };
  };
  return async ({ from, to }: { from: string; to: string }): Promise<HistoryReport> => {
    dateBounds(from, to);
    scan ??= load().finally(() => { scan = undefined; });
    const { records, sources } = await scan;
    return { rows: aggregateHistory(records, from, to), days: aggregateDailyHistory(records, from, to), sources, fetchedAt: new Date().toISOString() };
  };
}
