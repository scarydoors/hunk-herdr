import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionReviewSnapshot, ExtensionReviewSnapshotNote } from "hunkdiff/extension";
import { fileStops, moveForCommand, patchLineStops, replayMoves, stopAddress, type Stop } from "../cursor.ts";

const patch = [
  "diff --git a/app.ts b/app.ts", "--- a/app.ts", "+++ b/app.ts",
  "@@ -7,4 +7,4 @@ ctx", " line 7", "-line 8", "-line 9", "+line 8 changed", "+line 9 changed", " line 10",
  "@@ -20,2 +19,3 @@", " line 20", "+added", "\\ No newline at end of file", " line 21",
].join("\n");

function note(id: string, side: "old" | "new", line: number, extra: Partial<ExtensionReviewSnapshotNote> = {}): ExtensionReviewSnapshotNote {
  return {
    id, source: "user", fileKey: "file:app", summary: id, editable: true, resolution: "active",
    anchor: { [side === "old" ? "oldRange" : "newRange"]: [line, line], preferred: { side, line }, intersectingHunkIndices: [0], ownerHunkIndex: 0 },
    ...extra,
  };
}

function snapshot(notes: ExtensionReviewSnapshotNote[]): ExtensionReviewSnapshot {
  return {
    generation: "g", stateRevision: 1, notes,
    files: [{ fileKey: "file:app", runtimeId: "rt:app", path: "app.ts", changeKind: "change", stats: { additions: 2, deletions: 2, truncated: false }, flags: { untracked: false, binary: false, tooLarge: false, partial: false }, contentIdentity: "c" }],
  };
}

test("a unified patch becomes Hunk's row order: deletions on the old side, additions and context on the new", () => {
  assert.deepEqual(patchLineStops(patch).map(stop => `${stop.hunkIndex}:${stop.side}${stop.line}`), [
    "0:new7", "0:old8", "0:old9", "0:new8", "0:new9", "0:new10",
    "1:new19", "1:new20", "1:new21",
  ]);
});

test("notes sit directly under their anchor row, replies after their root, agent notes only when shown", () => {
  const notes = [
    note("agent", "old", 9, { source: "agent" }),
    note("root", "old", 9),
    note("reply", "old", 9, { parentId: "root" }),
    note("ctx", "new", 10),
  ];
  const ids = (stops: Stop[]) => stops.map(stop => stop.kind === "line" ? `${stop.side}${stop.line}` : `note:${stop.noteId}`);
  assert.deepEqual(ids(fileStops({ id: "rt:app", patch }, snapshot(notes), true)), [
    "new7", "old8", "old9", "note:agent", "note:root", "note:reply", "new8", "new9", "new10", "note:ctx", "new19", "new20", "new21",
  ]);
  assert.deepEqual(ids(fileStops({ id: "rt:app", patch }, snapshot(notes), false)).filter(id => id.startsWith("note")), ["note:root", "note:reply", "note:ctx"]);
  const reply = fileStops({ id: "rt:app", patch }, snapshot(notes), true).find(stop => stop.kind === "note" && stop.noteId === "reply");
  assert.deepEqual(reply && stopAddress(reply), { at: null, noteId: "root" }, "a reply row names its root");
});

test("moves replay the way Hunk steps: adjacent stops, clamped ends, and note-to-note jumps", () => {
  const stops = fileStops({ id: "rt:app", patch }, snapshot([note("root", "old", 9), note("ctx", "new", 10)]), true);
  const at = (stop: Stop | undefined) => stop && (stop.kind === "line" ? `${stop.side}${stop.line}` : `note:${stop.noteId}`);
  const fromLine9 = { kind: "line" as const, fileId: "rt:app", hunkIndex: 0, side: "old" as const, line: 9 };
  assert.equal(at(replayMoves(stops, fromLine9, [{ kind: "step", delta: 1 }])), "note:root", "down from a line lands on the note under it");
  assert.equal(at(replayMoves(stops, fromLine9, [{ kind: "step", delta: 1 }, { kind: "step", delta: 1 }])), "new8");
  assert.equal(at(replayMoves(stops, { kind: "note", noteId: "ctx" }, [{ kind: "step", delta: -1 }])), "new10", "up from a note row is its anchor row");
  assert.equal(at(replayMoves(stops, fromLine9, [{ kind: "note", delta: 1 }])), "note:root", "next note from a line is the first note below");
  assert.equal(at(replayMoves(stops, { kind: "note", noteId: "root" }, [{ kind: "note", delta: 1 }])), "note:ctx");
  assert.equal(at(replayMoves(stops, { kind: "note", noteId: "ctx" }, [{ kind: "note", delta: -1 }])), "note:root");
  assert.equal(replayMoves(stops, { kind: "note", noteId: "ctx" }, [{ kind: "note", delta: 1 }]), undefined, "past the file's last note Hunk moves to another file");
  assert.equal(at(replayMoves(stops, fromLine9, Array.from({ length: 50 }, () => ({ kind: "step" as const, delta: -1 })))), "new7", "steps clamp at the top");
  assert.equal(replayMoves(stops, { kind: "note", noteId: "gone" }, []), undefined);
});

test("hunk jumps land on the first row of the target hunk, and give up past the file", () => {
  const stops = fileStops({ id: "rt:app", patch }, snapshot([note("root", "old", 9)]), true);
  const at = (stop: Stop | undefined) => stop && (stop.kind === "line" ? `${stop.hunkIndex}:${stop.side}${stop.line}` : `note:${stop.noteId}`);
  const fromRoot = { kind: "note" as const, noteId: "root" };
  assert.equal(at(replayMoves(stops, fromRoot, [{ kind: "hunk", delta: 1, annotated: false }])), "1:new19");
  assert.equal(at(replayMoves(stops, { kind: "line", fileId: "rt:app", hunkIndex: 1, side: "new", line: 20 }, [{ kind: "hunk", delta: -1, annotated: false }])), "0:new7");
  assert.equal(replayMoves(stops, fromRoot, [{ kind: "hunk", delta: 1, annotated: true }]), undefined, "no later hunk with a note in this file");
  assert.equal(at(replayMoves(stops, { kind: "line", fileId: "rt:app", hunkIndex: 1, side: "new", line: 20 }, [{ kind: "hunk", delta: -1, annotated: true }])), "0:new7");
  assert.equal(replayMoves(stops, fromRoot, [{ kind: "hunk", delta: -1, annotated: false }]), undefined, "before the first hunk means another file");
});

test("only step, note and hunk commands replay; page, jump, hunk and file moves lose the position", () => {
  assert.deepEqual(moveForCommand("hunk.review.stepDown"), { kind: "step", delta: 1 });
  assert.deepEqual(moveForCommand("hunk.review.previousNote"), { kind: "note", delta: -1 });
  assert.deepEqual(moveForCommand("hunk.review.nextAnnotatedHunk"), { kind: "hunk", delta: 1, annotated: true });
  assert.equal(moveForCommand("hunk.review.pageDown"), "lost");
  assert.equal(moveForCommand("hunk.review.nextFile"), "lost");
  assert.equal(moveForCommand("hunk.app.toggleHelp"), undefined);
});
