import { defineRpc } from "@getpaseo/plugin";
import type { RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

export type Period = "daily" | "weekly" | "monthly";
const DAY = 86_400_000;
const HKT = 8 * 3_600_000;
export function validDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time)
    && new Date(time).toISOString().slice(0, 10) === value;
}
export function hktDate(time: number): string {
  return new Date(time + HKT).toISOString().slice(0, 10);
}
export function dateBounds(from: string, to: string) {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error("Use valid dates with From on or before To.");
  return { start: Date.parse(`${from}T00:00:00+08:00`), end: Date.parse(`${to}T00:00:00+08:00`) + DAY };
}
export function periodRange(period: Period, anchor = hktDate(Date.now()), offset = 0) {
  if (!validDate(anchor)) throw new Error("Invalid date.");
  const date = new Date(`${anchor}T00:00:00Z`);
  let start: number;
  let end: number;
  if (period === "monthly") {
    start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1);
    end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset + 1, 1);
  } else {
    const days = period === "weekly" ? 7 : 1;
    start = date.getTime() - (period === "weekly" ? (date.getUTCDay() + 6) % 7 * DAY : 0) + offset * days * DAY;
    end = start + days * DAY;
  }
  return { from: new Date(start).toISOString().slice(0, 10), to: new Date(end - DAY).toISOString().slice(0, 10) };
}

const count = z.number().int().nonnegative().safe().nullable();
export const tokenTotalsSchema = z.object({ input: count, cacheInput: count, totalInput: count, output: count });
export type TokenTotals = z.infer<typeof tokenTotalsSchema>;
export const historyRpc = defineRpc({
  name: "usage.history",
  input: z.object({ from: z.string().refine(validDate), to: z.string().refine(validDate) })
    .refine(({ from, to }) => from <= to, { message: "From must be on or before To." }),
  output: z.object({
    rows: z.array(tokenTotalsSchema.extend({ provider: z.enum(["claude", "codex", "grok"]), model: z.string() })),
    sources: z.array(z.object({
      provider: z.enum(["claude", "codex", "grok"]),
      status: z.enum(["available", "missing", "partial", "error"]),
      files: z.number().int().nonnegative(), message: z.string(),
    })),
    fetchedAt: z.string(),
  }),
});
export type HistoryReport = RpcOutput<typeof historyRpc>;
