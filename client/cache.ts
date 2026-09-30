import type { PaseoAgent } from "@getpaseo/client";
import { cacheRatio, providerId } from "../shared/usage";

export function createCacheStore() {
  let value: number | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(agent: Pick<PaseoAgent, "provider" | "lastUsage">) {
      const next = cacheRatio(providerId(agent.provider), agent.lastUsage);
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

export type CacheStore = ReturnType<typeof createCacheStore>;
