import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionReviewSelection, ExtensionReviewSnapshot, ExtensionReviewSnapshotNote } from "hunkdiff/extension";
import { nearestToCursor, nearestToLine, removeThread, rowIndexOf, threadAtSelection, threadsForCommentIds, type LineAnchor } from "../threads.ts";
import type { Run } from "../bridge.ts";

function note(id: string, options: { parentId?: string; line?: number; hunk?: number } = {}): ExtensionReviewSnapshotNote {
  const line = options.line ?? 12;
  const hunk = options.hunk ?? 0;
  return {
    id, ...(options.parentId ? { parentId: options.parentId } : {}), source: "user", fileKey: "file:one",
    anchor: { newRange: [line, line], preferred: { side: "new", line }, intersectingHunkIndices: [hunk], ownerHunkIndex: hunk },
    summary: id, editable: true, resolution: "active",
  };
}

function snapshot(notes: readonly ExtensionReviewSnapshotNote[]): ExtensionReviewSnapshot {
  return {
    generation: "generation:one", stateRevision: 4,
    files: [{
      fileKey: "file:one", runtimeId: "runtime:one", path: "src/one.ts", changeKind: "change",
      stats: { additions: 1, deletions: 0, truncated: false },
      flags: { untracked: false, binary: false, tooLarge: false, partial: false }, contentIdentity: "content:one",
    }],
    notes,
  };
}

function selection(line: number | null = 12): ExtensionReviewSelection {
  return {
    file: { id: "runtime:one", path: "src/one.ts" } as ExtensionReviewSelection["file"],
    hunkIndex: 0,
    currentLine: line === null ? null : { side: "new", line },
  };
}

test("finds one whole thread at the current line and orders children before parents", () => {
  const root = note("root");
  const reply = note("reply", { parentId: "root" });
  const nested = note("nested", { parentId: "reply" });
  const match = threadAtSelection(snapshot([root, reply, nested]), selection());
  assert.equal(match.kind, "found");
  if (match.kind === "found") assert.deepEqual(match.notes.map(item => item.id), ["nested", "reply", "root"]);
});

test("picks the thread nearest the cursor line when the hunk holds several", () => {
  const notes = [note("near", { line: 14 }), note("far", { line: 30 }), note("reply", { parentId: "far", line: 31 })];
  const match = threadAtSelection(snapshot(notes), selection(12));
  assert.equal(match.kind, "found");
  if (match.kind === "found") assert.equal(match.root.id, "near");

  const below = threadAtSelection(snapshot(notes), selection(26));
  if (below.kind === "found") assert.deepEqual(below.notes.map(item => item.id), ["reply", "far"]);
  else assert.fail("expected the lower thread");
});

test("a note whose range contains the line wins over a closer edge", () => {
  const spanning: ExtensionReviewSnapshotNote = { ...note("span"), anchor: { ...note("span").anchor, newRange: [10, 20] } };
  const match = threadAtSelection(snapshot([spanning, note("edge", { line: 21 })]), selection(20));
  assert.equal(match.kind === "found" && match.root.id, "span");
});

test("refuses only an exact tie, naming how to break it", () => {
  const tie = threadAtSelection(snapshot([note("one", { line: 10 }), note("two", { line: 14 })]), selection(12));
  assert.equal(tie.kind, "ambiguous");
  if (tie.kind === "ambiguous") assert.match(tie.message, /2 of your comments are equally close/);

  const noLine = threadAtSelection(snapshot([note("one"), note("two")]), selection(null));
  assert.equal(noLine.kind, "ambiguous");
  if (noLine.kind === "ambiguous") assert.match(noLine.message, /share this hunk/);
});

test("an agent's comment beside yours never makes the hunk ambiguous", () => {
  const agentNote: ExtensionReviewSnapshotNote = { ...note("agent", { line: 12 }), source: "agent" };
  const mine = note("mine", { line: 30 });
  // Same line as the agent's comment, and no current line at all: still yours.
  for (const at of [selection(12), selection(null)]) {
    const match = threadAtSelection(snapshot([agentNote, mine]), at);
    assert.equal(match.kind === "found" && match.root.id, "mine");
  }
  // With none of your comments in the hunk, the agent's thread is what X resolves.
  const only = threadAtSelection(snapshot([agentNote]), selection(12));
  assert.equal(only.kind === "found" && only.root.id, "agent");
});

test("falls back to the selected hunk when no exact line matches", () => {
  const match = threadAtSelection(snapshot([note("root", { line: 18 })]), selection(12));
  assert.equal(match.kind, "found");
});

test("expands displayed-group comment IDs to complete native threads", () => {
  const root = note("root");
  const reply = note("reply", { parentId: "root" });
  const other = note("other", { line: 20 });
  assert.deepEqual(threadsForCommentIds(snapshot([root, reply, other]), new Set(["reply"])).map(item => item.id), ["reply", "root"]);
});

test("removes a thread through the exact live session in supplied order", async () => {
  const calls: string[][] = [];
  const run: Run = async (_binary, args) => {
    calls.push(args);
    if (args[1] === "list") return JSON.stringify({ sessions: [
      { sessionId: "other", snapshot: { state: { reviewPublication: { generation: "generation:other" } } } },
      { sessionId: "wanted", snapshot: { state: { reviewPublication: { generation: "generation:one" } } } },
    ] });
    return JSON.stringify({ result: {} });
  };
  await removeThread(run, "/review", "generation:one", [note("reply", { parentId: "root" }), note("root")]);
  assert.deepEqual(calls, [
    ["session", "list", "--json"],
    ["session", "comment", "rm", "wanted", "reply", "--json"],
    ["session", "comment", "rm", "wanted", "root", "--json"],
  ]);
});

test("does not remove anything when the live session is not uniquely identified", async () => {
  const calls: string[][] = [];
  const run: Run = async (_binary, args) => { calls.push(args); return JSON.stringify({ sessions: [] }); };
  await assert.rejects(removeThread(run, "/review", "missing", [note("root")]), /could not be identified/);
  assert.equal(calls.length, 1);
});

test("a cursor that names a note row resolves to that item exactly, and to nothing without an id", () => {
  const anchors: Record<string, LineAnchor> = {
    a: { newRange: [10, 10], preferred: { side: "new", line: 10 } },
    b: { newRange: [11, 11], preferred: { side: "new", line: 11 } },
  };
  const items = Object.keys(anchors);
  const by = (id: string) => anchors[id]!;
  assert.deepEqual(nearestToCursor(items, by, { at: null, noteId: "b" }, id => id), { kind: "one", item: "b", distance: 0 });
  assert.deepEqual(nearestToCursor(items, by, { at: null, noteId: "zz" }, id => id), { kind: "none" });
  assert.equal(nearestToCursor(items, by, { at: null }).kind, "tie", "a note row nobody identified is a tie");
  assert.deepEqual(nearestToCursor(items, by, { at: { side: "new", line: 10 } }), { kind: "one", item: "a", distance: 0 });
});

test("threadAtSelection takes the named note's thread whoever wrote it, and explains an unidentified note row", () => {
  const agentNote: ExtensionReviewSnapshotNote = { ...note("agent", { line: 12 }), source: "agent" };
  const notes = [note("one", { line: 10 }), note("two", { line: 11 }), agentNote, note("reply", { parentId: "two", line: 11 })];
  const onRow = threadAtSelection(snapshot(notes), selection(null), { at: null, noteId: "two" });
  assert.equal(onRow.kind === "found" && onRow.root.id, "two");
  if (onRow.kind === "found") assert.deepEqual(onRow.notes.map(item => item.id), ["reply", "two"]);
  const onAgent = threadAtSelection(snapshot(notes), selection(null), { at: null, noteId: "agent" });
  assert.equal(onAgent.kind === "found" && onAgent.root.id, "agent", "X on an agent's row resolves that thread");
  const lost = threadAtSelection(snapshot(notes), selection(null));
  if (lost.kind === "ambiguous") assert.match(lost.message, /did not say which is under the cursor/);
  else assert.fail("expected a tie without an identified note");
});

test("with a row index, nearness is counted in rendered rows so old-side and new-side rows compare", () => {
  // Rows: -10, -11, -12, +10, +11 (a hunk replacing three lines with two).
  const rows = rowIndexOf([
    { side: "old", line: 10 }, { side: "old", line: 11 }, { side: "old", line: 12 }, { side: "new", line: 10 }, { side: "new", line: 11 },
  ]);
  const anchors: Record<string, LineAnchor> = {
    top: { oldRange: [10, 10], preferred: { side: "old", line: 10 } },
    bottom: { newRange: [11, 11], preferred: { side: "new", line: 11 } },
  };
  const by = (id: string) => anchors[id]!;
  // Cursor on the +10 row: one row from "bottom" (+11), three rows from "top" (-10).
  assert.deepEqual(nearestToLine(Object.keys(anchors), by, { side: "new", line: 10 }, rows), { kind: "one", item: "bottom", distance: 1 });
  // Cursor on -12: one row from "top"? no — two rows from -10, one row from +10 but that is not a note; "bottom" is two rows away too: a tie.
  assert.equal(nearestToLine(Object.keys(anchors), by, { side: "old", line: 12 }, rows).kind, "tie");
  // Without a row index the old rule applies: an old-side cursor cannot reach a new-side anchor.
  assert.deepEqual(nearestToLine(Object.keys(anchors), by, { side: "old", line: 12 }), { kind: "one", item: "top", distance: 2 });
});
