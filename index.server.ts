import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createClaudeReader } from "./server/claude";
import { claudeUsageRpc } from "./shared/claude";
import { createHistoryReader } from "./server/history";
import { historyRpc } from "./shared/history";
import { createContextReader } from "./server/context";
import { contextBreakdownRpc } from "./shared/context";
import { registerSpeed } from "./server/speed";

export default function contribute(server: PluginServerContext) {
  const lifetime = new AbortController();
  const readClaude = createClaudeReader(lifetime.signal);
  server.handle(claudeUsageRpc, readClaude);
  server.handle(historyRpc, createHistoryReader(lifetime.signal));
  server.handle(contextBreakdownRpc, createContextReader(lifetime.signal));
  const releaseSpeed = registerSpeed(server, lifetime.signal);
  return () => { lifetime.abort(); releaseSpeed(); };
}
