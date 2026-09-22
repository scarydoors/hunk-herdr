import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionReviewNote } from "hunkdiff/extension";
import {
  assignComment,
  commentAtCursor,
  createThread,
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
  assert.equal(nearestThreadForNote({ id: "new", filePath: "src/one.ts", line: 30 })?.id, auth.id);
  assert.equal(nearestThreadForNote({ id: "new", filePath: "src/one.ts", line: 80 })?.id, tests.id);
  assert.equal(nearestThreadForNote({ id: "new", filePath: "src/other.ts", line: 10 }), undefined);
  // Hunk moved the first comment down; the lookup follows it.
  updateThreadCommentNavigation("one", { side: "new", line: 79 });
  assert.equal(nearestThreadForNote({ id: "new", filePath: "src/one.ts", line: 80 })?.id, auth.id);
});

test("the comment at the cursor is the closest one in the selected file and hunk", () => {
  resetThreadBoard();
  const created = createThread("Authentication", { ...note("one", "Check auth handling"), line: 10 });
  assignComment(created.id, { ...note("two", "Add a regression test"), line: 40 });
  assignComment(created.id, { ...note("three", "Other hunk"), hunkIndex: 1, line: 200 });
  assert.equal(commentAtCursor("src/one.ts", 0, 35)?.id, "two");
  assert.equal(commentAtCursor("src/one.ts", 0, 12)?.id, "one");
  assert.equal(commentAtCursor("src/one.ts", 1, undefined)?.id, "three");
  assert.equal(commentAtCursor("src/one.ts", 2, 200), undefined);
  assert.equal(commentAtCursor(undefined, 0, 10), undefined);
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
