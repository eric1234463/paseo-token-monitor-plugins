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

export function used(window: UsageWindow | null): number | null {
  const left = remaining(window);
  return left === null ? null : 100 - left;
}

// SHORTCUT: fixed 90%/95% gateway; per-provider thresholds if usage patterns diverge.
export const GATEWAY_FIVE_HOUR_USED_PCT = 90;
export const GATEWAY_WEEKLY_USED_PCT = 95;
// Back-compat alias for the 5-hour threshold.
export const GATEWAY_USED_PCT = GATEWAY_FIVE_HOUR_USED_PCT;

export function gatewayReasons(usage: Usage | null | undefined): string[] {
  if (!usage || usage.status !== "available") return [];
  const { fiveHour, weekly } = quotaWindows(usage);
  const reasons: string[] = [];
  const fiveHourUsed = used(fiveHour);
  if (fiveHourUsed !== null && fiveHourUsed >= GATEWAY_FIVE_HOUR_USED_PCT) reasons.push("5-hour");
  const weeklyUsed = used(weekly);
  if (weeklyUsed !== null && weeklyUsed >= GATEWAY_WEEKLY_USED_PCT) reasons.push("Weekly");
  return reasons;
}

export function isGatewayTripped(usage: Usage | null | undefined): boolean {
  return gatewayReasons(usage).length > 0;
}

export function gatewayPillLabel(usage: Usage | null | undefined): string {
  const base = pillLabel(usage);
  return isGatewayTripped(usage) ? `STOP ${base}` : base;
}

// Hardcoded red for the gateway icon: pill icons don't receive the host theme,
// so this keeps the STOP state visible in light and dark themes alike.
export const GATEWAY_ALERT_COLOR = "#ef4444";

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

export function tokenPillLabel(speed: number | null): string {
  const rate = speed === null ? "—" : new Intl.NumberFormat("en-US", {
    notation: "compact", maximumFractionDigits: speed < 100 ? 1 : 0,
  }).format(speed);
  return `${rate}tok/s`;
}

export function cachePillLabel(remainingMs: number | null): string {
  return `Cache ${remainingMs === null ? "—" : remainingMs <= 0 ? "Expired" : formatCountdown(remainingMs)}`;
}

const HKT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatHkt(timestamp: string | null | undefined): string {
  if (!timestamp) return "Not provided";
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return "Not provided";
  // HKT is UTC+8 with no DST. Shift to UTC and read UTC parts so the result
  // never depends on host Intl behavior (some engines omit hour/minute parts).
  const hkt = new Date(ms + 8 * 3600 * 1000);
  const day = String(hkt.getUTCDate()).padStart(2, "0");
  const month = HKT_MONTHS[hkt.getUTCMonth()];
  const hour = String(hkt.getUTCHours()).padStart(2, "0");
  const minute = String(hkt.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month}, ${hour}:${minute} HKT`;
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
