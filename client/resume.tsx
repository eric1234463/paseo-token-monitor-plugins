import type { PluginButtonContentProps, PluginButtonIconProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { TextInput, copyText } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { buildResumePrompt } from "../shared/handoff";

// Workspace-scoped: composer pills need an agentId, so they are absent on the
// new-agent composer. A header button only needs a workspaceId and is therefore
// reachable while composing a new agent inside a workspace.
export function ResumeIcon({ color, size }: PluginButtonIconProps) {
  return <Text style={{ color, fontSize: size }} accessibilityLabel="Resume a previous agent">↺</Text>;
}

function pickModel(models: { id: string; isDefault?: boolean | null; isSelectable?: boolean | null }[] | null | undefined): string | null {
  if (!models || models.length === 0) return null;
  return models.find((entry) => entry.isDefault)?.id
    ?? models.find((entry) => entry.isSelectable !== false)?.id
    ?? models[0]?.id
    ?? null;
}

export function ResumePopover({ theme, layout, host, ...context }: PluginButtonContentProps) {
  const paseo = usePaseo();
  const workspaceId = context.workspaceId;
  const [previousId, setPreviousId] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [createState, setCreateState] = useState<"idle" | "creating" | "created" | "error">("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  // Null = follow the previous agent; set = switch to another provider/model.
  const [overrideProvider, setOverrideProvider] = useState<string | null>(null);
  const [overrideModel, setOverrideModel] = useState<string | null>(null);
  const target = previousId.trim();
  const reset = () => {
    setCopyState("idle"); setCreateState("idle"); setCreateError(null);
    setOverrideProvider(null); setOverrideModel(null);
  };
  const previous = useQuery({
    queryKey: ["resume-previous-agent", host.id, target],
    queryFn: async () => {
      const handle = paseo.agents.ref(target);
      return (await handle.refresh())?.agent ?? handle.current();
    },
    enabled: target.length > 0, staleTime: 60_000, retry: false,
  });
  const providers = useQuery({
    queryKey: ["resume-providers", host.id],
    queryFn: () => paseo.providers.listAvailable(),
    staleTime: 60_000, retry: false,
  });
  const available = providers.data?.providers.filter((entry) => entry.available) ?? [];
  const effectiveProvider = overrideProvider ?? previous.data?.provider ?? null;
  const modelList = useQuery({
    queryKey: ["resume-models", host.id, effectiveProvider],
    queryFn: () => paseo.providers.listModels(effectiveProvider!),
    enabled: effectiveProvider !== null, staleTime: 60_000, retry: false,
  });
  const models = modelList.data?.models ?? [];
  const effectiveModel = overrideModel
    ?? (overrideProvider ? pickModel(models) : previous.data?.model ?? pickModel(models))
    ?? null;
  const busy = previous.isFetching || modelList.isFetching;
  const canSubmit = target.length > 0 && !busy && !previous.isError
    && effectiveProvider !== null && effectiveModel !== null && createState !== "creating";
  const prompt = target.length > 0 ? buildResumePrompt(target) : null;
  const optionStyle = (active: boolean) => ({
    padding: 8, borderRadius: 6, borderWidth: 1,
    borderColor: active ? theme.colors.accent : theme.colors.border,
    backgroundColor: active ? theme.colors.surface2 : theme.colors.surface1,
  });
  return (
    <View style={{ width: layout.compact ? "100%" : 320, gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 16 }}>Resume previous agent</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        Type the previous agent id and confirm. A new agent is created in this workspace,
        reading that timeline with `paseo logs`, inspecting the repository, worktree, branch
        and uncommitted changes, then continuing the unfinished work. Provider and model
        follow the previous agent unless switched below.
      </Text>
      <TextInput value={previousId} placeholder="Previous agent id" autoCapitalize="none" autoCorrect={false}
        placeholderTextColor={theme.colors.foregroundMuted}
        onChangeText={(text) => { setPreviousId(text); reset(); }}
        style={{ padding: 8, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2, color: theme.colors.foreground }} />
      {previous.isError && target.length > 0 ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
        Could not read that agent. Check the id.
      </Text> : null}
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
          Provider{effectiveProvider ? ` · ${effectiveProvider}${overrideProvider ? " (switched)" : ""}` : ""}
        </Text>
        {available.map((entry) => {
          const active = overrideProvider === entry.provider;
          return (
            <Pressable key={entry.provider} accessibilityRole="button"
              accessibilityLabel={active ? `Use previous agent's provider instead of ${entry.provider}` : `Switch to ${entry.provider}`}
              onPress={() => { setOverrideProvider(active ? null : entry.provider); setOverrideModel(null); setCreateState("idle"); setCreateError(null); }}
              style={optionStyle(active)}>
              <Text style={{ color: theme.colors.foreground, fontWeight: active ? "600" : undefined }}>{entry.provider}</Text>
            </Pressable>
          );
        })}
      </View>
      {effectiveProvider && models.length > 0 ? <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
          Model{effectiveModel ? ` · ${effectiveModel}` : ""}
        </Text>
        {models.map((entry) => {
          const active = effectiveModel === entry.id;
          return (
            <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={`Use ${entry.label}`}
              onPress={() => { setOverrideModel(active && overrideModel ? null : entry.id); setCreateState("idle"); setCreateError(null); }}
              style={optionStyle(active)}>
              <Text style={{ color: theme.colors.foreground, fontWeight: active ? "600" : undefined }}>{entry.label}</Text>
            </Pressable>
          );
        })}
      </View> : null}
      {prompt ? <Text selectable style={{ color: theme.colors.foreground, fontSize: 12 }}>{prompt}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy resume prompt"
          disabled={prompt === null || copyState === "copied"}
          onPress={() => {
            if (!prompt || copyState === "copied") return;
            void copyText(prompt).then(() => setCopyState("copied")).catch(() => setCopyState("error"));
          }} style={{ flex: 1, padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface2,
            opacity: prompt === null || copyState === "copied" ? 0.6 : 1 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600", textAlign: "center" }}>
            {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed — retry" : "Copy"}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Create agent and send resume prompt"
          disabled={!canSubmit}
          onPress={() => {
            if (!canSubmit || !effectiveProvider || !effectiveModel) return;
            setCreateState("creating");
            setCreateError(null);
            void paseo.workspaces.ref(workspaceId).agents.create({
              config: { provider: `${effectiveProvider}/${effectiveModel}` }, prompt: buildResumePrompt(target),
            }).then(() => setCreateState("created")).catch((error) => {
              setCreateError(error instanceof Error ? `Create failed: ${error.message}` : "Create failed. Check the id and retry.");
              setCreateState("error");
            });
          }} style={{ flex: 1, padding: 8, borderRadius: 6, backgroundColor: theme.colors.accent, opacity: canSubmit ? 1 : 0.6 }}>
          <Text style={{ color: theme.colors.accentForeground, fontWeight: "600", textAlign: "center" }}>
            {busy ? "Loading…" : createState === "creating" ? "Creating…" : createState === "created" ? "Agent created" : createState === "error" ? "Confirm — retry" : "Confirm"}
          </Text>
        </Pressable>
      </View>
      {createState === "created" ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        New agent created in this workspace — open it from the agent list to continue.
      </Text> : null}
      {createState === "error" && createError ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
        {createError}
      </Text> : null}
    </View>
  );
}
