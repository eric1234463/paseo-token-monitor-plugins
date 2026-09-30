import { defineRpc } from "@getpaseo/plugin";
import type { RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

export const claudeUsageRpc = defineRpc({
  name: "usage.claude",
  input: z.object({}),
  output: z.object({
    providerId: z.literal("claude"),
    displayName: z.string(),
    status: z.enum(["available", "unavailable", "error"]),
    planLabel: z.string().nullable(),
    sourceLabel: z.string(),
    fetchedAt: z.string(),
    error: z.string().nullable(),
    windows: z.array(z.object({
      id: z.string(), label: z.string(),
      usedPct: z.number().finite().min(0),
      remainingPct: z.number().finite(),
      resetsAt: z.string().nullable(),
    })),
  }),
});

export type ClaudeUsage = RpcOutput<typeof claudeUsageRpc>;
