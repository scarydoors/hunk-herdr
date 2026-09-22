import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionDiffFile, ExtensionReviewNote, ExtensionReviewSnapshot } from "hunkdiff/extension";
import { recordCommand, recordFix, resetCursorTracking } from "../cursor.ts";
import {
  assignComment,
  commentAtCursor,
  createThread,
  paneCursor,
  rememberSnapshot,
  createThreadFromComment,
  createThreadFromGroup,
  moveComment,
  moveThreadComments,
  moveThreadSelection,
  nearestThreadForNote,
  removeAssignedComment,
  resetThreadBoard,
  selectedThreadItem,
  setCursorComment,
  setThreadCompleted,
  setThreadDispatching,
  startThreadNavigation,
  stopThreadNavigation,
  suggestedThreadTitle,
  threadBoardSnapshot,
  threadForComment,
  toggleThread,
  toggleThreadHelp,
  updateAssignedComment,
  updateThreadCommentNavigation,
} from "../threads-pane.tsx";

function note(id: string, body: string, parentId?: string): ExtensionReviewNote {
  return {
    id, ...(parentId ? { parentId } : {}), fileId: "runtime:one", filePath: "src/one.ts",
    hunkIndex: 0, side: "new", line: 12, body, draft: false,
  };
}

test("creates expandable session threads and assigns comments", () => {
  resetThreadBoard();
  const created = createThread("Authentication", note("one", "Check auth handling"));
  assert.equal(threadBoardSnapshot().threads[0]?.expanded, true);
  assert.equal(assignComment(created.id, note("two", "Add a regression test", "one")), true);
  assert.deepEqual(threadBoardSnapshot().threads[0]?.comments.map(comment => comment.id), ["one", "two"]);
  assert.equal(threadForComment("two")?.id, created.id);

  toggleThread(created.id);
  assert.equal(threadBoardSnapshot().threads[0]?.expanded, false);
});

test("navigates expanded thread rows and clears the selection on mode exit", () => {
  resetThreadBoard();
  const created = createThread("Authentication", note("one", "Check auth handling"));
  assignComment(created.id, note("two", "Add a regression test"));

  assert.equal(startThreadNavigation(), true);
  assert.equal(selectedThreadItem()?.kind, "thread");
  moveThreadSelection(1);
  assert.deepEqual(selectedThreadItem(), { kind: "comment", thread: threadBoardSnapshot().threads[0], comment: threadBoardSnapshot().threads[0]?.comments[0] });
  stopThreadNavigation();
  assert.equal(selectedThreadItem(), undefined);
  assert.equal(threadBoardSnapshot().navigating, false);
});

test("toggles the keybinding list only while navigating, and drops it on exit", () => {
  resetThreadBoard();
  createThread("Authentication", note("one", "Check auth handling"));

  assert.equal(toggleThreadHelp(), false, "the list stays closed outside Threads navigation");
  assert.equal(threadBoardSnapshot().helpVisible ?? false, false);

  startThreadNavigation();
  assert.equal(toggleThreadHelp(), true);
  assert.equal(threadBoardSnapshot().helpVisible, true);
  assert.equal(toggleThreadHelp(), true);
  assert.equal(threadBoardSnapshot().helpVisible, false);

  toggleThreadHelp();
  stopThreadNavigation();
  assert.equal(threadBoardSnapshot().helpVisible, false);
});

test("moves a whole displayed group to an existing or new thread", () => {
  resetThreadBoard();
  const source = createThread("Authentication", note("one", "Check auth handling"));
  assignComment(source.id, note("two", "Add a regression test"));
  const target = createThread("Tests", note("three", "Exercise failures"));
  const moved = moveThreadComments(source.id, target.id);
  assert.deepEqual(moved?.comments.map(comment => comment.id), ["three", "one", "two"]);
  assert.deepEqual(threadBoardSnapshot().threads.map(thread => thread.title), ["Tests"]);

  const renamed = createThreadFromGroup(target.id, "Authentication tests");
  assert.equal(renamed?.title, "Authentication tests");
  assert.deepEqual(renamed?.comments.map(comment => comment.id), ["three", "one", "two"]);
  assert.deepEqual(threadBoardSnapshot().threads.map(thread => thread.title), ["Authentication tests"]);
});

test("moves only the selected comment when splitting a displayed group", () => {
  resetThreadBoard();
  const source = createThread("Authentication", note("one", "Check auth handling"));
  assignComment(source.id, note("two", "Add a regression test"));
  const target = createThread("Tests", note("three", "Exercise failures"));
  const moved = moveComment(source.id, "two", target.id);
  assert.deepEqual(moved?.comments.map(comment => comment.id), ["three", "two"]);
  assert.deepEqual(threadBoardSnapshot().threads.map(thread => thread.comments.map(comment => comment.id)), [["one"], ["three", "two"]]);

  const created = createThreadFromComment(source.id, "one", "Authentication tests");
  assert.equal(created?.title, "Authentication tests");
  assert.deepEqual(created?.comments.map(comment => comment.id), ["one"]);
});

test("marks a group as dispatching while Herdr starts or sends its agent", () => {
  resetThreadBoard();
  const created = createThread("Authentication", note("one", "Check auth handling"));
  setThreadDispatching(created.id, true);
  assert.equal(threadBoardSnapshot().threads[0]?.dispatching, true);
  setThreadDispatching(created.id, false);
  setThreadCompleted(created.id);
  assert.deepEqual(threadBoardSnapshot().threads[0] && {
    dispatching: threadBoardSnapshot().threads[0].dispatching,
    completed: threadBoardSnapshot().threads[0].completed,
  }, { dispatching: false, completed: true });
  setThreadDispatching(created.id, true);
  assert.equal(threadBoardSnapshot().threads[0]?.completed, false);
});

test("updates and removes assigned comments without deleting the thread", () => {
  resetThreadBoard();
  const created = createThread("Tests", note("one", "Original"));
  updateAssignedComment(note("one", "Updated"));
  assert.equal(threadBoardSnapshot().threads[0]?.comments[0]?.body, "Updated");
  removeAssignedComment("one");
  assert.equal(threadBoardSnapshot().threads[0]?.comments.length, 0);
  assert.equal(threadBoardSnapshot().threads[0]?.id, created.id);
});

test("suggests a bounded title from the first comment line", () => {
  const title = suggestedThreadTitle(note("one", `${"a".repeat(70)}\nignored`));
  assert.equal(title.length, 48);
  assert.ok(title.endsWith("…"));
});

test("finds the group with the closest comment in the same file, using live anchors", () => {
  resetThreadBoard();
  const auth = createThread("Authentication", { ...note("one", "Check auth handling"), line: 10 });
  const tests = createThread("Tests", { ...note("two", "Cover failures"), line: 100 });
  assert.equal(nearestThreadForNote({ id: "new", filePath: "src/one.ts", side: "new", line: 30 })?.id, auth.id);
  assert.equal(nearestThreadForNote({ id: "new", filePath: "src/one.ts", side: "new", line: 80 })?.id, tests.id);
  assert.equal(nearestThreadForNote({ id: "new", filePath: "src/other.ts", side: "new", line: 10 }), undefined);
  // Hunk moved the first comment down; the lookup follows it.
  updateThreadCommentNavigation("one", { preferred: { side: "new", line: 79 } });
  assert.equal(nearestThreadForNote({ id: "new", filePath: "src/one.ts", side: "new", line: 80 })?.id, auth.id);
});

test("the comment at the cursor is the closest one in the selected file and hunk", () => {
  resetThreadBoard();
  const created = createThread("Authentication", { ...note("one", "Check auth handling"), line: 10 });
  assignComment(created.id, { ...note("two", "Add a regression test"), line: 40 });
  assignComment(created.id, { ...note("three", "Other hunk"), hunkIndex: 1, line: 200 });
  const at = (line: number) => ({ side: "new" as const, line });
  assert.equal(commentAtCursor("src/one.ts", 0, at(35))?.id, "two");
  assert.equal(commentAtCursor("src/one.ts", 0, at(12))?.id, "one");
  assert.equal(commentAtCursor("src/one.ts", 1, null)?.id, "three", "a lone comment needs no current line");
  assert.equal(commentAtCursor("src/one.ts", 0, null), undefined, "two comments and no current line is a tie");
  assert.equal(commentAtCursor("src/one.ts", 0, at(25)), undefined, "equally near comments highlight nothing, as P refuses");
  assert.equal(commentAtCursor("src/one.ts", 2, at(200)), undefined);
  assert.equal(commentAtCursor(undefined, 0, at(10)), undefined);
});

test("the active comment is measured by its saved range, like the command lookup", () => {
  resetThreadBoard();
  const created = createThread("Authentication", { ...note("span", "Spans a block"), line: 10, newRange: [10, 20] });
  assignComment(created.id, { ...note("edge", "Right after it"), line: 21 });
  // Line 20 is inside the first comment's range, so it wins over the adjacent one.
  assert.equal(commentAtCursor("src/one.ts", 0, { side: "new", line: 20 })?.id, "span");
  // A live anchor from Hunk replaces the saved geometry.
  updateThreadCommentNavigation("span", { newRange: [100, 110], preferred: { side: "new", line: 100 } });
  assert.equal(commentAtCursor("src/one.ts", 0, { side: "new", line: 20 })?.id, "edge");
});

test("Threads navigation starts on the comment at the review cursor", () => {
  resetThreadBoard();
  const created = createThread("Authentication", note("one", "Check auth handling"));
  assignComment(created.id, note("two", "Add a regression test"));
  setCursorComment("two");
  startThreadNavigation();
  const selected = selectedThreadItem();
  assert.equal(selected?.kind === "comment" ? selected.comment.id : undefined, "two");
  stopThreadNavigation();

  // A collapsed group still lands on its heading.
  toggleThread(created.id);
  startThreadNavigation();
  assert.deepEqual(selectedThreadItem()?.kind, "thread");
  stopThreadNavigation();

  setCursorComment(undefined);
  startThreadNavigation();
  assert.equal(selectedThreadItem()?.kind, "thread");
});

test("the pane follows the cursor onto a note row by replaying Hunk's moves from the last exact position", () => {
  resetThreadBoard();
  resetCursorTracking();
  const created = createThread("Authentication", { ...note("one", "Check auth handling"), side: "old", line: 10 });
  assignComment(created.id, { ...note("two", "Add a regression test"), side: "old", line: 12 });
  // A hunk that deletes old lines 10-12 and adds new line 10: rows -10, -11, -12, +10.
  const file = { id: "runtime:one", path: "src/one.ts", patch: "@@ -10,3 +10,1 @@\n-a\n-b\n-c\n+d\n" } as unknown as ExtensionDiffFile;
  const snapshot: ExtensionReviewSnapshot = {
    generation: "g", stateRevision: 1,
    files: [{ fileKey: "file:one", runtimeId: "runtime:one", path: "src/one.ts", changeKind: "change", stats: { additions: 1, deletions: 3, truncated: false }, flags: { untracked: false, binary: false, tooLarge: false, partial: false }, contentIdentity: "c" }],
    notes: [
      { id: "one", source: "user", fileKey: "file:one", summary: "a", editable: true, resolution: "active", anchor: { oldRange: [10, 10], preferred: { side: "old", line: 10 }, intersectingHunkIndices: [0], ownerHunkIndex: 0 } },
      { id: "two", source: "user", fileKey: "file:one", summary: "b", editable: true, resolution: "active", anchor: { oldRange: [12, 12], preferred: { side: "old", line: 12 }, intersectingHunkIndices: [0], ownerHunkIndex: 0 } },
    ],
  };
  rememberSnapshot(snapshot);
  // Hunk paints a current line (split layout): that wins outright.
  assert.deepEqual(paneCursor(file, 0, { side: "old", line: 11 }), { at: { side: "old", line: 11 } });
  // Nothing known yet: no highlight rather than a guess.
  assert.equal(commentAtCursor("src/one.ts", 0, paneCursor(file, 0, null)), undefined);
  // The user saved "two": Hunk makes it active. Stepping up: row -12, row -11, then the note under -10.
  recordFix({ kind: "note", noteId: "two" });
  assert.equal(commentAtCursor("src/one.ts", 0, paneCursor(file, 0, null))?.id, "two");
  recordCommand("hunk.review.stepUp");
  assert.deepEqual(paneCursor(file, 0, null), { at: { side: "old", line: 12 } });
  recordCommand("hunk.review.stepUp");
  assert.deepEqual(paneCursor(file, 0, null), { at: { side: "old", line: 11 } });
  recordCommand("hunk.review.stepUp");
  assert.equal(commentAtCursor("src/one.ts", 0, paneCursor(file, 0, null))?.id, "one");
  // Next note jumps straight to the other comment; a page move loses the position.
  recordCommand("hunk.review.nextNote");
  assert.equal(commentAtCursor("src/one.ts", 0, paneCursor(file, 0, null))?.id, "two");
  recordCommand("hunk.review.pageDown");
  assert.deepEqual(paneCursor(file, 0, null), { at: null });
  resetCursorTracking();
});
