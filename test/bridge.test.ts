import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge, buildPrompt, sameAgent, workspaceAgents, type Pane, type Run } from "../bridge.ts";

const caller: Pane = { pane_id: "w6:p1", workspace_id: "w6", tab_id: "w6:t1", terminal_id: "caller" };
const agent: Pane = { ...caller, pane_id: "w6:p2", terminal_id: "agent", agent: "pi", agent_status: "idle", name: "reviewer" };
const env = { HERDR_ENV: "1", HERDR_PANE_ID: "old-caller-id" };

/** The tab Herdr creates for a temporary agent, beside Hunk's own. */
const agentTab = "w6:t2";

function fixture() {
  const calls: string[][] = [];
  let agents = [agent];
  let pane = { ...agent };
  let startFails = false;
  const exec: Run = async (_binary, args) => {
    calls.push(args);
    let result: unknown = {};
    const command = args.slice(0, 2).join(" ");
    if (command === "pane current") result = { pane: caller };
    else if (command === "agent list") result = { agents };
    else if (command === "tab create") {
      pane = { ...pane, tab_id: agentTab, agent: undefined, name: undefined };
      result = { tab: { tab_id: agentTab }, root_pane: pane };
    }
    else if (command === "pane get") result = { pane };
    else if (command === "agent start") {
      if (startFails) throw new Error("agent_not_ready");
      pane = { ...agent, tab_id: agentTab, name: args[2] };
      agents = [pane];
    }
    return JSON.stringify({ result });
  };
  return {
    bridge: new Bridge("/review with spaces", exec, env), calls,
    agents(value: Pane[]) { agents = value; }, pane(value: Pane) { pane = value; },
    failStart() { startFails = true; },
  };
}

test("workspace picker uses caller identity, excludes caller and other workspaces", async () => {
  const f = fixture();
  f.agents([{ ...caller, agent: "pi" }, agent, { ...agent, workspace_id: "w9", pane_id: "w9:p1" }]);
  assert.deepEqual(await f.bridge.agents(), [agent]);
  assert.deepEqual(f.calls[0], ["pane", "current", "--current"]);
  assert.deepEqual(workspaceAgents([agent], caller), [agent]);
});

test("outside Herdr fails before executing any CLI", async () => {
  let calls = 0;
  const bridge = new Bridge("/tmp", async () => { calls++; return ""; }, {});
  await assert.rejects(bridge.agents(), /Launch Hunk inside/);
  assert.equal(calls, 0);
});

test("spawn starts the agent in a new unfocused tab of Hunk's workspace, never splitting or zooming Hunk", async () => {
  const f = fixture();
  const result = await f.bridge.spawn("pi", undefined, "hunk · Authentication");
  const tab = f.calls.findIndex(a => a[0] === "tab" && a[1] === "create");
  const start = f.calls.findIndex(a => a[0] === "agent" && a[1] === "start");
  assert.deepEqual(f.calls[tab], ["tab", "create", "--workspace", caller.workspace_id, "--cwd", "/review with spaces", "--label", "hunk · Authentication", "--no-focus"]);
  assert.ok(start > tab);
  assert.equal(f.calls.some(a => a[1] === "split" || a[1] === "zoom" || a[1] === "focus"), false);
  assert.equal(result.pane_id, agent.pane_id);
  assert.equal(result.tab_id, agentTab);
  assert.match(f.bridge.owned!.name, /^hunk-[a-f0-9]{8}$/);
  await assert.rejects(f.bridge.spawn("pi"), /already exists/);
});

test("spawn forwards a configured model only as agent CLI arguments", async () => {
  const f = fixture();
  await f.bridge.spawn("pi", "anthropic/claude-sonnet-4-5");
  const start = f.calls.find(call => call[0] === "agent" && call[1] === "start");
  assert.deepEqual(start!.slice(-3), ["--", "--model", "anthropic/claude-sonnet-4-5"]);
});

test("startup failure retains owned pane for reveal/cleanup and never prompts", async () => {
  const f = fixture(); f.failStart();
  await assert.rejects(f.bridge.spawn("pi"), /No prompt was sent/);
  assert.ok(f.bridge.owned);
  assert.equal(f.calls.some(a => a[1] === "prompt"), false);
  await f.bridge.revealOwned();
  assert.deepEqual(f.calls.at(-1), ["tab", "focus", agentTab]);
});

test("prompt is one argv value, not shell text; no completion wait", async () => {
  const f = fixture();
  const text = "quotes '\" ; $(touch /tmp/nope)\nsecond line";
  await f.bridge.prompt(agent, text);
  assert.deepEqual(f.calls.at(-1), ["agent", "prompt", agent.pane_id, text]);
});

test("queues a prompt with Herdr's agent wait command", async () => {
  const f = fixture();
  await f.bridge.promptWhenReady(agent, "Investigate the review");
  assert.deepEqual(f.calls.filter(call => call[0] === "agent" && ["wait", "prompt"].includes(call[1]!)), [
    ["agent", "wait", agent.pane_id],
    ["agent", "prompt", agent.pane_id, "Investigate the review", "--wait"],
  ]);
});

test("blocked, busy, unknown, moved, and replaced agents cannot receive prompts", async () => {
  for (const change of [
    { agent_status: "working" }, { agent_status: "blocked" }, { agent_status: "unknown" },
    { workspace_id: "w8" }, { terminal_id: "replacement" }, { name: "other" },
  ]) {
    const f = fixture(); f.agents([{ ...agent, ...change }]);
    await assert.rejects(f.bridge.prompt(agent, "secret"));
    assert.equal(f.calls.some(a => a[1] === "prompt"), false);
  }
  assert.equal(sameAgent({ ...agent, agent_session: { kind: "id", value: "old" } }, { ...agent, agent_session: { kind: "id", value: "new" } }), false);
});

test("reveal is explicit, unzooms before agent focus", async () => {
  const f = fixture();
  await f.bridge.reveal(agent);
  assert.deepEqual(f.calls.slice(-2), [["pane", "zoom", caller.pane_id, "--off"], ["agent", "focus", agent.pane_id]]);
});

test("reveal of an agent in another tab focuses it without touching Hunk's zoom", async () => {
  const f = fixture();
  const other = { ...agent, tab_id: agentTab };
  f.agents([other]);
  await f.bridge.reveal(other);
  assert.equal(f.calls.some(a => a[1] === "zoom"), false);
  assert.deepEqual(f.calls.at(-1), ["agent", "focus", agent.pane_id]);
});

test("cleanup only closes owned same-identity agents", async () => {
  const f = fixture();
  await f.bridge.stop();
  assert.equal(f.calls.length, 0);
  await f.bridge.spawn("pi");
  await f.bridge.stop();
  assert.deepEqual(f.calls.at(-1), ["pane", "close", agent.pane_id]);
  assert.equal(f.bridge.owned, undefined);
});

test("cleanup refuses replaced agents and moved panes", async () => {
  for (const change of [{ name: "other" }, { workspace_id: "w9" }, { tab_id: "w6:t3" }, { terminal_id: "other" }]) {
    const f = fixture();
    const spawned = await f.bridge.spawn("pi");
    f.agents([{ ...spawned, ...change }]); f.pane({ ...spawned, ...change });
    await assert.rejects(f.bridge.stop(), /refusing to close/);
    assert.equal(f.calls.some(a => a[1] === "close"), false);
  }
});

const conversation = {
  replyTo: "user:one", filePath: "src/auth.ts", side: "new" as const, line: 12, stale: true,
  messages: [{ from: "user", text: "Handle expiry\nand refresh" }, { from: "reviewer", text: "Which token?" }, { from: "user", text: "The refresh token." }],
  answered: false,
};
const groupPrompt = {
  skill: "/nix/store/skill.md", skillRead: false, sessionId: "session:one", cwd: "/review",
  title: "Authentication", author: "hunk-pi", conversations: [conversation],
};

test("group prompt carries the skill path, exact session and every reply-to ID, but no command syntax", () => {
  const payload = buildPrompt(groupPrompt);
  assert.match(payload, /Before starting, read the Hunk review skill at "\/nix\/store\/skill.md"/);
  assert.doesNotMatch(payload, /hunk skill path|--reply-to|comment add|session list/, "command syntax is left to the skill");
  assert.match(payload, /Use session "session:one" as the session selector/);
  assert.match(payload, /Review working directory: "\/review"/);
  assert.match(payload, /1\. reply to: user:one — src\/auth\.ts, new line 12 \(stale: the code at this line has changed since it was written\)\n   user: Handle expiry\n     and refresh\n   reviewer: Which token\?\n   user: The refresh token\.$/);
  assert.match(payload, /never resolve or delete a comment/);
  assert.match(payload, /Don't edit files unless the user's guidance below explicitly asks you to/);
  assert.match(payload, /Set the reply author to "hunk-pi"/);
  assert.match(payload, /The user reads your work only in the Hunk review, never in this session/);
  assert.match(payload, /a message written only here is lost/);
  assert.match(payload, /reply in that conversation with the specific question or blocker/);
  assert.match(payload, /these rules win/);
});

test("follow-ups skip re-reading the skill, and typed text is added as guidance", () => {
  const text = "Explain this; don't edit it.\nThen check tests.";
  const payload = buildPrompt({ ...groupPrompt, skillRead: true, guidance: text });
  assert.match(payload, /You've already read the Hunk review skill at "\/nix\/store\/skill.md"/);
  assert.doesNotMatch(payload, /Before starting, read/);
  assert.ok(payload.endsWith(`Additional guidance from the user:\n${text}`));
  assert.match(payload, /Task: answer each review conversation/, "guidance never replaces the task");
});

test("a re-prompt lists only conversations awaiting the user's answer, never ones the agent answered last", () => {
  const answered = { ...conversation, replyTo: "user:two", messages: [{ from: "user", text: "Rename this" }, { from: "hunk-pi", text: "Done: renamed." }], answered: true };
  const fresh = { ...conversation, replyTo: "user:three", stale: false, messages: [{ from: "user", text: "Also check the cache" }] };
  const payload = buildPrompt({ ...groupPrompt, conversations: [answered, fresh] });
  assert.match(payload, /Awaiting a reply \(the complete list\):\n1\. reply to: user:three/);
  assert.doesNotMatch(payload, /user:two|Done: renamed/, "without guidance an answered conversation is left out entirely");
  assert.match(payload, /Never reply to your own or another agent's message/);

  const guided = buildPrompt({ ...groupPrompt, conversations: [answered, fresh], guidance: "Undo the rename." });
  assert.match(guided, /Already answered \(context only\):\n1\. reply to: user:two/);
  assert.match(guided, /reply there only if the user's guidance below asks for it/);
});

test("with every conversation answered, the guidance becomes the task", () => {
  const answered = { ...conversation, messages: [{ from: "user", text: "Rename this" }, { from: "hunk-pi", text: "Done." }], answered: true };
  const payload = buildPrompt({ ...groupPrompt, conversations: [answered], guidance: "Now update the tests." });
  assert.match(payload, /Task: carry out the user's guidance below/);
  assert.match(payload, /Reply only where the guidance asks you to/);
  assert.doesNotMatch(payload, /Awaiting a reply/);
  assert.match(payload, /Already answered \(context only\):\n1\. reply to: user:one/);
});


test("notify shows a Herdr notification and swallows Herdr failures", async () => {
  const calls: string[][] = [];
  const bridge = new Bridge("/review", async (_binary, args) => {
    calls.push(args);
    throw new Error("herdr is gone");
  });
  await bridge.notify("Hunk · pi", "Authentication needs attention", "request");
  assert.deepEqual(calls, [["notification", "show", "Hunk · pi", "--body", "Authentication needs attention", "--sound", "request"]]);
});
