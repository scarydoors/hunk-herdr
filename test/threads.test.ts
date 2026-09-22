import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionReviewSelection, ExtensionReviewSnapshot, ExtensionReviewSnapshotNote } from "hunkdiff/extension";
import { removeThread, threadAtSelection, threadsForCommentIds } from "../threads.ts";
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
  if (tie.kind === "ambiguous") assert.match(tie.message, /2 review threads are equally close/);

  const noLine = threadAtSelection(snapshot([note("one"), note("two")]), selection(null));
  assert.equal(noLine.kind, "ambiguous");
  if (noLine.kind === "ambiguous") assert.match(noLine.message, /share this hunk/);
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
