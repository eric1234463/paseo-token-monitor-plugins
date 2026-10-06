import { useRpc } from "@getpaseo/plugin/client";
import type { PluginButtonContentProps, PluginButtonIconProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { contextBreakdownRpc, contextPartLabels, contextPillLabel } from "../shared/context";
import type { ContextBreakdown } from "../shared/context";
import { formatHkt } from "../shared/usage";

function useContextBreakdown(agentId: string, hostId: string) {
  const read = useRpc(contextBreakdownRpc);
  return useQuery({
    queryKey: ["token-context", hostId, agentId],
    queryFn: () => read({ agentId }),
    enabled: Boolean(agentId), staleTime: 10_000, refetchInterval: 15_000, retry: false,
  });
}

export function ContextIcon(props: PluginButtonIconProps & { onLabel(label: string): void }) {
  const agentId = props.context === "agent" ? props.agentId : "";
  const { data } = useContextBreakdown(agentId, props.host.id);
  const label = data ? contextPillLabel(data.usedTokens, data.maxTokens, data.estimatedTokens) : "Context…";
  useEffect(() => props.onLabel(label), [label, props.onLabel]);
  return <Text style={{ color: props.color, fontSize: props.size }} accessibilityLabel="Context window breakdown">▦</Text>;
}

function PartRow({ part, theme }: { part: ContextBreakdown["parts"][number]; theme: PluginButtonContentProps["theme"] }) {
  const share = part.sharePct;
  const color = share !== null && share >= 50 ? theme.colors.statusWarning : theme.colors.accent;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{contextPartLabels[part.part]}</Text>
        <Text style={{ color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
          {share === null ? "—" : `${share.toFixed(1)}%`}
        </Text>
      </View>
      <View accessibilityRole="progressbar" accessibilityLabel={`${contextPartLabels[part.part]} share`}
        accessibilityValue={share === null ? { text: "No content" } : { min: 0, max: 100, now: share, text: `${share.toFixed(1)}% of context` }}
        style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        {share === null || share <= 0 ? null : <View style={{ height: 6, width: `${share}%`, backgroundColor: color }} />}
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        ~{part.tokens.toLocaleString("en-US")} tokens · {part.items} item{part.items === 1 ? "" : "s"}{part.inputTokens !== null && part.outputTokens !== null
          ? ` · in ~${part.inputTokens.toLocaleString("en-US")} / out ~${part.outputTokens.toLocaleString("en-US")}` : ""}
      </Text>
    </View>
  );
}

function ToolRow({ tool, theme }: { tool: ContextBreakdown["topTools"][number]; theme: PluginButtonContentProps["theme"] }) {
  const share = tool.sharePct;
  const color = share !== null && share >= 50 ? theme.colors.statusWarning : theme.colors.accent;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", flex: 1 }} numberOfLines={1}>{tool.name}</Text>
        <Text style={{ color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
          {share === null ? "—" : `${share.toFixed(1)}%`}
        </Text>
      </View>
      <View accessibilityRole="progressbar" accessibilityLabel={`${tool.name} share`}
        accessibilityValue={share === null ? { text: "No content" } : { min: 0, max: 100, now: share, text: `${share.toFixed(1)}% of context` }}
        style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        {share === null || share <= 0 ? null : <View style={{ height: 6, width: `${share}%`, backgroundColor: color }} />}
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        ~{tool.tokens.toLocaleString("en-US")} tokens · {tool.calls} call{tool.calls === 1 ? "" : "s"} · in ~{tool.inputTokens.toLocaleString("en-US")} / out ~{tool.outputTokens.toLocaleString("en-US")}
      </Text>
    </View>
  );
}

function SkillsSection({ data, theme }: { data: ContextBreakdown; theme: PluginButtonContentProps["theme"] }) {
  const used = data.skills.filter((skill) => skill.used);
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
        Skills{data.skillsAvailable ? ` (${used.length} of ${data.skills.length} used)` : ""}
      </Text>
      {!data.skillsAvailable ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Skill list unavailable for this provider.
      </Text> : used.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {data.skills.length === 0 ? "No skills loaded in this session." : `No skills used in this chat yet · ${data.skills.length} loaded.`}
      </Text> : used.map((skill) => <View key={skill.name}
        style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: theme.colors.foreground, flex: 1 }} numberOfLines={1}>{skill.name}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          ~{skill.tokens.toLocaleString("en-US")}
        </Text>
      </View>)}
      {data.skillsAvailable && used.length > 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        ~{data.skillTokens.toLocaleString("en-US")} tokens · names and descriptions only
      </Text> : null}
    </View>
  );
}

export function ContextPopover({ theme, layout, host, ...context }: PluginButtonContentProps) {
  const agentId = context.context === "agent" ? context.agentId : "";
  const { data, isPending, isFetching, isError, refetch } = useContextBreakdown(agentId, host.id);
  const used = data?.usedTokens ?? null;
  const max = data?.maxTokens ?? null;
  const authoritative = used !== null && max !== null && max > 0;
  const usedPct = authoritative ? Math.min(100, used / max * 100) : null;
  const overhead = data?.overheadTokens ?? null;
  const overheadPct = authoritative && overhead !== null ? Math.min(100, overhead / max! * 100) : null;
  return (
    <View style={{ width: layout.compact ? "100%" : 320, gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 16 }}>Context</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>This chat · {host.label}</Text>
      {isPending ? <Text style={{ color: theme.colors.foregroundMuted }}>Reading context…</Text> : null}
      {isError ? <Text style={{ color: theme.colors.statusWarning }}>Could not refresh context. Try Refresh.</Text> : null}
      {data ? <>
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Window used</Text>
            <Text style={{ color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
              {authoritative ? `${usedPct!.toFixed(1)}%` : `~${data.estimatedTokens.toLocaleString("en-US")} tokens`}
            </Text>
          </View>
          {authoritative ? <>
            <View accessibilityRole="progressbar" accessibilityLabel="Context window used"
              accessibilityValue={{ min: 0, max: 100, now: usedPct!, text: `${usedPct!.toFixed(1)}% used` }}
              style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
              <View style={{ height: 6, width: `${usedPct!}%`,
                backgroundColor: usedPct! >= 90 ? theme.colors.statusDanger : usedPct! >= 70 ? theme.colors.statusWarning : theme.colors.accent }} />
            </View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {used!.toLocaleString("en-US")} / {max!.toLocaleString("en-US")} tokens · estimated parts below
            </Text>
          </> : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            Provider did not report window usage; totals are estimated from visible timeline.
          </Text>}
        </View>
        {data.topTools.length > 0 ? <View style={{ gap: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Top tools</Text>
          {data.topTools.slice(0, 6).map((tool) => <ToolRow key={tool.name} tool={tool} theme={theme} />)}
        </View> : null}
        <SkillsSection data={data} theme={theme} />
        {data.parts.filter((row) => row.items > 0).map((row) => <PartRow key={row.part} part={row} theme={theme} />)}
        {overhead !== null && overheadPct !== null ? <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>System prompt & definitions</Text>
            <Text style={{ color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
              {overheadPct.toFixed(1)}%
            </Text>
          </View>
          <View accessibilityRole="progressbar" accessibilityLabel="System prompt and tool definition overhead"
            accessibilityValue={{ min: 0, max: 100, now: overheadPct, text: `${overheadPct.toFixed(1)}% of context` }}
            style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
            {overheadPct <= 0 ? null : <View style={{ height: 6, width: `${overheadPct}%`, backgroundColor: theme.colors.statusWarning }} />}
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            ~{overhead.toLocaleString("en-US")} tokens · reported use minus visible estimate
          </Text>
        </View> : null}
        {data.truncated ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          Long chat: only the latest {data.itemCount} items were scanned, so shares skew toward recent content.
        </Text> : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Estimates from visible chat text (~4 chars/token). MCP calls are split out by the mcp__ tool-name prefix.
          Skill tokens cover names and descriptions only; full skill bodies live provider-side.
          System prompt & definitions is reported window use minus the visible estimate; it covers the system prompt,
          skill bodies, tool definitions and other provider-side content.
        </Text>
      </> : null}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }}>
          {data ? `Updated ${formatHkt(data.fetchedAt)}` : "Breakdown by content part"}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh context breakdown" disabled={isFetching}
          onPress={() => { void refetch(); }} style={{ padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface2 }}>
          <Text style={{ color: theme.colors.foreground }}>{isFetching ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
