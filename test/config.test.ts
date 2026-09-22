import { test } from "node:test";
import assert from "node:assert/strict";
import { agentConfig, AGENT_KINDS } from "../config.ts";

test("defaults preserve all supported agents and no preferred type", () => {
  assert.deepEqual(agentConfig(), { agents: [...AGENT_KINDS], defaultAgent: undefined });
});
test("default is first, configured order is otherwise preserved, duplicates removed", () => {
  assert.deepEqual(agentConfig({ agents: ["pi", "claude", "pi"], default_agent: "claude" }), {
    agents: ["claude", "pi"], defaultAgent: "claude",
  });
});
test("empty list disables agent choices", () => {
  assert.deepEqual(agentConfig({ agents: [] }).agents, []);
});
test("reject invalid types and defaults instead of launching arbitrary commands", () => {
  for (const config of [
    { agents: "pi" }, { agents: ["sh"] }, { agents: [42] },
    { default_agent: "sh" }, { default_agent: 1 },
    { agents: ["pi"], default_agent: "claude" }, { agents: [], default_agent: "pi" },
  ]) assert.throws(() => agentConfig(config), /hunk-herdr:/);
});
