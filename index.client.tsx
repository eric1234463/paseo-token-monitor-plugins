import type { PluginButtonContentProps, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { PaseoAgent, OwnedSubscription, PaseoAgentListResult, PaseoWorkspaceListResult } from "@getpaseo/client";
import { CacheIcon, CachePopover, UsageIcon, UsagePopover } from "./client/usage";
import { ContextIcon, ContextPopover } from "./client/context";
import { providerId } from "./shared/usage";
import { createCacheStore } from "./client/cache";
import type { CacheStore } from "./client/cache";
import { TokenHistory } from "./client/history";
import { ResumeIcon, ResumePopover } from "./client/resume";

export default function contribute(client: PluginClientContext) {
  client.addSurface("token-history", TokenHistory);
  client.addSidebarItem({ id: "token-history", title: "Token usage", icon: "ChartColumn", surface: "token-history" });
  const pills = new Map<string, { workspaceId: string; provider: string; cacheStore: CacheStore; registrations: PluginButtonRegistration[] }>();
  const lifetime = new AbortController();
  let subscription: OwnedSubscription<PaseoAgentListResult> | undefined;
  let workspaceSubscription: OwnedSubscription<PaseoWorkspaceListResult> | undefined;
  const resumeButtons = new Set<PluginButtonRegistration>();
  // Workspace-scoped so the control also exists on the new-agent composer, where
  // no agentId exists yet and composer pills therefore cannot render.
  const registerResumeButton = (workspaceId: string) => {
    if (lifetime.signal.aborted) return;
    resumeButtons.add(client.addHeaderButton({
      id: "resume-previous-agent", workspaceId,
      button: {
        title: "Resume a previous agent", label: "Resume…", icon: ResumeIcon,
        behavior: { kind: "popover", Content: ResumePopover },
      },
    }));
  };
  const remove = (id: string) => {
    for (const registration of pills.get(id)?.registrations ?? []) registration.remove();
    pills.delete(id);
  };
  const register = (agent: PaseoAgent) => {
    if (lifetime.signal.aborted) return;
    if (!agent.workspaceId || agent.archivedAt) return remove(agent.id);
    const existing = pills.get(agent.id);
    if (existing?.workspaceId === agent.workspaceId && existing.provider === agent.provider) {
      existing.cacheStore.update(agent);
      return;
    }
    remove(agent.id);
    const cacheStore = createCacheStore();
    cacheStore.update(agent);
    const workspaceId = agent.workspaceId;
    const resumePill = client.addComposerPill({
      id: "resume-previous-agent", workspaceId, agentId: agent.id,
      button: {
        title: "Resume a previous agent", label: "Resume…", icon: ResumeIcon,
        behavior: { kind: "popover", Content: ResumePopover },
      },
    });
    // Resume is provider-independent; the usage pills need supported token semantics.
    const sections = providerId(agent.provider) ? (["limits", "tokens", "cache", "context"] as const) : ([] as const);
    const registrations = [resumePill, ...sections.map((section) => {
      let registration: PluginButtonRegistration;
      const onLabel = (label: string) => registration?.update({ label });
      const titles = { limits: "Provider usage limits", tokens: "Cache ratio and average tokens per second", cache: "Prompt cache expiry", context: "Context window breakdown" };
      const labels = { limits: "Limits…", tokens: "Tokens…", cache: "Cache…", context: "Context…" };
      const Icon = section === "context"
        ? (props: PluginButtonIconProps) => <ContextIcon {...props} onLabel={onLabel} />
        : section === "cache" ? (props: PluginButtonIconProps) => <CacheIcon {...props} cacheStore={cacheStore} onLabel={onLabel} />
        : (props: PluginButtonIconProps) => <UsageIcon {...props} section={section} cacheStore={cacheStore} onLabel={onLabel} />;
      const Content = section === "context"
        ? (props: PluginButtonContentProps) => <ContextPopover {...props} />
        : section === "cache" ? (props: PluginButtonContentProps) => <CachePopover {...props} cacheStore={cacheStore} />
        : (props: PluginButtonContentProps) => <UsagePopover {...props} section={section} cacheStore={cacheStore} />;
      registration = client.addComposerPill({
        id: `usage-${section}`, workspaceId, agentId: agent.id,
        button: { title: titles[section], label: labels[section], icon: Icon, behavior: { kind: "popover", Content } },
      });
      return registration;
    })];
    pills.set(agent.id, { workspaceId: agent.workspaceId, provider: agent.provider, cacheStore, registrations });
  };
  void client.paseo.agents.list({ scope: "active", subscribe: {}, signal: lifetime.signal }).then((directory) => {
    if (lifetime.signal.aborted) return directory.subscription.release();
    subscription = directory.subscription;
    subscription.subscribe({
      snapshot({ entries }) {
        for (const id of pills.keys()) remove(id);
        for (const { agent } of entries) register(agent);
      },
      update(message) {
        if (message.type !== "agent_update") return;
        if (message.payload.kind === "remove") remove(message.payload.agentId);
        else register(message.payload.agent);
      },
    });
  }).catch(() => {
    if (!lifetime.signal.aborted) console.error("Token monitor could not observe the agent directory.");
  });
  void client.paseo.workspaces.list({ subscribe: {} }).then((directory) => {
    if (lifetime.signal.aborted) return directory.subscription.release();
    workspaceSubscription = directory.subscription;
    for (const workspace of directory.entries) registerResumeButton(workspace.id);
  }).catch(() => {
    if (!lifetime.signal.aborted) console.error("Token monitor could not observe the workspace directory.");
  });
  return async () => {
    lifetime.abort();
    for (const id of pills.keys()) remove(id);
    for (const registration of resumeButtons) registration.remove();
    resumeButtons.clear();
    await subscription?.release();
    await workspaceSubscription?.release();
  };
}
