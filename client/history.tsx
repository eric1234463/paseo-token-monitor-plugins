import { useRpc } from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { dateBounds, historyRpc, periodRange } from "../shared/history";
import type { HistoryReport, Period } from "../shared/history";
import { formatHkt } from "../shared/usage";
import type { SupportedProvider } from "../shared/usage";
import { DailyTokenChart } from "./bar-chart";

const fields = [["input", "Input"], ["cacheInput", "Cache input"], ["totalInput", "Total input"], ["output", "Output"]] as const;
const providers = [["codex", "Codex"], ["claude", "Claude"], ["grok", "Grok"]] as const;
const formatCount = (value: number | null) => value === null ? "Not provided" : value.toLocaleString("en-US");

function ModelRow({ row, theme, layout }: { row: HistoryReport["rows"][number] } & Pick<PluginSurfaceProps, "theme" | "layout">) {
  return (
    <View style={{ padding: 16, gap: 12, borderRadius: 8, backgroundColor: theme.colors.surface1,
      flexDirection: layout.compact ? "column" : "row", alignItems: layout.compact ? "stretch" : "center" }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", flex: layout.compact ? undefined : 2 }}>{row.model}</Text>
      <View style={{ flex: layout.compact ? undefined : 4, flexDirection: "row", flexWrap: layout.compact ? "wrap" : "nowrap", gap: 12 }}>
        {fields.map(([field, label]) => (
          <View key={field} style={{ flex: layout.compact ? undefined : 1, width: layout.compact ? "47%" : undefined, gap: 4 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
            <Text style={{ color: theme.colors.foreground, fontVariant: ["tabular-nums"], fontSize: 16 }}>
              {formatCount(row[field])}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export function TokenHistory({ theme, layout, host }: PluginSurfaceProps) {
  const initial = periodRange("weekly");
  const [period, setPeriod] = useState<Period | null>("weekly");
  const [offset, setOffset] = useState(0);
  const [range, setRange] = useState(initial);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [validation, setValidation] = useState<string | null>(null);
  const [provider, setProvider] = useState<SupportedProvider>("codex");
  const read = useRpc(historyRpc);
  const query = useQuery({
    queryKey: ["token-history", host.id, range.from, range.to, "daily-totals"],
    queryFn: () => read(range), staleTime: 60_000, retry: false,
  });
  const rows = query.data?.rows.filter((row) => row.provider === provider) ?? [];
  const source = query.data?.sources.find((source) => source.provider === provider);
  const providerLabel = providers.find(([id]) => id === provider)![1];
  const apply = (next: { from: string; to: string }) => {
    setRange(next); setFrom(next.from); setTo(next.to); setValidation(null);
  };
  const choosePeriod = (next: Period) => {
    setPeriod(next); setOffset(0); apply(periodRange(next));
  };
  const shift = (direction: number) => {
    if (!period) return;
    setOffset(offset + direction); apply(periodRange(period, undefined, offset + direction));
  };
  const button = (label: string, onPress: () => void, selected = false, disabled = false) => (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
      style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 6,
        opacity: disabled ? 0.5 : 1, backgroundColor: selected ? theme.colors.accent : theme.colors.surface2 }}>
      <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 20 }}>
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 24, fontWeight: "600" }}>Token history</Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>{host.label} · Local CLI sessions · HKT (UTC+8)</Text>
      </View>
      <View accessibilityRole="tablist" accessibilityLabel="Usage provider" style={{ flexDirection: "row", gap: 8 }}>
        {providers.map(([id, label]) => (
          <Pressable key={id} accessibilityRole="tab" accessibilityLabel={label}
            accessibilityState={{ selected: provider === id }} onPress={() => setProvider(id)}
            style={{ flex: layout.compact ? 1 : undefined, paddingHorizontal: 18, paddingVertical: 12,
              borderBottomWidth: 2, borderBottomColor: provider === id ? theme.colors.accent : theme.colors.border }}>
            <Text style={{ color: provider === id ? theme.colors.accent : theme.colors.foregroundMuted,
              fontWeight: provider === id ? "600" : "400", textAlign: "center" }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button("Daily", () => choosePeriod("daily"), period === "daily")}
        {button("7 days", () => choosePeriod("weekly"), period === "weekly")}
        {button("Monthly", () => choosePeriod("monthly"), period === "monthly")}
        {button("Previous period", () => shift(-1), false, period === null)}
        {button("Next period", () => shift(1), false, period === null)}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
        {([["From", from, setFrom], ["To", to, setTo]] as const).map(([label, value, onChange]) => (
          <View key={label} style={{ gap: 6, minWidth: 150, flex: layout.compact ? 1 : undefined }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label} (HKT)</Text>
            <TextInput accessibilityLabel={`${label} date in YYYY-MM-DD`} value={value} onChangeText={onChange}
              placeholder="YYYY-MM-DD" placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none" autoCorrect={false} maxLength={10}
              style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface1,
                borderColor: theme.colors.border, borderWidth: 1, borderRadius: 6, padding: 10 }} />
          </View>
        ))}
        {button("Apply range", () => {
          try { dateBounds(from, to); setPeriod(null); setOffset(0); apply({ from, to }); }
          catch { setValidation("Use YYYY-MM-DD dates with From on or before To."); }
        })}
        {button(query.isFetching ? "Refreshing…" : "Refresh history", () => { void query.refetch(); }, false, query.isFetching)}
      </View>
      {validation ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{validation}</Text> : null}
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{range.from} — {range.to} · HKT · Grouped by model</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Input excludes cache reads and includes cache writes. Total input = Input + Cache input. Only retained logs on this host are included.
      </Text>
      {query.isPending ? <Text style={{ color: theme.colors.foregroundMuted }}>Reading local token history… The first scan may take a moment.</Text> : null}
      {query.isError ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning }}>
        Could not refresh history. Any totals shown are the last successful reading; try Refresh history.
      </Text> : null}
      {query.data ? (
        <View accessibilityLabel={`${providerLabel} token usage`} style={{ gap: 10 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 18 }}>{providerLabel}</Text>
          <Text style={{ color: source?.status === "error" || source?.status === "partial" ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>
            {source?.message} {source?.files ? `(${source.files} files)` : ""}
          </Text>
          {period === "weekly" || period === "monthly" ? <DailyTokenChart days={query.data.days} provider={provider}
            from={range.from} to={range.to} complete={source?.status === "available"} theme={theme} /> : null}
          {rows.length ? rows.map((row) => <ModelRow key={row.model} row={row} theme={theme} layout={layout} />)
            : <Text style={{ color: theme.colors.foregroundMuted }}>{source?.status === "available" ? "No usage recorded in this date range." : "Token history not provided."}</Text>}
        </View>
      ) : null}
      {query.data ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Updated {formatHkt(query.data.fetchedAt)}</Text> : null}
    </ScrollView>
  );
}
