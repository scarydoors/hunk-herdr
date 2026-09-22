import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionReviewSelection, ExtensionReviewSnapshot, ExtensionReviewSnapshotNote } from "hunkdiff/extension";
import { nearestToLine, removeThread, threadAtSelection, threadsForCommentIds, type LineAnchor } from "../threads.ts";
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

test("refuses an ambiguous location without selecting a thread", () => {
  const match = threadAtSelection(snapshot([note("one"), note("two")]), selection());
  assert.equal(match.kind, "ambiguous");
  if (match.kind === "ambiguous") assert.match(match.message, /2 review threads/);
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

test("nearestToLine measures by range containment, then by gap, and reports exact ties", () => {
  const anchors: Record<string, LineAnchor> = {
    span: { newRange: [10, 20], preferred: { side: "new", line: 10 } },
    edge: { newRange: [21, 21], preferred: { side: "new", line: 21 } },
    far: { oldRange: [5, 5], preferred: { side: "old", line: 5 } },
  };
  const by = (id: string) => anchors[id]!;
  assert.deepEqual(nearestToLine(Object.keys(anchors), by, { side: "new", line: 20 }), { kind: "one", item: "span", distance: 0 });
  assert.deepEqual(nearestToLine(Object.keys(anchors), by, { side: "new", line: 23 }), { kind: "one", item: "edge", distance: 2 });
  assert.equal(nearestToLine(["span", "edge"], by, { side: "new", line: 25 }).kind, "one");
  assert.equal(nearestToLine(["a", "b"], () => anchors.edge!, { side: "new", line: 30 }).kind, "tie");
  assert.deepEqual(nearestToLine([], by, { side: "new", line: 1 }), { kind: "none" });
  // An anchor with nothing on the line's side is infinitely far, never a match on distance.
  assert.deepEqual(nearestToLine(["far"], by, { side: "new", line: 5 }), { kind: "one", item: "far", distance: Number.POSITIVE_INFINITY });
});
