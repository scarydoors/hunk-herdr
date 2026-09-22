import { test } from "node:test";
import assert from "node:assert/strict";
import register from "../index.ts";
import { Bridge, type Pane } from "../bridge.ts";
import type { ExtensionKeyEvent, ExtensionCommandContext, ExtensionKeyboardMode, ExtensionReviewNote, ExtensionReviewSelection, ExtensionReviewSnapshot, ExtensionReviewSnapshotNote, HunkExtensionAPI } from "hunkdiff/extension";

type KeyboardMode = { id: string; onKey: ExtensionKeyboardMode["onKey"]; onEnter?: () => void; onExit?: () => void };
import { createThread, resetThreadBoard, threadBoardSnapshot } from "../threads-pane.tsx";
import { DEFAULT_REQUEST } from "../index.ts";

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
  const keyboardModes = new Map<string, KeyboardMode>();
  const inputTitles: string[] = [];
  const inputInitials: string[] = [];
  let activeKeyboardMode: string | undefined;
  const events = new Map<string, (payload: unknown, ctx: unknown) => void | Promise<void>>();
  const state = {
    live: true, inputCalls: 0, cliRegistered: false, paneRegistered: false, keyboardModeRegistered: false,
    snapshot: {} as ExtensionReviewSnapshot,
    selection: { file: null, hunkIndex: null, currentLine: null } as ExtensionReviewSelection,
  };
  const ctx = {
    cwd: "/review", review: { snapshot: () => state.live ? state.snapshot : null },
    get selection() { return state.selection; }, notify: (text: string) => notices.push(text),
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
      input: async (arg: { title: string; initial?: string }) => { state.inputCalls++; inputTitles.push(arg.title); inputInitials.push(arg.initial ?? ""); return inputs.shift() ?? null; }, confirm: async () => false,
    },
  } as unknown as ExtensionCommandContext;
  register({
    apiVersion: 10, config,
    registerPane: () => { state.paneRegistered = true; },
    registerKeyboardMode: (mode: KeyboardMode) => { keyboardModes.set(mode.id, mode); state.keyboardModeRegistered = true; },
    registerCommand: (cmd: { id: string }, handler: (ctx: ExtensionCommandContext) => Promise<void> | void) => commands.set(cmd.id, handler),
    registerCliCommand: () => { state.cliRegistered = true; },
    on: (event: string, handler: (payload: unknown, ctx: unknown) => void | Promise<void>) => { events.set(event, handler); },
    log: () => {},
  } as unknown as HunkExtensionAPI);
  return {
    commands, ctx, answers, inputs, inputTitles, inputInitials, notices, options, openedPanes, state,
    invoke: async (id: string) => commands.get(id)!(ctx),
    /** Focus Threads navigation, which selects the first row (or the cursor's comment). */
    focus: () => ctx.keyboardModes.enterMode("threads"),
    press: (key: Partial<ExtensionKeyEvent>) =>
      keyboardModes.get("threads")!.onKey({ name: "", sequence: "", ...key } as ExtensionKeyEvent, ctx as never),
    emit: async (event: string, payload: unknown) => events.get(event)?.(payload, ctx),
  };
}

const authNote: ExtensionReviewNote = {
  id: "user:one", fileId: "runtime:one", filePath: "src/auth.ts", hunkIndex: 0,
  side: "new", line: 12, body: "Handle expiry", draft: false,
};

/** A review snapshot with one file and the given active user root comments. */
function reviewAt(notes: readonly { id: string; line: number; source?: ExtensionReviewSnapshotNote["source"] }[]): ExtensionReviewSnapshot {
  return {
    generation: "generation:one", stateRevision: 1,
    files: [{
      fileKey: "file:auth", runtimeId: "runtime:one", path: "src/auth.ts", changeKind: "change",
      stats: { additions: 1, deletions: 0, truncated: false },
      flags: { untracked: false, binary: false, tooLarge: false, partial: false }, contentIdentity: "content:auth",
    }],
    notes: notes.map(note => ({
      id: note.id, source: note.source ?? "user", fileKey: "file:auth", summary: `Comment ${note.id}`, editable: true, resolution: "active",
      anchor: { newRange: [note.line, note.line], preferred: { side: "new", line: note.line }, intersectingHunkIndices: [0], ownerHunkIndex: 0 },
    })),
  };
}

function cursorAt(line: number): ExtensionReviewSelection {
  return { file: { id: "runtime:one", path: "src/auth.ts" } as ExtensionReviewSelection["file"], hunkIndex: 0, currentLine: { side: "new", line } };
}

test("registers discoverable commands and diagnostic CLI without requiring status-row API", () => {
  const h = host();
  assert.deepEqual([...h.commands.keys()], ["menu", "threads", "focus-threads", "pick", "help", "models", "prompt", "status", "reveal", "hide", "stop", "resolve-thread", "reassign-thread-group"]);
  assert.equal(h.state.cliRegistered, true);
  assert.equal(h.state.paneRegistered, true);
  assert.equal(h.state.keyboardModeRegistered, true);
});

test("a saved comment lands in Unassigned without a dialog when its file has no group yet", async () => {
  resetThreadBoard();
  const h = host();
  await h.emit("note_created", { note: authNote });
  assert.equal(h.options.length, 0, "no assignment dialog");
  assert.deepEqual(threadBoardSnapshot().threads.map(thread => [thread.title, thread.comments.length]), [["Unassigned", 1]]);
  assert.deepEqual(h.openedPanes, ["threads"]);
  assert.equal(h.notices.at(-1), "Added to Unassigned · Ctrl+R to move or name");
});

test("a saved comment joins the group holding the closest comment in the same file", async () => {
  resetThreadBoard();
  const h = host();
  createThread("Authentication", authNote);
  createThread("Tests", { ...authNote, id: "user:test", line: 200 });
  await h.emit("note_created", { note: { ...authNote, id: "user:two", line: 30, body: "Refresh the token" } });
  await h.emit("note_created", { note: { ...authNote, id: "user:three", line: 190, body: "Cover the failure path" } });
  await h.emit("note_created", { note: { ...authNote, id: "user:four", filePath: "src/other.ts", fileId: "runtime:two", body: "Unrelated" } });
  assert.deepEqual(threadBoardSnapshot().threads.map(thread => [thread.title, thread.comments.map(comment => comment.id)]), [
    ["Authentication", ["user:one", "user:two"]],
    ["Tests", ["user:test", "user:three"]],
    ["Unassigned", ["user:four"]],
  ]);
  assert.equal(h.notices[0], "Added to Authentication · Ctrl+R to move or name");
});

test("native replies do not trigger thread assignment", async () => {
  resetThreadBoard();
  const h = host();
  await h.emit("note_created", { note: { ...authNote, id: "user:reply", parentId: "user:root", body: "Follow-up" } });
  assert.deepEqual(threadBoardSnapshot().threads, []);
  assert.deepEqual(h.openedPanes, []);
});

test("reassigns the selected Threads group through the pane command", async () => {
  resetThreadBoard();
  const h = host();
  createThread("Authentication", authNote);
  createThread("Tests", { ...authNote, id: "user:two", filePath: "src/auth.test.ts", body: "Add a refresh test" });
  await h.invoke("focus-threads");
  h.answers.push("Tests · 1 comment [1]");
  await h.invoke("reassign-thread-group");
  assert.deepEqual(threadBoardSnapshot().threads.map(thread => [thread.title, thread.comments.length]), [["Tests", 2]]);
  assert.match(h.notices.at(-1)!, /Moved 1 comment to thread: Tests/);
});

test("Ctrl+R from the review cursor names the comment under it, filing it first if needed", async () => {
  resetThreadBoard();
  const h = host();
  // A comment saved before this session is in no group yet; the cursor sits on it.
  h.state.snapshot = reviewAt([{ id: "user:old", line: 40 }]);
  h.state.selection = cursorAt(40);
  h.answers.push("+ Create new thread…");
  h.inputs.push("Authentication");
  await h.invoke("reassign-thread-group");
  assert.deepEqual(threadBoardSnapshot().threads.map(thread => [thread.title, thread.comments.map(comment => comment.id)]), [
    ["Unassigned", []], ["Authentication", ["user:old"]],
  ]);
  assert.match(h.notices.at(-1)!, /Moved comment to thread: Authentication/);
});

test("P on a line with no comment warns instead of prompting anything", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  const agents = t.mock.method(Bridge.prototype, "agents", async () => [agent]);
  const h = host();
  h.state.snapshot = reviewAt([{ id: "user:one", line: 12 }]);
  h.state.selection = cursorAt(90);
  h.state.snapshot = { ...h.state.snapshot, notes: [] };
  await h.invoke("prompt");
  assert.equal(h.notices.at(-1), "No review comment at the cursor. Save one, or focus Threads (Ctrl+T).");
  assert.equal(agents.mock.callCount(), 0);
  assert.equal(h.options.length, 0);
});

test("P from the review cursor prompts the group of the comment under it", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent]);
  t.mock.method(Bridge.prototype, "validate", async () => agent);
  const h = host();
  h.state.snapshot = reviewAt([{ id: "user:one", line: 12 }]);
  h.state.selection = cursorAt(13);
  h.answers.push(`○ pi · idle · ${agent.pane_id} · `);
  h.inputs.push(null);
  await h.invoke("prompt");
  assert.match(h.inputTitles.at(-1)!, /· Authentication$/);
});

test("Ctrl+L configures models without Threads focus", async () => {
  const h = host({ agents: ["pi", "claude"] });
  h.answers.push("Leave unchanged");
  await h.invoke("models");
  // Model defaults come from the user's local state, so only the shape is asserted.
  assert.deepEqual(h.options[0]!.map(option => option.split(" · ")[0]), ["Pi", "Claude", "Leave unchanged"]);
});

test("claims \"?\" for the Threads keybinding list instead of losing it to Hunk's own help", () => {
  resetThreadBoard();
  createThread("Authentication", {
    id: "user:one", fileId: "runtime:one", filePath: "src/auth.ts", hunkIndex: 0,
    side: "new", line: 12, body: "Handle expiry", draft: false,
  });
  const h = host();
  h.ctx.keyboardModes.enterMode("threads");
  assert.equal(h.press({ sequence: "?", shift: true }), "handled");
  assert.equal(threadBoardSnapshot().helpVisible, true);
  assert.equal(h.press({ sequence: "?", shift: true }), "handled");
  assert.equal(threadBoardSnapshot().helpVisible, false);
  assert.equal(h.press({ name: "j" }), "handled", "navigation keys keep working");
});

test("closes a temporary agent once the last comment of its group is resolved", async t => {
  resetThreadBoard();
  createThread("Authentication", {
    id: "user:one", fileId: "runtime:one", filePath: "src/auth.ts", hunkIndex: 0,
    side: "new", line: 12, body: "Handle expiry", draft: false,
  });
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => []);
  t.mock.method(Bridge.prototype, "layout", async () => ({ zoomed: true, focused_pane_id: caller.pane_id, area: { width: 100, height: 40 } }));
  t.mock.method(Bridge.prototype, "spawn", async () => agent);
  const stop = t.mock.method(Bridge.prototype, "stop", async () => {});
  const h = host();
  h.focus();
  h.answers.push("+ Start temporary agent…", "pi");
  await h.invoke("pick");
  assert.equal(threadBoardSnapshot().threads.length, 1);

  // Resolving from the review, rather than the pane, reaches Herdr only as this event.
  await h.emit("note_changed", { kind: "removed", note: { id: "user:one", anchor: { preferred: null } } });
  assert.equal(stop.mock.callCount(), 1);
  assert.deepEqual(threadBoardSnapshot().threads, []);
  assert.match(h.notices.at(-1)!, /temporary agent was closed/);
});

test("retires an emptied group without ever closing an agent the user picked", async t => {
  resetThreadBoard();
  createThread("Authentication", {
    id: "user:one", fileId: "runtime:one", filePath: "src/auth.ts", hunkIndex: 0,
    side: "new", line: 12, body: "Handle expiry", draft: false,
  });
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent]);
  t.mock.method(Bridge.prototype, "validate", async () => agent);
  const stop = t.mock.method(Bridge.prototype, "stop", async () => {});
  const h = host();
  h.focus();
  h.answers.push(`○ pi · idle · ${agent.pane_id} · `);
  await h.invoke("pick");

  await h.emit("note_changed", { kind: "removed", note: { id: "user:one", anchor: { preferred: null } } });
  assert.equal(stop.mock.callCount(), 0, "agents the user picked outlive the review");
  assert.deepEqual(threadBoardSnapshot().threads, []);
});

test("resolving runs while an agent operation is still in flight", async t => {
  resetThreadBoard();
  let release!: (pane: Pane) => void;
  t.mock.method(Bridge.prototype, "caller", () => new Promise<Pane>(resolve => { release = resolve; }));
  const h = host();
  const busy = h.invoke("status"); // Holds the slot that used to refuse every other command.
  await new Promise<void>(resolve => setImmediate(resolve));

  await h.invoke("resolve-thread");
  assert.ok(!h.notices.includes("Herdr operation in progress…"));
  assert.equal(h.notices.at(-1), "No review thread at the current location.");

  release(caller);
  await busy;
});

test("releases the command lock while the agent's turn is still running", async t => {
  resetThreadBoard();
  createThread("Authentication", {
    id: "user:one", fileId: "runtime:one", filePath: "src/auth.ts", hunkIndex: 0,
    side: "new", line: 12, body: "Handle expiry", draft: false,
  });
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent]);
  t.mock.method(Bridge.prototype, "validate", async () => agent);
  t.mock.method(Bridge.prototype, "skillPath", async () => "/skills/hunk-review.md");
  // A Herdr wait that never returns is exactly the case that used to strand the lock.
  let settle!: (pane: Pane) => void;
  t.mock.method(Bridge.prototype, "promptWhenReady", () => new Promise<Pane>(resolve => { settle = resolve; }));
  const h = host();
  h.focus();
  h.answers.push(`○ pi · idle · ${agent.pane_id} · `);
  h.inputs.push("Explain this expiry path");
  await h.invoke("prompt");

  assert.match(h.notices.at(-1)!, /^Sent to pi: Authentication\.$/);
  assert.equal(threadBoardSnapshot().threads[0]?.dispatching, true, "the group still reports the running turn");

  // The lock is what used to make every one of these answer "Herdr operation in progress…".
  await h.invoke("resolve-thread");
  await h.invoke("status");
  assert.ok(!h.notices.includes("Herdr operation in progress…"));

  settle({ ...agent, agent_status: "idle" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(threadBoardSnapshot().threads[0]?.dispatching, false);
  assert.equal(threadBoardSnapshot().threads[0]?.completed, true);
  assert.match(h.notices.at(-1)!, /Agent completed the prompt for thread: Authentication/);
});

test("cancelled picker never spawns or prompts", async t => {
  resetThreadBoard();
  createThread("Authentication", {
    id: "user:one", fileId: "runtime:one", filePath: "src/auth.ts", hunkIndex: 0,
    side: "new", line: 12, body: "Handle expiry", draft: false,
  });
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent]);
  const spawn = t.mock.method(Bridge.prototype, "spawn", async () => agent);
  const prompt = t.mock.method(Bridge.prototype, "prompt", async () => {});
  const h = host();
  h.focus();
  await h.invoke("prompt");
  assert.ok(h.options[0]!.some(value => value.includes("w1:p2")));
  assert.ok(h.options[0]!.includes("Leave unchanged"));
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(prompt.mock.callCount(), 0);
  assert.equal(h.state.inputCalls, 0);
});

test("names the model on the prompt screen, and says so when the agent was not started here", async t => {
  resetThreadBoard();
  createThread("Authentication", {
    id: "user:one", fileId: "runtime:one", filePath: "src/auth.ts", hunkIndex: 0,
    side: "new", line: 12, body: "Handle expiry", draft: false,
  });
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent]);
  t.mock.method(Bridge.prototype, "validate", async () => agent);
  const h = host();
  h.focus();
  h.answers.push(`○ pi · idle · ${agent.pane_id} · `);
  h.inputs.push(null); // Cancel before the prompt reaches the local hunk executable.
  await h.invoke("prompt");
  assert.equal(h.state.inputCalls, 1);
  assert.match(h.inputTitles.at(-1)!, /^Prompt pi · model: as started · Authentication$/);
});

test("opens the prompt immediately while a new temporary agent is starting", async t => {
  resetThreadBoard();
  createThread("Authentication", {
    id: "user:one", fileId: "runtime:one", filePath: "src/auth.ts", hunkIndex: 0,
    side: "new", line: 12, body: "Handle expiry", draft: false,
  });
  let finishSpawn!: (pane: Pane) => void;
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => []);
  t.mock.method(Bridge.prototype, "layout", async () => ({ zoomed: true, focused_pane_id: caller.pane_id, area: { width: 100, height: 40 } }));
  t.mock.method(Bridge.prototype, "spawn", () => new Promise<Pane>(resolve => { finishSpawn = resolve; }));
  const h = host();
  h.focus();
  h.answers.push("+ Start temporary agent…", "pi");
  // Cancelling after the assertion avoids invoking the local hunk executable.
  h.inputs.push(null);
  const pending = h.invoke("prompt");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.state.inputCalls, 1);
  await pending;
  finishSpawn(agent);
  await new Promise<void>(resolve => setImmediate(resolve));
});

test("cancelled agent kind does not mutate layout", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => []);
  const spawn = t.mock.method(Bridge.prototype, "spawn", async () => agent);
  const h = host();
  h.focus();
  h.answers.push("+ Start temporary agent…", "Leave unchanged");
  await h.invoke("pick");
  assert.equal(spawn.mock.callCount(), 0);
});

test("the default agent is the first picker row and starts without a kind dialog", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent, { ...agent, pane_id: "w1:p3", agent: "codex" }]);
  t.mock.method(Bridge.prototype, "layout", async () => ({ zoomed: true, focused_pane_id: caller.pane_id, area: { width: 100, height: 40 } }));
  const spawn = t.mock.method(Bridge.prototype, "spawn", async () => ({ ...agent, agent: "claude" }));
  const h = host({ agents: ["pi", "claude"], default_agent: "claude" });
  h.focus();
  h.answers.push("__default__");
  const select = h.ctx.dialogs.select;
  // Pick whatever the first row says: its model suffix depends on local state.
  h.ctx.dialogs.select = async arg => { h.options.push([...arg.options]); h.answers.shift(); return arg.options[0]!; };
  await h.invoke("pick");
  h.ctx.dialogs.select = select;
  assert.match(h.options[0]![0]!, /^\+ Start claude \(default\)( · \S+)?$/, "the saved model, if any, is named on the row");
  assert.deepEqual(h.options[0]!.slice(1), [`○ pi · idle · ${agent.pane_id} · `, "+ Start another kind…", "Leave unchanged"]);
  assert.ok(!h.options[0]!.some(value => value.includes("w1:p3")), "kinds outside the configuration are filtered");
  assert.equal(h.options.length, 1, "no second dialog for the default kind");
  assert.deepEqual(spawn.mock.calls.map(call => call.arguments[0]), ["claude"]);
});

test("\"another kind\" lists only the non-default kinds", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => []);
  const spawn = t.mock.method(Bridge.prototype, "spawn", async () => agent);
  const h = host({ agents: ["pi", "claude", "codex"], default_agent: "claude" });
  h.focus();
  h.answers.push("+ Start another kind…", "Leave unchanged");
  await h.invoke("pick");
  assert.deepEqual(h.options[1], ["pi", "codex", "Leave unchanged"]);
  assert.equal(spawn.mock.callCount(), 0);
});

test("a single configured kind is offered directly even without default_agent", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => []);
  const h = host({ agents: ["pi"] });
  h.focus();
  h.answers.push("Leave unchanged");
  await h.invoke("pick");
  assert.deepEqual(h.options[0], ["+ Start pi", "Leave unchanged"]);
});

test("empty agents list offers only cancellation", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent]);
  const h = host({ agents: [] });
  h.focus();
  await h.invoke("pick");
  assert.deepEqual(h.options[0], ["Leave unchanged"]);
});

test("invalid config warns without spawning", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  const spawn = t.mock.method(Bridge.prototype, "spawn", async () => agent);
  const h = host({ agents: ["sh"] });
  h.focus();
  await h.invoke("pick");
  assert.match(h.notices[0]!, /agents must be/);
  assert.equal(spawn.mock.callCount(), 0);
});

test("reload during discovery cancels stale UI work", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  const h = host();
  h.focus();
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => { h.state.live = false; return [agent]; });
  await h.invoke("pick");
  assert.equal(h.options.length, 0);
});

test("an empty prompt sends the default request and clears the draft on hand-off", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent]);
  t.mock.method(Bridge.prototype, "validate", async () => agent);
  t.mock.method(Bridge.prototype, "skillPath", async () => "/skills/hunk-review.md");
  const payloads: string[] = [];
  let settle!: (pane: Pane) => void;
  t.mock.method(Bridge.prototype, "promptWhenReady", (_pane: Pane, text: string) => { payloads.push(text); return new Promise<Pane>(resolve => { settle = resolve; }); });
  const h = host();
  h.focus();
  h.answers.push(`○ pi · idle · ${agent.pane_id} · `);
  h.inputs.push("   ");
  await h.invoke("prompt");
  assert.equal(payloads.length, 1);
  assert.ok(payloads[0]!.endsWith(`User request:\n${DEFAULT_REQUEST}`));

  // While the turn is still running, P again starts from an empty prompt.
  h.inputs.push(null);
  await h.invoke("prompt");
  assert.equal(h.inputInitials.at(-1), "");
  settle({ ...agent, agent_status: "idle" });
  await new Promise<void>(resolve => setImmediate(resolve));
});

test("a failed hand-off keeps the typed request as the draft", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  t.mock.method(Bridge.prototype, "caller", async () => caller);
  t.mock.method(Bridge.prototype, "agents", async () => [agent]);
  t.mock.method(Bridge.prototype, "validate", async () => agent);
  t.mock.method(Bridge.prototype, "skillPath", async () => "/skills/hunk-review.md");
  t.mock.method(Bridge.prototype, "promptWhenReady", async () => { throw new Error("Agent is busy"); });
  const h = host();
  h.focus();
  h.answers.push(`○ pi · idle · ${agent.pane_id} · `);
  h.inputs.push("Explain the expiry path");
  await h.invoke("prompt");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.match(h.notices.at(-1)!, /Agent is busy/);
  h.inputs.push(null);
  await h.invoke("prompt");
  assert.equal(h.inputInitials.at(-1), "Explain the expiry path");
});

test("overlapping actions are refused rather than double spawning", async t => {
  resetThreadBoard();
  createThread("Authentication", authNote);
  let finish!: (pane: Pane) => void;
  t.mock.method(Bridge.prototype, "caller", () => new Promise<Pane>(resolve => { finish = resolve; }));
  t.mock.method(Bridge.prototype, "agents", async () => []);
  const h = host();
  h.focus();
  const pending = h.invoke("pick");
  await h.invoke("pick");
  assert.ok(h.notices.includes("Herdr operation in progress…"));
  finish(caller);
  await pending;
});
