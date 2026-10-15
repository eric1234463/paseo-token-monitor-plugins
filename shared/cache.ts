import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ONE_HOUR_CACHE_TTL_MS = 60 * 60 * 1000;
export const FIVE_MINUTE_CACHE_TTL_MS = 5 * 60 * 1000;

/** TTL of the tier a Claude `usage.cache_creation` block wrote to; null when it wrote nothing. */
export function claudeCacheWriteTtlMs(creation: unknown): number | null {
  if (!creation || typeof creation !== "object") return null;
  const tokens = (key: string) => {
    const value = (creation as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  if (tokens("ephemeral_1h_input_tokens") > 0) return ONE_HOUR_CACHE_TTL_MS;
  if (tokens("ephemeral_5m_input_tokens") > 0) return FIVE_MINUTE_CACHE_TTL_MS;
  return null;
}

export const cacheTtlRpc = defineRpc({
  name: "usage.cache-ttl",
  input: z.object({ agentId: z.string().min(1).max(200) }),
  output: z.object({ ttlMs: z.number().int().positive().nullable() }),
});
