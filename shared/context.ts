import { defineRpc } from "@getpaseo/plugin";
import type { RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

export const contextParts = ["user", "assistant", "reasoning", "tools", "tasks", "other"] as const;
export type ContextPart = (typeof contextParts)[number];

export const contextPartLabels: Record<ContextPart, string> = {
  user: "User messages",
  assistant: "Assistant replies",
  reasoning: "Thinking",
  tools: "Tool calls",
  tasks: "Tasks & todos",
  other: "System & other",
};

/** Characters per token heuristic for visible text. Keep in sync with the UI footnote. */
export const CHARS_PER_TOKEN = 4;
/** Per-item text cap so one huge tool output cannot dominate the scan. */
export const MAX_ITEM_CHARS = 20_000;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Math.min(text.length, MAX_ITEM_CHARS) / CHARS_PER_TOKEN));
}

export interface ContextItem {
  type: string;
  text: string;
}

export function contextPartOf(item: Pick<ContextItem, "type">): ContextPart {
  switch (item.type) {
    case "user_message": return "user";
    case "assistant_message": return "assistant";
    case "reasoning": return "reasoning";
    case "tool_call": return "tools";
    case "todo": return "tasks";
    default: return "other";
  }
}

/** Extract the visible text of one timeline item for estimation. Unknown shapes fall back to capped JSON. */
export function contextTextOf(item: Record<string, unknown>): string {
  const type = typeof item.type === "string" ? item.type : "unknown";
  const text = (value: unknown) => typeof value === "string" ? value : "";
  switch (type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return text(item.text);
    case "tool_call": {
      const detail = item.detail && typeof item.detail === "object" ? JSON.stringify(item.detail) : "";
      return `${text(item.name)}\n${detail}`.slice(0, MAX_ITEM_CHARS);
    }
    case "todo":
      return Array.isArray(item.items)
        ? item.items.map((entry) => text((entry as Record<string, unknown>).text)).join("\n")
        : "";
    case "error":
    case "notification":
      return text(item.message);
    case "compaction":
      return `${text(item.trigger)} ${text(item.status)}`;
    default:
      try { return JSON.stringify(item).slice(0, MAX_ITEM_CHARS); }
      catch { return type; }
  }
}

export interface ContextPartTotal {
  part: ContextPart;
  tokens: number;
  items: number;
  sharePct: number | null;
}

export function aggregateContext(items: Iterable<ContextItem>): { parts: ContextPartTotal[]; estimatedTokens: number; itemCount: number } {
  const totals = new Map<ContextPart, { tokens: number; items: number }>();
  let estimatedTokens = 0;
  let itemCount = 0;
  for (const item of items) {
    const part = contextPartOf(item);
    const tokens = estimateTokens(item.text);
    const total = totals.get(part) ?? { tokens: 0, items: 0 };
    total.tokens += tokens;
    total.items += 1;
    totals.set(part, total);
    estimatedTokens += tokens;
    itemCount += 1;
  }
  const parts = contextParts.map((part) => {
    const total = totals.get(part) ?? { tokens: 0, items: 0 };
    return {
      part, tokens: total.tokens, items: total.items,
      sharePct: estimatedTokens > 0 ? Math.round(total.tokens / estimatedTokens * 1000) / 10 : null,
    };
  });
  return { parts, estimatedTokens, itemCount };
}

export function contextPillLabel(usedTokens: number | null, maxTokens: number | null, estimatedTokens: number | null): string {
  if (usedTokens !== null && maxTokens !== null && maxTokens > 0) return `Ctx ${Math.round(usedTokens / maxTokens * 100)}%`;
  if (estimatedTokens !== null) {
    const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(estimatedTokens);
    return `Ctx ~${compact}`;
  }
  return "Context…";
}

export const contextBreakdownRpc = defineRpc({
  name: "context.breakdown",
  input: z.object({ agentId: z.string().min(1).max(200) }),
  output: z.object({
    usedTokens: z.number().int().nonnegative().safe().nullable(),
    maxTokens: z.number().int().positive().safe().nullable(),
    estimatedTokens: z.number().int().nonnegative().safe(),
    itemCount: z.number().int().nonnegative().safe(),
    truncated: z.boolean(),
    parts: z.array(z.object({
      part: z.enum(contextParts),
      tokens: z.number().int().nonnegative().safe(),
      items: z.number().int().nonnegative().safe(),
      sharePct: z.number().finite().nonnegative().max(100).nullable(),
    })),
    fetchedAt: z.string(),
  }),
});
export type ContextBreakdown = RpcOutput<typeof contextBreakdownRpc>;
