import { useAgent, usePaseo, useRpc } from "@getpaseo/plugin/client";
import type { PluginButtonContentProps, PluginButtonIconProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { claudeUsageRpc } from "../shared/claude";
import { PROMPT_CACHE_TTL_MS, cachePillLabel, cacheRemainingMs, formatCountdown, formatHkt, gatewayPillLabel, gatewayReasons, isGatewayTripped, providerId, quotaWindows, remaining, tokenPillLabel, GATEWAY_ALERT_COLOR } from "../shared/usage";
import type { Usage, UsageWindow } from "../shared/usage";
import { HANDOFF_FILENAME, buildHandoffPrompt, handoffTriggerSummary } from "../shared/handoff";
import type { CacheStore } from "./cache";
import { speedLabel, speedRpc } from "../shared/speed";

function useSpeed(agentId: string, hostId: string) {
  const readSpeed = useRpc(speedRpc);
  return useQuery({
    queryKey: ["token-speed", hostId, agentId],
    queryFn: () => readSpeed({ agentId }),
    enabled: Boolean(agentId), staleTime: 5_000, refetchInterval: 5_000, retry: false,
  });
}

function useAccountUsage(hostId: string) {
  const paseo = usePaseo();
  const readClaude = useRpc(claudeUsageRpc);
  return useQuery({
    queryKey: ["token-monitor", hostId],
    queryFn: async () => {
      const snapshot = await paseo.providers.listUsage();
      const claude = snapshot.providers.find((usage) => usage.providerId === "claude");
      if (!claude || claude.status !== "available") {
        const fallback = await readClaude({}).catch(() => claude ?? {
          providerId: "claude", displayName: "Claude", status: "unavailable" as const,
          planLabel: null, windows: [],
        });
        snapshot.providers = [...snapshot.providers.filter((usage) => usage.providerId !== "claude"), fallback];
      }
      return snapshot;
    },
    staleTime: 60_000, refetchInterval: 60_000, retry: false,
  });
}

function useUsage(agentId: string, hostId: string) {
  const provider = useAgent(agentId, (agent) => agent.provider);
  const query = useAccountUsage(hostId);
  const id = provider ? providerId(provider) : null;
  return { ...query, provider: id, usage: query.data?.providers.find((usage) => usage.providerId === id) ?? null };
}

export function UsageOverview({ theme, layout, host }: PluginSurfaceProps) {
  const query = useAccountUsage(host.id);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 24, fontWeight: "600" }}>Usage overview</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh account usage" disabled={query.isFetching}
          onPress={() => { void query.refetch(); }} style={{ padding: 10, borderRadius: 6, backgroundColor: theme.colors.surface2 }}>
          <Text style={{ color: theme.colors.foreground }}>{query.isFetching ? "Refreshing…" : "Refresh usage"}</Text>
        </Pressable>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted }}>{host.label} · Account limits across chats · HKT (UTC+8)</Text>
      {query.isPending ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading account usage…</Text> : null}
      {query.isError ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning }}>
        Could not refresh account usage. Any values shown are the last known reading.
      </Text> : null}
      <View style={{ flexDirection: layout.compact ? "column" : "row", gap: 12 }}>
        {([["codex", "Codex"], ["claude", "Claude"]] as const).map(([id, label]) => {
          const usage = query.data?.providers.find((usage) => usage.providerId === id);
          const { fiveHour, weekly } = quotaWindows(usage?.status === "available" ? usage : null);
          return (
            <View key={id} accessibilityLabel={`${label} account limits`}
              style={{ flex: layout.compact ? undefined : 1, padding: 16, gap: 12, borderRadius: 8, backgroundColor: theme.colors.surface1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "600" }}>{label}{usage?.planLabel ? ` · ${usage.planLabel}` : ""}</Text>
              {!query.isPending && usage?.status !== "available" ? <Text style={{ color: theme.colors.foregroundMuted }}>
                {usage?.error || "Usage is unavailable for this provider account."}
              </Text> : null}
              <WindowRow label="5-hour limit" window={fiveHour} theme={theme} />
              <WindowRow label="Weekly limit" window={weekly} theme={theme} />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Updated {formatHkt(usage?.fetchedAt ?? query.data?.fetchedAt)}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export type UsageSection = "limits" | "tokens";

export function UsageIcon(props: PluginButtonIconProps & { section: UsageSection; cacheStore: CacheStore; onLabel(label: string): void }) {
  const agentId = props.context === "agent" ? props.agentId : "";
  const { usage, isPending, isError } = useUsage(agentId, props.host.id);
  const speed = useSpeed(agentId, props.host.id);
  const cacheState = useSyncExternalStore(props.cacheStore.subscribe, props.cacheStore.getSnapshot, props.cacheStore.getSnapshot);
  const tripped = props.section === "limits" && !isPending && !isError && isGatewayTripped(usage?.status === "available" ? usage : null);
  const label = props.section === "tokens" ? tokenPillLabel(cacheState.ratio, speed.isError ? null : speed.data?.tokensPerSecond ?? null)
    : isPending ? "Limits…" : isError ? "Limits stale" : gatewayPillLabel(usage);
  useEffect(() => props.onLabel(label), [label, props.onLabel]);
  const glyph = props.section === "limits" ? (tripped ? "\u26A0" : "◷") : "↯";
  // The host owns the pill background (no tone/style field on PluginButton),
  // so the strongest red signal available is a red badge in the icon slot.
  if (tripped) {
    return (
      <View style={{ backgroundColor: GATEWAY_ALERT_COLOR, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 }}>
        <Text style={{ color: "#ffffff", fontSize: props.size, fontWeight: "700" }} accessibilityLabel="Account limits">{"\u26A0"}</Text>
      </View>
    );
  }
  return <Text style={{ color: props.color, fontSize: props.size }} accessibilityLabel={props.section === "limits" ? "Account limits" : "Cache and average throughput"}>{glyph}</Text>;
}

export function CacheIcon(props: PluginButtonIconProps & { cacheStore: CacheStore; onLabel(label: string): void }) {
  const cacheState = useSyncExternalStore(props.cacheStore.subscribe, props.cacheStore.getSnapshot, props.cacheStore.getSnapshot);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const remainingMs = cacheState.ratio === null ? null : cacheRemainingMs(cacheState.updatedAtMs, nowMs);
  const ticking = remainingMs !== null && remainingMs > 0;
  useEffect(() => {
    if (!ticking) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking, cacheState.updatedAtMs]);
  const label = cachePillLabel(remainingMs);
  useEffect(() => props.onLabel(label), [label, props.onLabel]);
  return <Text style={{ color: props.color, fontSize: props.size }} accessibilityLabel="Prompt cache expiry">◷</Text>;
}

function WindowRow({ label, window, theme }: { label: string; window: UsageWindow | null; theme: PluginButtonContentProps["theme"] }) {
  const left = remaining(window);
  const used = left === null ? null : 100 - left;
  const color = used !== null && used >= 95 ? theme.colors.statusDanger
    : used !== null && used >= 80 ? theme.colors.statusWarning : theme.colors.accent;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{label}</Text>
        <Text style={{ color: left === null ? theme.colors.foregroundMuted : color }}>
          {left === null ? "Not provided" : `${Math.round(left)}% left`}
        </Text>
      </View>
      <View accessibilityRole="progressbar" accessibilityLabel={`${label} usage`}
        accessibilityValue={used === null ? { text: "Not provided" } : { min: 0, max: 100, now: used, text: `${Math.round(used)}% used` }}
        style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        {used === null ? null : <View style={{ height: 6, width: `${used}%`, backgroundColor: color }} />}
      </View>
      {used !== null ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {Math.round(used)}% used{window?.resetsAt ? ` · Resets ${formatHkt(window.resetsAt)}` : ""}
      </Text> : null}
    </View>
  );
}

function CacheExpiry({ cacheStore, theme }: { cacheStore: CacheStore; theme: PluginButtonContentProps["theme"] }) {
  const state = useSyncExternalStore(cacheStore.subscribe, cacheStore.getSnapshot, cacheStore.getSnapshot);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remainingMs = cacheRemainingMs(state.updatedAtMs, nowMs);
  if (state.ratio === null || remainingMs === null || state.updatedAtMs === null) {
    return (
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Cache expiry · Not available</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          No cache reading yet. Send a message to establish prompt cache.
        </Text>
      </View>
    );
  }
  const expired = remainingMs <= 0;
  const pct = expired ? 0 : Math.max(0, Math.min(100, remainingMs / PROMPT_CACHE_TTL_MS * 100));
  const color = expired ? theme.colors.statusDanger : remainingMs < 60_000 ? theme.colors.statusWarning : theme.colors.accent;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Cache expiry</Text>
        <Text style={{ color, fontVariant: ["tabular-nums"] }}>
          {expired ? "Expired" : `Expires in ${formatCountdown(remainingMs)}`}
        </Text>
      </View>
      <View accessibilityRole="progressbar" accessibilityLabel="Prompt cache expiry"
        accessibilityValue={expired ? { text: "Expired" } : { min: 0, max: 300, now: Math.ceil(remainingMs / 1000), text: `Expires in ${formatCountdown(remainingMs)}` }}
        style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        {expired ? null : <View style={{ height: 6, width: `${pct}%`, backgroundColor: color }} />}
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {expired
          ? `Idle over 5 min — next request starts fresh. Last activity ${formatHkt(new Date(state.updatedAtMs).toISOString())}.`
          : `Last activity ${formatHkt(new Date(state.updatedAtMs).toISOString())} · 5-min idle TTL (heuristic).`}
      </Text>
    </View>
  );
}

function GatewayWarning({ usage, agentId, theme }: { usage: Usage | null; agentId: string; theme: PluginButtonContentProps["theme"] }) {
  const paseo = usePaseo();
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const reasons = gatewayReasons(usage);
  if (reasons.length === 0) return null;
  const headline = [
    reasons.includes("5-hour") ? "5-hour \u226590%" : null,
    reasons.includes("Weekly") ? "weekly \u226595%" : null,
  ].filter(Boolean).join(" · ");
  const canSend = Boolean(agentId) && state !== "sending" && state !== "sent";
  return (
    <View style={{ gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.statusDanger, backgroundColor: theme.colors.surface2 }}>
      <Text style={{ color: theme.colors.statusDanger, fontWeight: "700" }}>STOP \u2014 {headline} used</Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{handoffTriggerSummary(usage)}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Paseo plugins can\u2019t block sends \u2014 treat this as a stop line: generate the handoff before continuing.
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Generate handoff doc" disabled={!canSend}
        onPress={() => {
          if (!agentId || state === "sending" || state === "sent") return;
          setState("sending");
          void paseo.agents.ref(agentId).send(buildHandoffPrompt(usage)).then(() => setState("sent")).catch(() => setState("error"));
        }} style={{ padding: 8, borderRadius: 6, backgroundColor: theme.colors.accent, opacity: canSend ? 1 : 0.6 }}>
        <Text style={{ color: theme.colors.accentForeground, fontWeight: "600", textAlign: "center" }}>
          {state === "sending" ? "Sending\u2026" : state === "sent" ? "Handoff prompt sent" : state === "error" ? "Send failed \u2014 retry" : "Generate handoff doc"}
        </Text>
      </Pressable>
      {state === "sent" ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        The agent will save {HANDOFF_FILENAME} in the workspace root and reply in chat. Copy it to the next session.
      </Text> : null}
    </View>
  );
}

export function CachePopover({ theme, layout, cacheStore }: PluginButtonContentProps & { cacheStore: CacheStore }) {
  return <View style={{ width: layout.compact ? "100%" : 320 }}>
    <CacheExpiry cacheStore={cacheStore} theme={theme} />
  </View>;
}

export function UsagePopover({ theme, layout, host, cacheStore, section, ...context }: PluginButtonContentProps & { section: UsageSection; cacheStore: CacheStore }) {
  const agentId = context.context === "agent" ? context.agentId : "";
  const { usage, provider, isPending, isFetching, isError, refetch, data } = useUsage(agentId, host.id);
  const speed = useSpeed(agentId, host.id);
  const cacheState = useSyncExternalStore(cacheStore.subscribe, cacheStore.getSnapshot, cacheStore.getSnapshot);
  const cache = cacheState.ratio;
  const { fiveHour, weekly } = quotaWindows(usage?.status === "available" ? usage : null);
  const extras = usage?.status === "available" ? usage.windows.filter((window) => window !== fiveHour && window !== weekly) : [];
  return (
    <View style={{ width: layout.compact ? "100%" : 320, gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 16 }}>{usage?.displayName ?? "Provider"} {section === "limits" ? "limits" : "tokens"}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {section === "limits" ? "Account usage across chats" : "This chat"} · {host.label}{section === "limits" && usage?.planLabel ? ` · ${usage.planLabel}` : ""}
      </Text>
      {section === "limits" ? <>
      <GatewayWarning usage={usage?.status === "available" ? usage : null} agentId={agentId} theme={theme} />
      {isPending ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading usage…</Text> : null}
      {isError ? <Text style={{ color: theme.colors.statusWarning }}>Could not refresh usage. Any values shown are the last known reading.</Text> : null}
      {!isPending && usage?.status !== "available" ? <Text style={{ color: theme.colors.foregroundMuted }}>
        {usage?.providerId === "claude" && usage.error ? usage.error : "Usage is unavailable for this provider account."}
      </Text> : null}
      <WindowRow label="5-hour limit" window={fiveHour} theme={theme} />
      <WindowRow label="Weekly limit" window={weekly} theme={theme} />
      {extras.map((window) => <WindowRow key={window.id} label={window.label} window={window} theme={theme} />)}
      {usage?.sourceLabel ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{usage.sourceLabel}</Text> : null}
      </> : <>
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Cache ratio · {cache === null ? "Not provided" : `${Math.round(cache)}%`}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Latest reported usage in this chat.{provider === "claude" ? " Cache reads / (fresh input + cache reads); excludes cache writes." : provider === "codex" ? " Cached input / total input tokens." : " Cache token semantics are not provided for this provider."}
        </Text>
      </View>
      <CacheExpiry cacheStore={cacheStore} theme={theme} />
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{speedLabel(speed.isError ? null : speed.data?.tokensPerSecond ?? null)}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Output tokens / full turn time, including tool and permission waits.
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {speed.isError ? "Could not refresh turn speed."
            : speed.data?.completedAt ? `Last completed turn · ${speed.data.outputTokens?.toLocaleString()} output tokens · ${((speed.data.elapsedMs ?? 0) / 1000).toFixed(1)}s · Completed ${formatHkt(speed.data.completedAt)}`
            : speed.data?.status === "running" ? "No completed reading yet. Available after this turn completes."
            : speed.data?.status === "unavailable" ? "This turn did not complete or matching token usage is unavailable."
            : "No completed turn with matching token usage and duration is available."}
        </Text>
        {speed.data?.status === "running" && speed.data.completedAt ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          New turn running; showing the last completed turn until it finishes.
        </Text> : null}
      </View>
      </>}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }}>
          {section === "limits" ? `Updated ${formatHkt(usage?.fetchedAt ?? data?.fetchedAt)}` : "C = cache ratio · tok/s = Avg output"}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh provider usage" disabled={isFetching || speed.isFetching}
          onPress={() => { void refetch(); void speed.refetch(); }} style={{ padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface2 }}>
          <Text style={{ color: theme.colors.foreground }}>{isFetching || speed.isFetching ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
