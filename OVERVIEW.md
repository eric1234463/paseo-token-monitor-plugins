Shows Codex, Claude, and Grok account usage and local token history inside Paseo. Composer pills show the remaining five-hour and weekly allowance with reset times, plus last-turn throughput and prompt cache state. A Token usage sidebar page shows the same account overview with per model history and a daily chart.

Visible pills share one usage query per host and refresh every 60 seconds. History is computed from retained CLI logs on the selected daemon, so it reflects local logs rather than a billing report.

## Setup

Requires Paseo daemon and client 0.10.0 or later with plugins enabled. It reports the account configured on the daemon it runs on, including usage from other chats.

Codex and Grok read the connected host usage API. Claude uses the same API when available, and otherwise the daemon queries the Claude Code OAuth usage endpoint with the existing local sign-in. If Claude sign-in has expired, sign in again with Claude Code on the daemon machine and refresh after one minute. Custom log locations are honored through CODEX_HOME, CLAUDE_CONFIG_DIR or CLAUDE_HOME, and GROK_HOME.

## Usage display

The limits pill shows remaining five-hour and weekly allowance, with reset times in HKT (UTC+8). It switches to a STOP state when the five-hour window reaches 90 percent used or the weekly window reaches 95 percent used, and the popover names the triggering window with remaining allowance and reset time. Refresh rechecks the host, and failed refreshes mark retained readings as stale.

The popover includes a copy resume prompt button that copies a pull-based handoff prompt for the current agent. A workspace header button offers the same prompt when starting a new agent, with optional provider and model switching. The new agent reads the previous timeline and verifies file state before continuing.

The tokens pill shows average throughput for the last completed turn, measured as reported output tokens divided by full elapsed time including tool runs and waits. The popover shows output count, elapsed seconds, and completion time in HKT (UTC+8). Running, failed, or missing turns keep the previous completed reading.

The cache pill shows the cache ratio from the latest reported usage in the current chat with a countdown to expiry. Expiry assumes a five minute idle TTL and is a freshness hint rather than a billing signal. Claude and Codex report cache reads; Grok cache ratio is unavailable.

## Token history

The sidebar starts with a Codex and Claude account overview that shares the pills query and refresh. Provider tabs for Codex, Claude, and Grok show model totals grouped by provider and model, with input, cache input, total input, and output. Input excludes cache reads; total input is input plus cache reads.

The date range is shared across tabs and defaults to the last 7 days in HKT (UTC+8), with daily, monthly, and custom From and To range options. The 7-day and monthly views include a daily stacked bar chart of input, cache input, and output for the selected provider. Each day total is total input plus output.

## Data access and limits

The plugin reads usage APIs, local session logs, and saved speed readings under the daemon cache directory. Claude fallback reads the local credentials file or the macOS Keychain entry only to call the usage endpoint. Credentials stay in server memory and are never included in RPC results, client bundles, files, or logs. Only model names and token aggregates reach the client. Nothing is written to the source logs.

Account windows cover the whole configured account rather than the current conversation. Separate accounts selected through custom provider environments are not detected. API key billing and rate limits are separate from subscription windows.

History excludes deleted logs, other devices, custom provider homes, and unrecorded usage. Missing counters display as not provided rather than zero. Claude cache ratio excludes cache writes because that counter is not exposed. File failures appear as incomplete coverage. The pills cannot intercept sends or stop a running turn.
