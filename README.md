# Paseo Token Monitor

Shows account usage in the chat composer for Codex, Claude, and Grok.
The pill displays the remaining five-hour and weekly allowance. Click it for
usage bars, additional provider windows, and reset times in HKT (UTC+8).
Missing windows display `Not provided`; they never imply zero usage or unlimited access.

The pill also shows `Cache N%` from this chat's latest reported token usage,
updated through Paseo's agent subscription. This is separate from account limits
and is not a cumulative chat average. Codex uses cached input / total input tokens
(latest model request). Claude uses cache reads / (fresh input + cache reads)
(latest reported turn); Paseo does not expose Claude's cache-write count, so these
tokens are excluded. Grok's token normalization is not defined by the installed
SDK, so its cache ratio is unavailable. Missing, zero-total, or invalid counters
show `Cache —`, while a reported zero cache-read count shows `Cache 0%`.

The pill shows **Avg N tok/s** for a completed turn observed since the plugin
started. It divides all reported output tokens in that turn by the full elapsed
time, including tool execution, permission waits, and provider latency. This is
turn throughput, not pure model generation speed. The popover shows the output
count, elapsed seconds, and completion time in HKT. A new turn clears the previous
reading; running, failed, canceled, missing-data, and unobserved turns show
`Avg — tok/s`. Reloading the plugin clears readings; complete a new turn to measure.

The daemon observes turn lifecycle events and reads only the matching local
provider session's usage records, reusing the history counter normalization and
deduplication. This includes every Codex request in the turn rather than just
Paseo's last-request usage. Counts include provider-reported reasoning output
when already included, and exclude input/cache tokens. Readings stay in memory;
visible pills refresh them every five seconds without calling a provider API.

## Token history sidebar

Open **Token usage** in the sidebar and select the Codex, Claude, or Grok tab.
Only the selected provider's model totals and coverage are shown; the date range
is shared across tabs. Daily, Weekly, and Monthly select calendar
periods in HKT; weeks start Monday. Use Previous/Next period to browse history,
or enter inclusive From/To dates (`YYYY-MM-DD`) and Apply range. Results are
grouped by provider and model, with Input, Cache input, Total input, and Output.

- **Input** is non-cache-read input. For Claude it includes fresh input and cache
  writes; for Codex/Grok it is total input minus cache reads.
- **Cache input** is cache-read tokens. **Total input** is Input + Cache input.
- **Output** uses the provider's reported output counter; reasoning tokens are
  not added again when already included by the provider.
- Claude reads assistant usage in local `projects/**/*.jsonl` and deduplicates
  message IDs across streaming records and copied/forked logs.
- Codex reads local `sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl`, follows the reported model, and uses
  changes in cumulative usage to avoid counting repeated token events. A first
  reading uses last-request usage so inherited fork totals are not billed again.
- Grok reads saved `sessions/**/usage.json`, using completed turns' `modelUsage`
  rather than adding the session summary. Older sessions without this file are
  unavailable. Codex/Grok records without request IDs use timestamp/model/token
  fingerprints to deduplicate replayed records.

History includes retained CLI logs on the selected daemon, including use outside
Paseo. It is not an account billing report: deleted logs, other devices, custom
provider homes, and unrecorded usage are excluded. File failures are shown as
incomplete coverage; missing counters display Not provided rather than zero.
Date attribution follows each log record's timestamp (Grok uses turn end time).

The reader honors `CODEX_HOME`, `CLAUDE_CONFIG_DIR` / `CLAUDE_HOME`, and `GROK_HOME`,
with the usual home-directory defaults. It does not read authentication files or
send log contents to a provider. Only model names and token aggregates reach the
client. Parsed usage records are cached in server memory by file mtime/size;
Refresh history scans for changed files. Nothing is written to the source logs.

## Data sources

- Codex and Grok use the connected host's existing `providers.listUsage()` SDK API.
  Paseo's `session` window is displayed as the five-hour limit, and its `weekly`
  window as the weekly limit. Grok currently provides only a weekly window.
- Claude uses the same SDK data when available. Otherwise the plugin's daemon
  entry queries the Claude Code OAuth usage endpoint using the existing local
  sign-in. It reads `.credentials.json` under `CLAUDE_CONFIG_DIR`, `CLAUDE_HOME`,
  or `~/.claude`, then the `Claude Code-credentials` Keychain entry on macOS.
  This endpoint is not a documented public Claude API contract and can change.
- Usage belongs to the account configured on that daemon and includes other chats.
  It is not a counter for the current conversation. Separate accounts selected
  through custom provider environments are not detected by this plugin.
- API-key billing and RPM/TPM are separate from subscription windows. A provider
  without subscription usage data displays unavailable.

Credentials stay in server memory and are sent only to Anthropic's usage endpoint.
They are never included in RPC results, client bundles, files, or logs. The plugin
does not refresh or change login credentials. If Claude sign-in has expired, open
Claude Code on the daemon machine, run `/login`, then refresh the popover after
one minute.

Visible composer pills share one usage query per host and refresh every 60 seconds.
The Claude fallback is also cached for 60 seconds to avoid duplicate requests.
The popover's Refresh button rechecks the host; provider-side caches may still apply.
On a transport failure, previously fetched readings are marked stale. Their reset
time does not itself prove the allowance has refreshed.

## Install

Requires Paseo daemon and client 0.10.1 or later with plugins enabled.

```sh
npm install
npm run typecheck
npm test
paseo plugin install /Users/eric/personal-project/paseo-token-monitor-plugins
```

Install on the daemon whose account usage you want to view. After editing source:

```sh
paseo plugin reload paseo-token-monitor-plugins
paseo plugin ls paseo-token-monitor-plugins
```

The plugin owns its directory observation and removes pills, subscriptions, and
pending usage requests when unloaded. All UI uses React Native primitives and
the active Paseo theme; compact clients show the popover as a sheet.
