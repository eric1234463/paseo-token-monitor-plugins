import { formatHkt, gatewayReasons, quotaWindows, remaining, used } from "./usage";
import type { Usage } from "./usage";

export const HANDOFF_FILENAME = "HANDOFF.md";

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

export function buildHandoffPrompt(usage: Usage | null | undefined): string {
  const trigger = handoffTriggerSummary(usage);
  return [
    `Usage gateway tripped: ${trigger}`,
    `STOP starting new work. Write a handoff doc so another agent can take over this task with zero re-discovery.`,
    ``,
    `Save it to ${HANDOFF_FILENAME} in the workspace root, then output the full doc in chat.`,
    ``,
    `Include these sections:`,
    `1. Goal — what the task is and what "done" means.`,
    `2. Current state — where things stand right now.`,
    `3. Done — completed steps with file paths and key decisions.`,
    `4. Remaining — next steps in order, with exact commands/files where known.`,
    `5. Key files — paths touched or to read first.`,
    `6. Blockers / risks — anything uncertain, failing, or time-sensitive.`,
    `7. How to resume — the first 3 actions the next agent should take.`,
    `8. Verification — how to confirm the work (tests, commands, expected output).`,
    ``,
    `Keep it factual and specific. Reference real file paths, branch names, and test commands, not guesses.`,
  ].join("\n");
}
