import { useAgent, usePaseo, useRpc } from "@getpaseo/plugin/client";
import type { PluginButtonContentProps, PluginButtonIconProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { claudeUsageRpc } from "../shared/claude";
import { formatHkt, pillLabel, providerId, quotaWindows, remaining, tokenPillLabel } from "../shared/usage";
import type { UsageWindow } from "../shared/usage";
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

function useUsage(agentId: string, hostId: string) {
  const paseo = usePaseo();
  const readClaude = useRpc(claudeUsageRpc);
  const provider = useAgent(agentId, (agent) => agent.provider);
  const query = useQuery({
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
  const id = provider ? providerId(provider) : null;
  return { ...query, provider: id, usage: query.data?.providers.find((usage) => usage.providerId === id) ?? null };
}

export type UsageSection = "limits" | "tokens";

export function UsageIcon(props: PluginButtonIconProps & { section: UsageSection; cacheStore: CacheStore; onLabel(label: string): void }) {
  const agentId = props.context === "agent" ? props.agentId : "";
  const { usage, isPending, isError } = useUsage(agentId, props.host.id);
  const speed = useSpeed(agentId, props.host.id);
  const cache = useSyncExternalStore(props.cacheStore.subscribe, props.cacheStore.getSnapshot, props.cacheStore.getSnapshot);
  const label = props.section === "tokens" ? tokenPillLabel(cache, speed.isError ? null : speed.data?.tokensPerSecond ?? null)
    : isPending ? "Limits…" : isError ? "Limits stale" : pillLabel(usage);
  useEffect(() => props.onLabel(label), [label, props.onLabel]);
  return <Text style={{ color: props.color, fontSize: props.size }} accessibilityLabel={props.section === "limits" ? "Account limits" : "Cache and average throughput"}>{props.section === "limits" ? "◷" : "↯"}</Text>;
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

export function UsagePopover({ theme, layout, host, cacheStore, section, ...context }: PluginButtonContentProps & { section: UsageSection; cacheStore: CacheStore }) {
  const agentId = context.context === "agent" ? context.agentId : "";
  const { usage, provider, isPending, isFetching, isError, refetch, data } = useUsage(agentId, host.id);
  const speed = useSpeed(agentId, host.id);
  const cache = useSyncExternalStore(cacheStore.subscribe, cacheStore.getSnapshot, cacheStore.getSnapshot);
  const { fiveHour, weekly } = quotaWindows(usage?.status === "available" ? usage : null);
  const extras = usage?.status === "available" ? usage.windows.filter((window) => window !== fiveHour && window !== weekly) : [];
  return (
    <View style={{ width: layout.compact ? "100%" : 320, gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 16 }}>{usage?.displayName ?? "Provider"} {section === "limits" ? "limits" : "tokens"}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {section === "limits" ? "Account usage across chats" : "This chat"} · {host.label}{section === "limits" && usage?.planLabel ? ` · ${usage.planLabel}` : ""}
      </Text>
      {section === "limits" ? <>
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
