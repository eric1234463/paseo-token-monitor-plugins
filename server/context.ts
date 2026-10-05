import type { PaseoApi } from "@getpaseo/client";
import { aggregateContext, contextTextOf } from "../shared/context";
import type { ContextBreakdown, ContextItem } from "../shared/context";

const PAGE_LIMIT = 200;
// SHORTCUT: cap full-history scan at 5 pages (1000 items); raise or cursor-cache if long chats truncate often.
const MAX_PAGES = 5;

const safeCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function createContextReader(signal: AbortSignal) {
  return async ({ agentId }: { agentId: string }, { paseo }: { paseo: PaseoApi }): Promise<ContextBreakdown> => {
    const ref = paseo.agents.ref(agentId);
    await ref.refresh();
    if (signal.aborted) throw new Error("Context breakdown cancelled.");
    const usage = ref.current()?.lastUsage ?? null;
    const usedTokens = safeCount(usage?.contextWindowUsedTokens);
    const maxRaw = safeCount(usage?.contextWindowMaxTokens);
    const maxTokens = maxRaw !== null && maxRaw > 0 ? maxRaw : null;

    const items: ContextItem[] = [];
    let truncated = false;
    // First page reads the tail; older pages walk back through the start cursor.
    let page = await ref.timeline.refetch({ direction: "tail", limit: PAGE_LIMIT, projection: "canonical" });
    for (let seen = 0; seen < MAX_PAGES; seen++) {
      if (signal.aborted) throw new Error("Context breakdown cancelled.");
      for (const entry of page.entries ?? []) {
        const row = (entry as { item?: Record<string, unknown> }).item;
        if (!row || typeof row !== "object") continue;
        const type = typeof row.type === "string" ? row.type : "unknown";
        items.push({ type, text: contextTextOf(row) });
      }
      if (!page.hasOlder || !page.startCursor) break;
      if (seen === MAX_PAGES - 1) { truncated = true; break; }
      page = await ref.timeline.refetch({ direction: "before", cursor: page.startCursor, limit: PAGE_LIMIT, projection: "canonical" });
    }

    const { parts, estimatedTokens, itemCount } = aggregateContext(items);
    return { usedTokens, maxTokens, estimatedTokens, itemCount, truncated, parts, fetchedAt: new Date().toISOString() };
  };
}


