import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionReviewNote } from "hunkdiff/extension";
import {
  assignComment,
  createThread,
  createThreadFromGroup,
  moveThreadComments,
  moveThreadSelection,
  removeAssignedComment,
  resetThreadBoard,
  selectedThreadItem,
  startThreadNavigation,
  stopThreadNavigation,
  suggestedThreadTitle,
  threadBoardSnapshot,
  threadForComment,
  toggleThread,
  updateAssignedComment,
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
