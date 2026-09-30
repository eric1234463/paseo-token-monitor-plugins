import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Usage } from "../shared/usage";
import type { ClaudeUsage } from "../shared/claude";

const run = promisify(execFile);
const credentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1), expiresAt: z.number().optional() }).optional(),
});
const windowSchema = z.object({ utilization: z.number().finite().min(0), resets_at: z.string().nullable().optional() });
const responseSchema = z.object({
  five_hour: windowSchema.nullish(), seven_day: windowSchema.nullish(),
  seven_day_opus: windowSchema.nullish(), seven_day_sonnet: windowSchema.nullish(),
});

function report(status: Usage["status"], error: string | null = null): ClaudeUsage {
  return {
    providerId: "claude", displayName: "Claude", status, planLabel: null,
    sourceLabel: "Claude Code login on this host", fetchedAt: new Date().toISOString(),
    windows: [], error,
  };
}

export function parseClaudeUsage(value: unknown): ClaudeUsage {
  const data = responseSchema.parse(value);
  const result = report("available");
  for (const [key, id, label] of [
    ["five_hour", "session", "5-hour"], ["seven_day", "weekly", "Weekly"],
    ["seven_day_opus", "weekly_opus", "Weekly · Opus"],
    ["seven_day_sonnet", "weekly_sonnet", "Weekly · Sonnet"],
  ] as const) {
    const window = data[key];
    if (!window) continue;
    result.windows.push({
      id, label, usedPct: window.utilization,
      remainingPct: Math.max(0, 100 - window.utilization),
      resetsAt: window.resets_at && Number.isFinite(Date.parse(window.resets_at)) ? window.resets_at : null,
    });
  }
  return result;
}

export async function fetchClaudeUsage(token: string, fetchApi: typeof fetch = fetch, signal?: AbortSignal): Promise<ClaudeUsage> {
  const request = new AbortController();
  const abort = () => request.abort();
  signal?.addEventListener("abort", abort);
  if (signal?.aborted) request.abort();
  const timeout = setTimeout(abort, 15_000);
  try {
    const response = await fetchApi("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" },
      signal: request.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return report("unavailable", "Claude sign-in needs refreshing. Open Claude Code and run /login, then refresh here.");
    }
    if (!response.ok) return report("error", response.status === 429 ? "Claude usage is rate limited. Try again later." : "Claude usage could not be loaded.");
    return parseClaudeUsage(await response.json());
  } catch {
    return report("error", "Claude usage could not be loaded. Try again later.");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function readCredentials(signal: AbortSignal) {
  let credentials: z.infer<typeof credentialsSchema>["claudeAiOauth"];
  try {
    const directory = process.env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
    credentials = credentialsSchema.parse(JSON.parse(await readFile(join(directory, ".credentials.json"), "utf8"))).claudeAiOauth;
    if (credentials && (!credentials.expiresAt || credentials.expiresAt > Date.now())) return credentials;
  } catch { /* Missing file: Claude Code uses Keychain on macOS. */ }
  if (process.platform === "darwin") {
    const user = process.env.USER || userInfo().username;
    const account = /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user";
    for (const args of [
      ["find-generic-password", "-a", account, "-s", "Claude Code-credentials", "-w"],
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    ]) {
      try {
        const { stdout } = await run("/usr/bin/security", args, { timeout: 5_000, maxBuffer: 64 * 1024, signal });
        const oauth = credentialsSchema.parse(JSON.parse(stdout)).claudeAiOauth;
        if (oauth) return oauth;
      } catch { /* No matching Claude Code credential. Never log credential output. */ }
    }
  }
  return credentials;
}

export function createClaudeReader(signal: AbortSignal) {
  let cached: { until: number; value: Promise<ClaudeUsage> } | undefined;
  return () => {
    if (cached && cached.until > Date.now()) return cached.value;
    const value = (async () => {
      const credentials = await readCredentials(signal);
      if (!credentials) return report("unavailable", "Sign in to Claude Code on this host to load subscription usage.");
      if (credentials.expiresAt && credentials.expiresAt <= Date.now()) {
        return report("unavailable", "Claude sign-in has expired. Open Claude Code and run /login, then refresh here.");
      }
      return fetchClaudeUsage(credentials.accessToken, fetch, signal);
    })();
    cached = { until: Date.now() + 60_000, value };
    return value;
  };
}
