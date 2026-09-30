import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { dailySeries } from "../shared/history";
import type { HistoryReport } from "../shared/history";
import type { SupportedProvider } from "../shared/usage";

const compact = (value: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const count = (value: number | null) => value === null ? "Not provided" : value.toLocaleString("en-US");

export function DailyTokenChart({ days, provider, from, to, complete, theme }: {
  days: HistoryReport["days"]; provider: SupportedProvider; from: string; to: string; complete: boolean;
} & Pick<PluginSurfaceProps, "theme">) {
  const points = dailySeries(days, provider, from, to, complete);
  const max = Math.max(0, ...points.map((point) => point.totalTokens ?? 0));
  const [selected, setSelected] = useState<string | null>(null);
  const detail = points.find((point) => point.date === selected);
  const segments = [
    { field: "input", label: "Input", color: theme.colors.accent },
    { field: "cacheInput", label: "Cache input", color: theme.colors.statusSuccess },
    { field: "output", label: "Output", color: theme.colors.statusWarning },
  ] as const;
  return (
    <View accessibilityLabel="Daily total token usage chart" style={{ padding: 16, gap: 12, borderRadius: 8, backgroundColor: theme.colors.surface1 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Daily total tokens</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Total input + output · All models in this provider · HKT · Today may be incomplete
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
        {segments.map(({ field, label, color }) => <View key={field} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 10, height: 10, backgroundColor: color }} />
          <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{label}</Text>
        </View>)}
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ width: 48, height: 174, justifyContent: "space-between", paddingTop: 24 }}>
          {[max, max / 2, 0].map((value, index) => <Text key={index} style={{ color: theme.colors.foregroundMuted, fontSize: 11, textAlign: "right" }}>{compact(value)}</Text>)}
        </View>
        <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} showsHorizontalScrollIndicator>
          <View style={{ flex: 1, minWidth: points.length * 40, flexDirection: "row", gap: 6 }}>
            {points.map((point) => (
              <Pressable key={point.date} accessibilityRole="button"
                accessibilityLabel={`${point.date} HKT: Total ${count(point.totalTokens)}; Input ${count(point.input)}; Cache input ${count(point.cacheInput)}; Output ${count(point.output)}`}
                accessibilityState={{ selected: point.date === selected }} onPress={() => setSelected(point.date)}
                style={{ flex: 1, minWidth: 34, alignItems: "center", gap: 6 }}>
                <View style={{ height: 174, justifyContent: "flex-end", alignItems: "center", width: "100%", gap: 4 }}>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                    {point.totalTokens === null ? "—" : compact(point.totalTokens)}
                  </Text>
                  <View style={{ width: "70%", height: Math.max(1, max ? (point.totalTokens ?? 0) / max * 150 : 0), borderTopLeftRadius: 3, borderTopRightRadius: 3,
                    backgroundColor: point.totalTokens ? theme.colors.foregroundMuted : theme.colors.surface2, overflow: "hidden",
                    opacity: point.date === selected ? 1 : 0.75 }}>
                    {point.totalTokens !== null && segments.every(({ field }) => point[field] !== null)
                      ? [...segments].reverse().map(({ field, color }) => <View key={field}
                        style={{ height: max ? point[field]! / max * 150 : 0, backgroundColor: color }} />) : null}
                  </View>
                </View>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{point.date.slice(5)}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </View>
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
        {detail ? `${detail.date} HKT · Total ${count(detail.totalTokens)} · Input ${count(detail.input)} · Cache input ${count(detail.cacheInput)} · Output ${count(detail.output)}`
          : "Select a bar for exact counts. 0 = no retained usage; — = missing data or incomplete coverage. Gray = breakdown not provided."}
      </Text>
    </View>
  );
}
