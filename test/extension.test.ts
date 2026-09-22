import { test } from "node:test";
import assert from "node:assert/strict";
import register from "../index.ts";
import { Bridge, type Pane } from "../bridge.ts";
import type { ExtensionCommandContext, ExtensionReviewNote, HunkExtensionAPI } from "hunkdiff/extension";
import { resetThreadBoard, threadBoardSnapshot } from "../threads-pane.tsx";

const caller: Pane = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "caller" };
const agent: Pane = { ...caller, pane_id: "w1:p2", terminal_id: "agent", agent: "pi", agent_status: "idle" };

function host(config: Record<string, unknown> = {}) {
  const commands = new Map<string, (ctx: ExtensionCommandContext) => Promise<void> | void>();
  const answers: (string | null)[] = [];
  const inputs: (string | null)[] = [];
  const notices: string[] = [];
  const options: string[][] = [];
  const openedPanes: string[] = [];
  const openPanes = new Set<string>();
  const keyboardModes = new Map<string, { onEnter?: () => void; onExit?: () => void }>();
  let activeKeyboardMode: string | undefined;
  const events = new Map<string, (payload: unknown, ctx: unknown) => void | Promise<void>>();
  const state = { live: true, inputCalls: 0, cliRegistered: false, paneRegistered: false, keyboardModeRegistered: false };
  const ctx = {
    cwd: "/review", review: { snapshot: () => state.live ? {} : null },
    selection: { file: null, hunkIndex: null }, notify: (text: string) => notices.push(text),
    panes: {
      open: (id: string) => { openPanes.add(id); openedPanes.push(id); },
      close: (id: string) => { openPanes.delete(id); },
      toggle: (id: string) => { openPanes.has(id) ? openPanes.delete(id) : openPanes.add(id); },
      isOpen: (id: string) => openPanes.has(id),
    },
    keyboardModes: {
      enterMode: (id: string) => { activeKeyboardMode = id; keyboardModes.get(id)?.onEnter?.(); return true; },
      exitMode: () => { keyboardModes.get(activeKeyboardMode ?? "")?.onExit?.(); activeKeyboardMode = undefined; return true; },
      isActive: (id?: string) => activeKeyboardMode !== undefined && (!id || activeKeyboardMode === id),
    },
    dialogs: {
      select: async (arg: { options: string[] }) => { options.push(arg.options); return answers.shift() ?? null; },
      input: async () => { state.inputCalls++; return inputs.shift() ?? null; }, confirm: async () => false,
    },
  } as unknown as ExtensionCommandContext;
  register({
    apiVersion: 10, config,
    registerPane: () => { state.paneRegistered = true; },
    registerKeyboardMode: (mode: { id: string; onEnter?: () => void; onExit?: () => void }) => { keyboardModes.set(mode.id, mode); state.keyboardModeRegistered = true; },
    registerCommand: (cmd: { id: string }, handler: (ctx: ExtensionCommandContext) => Promise<void> | void) => commands.set(cmd.id, handler),
    registerCliCommand: () => { state.cliRegistered = true; },
    on: (event: string, handler: (payload: unknown, ctx: unknown) => void | Promise<void>) => { events.set(event, handler); },
    log: () => {},
  } as unknown as HunkExtensionAPI);
  return {
    commands, ctx, answers, inputs, notices, options, openedPanes, state,
    invoke: async (id: string) => commands.get(id)!(ctx),
    emit: async (event: string, payload: unknown) => events.get(event)?.(payload, ctx),
  };
}

test("registers discoverable commands and diagnostic CLI without requiring status-row API", () => {
  const h = host();
  assert.deepEqual([...h.commands.keys()], ["menu", "threads", "focus-threads", "pick", "prompt", "status", "reveal", "hide", "stop", "resolve-thread", "reassign-thread-group"]);
  assert.equal(h.state.cliRegistered, true);
  assert.equal(h.state.paneRegistered, true);
  assert.equal(h.state.keyboardModeRegistered, true);
});

 test("saved user comments can create a thread and open the sidebar", async () => {
  resetThreadBoard();
  const h = host();
  const note: ExtensionReviewNote = {
    id: "user:one", fileId: "runtime:one", filePath: "src/one.ts", hunkIndex: 0,
    side: "new", line: 12, body: "Handle expired credentials", draft: false,
  };
  h.answers.push("+ Create new thread…");
  h.inputs.push("Authentication");
  await h.emit("note_created", { note });
  assert.equal(threadBoardSnapshot().threads[0]?.title, "Authentication");
  assert.deepEqual(h.openedPanes, ["threads"]);
  assert.match(h.notices.at(-1)!, /Assigned comment/);

  await h.emit("note_created", { note: { ...note, id: "user:two", body: "Add a refresh test" } });
  assert.match(h.options[1]![0]!, /^Authentication · 1 comment/);
});

test("Unassigned groups explicitly unassigned comments", async () => {
  resetThreadBoard();
  const h = host();
  const note: ExtensionReviewNote = {
    id: "user:one", fileId: "runtime:one", filePath: "src/one.ts", hunkIndex: 0,
    side: "new", line: 12, body: "Handle expired credentials", draft: false,
  };
  h.answers.push("Unassigned", "Unassigned");
  await h.emit("note_created", { note });
  await h.emit("note_created", { note: { ...note, id: "user:two" } });
  assert.deepEqual(threadBoardSnapshot().threads.map(thread => [thread.title, thread.comments.length]), [["Unassigned", 2]]);
});

test("cancelling assignment puts the comment in Unassigned", async () => {
  resetThreadBoard();
  const h = host();
  const note: ExtensionReviewNote = {
    id: "user:one", fileId: "runtime:one", filePath: "src/one.ts", hunkIndex: 0,
    side: "new", line: 12, body: "Handle expired credentials", draft: false,
  };
  await h.emit("note_created", { note });
  assert.deepEqual(threadBoardSnapshot().threads.map(thread => [thread.title, thread.comments.length]), [["Unassigned", 1]]);
});

test("reassigns the selected Threads group through the pane command", async () => {
  resetThreadBoard();
  const h = host();
  const first: ExtensionReviewNote = {
    id: "user:one", fileId: "runtime:one", filePath: "src/one.ts", hunkIndex: 0,
    side: "new", line: 12, body: "Handle expired credentials", draft: false,
  };
  h.answers.push("+ Create new thread…", "+ Create new thread…");
  h.inputs.push("Authentication", "Tests");
  await h.emit("note_created", { note: first });
  await h.emit("note_created", { note: { ...first, id: "user:two", body: "Add a refresh test" } });
  await h.invoke("focus-threads");
  h.answers.push("Tests · 1 comment [1]");
  await h.invoke("reassign-thread-group");
  assert.deepEqual(threadBoardSnapshot().threads.map(thread => [thread.title, thread.comments.length]), [["Tests", 2]]);
  assert.match(h.notices.at(-1)!, /Moved 1 comment to thread: Tests/);
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

test("configuration filters existing agents and prefers default without spawning on cancel", async t => {
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent, { ...agent, pane_id: "w1:p3", agent: "codex" }]);
  const spawn = t.mock.method(Bridge.prototype, "spawn", async () => agent);
  const h = host({ agents: ["pi", "claude"], default_agent: "claude" });
  h.answers.push("+ Create temporary agent (hidden sibling)", "Leave unchanged");
  await h.invoke("pick");
  assert.ok(h.options[0]!.some(value => value.includes("w1:p2")));
  assert.ok(!h.options[0]!.some(value => value.includes("w1:p3")));
  assert.deepEqual(h.options[1], ["claude", "pi", "Leave unchanged"]);
  assert.equal(spawn.mock.callCount(), 0);
});

test("empty agents list offers only cancellation", async t => {
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent]);
  const h = host({ agents: [] });
  await h.invoke("pick");
  assert.deepEqual(h.options[0], ["Leave unchanged"]);
});

test("invalid config warns without spawning", async t => {
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  const spawn = t.mock.method(Bridge.prototype, "spawn", async () => agent);
  const h = host({ agents: ["sh"] });
  await h.invoke("pick");
  assert.match(h.notices[0]!, /agents must be/);
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
