import type { PaseoApi } from "@getpaseo/client";
import { aggregateContext, aggregateSkills, contextTextOf, contextToolSplit, hiddenOverheadTokens } from "../shared/context";
import type { ContextBreakdown, ContextItem, ContextSkillTotal } from "../shared/context";

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
        const name = typeof row.name === "string" ? row.name : undefined;
        if (type === "tool_call") {
          const split = contextToolSplit(row);
          items.push({ type, text: contextTextOf(row), name, input: split.input, output: split.output });
        } else {
          items.push({ type, text: contextTextOf(row) });
        }
      }
      if (!page.hasOlder || !page.startCursor) break;
      if (seen === MAX_PAGES - 1) { truncated = true; break; }
      page = await ref.timeline.refetch({ direction: "before", cursor: page.startCursor, limit: PAGE_LIMIT, projection: "canonical" });
    }

    const { parts, estimatedTokens, itemCount, topTools } = aggregateContext(items);
    const overheadTokens = usedTokens !== null && maxTokens !== null
      ? hiddenOverheadTokens(usedTokens, estimatedTokens)
      : null;

    // Skills actually loaded in the live session (names + descriptions only).
    // Providers that cannot answer report it in `error` rather than rejecting.
    let skills: ContextSkillTotal[] = [];
    let skillTokens = 0;
    let skillsAvailable = false;
    try {
      const listed = await ref.commands();
      if (signal.aborted) throw new Error("Context breakdown cancelled.");
      if (!listed?.error && Array.isArray(listed?.commands)) {
        const entries = listed.commands.filter((entry) => entry?.kind === "skill");
        const toolNames = items.filter((item) => item.type === "tool_call" && item.name).map((item) => item.name as string);
        const userTexts = items.filter((item) => item.type === "user_message").map((item) => item.text);
        ({ skills, skillTokens } = aggregateSkills(entries, { toolNames, userTexts }));
        skillsAvailable = true;
      }
    } catch {
      skillsAvailable = false;
    }
    return { usedTokens, maxTokens, estimatedTokens, itemCount, truncated, parts, topTools, overheadTokens, skills, skillTokens, skillsAvailable, fetchedAt: new Date().toISOString() };
  };
}


