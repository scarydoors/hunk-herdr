import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge, buildPrompt, sameAgent, workspaceAgents, type Pane, type Run } from "../bridge.ts";

const caller: Pane = { pane_id: "w6:p1", workspace_id: "w6", tab_id: "w6:t1", terminal_id: "caller" };
const agent: Pane = { ...caller, pane_id: "w6:p2", terminal_id: "agent", agent: "pi", agent_status: "idle", name: "reviewer" };
const env = { HERDR_ENV: "1", HERDR_PANE_ID: "old-caller-id" };

function fixture(settleResize?: () => Promise<void>) {
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
    else if (command === "pane layout") result = { layout: { zoomed: false, focused_pane_id: caller.pane_id, area: { width: 160, height: 40 } } };
    else if (command === "pane split") result = { pane: { ...pane, agent: undefined, name: undefined } };
    else if (command === "pane get") result = { pane };
    else if (command === "agent start") {
      if (startFails) throw new Error("agent_not_ready");
      pane = { ...agent, name: args[2] };
      agents = [pane];
    }
    return JSON.stringify({ result });
  };
  return {
    bridge: new Bridge("/review with spaces", exec, env, settleResize ?? (async () => {})), calls,
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

test("spawn splits before zooming once, preserves cwd/focus and registers owned pane", async () => {
  const f = fixture();
  const result = await f.bridge.spawn("pi");
  const split = f.calls.findIndex(a => a[1] === "split");
  const zoom = f.calls.findIndex(a => a[1] === "zoom");
  const start = f.calls.findIndex(a => a[0] === "agent" && a[1] === "start");
  assert.ok(zoom > split);
  assert.ok(start > zoom);
  assert.deepEqual(f.calls.filter(a => a[1] === "zoom"), [["pane", "zoom", caller.pane_id, "--on"]]);
  assert.deepEqual(f.calls[split], ["pane", "split", caller.pane_id, "--direction", "right", "--cwd", "/review with spaces", "--no-focus"]);
  assert.equal(result.pane_id, agent.pane_id);
  assert.match(f.bridge.owned!.name, /^hunk-[a-f0-9]{8}$/);
  assert.equal(f.calls.some(a => a[1] === "focus"), false);
  await assert.rejects(f.bridge.spawn("pi"), /already exists/);
});

test("spawn waits for the split resize to settle before zooming or starting the agent", async () => {
  let resume!: () => void;
  let reached!: () => void;
  const reachedBarrier = new Promise<void>(resolve => { reached = resolve; });
  const barrier = new Promise<void>(resolve => { resume = resolve; });
  const f = fixture(async () => { reached(); await barrier; });
  const spawning = f.bridge.spawn("pi");
  await reachedBarrier;
  assert.ok(f.bridge.owned, "track the pane before waiting so cleanup can find it");
  assert.ok(f.calls.some(a => a[1] === "split"));
  assert.equal(f.calls.some(a => a[1] === "zoom" || a[1] === "start"), false);
  resume();
  await spawning;
  assert.ok(f.calls.some(a => a[1] === "zoom"));
  assert.ok(f.calls.some(a => a[1] === "start"));
});

test("startup failure retains owned pane for reveal/cleanup and never prompts", async () => {
  const f = fixture(); f.failStart();
  await assert.rejects(f.bridge.spawn("pi"), /No prompt was sent/);
  assert.ok(f.bridge.owned);
  assert.equal(f.calls.some(a => a[1] === "prompt"), false);
  await f.bridge.revealOwned();
  assert.deepEqual(f.calls.at(-1), ["pane", "zoom", caller.pane_id, "--off"]);
});

test("prompt is one argv value, not shell text; no completion wait", async () => {
  const f = fixture();
  const text = "quotes '\" ; $(touch /tmp/nope)\nsecond line";
  await f.bridge.prompt(agent, text);
  assert.deepEqual(f.calls.at(-1), ["agent", "prompt", agent.pane_id, text]);
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
  for (const change of [{ name: "other" }, { workspace_id: "w9" }, { tab_id: "w6:t2" }, { terminal_id: "other" }]) {
    const f = fixture();
    const spawned = await f.bridge.spawn("pi");
    f.agents([{ ...spawned, ...change }]); f.pane({ ...spawned, ...change });
    await assert.rejects(f.bridge.stop(), /refusing to close/);
    assert.equal(f.calls.some(a => a[1] === "close"), false);
  }
});

test("payload includes skill discovery, full user text, cwd and selection", () => {
  const text = "Explain this; don't edit it.\nThen check tests.";
  const payload = buildPrompt("/nix/store/skill.md", "/review", text, { file: "src/main.ts", hunk: 2 });
  assert.ok(payload.includes("`hunk skill path`"));
  assert.ok(payload.includes("/nix/store/skill.md"));
  assert.ok(payload.includes('"/review"'));
  assert.ok(payload.includes("hunk 3"));
  assert.ok(payload.includes("IMPORTANT: Read the review's user-authored comments"));
  assert.ok(payload.includes("--reply-to <note-id>"));
  assert.ok(payload.includes("do not answer with detached root comments"));
  assert.ok(payload.endsWith(text));
});
