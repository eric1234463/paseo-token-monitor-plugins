import type { PaseoAgent } from "@getpaseo/client";
import { cacheRatio, providerId } from "../shared/usage";

export interface CacheState {
  ratio: number | null;
  /** Wall-clock ms of the last agent update that reported usable cache counters. Null without one. */
  updatedAtMs: number | null;
}

export function createCacheStore() {
  let value: CacheState = { ratio: null, updatedAtMs: null };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(agent: Pick<PaseoAgent, "provider" | "lastUsage">, nowMs: number = Date.now()) {
      const ratio = cacheRatio(providerId(agent.provider), agent.lastUsage);
      const updatedAtMs = ratio === null ? null : nowMs;
      if (value.ratio === ratio && value.updatedAtMs === updatedAtMs) return;
      value = { ratio, updatedAtMs };
      for (const listener of listeners) listener();
    },
  };
}

export type CacheStore = ReturnType<typeof createCacheStore>;
