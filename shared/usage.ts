import type { PaseoAgent, PaseoProviderUsageResult } from "@getpaseo/client";

export type Usage = PaseoProviderUsageResult["providers"][number];
export type UsageWindow = Usage["windows"][number];
export type SupportedProvider = "codex" | "claude" | "grok";

export function providerId(selection: string): SupportedProvider | null {
  const id = selection.split("/")[0];
  return id === "codex" || id === "claude" || id === "grok" ? id : null;
}

export function quotaWindows(usage: Usage | null | undefined) {
  return {
    fiveHour: usage?.windows.find(({ id }) => id === "session" || id === "five_hour") ?? null,
    weekly: usage?.windows.find(({ id }) => id === "weekly" || id === "seven_day") ?? null,
  };
}

export function remaining(window: UsageWindow | null): number | null {
  if (!window) return null;
  const value = typeof window.remainingPct === "number" && Number.isFinite(window.remainingPct)
    ? window.remainingPct
    : typeof window.usedPct === "number" && Number.isFinite(window.usedPct)
      ? 100 - window.usedPct
      : null;
  return value === null ? null : Math.max(0, Math.min(100, value));
}

export function cacheRatio(provider: SupportedProvider | null, usage: PaseoAgent["lastUsage"]): number | null {
  if (provider !== "codex" && provider !== "claude") return null;
  const input = usage?.inputTokens;
  const cached = usage?.cachedInputTokens;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0
    || typeof cached !== "number" || !Number.isFinite(cached) || cached < 0) return null;
  // Claude reports fresh input separately; cache-write tokens are not exposed by Paseo.
  const total = provider === "claude" ? input + cached : input;
  if (!Number.isFinite(total) || total <= 0 || cached > total) return null;
  return cached / total * 100;
}

export function pillLabel(usage: Usage | null | undefined): string {
  if (!usage || usage.status !== "available") return "5h — · W —";
  const { fiveHour, weekly } = quotaWindows(usage);
  const percentage = (window: UsageWindow | null) => {
    const value = remaining(window);
    return value === null ? "—" : `${Math.round(value)}%`;
  };
  return `5h ${percentage(fiveHour)} · W ${percentage(weekly)}`;
}

export function tokenPillLabel(cache: number | null, speed: number | null): string {
  const rate = speed === null ? "—" : new Intl.NumberFormat("en-US", {
    notation: "compact", maximumFractionDigits: speed < 100 ? 1 : 0,
  }).format(speed);
  return `C${cache === null ? "—" : `${Math.round(cache)}%`} ${rate}tok/s`;
}

export function formatHkt(timestamp: string | null | undefined): string {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "Not provided";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const part = (type: string) => parts.find((value) => value.type === type)?.value;
  return `${part("day")} ${part("month")}, ${part("hour")}:${part("minute")} HKT`;
}

// SHORTCUT: fixed 5-min idle TTL; per-model/extended-cache TTLs if providers expose them.
export const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

export function cacheRemainingMs(updatedAtMs: number | null | undefined, nowMs: number, ttlMs = PROMPT_CACHE_TTL_MS): number | null {
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return null;
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;
  return updatedAtMs + ttlMs - nowMs;
}

export function formatCountdown(remainingMs: number): string {
  const clamped = Math.max(0, Math.floor(remainingMs / 1000));
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, "0")}`;
}
