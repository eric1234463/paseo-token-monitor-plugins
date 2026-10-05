import { defineRpc } from "@getpaseo/plugin";
import type { RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

export const contextParts = ["user", "assistant", "reasoning", "tools", "mcp", "tasks", "other"] as const;
export type ContextPart = (typeof contextParts)[number];

export const contextPartLabels: Record<ContextPart, string> = {
  user: "User messages",
  assistant: "Assistant replies",
  reasoning: "Thinking",
  tools: "Tool calls",
  mcp: "MCP tools",
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
  /** Tool-call name; used to split MCP invocations out of built-in tool calls. */
  name?: string;
  /** Tool-call argument text (input side). Absent for non-tool items. */
  input?: string;
  /** Tool-call result text (output side). Absent for non-tool items. */
  output?: string;
}

/** MCP invocations surface as tool calls whose name carries the `mcp__server__tool` prefix. */
export function isMcpToolCall(name: string | undefined): boolean {
  return typeof name === "string" && /^mcp(__|_|-|:)/i.test(name.trim());
}

export function contextPartOf(item: Pick<ContextItem, "type" | "name">): ContextPart {
  switch (item.type) {
    case "user_message": return "user";
    case "assistant_message": return "assistant";
    case "reasoning": return "reasoning";
    case "tool_call": return isMcpToolCall(item.name) ? "mcp" : "tools";
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
  /** Input/output split; non-null only for the tools and mcp parts. */
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ContextToolTotal {
  name: string;
  tokens: number;
  calls: number;
  sharePct: number | null;
  inputTokens: number;
  outputTokens: number;
}

/** Split one raw tool_call timeline row into argument (input) vs result (output) text. */
export function contextToolSplit(row: Record<string, unknown>): { input: string; output: string } {
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const num = (value: unknown) => typeof value === "number" ? String(value) : "";
  const json = (value: unknown) => {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return ""; }
  };
  const name = text(row.name);
  const detail = row.detail && typeof row.detail === "object" ? (row.detail as Record<string, unknown>) : {};
  const kind = typeof detail.type === "string" ? detail.type : "";
  const join = (parts: string[]) => parts.filter(Boolean).join("\n").slice(0, MAX_ITEM_CHARS);
  switch (kind) {
    case "shell":
      return { input: join([name, text(detail.command), text(detail.cwd)]), output: join([text(detail.output), num(detail.exitCode)]) };
    case "read":
      return { input: join([name, text(detail.filePath), num(detail.offset), num(detail.limit)]), output: join([text(detail.content)]) };
    case "edit":
      return { input: join([name, text(detail.filePath), text(detail.oldString), text(detail.newString)]), output: join([text(detail.unifiedDiff)]) };
    case "write":
      return { input: join([name, text(detail.filePath), text(detail.content)]), output: "" };
    case "search":
      return {
        input: join([name, text(detail.query), text(detail.toolName), json(detail.filePaths)]),
        output: join([text(detail.content), json(detail.webResults), json(detail.annotations)]),
      };
    case "fetch":
      return { input: join([name, text(detail.url), text(detail.prompt)]), output: join([text(detail.result), num(detail.code), text(detail.codeText)]) };
    case "worktree_setup": {
      const commands = Array.isArray(detail.commands) ? detail.commands : [];
      const cmds = (field: string) => commands.map((entry) => text((entry as Record<string, unknown>)[field])).filter(Boolean).join("\n");
      return { input: join([name, text(detail.worktreePath), text(detail.branchName), cmds("command")]), output: join([text(detail.log), cmds("log")]) };
    }
    case "sub_agent": {
      const actions = Array.isArray(detail.actions)
        ? detail.actions.map((entry) => text((entry as Record<string, unknown>).summary)).filter(Boolean).join("\n") : "";
      return { input: join([name, text(detail.subAgentType), text(detail.description)]), output: join([text(detail.log), actions]) };
    }
    case "plain_text":
      return { input: join([name, text(detail.label)]), output: join([text(detail.text)]) };
    case "plan":
      return { input: name, output: join([text(detail.text)]) };
    case "unknown":
      return { input: join([name, json(detail.input)]), output: join([json(detail.output)]) };
    default:
      return { input: name, output: join([json(row.detail)]) };
  }
}

/** Max per-tool rows returned; bounds the RPC payload on long chats. */
export const MAX_TOP_TOOLS = 10;

export function aggregateContext(items: Iterable<ContextItem>): { parts: ContextPartTotal[]; estimatedTokens: number; itemCount: number; topTools: ContextToolTotal[] } {
  const totals = new Map<ContextPart, { tokens: number; items: number; inputTokens: number; outputTokens: number }>();
  const tools = new Map<string, { tokens: number; calls: number; inputTokens: number; outputTokens: number }>();
  let estimatedTokens = 0;
  let itemCount = 0;
  for (const item of items) {
    const part = contextPartOf(item);
    const tokens = estimateTokens(item.text);
    const total = totals.get(part) ?? { tokens: 0, items: 0, inputTokens: 0, outputTokens: 0 };
    total.tokens += tokens;
    total.items += 1;
    let inputTokens = 0;
    let outputTokens = 0;
    if (item.type === "tool_call") {
      // Items without a pre-split side fall back to the combined text as input.
      inputTokens = item.input !== undefined ? estimateTokens(item.input) : tokens;
      outputTokens = item.output !== undefined ? estimateTokens(item.output) : 0;
      total.inputTokens += inputTokens;
      total.outputTokens += outputTokens;
      const name = item.name?.trim() || "unknown";
      const tool = tools.get(name) ?? { tokens: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
      tool.tokens += tokens;
      tool.calls += 1;
      tool.inputTokens += inputTokens;
      tool.outputTokens += outputTokens;
      tools.set(name, tool);
    }
    totals.set(part, total);
    estimatedTokens += tokens;
    itemCount += 1;
  }
  const parts = contextParts.map((part) => {
    const total = totals.get(part) ?? { tokens: 0, items: 0, inputTokens: 0, outputTokens: 0 };
    const split = part === "tools" || part === "mcp";
    return {
      part, tokens: total.tokens, items: total.items,
      sharePct: estimatedTokens > 0 ? Math.round(total.tokens / estimatedTokens * 1000) / 10 : null,
      inputTokens: split ? total.inputTokens : null,
      outputTokens: split ? total.outputTokens : null,
    };
  });
  const topTools = [...tools.entries()]
    .map(([name, total]) => ({
      name, tokens: total.tokens, calls: total.calls,
      sharePct: estimatedTokens > 0 ? Math.round(total.tokens / estimatedTokens * 1000) / 10 : null,
      inputTokens: total.inputTokens, outputTokens: total.outputTokens,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX_TOP_TOOLS);
  return { parts, estimatedTokens, itemCount, topTools };
}

/**
 * Provider-side content the timeline cannot see (system prompt, tool definitions,
 * native overhead) approximated as reported window use minus visible estimate.
 * Null without authoritative usage; clamped at zero when the estimate overshoots.
 */
export function hiddenOverheadTokens(usedTokens: number | null, estimatedTokens: number): number | null {
  if (usedTokens === null) return null;
  return Math.max(0, usedTokens - estimatedTokens);
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
      inputTokens: z.number().int().nonnegative().safe().nullable(),
      outputTokens: z.number().int().nonnegative().safe().nullable(),
    })),
    topTools: z.array(z.object({
      name: z.string().min(1).max(200),
      tokens: z.number().int().nonnegative().safe(),
      calls: z.number().int().nonnegative().safe(),
      sharePct: z.number().finite().nonnegative().max(100).nullable(),
      inputTokens: z.number().int().nonnegative().safe(),
      outputTokens: z.number().int().nonnegative().safe(),
    })),
    overheadTokens: z.number().int().nonnegative().safe().nullable(),
    fetchedAt: z.string(),
  }),
});
export type ContextBreakdown = RpcOutput<typeof contextBreakdownRpc>;
