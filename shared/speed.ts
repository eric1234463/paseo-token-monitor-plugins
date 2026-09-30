import { defineRpc } from "@getpaseo/plugin";
import type { RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

export function averageSpeed(output: number | null, elapsedMs: number): number | null {
  if (output === null || !Number.isSafeInteger(output) || output < 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  const speed = output / elapsedMs * 1000;
  return Number.isFinite(speed) ? speed : null;
}

export function speedLabel(speed: number | null): string {
  return speed === null ? "Avg — tok/s" : `Avg ${speed.toFixed(1)} tok/s`;
}

export const speedRpc = defineRpc({
  name: "usage.speed",
  input: z.object({ agentId: z.string().min(1).max(200) }),
  output: z.object({
    status: z.enum(["waiting", "running", "available", "unavailable"]),
    tokensPerSecond: z.number().finite().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().safe().nullable(),
    elapsedMs: z.number().finite().positive().nullable(),
    completedAt: z.string().nullable(),
  }),
});
export type SpeedReading = RpcOutput<typeof speedRpc>;
