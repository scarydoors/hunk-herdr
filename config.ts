export const AGENT_KINDS = ["pi", "claude", "codex", "gemini", "opencode"] as const;
export type AgentKind = typeof AGENT_KINDS[number];

export const NOTIFICATION_TARGETS = ["both", "hunk", "herdr"] as const;
export type NotificationTarget = typeof NOTIFICATION_TARGETS[number];

/** Where a finished or blocked agent is announced: Hunk's toast, Herdr's notification, or both. */
export function notificationTarget(config: Record<string, unknown> = {}): NotificationTarget {
  const target = config.notifications ?? "both";
  if (typeof target !== "string" || !(NOTIFICATION_TARGETS as readonly string[]).includes(target)) {
    throw new Error("hunk-herdr: notifications must be one of: " + NOTIFICATION_TARGETS.join(", "));
  }
  return target as NotificationTarget;
}

export function agentConfig(config: Record<string, unknown> = {}): { agents: AgentKind[]; defaultAgent?: AgentKind } {
  const agents = config.agents ?? [...AGENT_KINDS];
  if (!Array.isArray(agents) || !agents.every(a => typeof a === "string" && (AGENT_KINDS as readonly string[]).includes(a))) {
    throw new Error("hunk-herdr: agents must be an array of supported types: " + AGENT_KINDS.join(", "));
  }
  const kinds = [...new Set(agents)] as AgentKind[];
  const defaultAgent = config.default_agent;
  if (defaultAgent !== undefined && (typeof defaultAgent !== "string" || !kinds.includes(defaultAgent as AgentKind))) {
    throw new Error("hunk-herdr: default_agent must be included in agents");
  }
  return {
    agents: defaultAgent === undefined ? kinds : [defaultAgent as AgentKind, ...kinds.filter(a => a !== defaultAgent)],
    defaultAgent: defaultAgent as AgentKind | undefined,
  };
}
