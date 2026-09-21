import { test } from "node:test";
import assert from "node:assert/strict";
import register from "../index.ts";
import { Bridge, type Pane } from "../bridge.ts";
import type { ExtensionCommandContext, HunkExtensionAPI } from "hunkdiff/extension";

const caller: Pane = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "caller" };
const agent: Pane = { ...caller, pane_id: "w1:p2", terminal_id: "agent", agent: "pi", agent_status: "idle" };

function host() {
  const commands = new Map<string, (ctx: ExtensionCommandContext) => Promise<void> | void>();
  const answers: (string | null)[] = [];
  const notices: string[] = [];
  const options: string[][] = [];
  const state = { live: true, inputCalls: 0, cliRegistered: false };
  const ctx = {
    cwd: "/review", review: { snapshot: () => state.live ? {} : null },
    selection: { file: null, hunkIndex: null }, notify: (text: string) => notices.push(text),
    dialogs: {
      select: async (arg: { options: string[] }) => { options.push(arg.options); return answers.shift() ?? null; },
      input: async () => { state.inputCalls++; return null; }, confirm: async () => false,
    },
  } as unknown as ExtensionCommandContext;
  register({
    apiVersion: 10,
    registerCommand: (cmd: { id: string }, handler: (ctx: ExtensionCommandContext) => Promise<void> | void) => commands.set(cmd.id, handler),
    registerCliCommand: () => { state.cliRegistered = true; }, on: () => {}, log: () => {},
  } as unknown as HunkExtensionAPI);
  return { commands, ctx, answers, notices, options, state, invoke: async (id: string) => commands.get(id)!(ctx) };
}

test("registers discoverable commands and diagnostic CLI without requiring status-row API", () => {
  const h = host();
  assert.deepEqual([...h.commands.keys()], ["menu", "pick", "prompt", "status", "reveal", "reveal-temporary", "hide", "stop"]);
  assert.equal(h.state.cliRegistered, true);
});

test("cancelled picker never spawns or prompts", async t => {
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent]);
  const spawn = t.mock.method(Bridge.prototype, "spawn", async () => agent);
  const prompt = t.mock.method(Bridge.prototype, "prompt", async () => {});
  const h = host();
  await h.invoke("prompt");
  assert.ok(h.options[0]!.some(value => value.includes("w1:p2")));
  assert.ok(h.options[0]!.includes("Leave unchanged"));
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(prompt.mock.callCount(), 0);
  assert.equal(h.state.inputCalls, 0);
});

test("cancelled agent kind does not mutate layout", async t => {
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => []);
  const spawn = t.mock.method(Bridge.prototype, "spawn", async () => agent);
  const h = host();
  h.answers.push("+ Create temporary agent (hidden sibling)", "Leave unchanged");
  await h.invoke("pick");
  assert.equal(spawn.mock.callCount(), 0);
});

test("reload during discovery cancels stale UI work", async t => {
  const h = host();
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => { h.state.live = false; return [agent]; });
  await h.invoke("pick");
  assert.equal(h.options.length, 0);
});

test("overlapping actions are refused rather than double spawning", async t => {
  let finish!: (pane: Pane) => void;
  t.mock.method(Bridge.prototype, "caller", () => new Promise<Pane>(resolve => { finish = resolve; }));
  t.mock.method(Bridge.prototype, "agents", async () => []);
  const h = host();
  const pending = h.invoke("pick");
  await h.invoke("pick");
  assert.ok(h.notices.includes("Herdr operation in progress…"));
  finish(caller);
  await pending;
});
