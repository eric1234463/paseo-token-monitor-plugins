import type { PluginButtonContentProps, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import type { PaseoAgent, OwnedSubscription, PaseoAgentListResult } from "@getpaseo/client";
import { UsageIcon, UsagePopover } from "./client/usage";
import { providerId } from "./shared/usage";
import { createCacheStore } from "./client/cache";
import type { CacheStore } from "./client/cache";
import { TokenHistory } from "./client/history";

export default function contribute(client: PluginClientContext) {
  client.addSurface("token-history", TokenHistory);
  client.addSidebarItem({ id: "token-history", title: "Token usage", icon: "ChartColumn", surface: "token-history" });
  const pills = new Map<string, { workspaceId: string; provider: string; cacheStore: CacheStore; registration: PluginButtonRegistration }>();
  const lifetime = new AbortController();
  let subscription: OwnedSubscription<PaseoAgentListResult> | undefined;
  const remove = (id: string) => {
    pills.get(id)?.registration.remove();
    pills.delete(id);
  };
  const register = (agent: PaseoAgent) => {
    if (lifetime.signal.aborted) return;
    if (!agent.workspaceId || !providerId(agent.provider) || agent.archivedAt) return remove(agent.id);
    const existing = pills.get(agent.id);
    if (existing?.workspaceId === agent.workspaceId && existing.provider === agent.provider) {
      existing.cacheStore.update(agent);
      return;
    }
    remove(agent.id);
    const cacheStore = createCacheStore();
    cacheStore.update(agent);
    let registration: PluginButtonRegistration;
    const onLabel = (label: string) => registration?.update({ label });
    const Icon = (props: PluginButtonIconProps) => <UsageIcon {...props} cacheStore={cacheStore} onLabel={onLabel} />;
    const Content = (props: PluginButtonContentProps) => <UsagePopover {...props} cacheStore={cacheStore} />;
    registration = client.addComposerPill({
      id: "usage-limits", workspaceId: agent.workspaceId, agentId: agent.id,
      button: {
        title: "Provider usage limits", label: "Limits…", icon: Icon,
        behavior: { kind: "popover", Content },
      },
    });
    pills.set(agent.id, { workspaceId: agent.workspaceId, provider: agent.provider, cacheStore, registration });
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
  return async () => {
    lifetime.abort();
    for (const id of pills.keys()) remove(id);
    await subscription?.release();
  };
}
