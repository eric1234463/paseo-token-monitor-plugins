import { formatHkt, gatewayReasons, quotaWindows, remaining, used } from "./usage";
import type { Usage } from "./usage";

export function handoffTriggerSummary(usage: Usage | null | undefined): string {
  const reasons = gatewayReasons(usage);
  if (reasons.length === 0) return "Usage is below the gateway threshold.";
  if (!usage || usage.status !== "available") return "Usage is below the gateway threshold.";
  const { fiveHour, weekly } = quotaWindows(usage);
  const parts: string[] = [];
  if (reasons.includes("5-hour")) {
    const value = used(fiveHour);
    parts.push(`5-hour ${value === null ? "unknown" : `${Math.round(value)}% used`} (resets ${formatHkt(fiveHour?.resetsAt)})`);
  }
  if (reasons.includes("Weekly")) {
    const value = used(weekly);
    parts.push(`weekly ${value === null ? "unknown" : `${Math.round(value)}% used`} (resets ${formatHkt(weekly?.resetsAt)})`);
  }
  const leftovers: string[] = [];
  if (!reasons.includes("5-hour")) {
    const left = remaining(fiveHour);
    if (left !== null) leftovers.push(`5-hour ${Math.round(left)}% left`);
  }
  if (!reasons.includes("Weekly")) {
    const left = remaining(weekly);
    if (left !== null) leftovers.push(`weekly ${Math.round(left)}% left`);
  }
  return `${parts.join("; ")}${leftovers.length > 0 ? `. Other window: ${leftovers.join(", ")}` : ""}.`;
}

// Pull-based resume: the new agent reads the previous agent's timeline itself,
// so no handoff doc needs to be generated before the old agent stops.
export function buildResumePrompt(previousAgentId: string): string {
  return `Use \`paseo logs ${previousAgentId}\` to read the previous agent's timeline. Identify the original goal, completed work, decisions, and remaining tasks. Inspect its repository, worktree, branch, and uncommitted changes, then continue the unfinished work. Verify the actual file state and test results before relying on claims in the timeline.`;
}
