import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ExtensionPaneProps, ExtensionReviewNote, ExtensionReviewSnapshot } from "hunkdiff/extension";
import { nearestToLine, type LineAnchor } from "./threads.ts";

export interface AssignedComment {
  readonly id: string;
  readonly parentId?: string;
  readonly body: string;
  readonly filePath: string;
  readonly hunkIndex: number;
  readonly side: "old" | "new";
  readonly line: number;
  /** Line geometry when the comment was saved; Hunk's later anchors are tracked separately. */
  readonly anchor: LineAnchor;
  /**
   * Hunk's reconciliation verdict from the last review snapshot seen: a stale
   * note still sits at its line but the content there changed; an orphaned one
   * is no longer rendered at all. Undefined until a snapshot has been read.
   */
  readonly resolution?: "active" | "stale" | "orphaned";
}

export interface ReviewThread {
  readonly id: string;
  readonly title: string;
  readonly expanded: boolean;
  readonly comments: readonly AssignedComment[];
  /** True while Herdr is starting or awaiting work from this group's agent. */
  readonly dispatching?: boolean;
  /** True when the group's most recently dispatched prompt settled successfully. */
  readonly completed?: boolean;
}

export interface ThreadBoardSnapshot {
  readonly threads: readonly ReviewThread[];
  readonly navigating: boolean;
  readonly selectedKey?: string;
  /** True while the keybinding list is shown in place of the thread rows. */
  readonly helpVisible?: boolean;
  /** The comment added most recently; Ctrl+T lands on it, so "comment, Ctrl+T, P" works. */
  readonly lastAddedCommentId?: string;
}

/** Shown by `?` while Threads navigation is focused. */
const HELP_ROWS: readonly (readonly [string, string])[] = [
  ["j / k", "move selection; the diff follows the comment"],
  ["↓ / ↑", "move selection; the diff follows the comment"],
  ["Enter", "expand or collapse the group"],
  ["A", "agent actions for the group"],
  ["P", "prompt the group"],
  ["X", "resolve the group or comment"],
  ["Ctrl+R", "move or name the group or comment"],
  ["Ctrl+L", "configure Pi/Claude model defaults"],
  ["Ctrl+T", "focus Threads"],
  ["T", "toggle the Threads sidebar"],
  ["Esc", "leave Threads navigation"],
];

export type ThreadSelection =
  | { readonly kind: "thread"; readonly thread: ReviewThread }
  | { readonly kind: "comment"; readonly thread: ReviewThread; readonly comment: AssignedComment };

export const UNASSIGNED_THREAD_ID = "thread:unassigned";
export const UNASSIGNED_THREAD_TITLE = "Unassigned";

let board: ThreadBoardSnapshot = { threads: [], navigating: false };
const listeners = new Set<() => void>();
/** Hunk's current anchor for each assigned comment, refreshed as the review changes. */
const navigationByCommentId = new Map<string, LineAnchor>();

function publish(next: ThreadBoardSnapshot) {
  board = next;
  for (const listener of listeners) listener();
}

function useThreadBoard() {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => board,
  );
}

export function threadBoardSnapshot(): ThreadBoardSnapshot {
  return board;
}

/**
 * Bring the board in line with an authoritative review snapshot: every note's
 * current anchor, and each assigned comment's reconciliation verdict. A reload
 * that remaps or drops notes emits no note event, and event handlers cannot
 * take a snapshot, so commands call this on entry — Ctrl+T included — which is
 * when the verdicts are about to matter.
 */
export function syncCommentsWithReview(snapshot: ExtensionReviewSnapshot | null | undefined): void {
  if (!snapshot || !Array.isArray(snapshot.notes)) return;
  const byId = new Map(snapshot.notes.map(note => [note.id, note]));
  for (const note of snapshot.notes) navigationByCommentId.set(note.id, note.anchor);
  let changed = false;
  const threads = board.threads.map(thread => {
    const comments = thread.comments.map(comment => {
      const resolution = byId.get(comment.id)?.resolution ?? "orphaned";
      if (comment.resolution === resolution) return comment;
      changed = true;
      return { ...comment, resolution };
    });
    return changed ? { ...thread, comments } : thread;
  });
  if (changed) publish({ ...board, threads });
}

/** Updates one current native note anchor by its stable comment ID. */
export function updateThreadCommentNavigation(commentId: string, anchor: LineAnchor | undefined): void {
  if (anchor) navigationByCommentId.set(commentId, anchor);
  else navigationByCommentId.delete(commentId);
}

export function threadForComment(commentId: string | undefined): ReviewThread | undefined {
  if (!commentId) return undefined;
  return board.threads.find(thread => thread.comments.some(comment => comment.id === commentId));
}

/** Where a comment sits now: Hunk's live anchor when it has reported one. */
function commentAnchor(comment: AssignedComment): LineAnchor {
  return navigationByCommentId.get(comment.id) ?? comment.anchor;
}

function allComments(): { thread: ReviewThread; comment: AssignedComment }[] {
  return board.threads.flatMap(thread => thread.comments.map(comment => ({ thread, comment })));
}

/**
 * The group holding the comment nearest `note` in the same file, or undefined
 * when no group has a comment there, measured by line on the comment's side.
 */
export function nearestThreadForNote(note: Pick<ExtensionReviewNote, "id" | "filePath" | "side" | "line">): ReviewThread | undefined {
  const inFile = allComments().filter(({ comment }) => comment.filePath === note.filePath && comment.id !== note.id);
  const nearest = nearestToLine(inFile, ({ comment }) => commentAnchor(comment), { side: note.side, line: note.line });
  // A tie between groups is broken by board order, so a new comment is never left unfiled.
  if (nearest.kind === "tie") return inFile.map(({ thread }) => thread).find(() => true);
  return nearest.kind === "one" ? nearest.item.thread : undefined;
}

export function suggestedThreadTitle(note: Pick<ExtensionReviewNote, "body" | "filePath">): string {
  const firstLine = note.body.trim().split(/\r?\n/, 1)[0]?.trim();
  const title = firstLine || note.filePath;
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}

function assignedComment(note: ExtensionReviewNote): AssignedComment {
  return {
    id: note.id,
    ...(note.parentId ? { parentId: note.parentId } : {}),
    body: note.body.trim(),
    filePath: note.filePath,
    hunkIndex: note.hunkIndex,
    side: note.side,
    line: note.line,
    anchor: {
      ...(note.oldRange ? { oldRange: note.oldRange } : {}),
      ...(note.newRange ? { newRange: note.newRange } : {}),
      preferred: { side: note.side, line: note.line },
    },
  };
}

export function createThread(title: string, note: ExtensionReviewNote): ReviewThread {
  const thread: ReviewThread = {
    id: `thread:${note.id}`,
    title: title.trim() || suggestedThreadTitle(note),
    expanded: true,
    comments: [assignedComment(note)],
  };
  publish({ ...board, threads: [...board.threads, thread], lastAddedCommentId: note.id });
  return thread;
}

export function assignComment(threadId: string, note: ExtensionReviewNote): boolean {
  let assigned = false;
  const comment = assignedComment(note);
  const threads = board.threads.map(thread => {
    const without = thread.comments.filter(candidate => candidate.id !== note.id);
    if (thread.id !== threadId) {
      return without.length === thread.comments.length ? thread : { ...thread, comments: without };
    }
    assigned = true;
    return { ...thread, expanded: true, comments: [...without, comment] };
  });
  if (assigned) publish({ ...board, threads, lastAddedCommentId: note.id });
  return assigned;
}

/** Assign to the session-wide unassigned group, creating it on first use. */
export function assignUnassignedThread(note: ExtensionReviewNote): ReviewThread {
  const existing = board.threads.find(thread => thread.id === UNASSIGNED_THREAD_ID);
  if (existing) {
    assignComment(existing.id, note);
    return threadBoardSnapshot().threads.find(thread => thread.id === UNASSIGNED_THREAD_ID)!;
  }
  const thread: ReviewThread = {
    id: UNASSIGNED_THREAD_ID,
    title: UNASSIGNED_THREAD_TITLE,
    expanded: true,
    comments: [assignedComment(note)],
  };
  publish({ ...board, threads: [...board.threads, thread], lastAddedCommentId: note.id });
  return thread;
}

/** Moves every comment in one displayed group into another, retiring the source group. */
export function moveThreadComments(sourceId: string, targetId: string): ReviewThread | undefined {
  if (sourceId === targetId) return board.threads.find(thread => thread.id === sourceId);
  const source = board.threads.find(thread => thread.id === sourceId);
  const target = board.threads.find(thread => thread.id === targetId);
  if (!source || !target) return undefined;
  const targetCommentIds = new Set(target.comments.map(comment => comment.id));
  const comments = [...target.comments, ...source.comments.filter(comment => !targetCommentIds.has(comment.id))];
  const moved = { ...target, expanded: true, comments };
  publish({
    ...board,
    selectedKey: `thread:${targetId}`,
    threads: board.threads.flatMap(thread => {
      if (thread.id === sourceId) return [];
      return [thread.id === targetId ? moved : thread];
    }),
  });
  return moved;
}

/** Moves a displayed group into Unassigned, creating that session-wide group if needed. */
/** Moves one selected comment into a different existing group, retaining its source group. */
export function moveComment(sourceId: string, commentId: string, targetId: string): ReviewThread | undefined {
  if (sourceId === targetId) return board.threads.find(thread => thread.id === sourceId);
  const source = board.threads.find(thread => thread.id === sourceId);
  const target = board.threads.find(thread => thread.id === targetId);
  const comment = source?.comments.find(candidate => candidate.id === commentId);
  if (!source || !target || !comment) return undefined;
  const comments = target.comments.some(candidate => candidate.id === commentId)
    ? target.comments
    : [...target.comments, comment];
  const moved = { ...target, expanded: true, comments };
  publish({
    ...board,
    selectedKey: `thread:${targetId}`,
    threads: board.threads.map(thread => {
      if (thread.id === sourceId) return { ...thread, comments: thread.comments.filter(candidate => candidate.id !== commentId) };
      return thread.id === targetId ? moved : thread;
    }),
  });
  return moved;
}

/** Moves a selected comment into Unassigned, creating that session-wide group if needed. */
export function moveCommentToUnassigned(sourceId: string, commentId: string): ReviewThread | undefined {
  const existing = board.threads.find(thread => thread.id === UNASSIGNED_THREAD_ID);
  if (existing) return moveComment(sourceId, commentId, existing.id);
  const source = board.threads.find(thread => thread.id === sourceId);
  const comment = source?.comments.find(candidate => candidate.id === commentId);
  if (!source || !comment) return undefined;
  const thread: ReviewThread = {
    id: UNASSIGNED_THREAD_ID,
    title: UNASSIGNED_THREAD_TITLE,
    expanded: true,
    comments: [comment],
  };
  publish({
    ...board,
    selectedKey: `thread:${thread.id}`,
    threads: board.threads.flatMap(candidate => candidate.id === sourceId
      ? [{ ...candidate, comments: candidate.comments.filter(item => item.id !== commentId) }, thread]
      : [candidate]),
  });
  return thread;
}

export function moveThreadToUnassigned(sourceId: string): ReviewThread | undefined {
  const existing = board.threads.find(thread => thread.id === UNASSIGNED_THREAD_ID);
  if (existing) return moveThreadComments(sourceId, existing.id);
  const source = board.threads.find(thread => thread.id === sourceId);
  if (!source) return undefined;
  const thread: ReviewThread = {
    id: UNASSIGNED_THREAD_ID,
    title: UNASSIGNED_THREAD_TITLE,
    expanded: true,
    comments: source.comments,
  };
  publish({
    ...board,
    selectedKey: `thread:${thread.id}`,
    threads: board.threads.flatMap(candidate => candidate.id === sourceId ? [thread] : [candidate]),
  });
  return thread;
}

/** Creates a named group containing every comment in an existing displayed group. */
/** Creates a named group from one selected comment, retaining the source group. */
export function createThreadFromComment(sourceId: string, commentId: string, title: string): ReviewThread | undefined {
  const source = board.threads.find(thread => thread.id === sourceId);
  const comment = source?.comments.find(candidate => candidate.id === commentId);
  if (!source || !comment) return undefined;
  const baseId = `thread:comment:${comment.id}`;
  let id = baseId;
  let suffix = 2;
  while (board.threads.some(thread => thread.id === id)) id = `${baseId}:${suffix++}`;
  const thread: ReviewThread = { id, title: title.trim() || source.title, expanded: true, comments: [comment] };
  publish({
    ...board,
    selectedKey: `thread:${thread.id}`,
    threads: board.threads.flatMap(candidate => candidate.id === sourceId
      ? [{ ...candidate, comments: candidate.comments.filter(item => item.id !== commentId) }, thread]
      : [candidate]),
  });
  return thread;
}

export function createThreadFromGroup(sourceId: string, title: string): ReviewThread | undefined {
  const source = board.threads.find(thread => thread.id === sourceId);
  if (!source) return undefined;
  const baseId = `thread:group:${source.comments[0]?.id ?? source.id}`;
  let id = baseId;
  let suffix = 2;
  while (board.threads.some(thread => thread.id === id)) id = `${baseId}:${suffix++}`;
  const thread: ReviewThread = {
    id,
    title: title.trim() || source.title,
    expanded: true,
    comments: source.comments,
  };
  publish({
    ...board,
    selectedKey: `thread:${thread.id}`,
    threads: board.threads.flatMap(candidate => candidate.id === sourceId ? [thread] : [candidate]),
  });
  return thread;
}

/** Marks a group as actively starting or receiving work from its agent. */
export function setThreadDispatching(threadId: string, dispatching: boolean): void {
  let changed = false;
  const threads = board.threads.map(thread => {
    if (thread.id !== threadId || !!thread.dispatching === dispatching) return thread;
    changed = true;
    return { ...thread, dispatching, ...(dispatching ? { completed: false } : {}) };
  });
  if (changed) publish({ ...board, threads });
}

/** Records a successful response for the group's latest dispatched prompt. */
export function setThreadCompleted(threadId: string): void {
  let changed = false;
  const threads = board.threads.map(thread => {
    if (thread.id !== threadId || thread.completed) return thread;
    changed = true;
    return { ...thread, completed: true };
  });
  if (changed) publish({ ...board, threads });
}

export function updateAssignedComment(note: ExtensionReviewNote): void {
  const comment = assignedComment(note);
  let changed = false;
  const threads = board.threads.map(thread => {
    const index = thread.comments.findIndex(candidate => candidate.id === note.id);
    if (index < 0) return thread;
    changed = true;
    const comments = [...thread.comments];
    comments[index] = comment;
    return { ...thread, comments };
  });
  if (changed) publish({ ...board, threads });
}

/** Retires a session-local displayed group after its native comments are resolved. */
export function removeThreadGroup(threadId: string): void {
  const threads = board.threads.filter(thread => thread.id !== threadId);
  if (threads.length !== board.threads.length) publish({
    ...board,
    selectedKey: board.selectedKey?.startsWith(`thread:${threadId}`) || board.selectedKey?.startsWith(`comment:${threadId}:`)
      ? undefined
      : board.selectedKey,
    threads,
  });
}

export function removeAssignedComment(noteId: string): void {
  let changed = false;
  const threads = board.threads.map(thread => {
    const comments = thread.comments.filter(comment => comment.id !== noteId);
    if (comments.length === thread.comments.length) return thread;
    changed = true;
    return { ...thread, comments };
  });
  if (changed) publish({ ...board, threads });
}

function selections(): ThreadSelection[] {
  return board.threads.flatMap(thread => [
    { kind: "thread" as const, thread },
    ...(thread.expanded ? thread.comments.map(comment => ({ kind: "comment" as const, thread, comment })) : []),
  ]);
}

function selectionKey(selection: ThreadSelection): string {
  return selection.kind === "thread"
    ? `thread:${selection.thread.id}`
    : `comment:${selection.thread.id}:${selection.comment.id}`;
}

export function selectedThreadItem(): ThreadSelection | undefined {
  return selections().find(selection => selectionKey(selection) === board.selectedKey);
}

export function startThreadNavigation(): boolean {
  const items = selections();
  const first = items[0];
  if (!first) return false;
  // Land on the comment saved last, so "comment, Ctrl+T, P" acts on what you just wrote.
  const recent = board.lastAddedCommentId
    ? items.find(item => item.kind === "comment" && item.comment.id === board.lastAddedCommentId)
      ?? items.find(item => item.kind === "thread" && item.thread.comments.some(comment => comment.id === board.lastAddedCommentId))
    : undefined;
  publish({ ...board, navigating: true, selectedKey: board.selectedKey ?? selectionKey(recent ?? first) });
  return true;
}

export function stopThreadNavigation(): void {
  if (board.navigating || board.selectedKey || board.helpVisible) {
    publish({ ...board, navigating: false, selectedKey: undefined, helpVisible: false });
  }
}

/** Show or hide the keybinding list; only meaningful while navigating. */
export function toggleThreadHelp(): boolean {
  if (!board.navigating) return false;
  publish({ ...board, helpVisible: !board.helpVisible });
  return true;
}

export function moveThreadSelection(delta: number): boolean {
  const items = selections();
  if (!items.length) return false;
  const current = items.findIndex(item => selectionKey(item) === board.selectedKey);
  const index = (Math.max(0, current) + delta + items.length) % items.length;
  publish({ ...board, selectedKey: selectionKey(items[index]!) });
  return true;
}

export function toggleThread(threadId: string): void {
  publish({
    ...board,
    threads: board.threads.map(thread => thread.id === threadId
      ? { ...thread, expanded: !thread.expanded }
      : thread),
  });
}

export function resetThreadBoard(): void {
  navigationByCommentId.clear();
  publish({ threads: [], navigating: false, helpVisible: false });
}

function oneLine(text: string, width: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > width ? `${normalized.slice(0, Math.max(1, width - 1))}…` : normalized;
}

/**
 * Scrolls the review to a comment, at Hunk's live anchor when it has reported
 * one. This is how the sidebar drives the diff: Hunk reveals a line exactly,
 * while it never tells an extension which note its own cursor is on.
 */
function revealComment(comment: AssignedComment, files: ExtensionPaneProps["files"], actions: ExtensionPaneProps["actions"], quiet = false): void {
  const file = files.find(candidate => candidate.path === comment.filePath);
  if (!file) {
    if (!quiet) actions.notify(`Comment file is not visible: ${comment.filePath}`, "warning");
    return;
  }
  const at = navigationByCommentId.get(comment.id)?.preferred ?? { side: comment.side, line: comment.line };
  actions.revealLine(file.id, at.side, at.line);
}

/** Activates the keyboard-selected row: a group expands or collapses. A comment is already revealed. */
export function activateSelectedThreadItem(): boolean {
  const selection = selectedThreadItem();
  if (!selection) return false;
  if (selection.kind === "thread") toggleThread(selection.thread.id);
  return true;
}

/** Session-local prototype UI for grouping saved user comments into orchestration threads. */
export function ThreadsPane({ files, theme, actions, width }: ExtensionPaneProps): ReactNode {
  const state = useThreadBoard();
  const selection = selectedThreadItem();
  const selectedComment = state.navigating && selection?.kind === "comment" ? selection.comment : undefined;
  // The sidebar is the cursor: moving the selection onto a comment shows it in the diff.
  useEffect(() => {
    if (selectedComment) revealComment(selectedComment, files, actions, true);
  }, [selectedComment?.id]);
  const dispatching = state.threads.some(thread => thread.dispatching);
  const [throbberFrame, setThrobberFrame] = useState(0);
  useEffect(() => {
    if (!dispatching) return;
    const timer = setInterval(() => setThrobberFrame(frame => frame + 1), 100);
    return () => clearInterval(timer);
  }, [dispatching]);
  return (
    <scrollbox
      width="100%"
      height="100%"
      focused={false}
      scrollY={true}
      rootOptions={{ backgroundColor: theme.panel }}
      wrapperOptions={{ backgroundColor: theme.panel }}
      viewportOptions={{ backgroundColor: theme.panel }}
      contentOptions={{ backgroundColor: theme.panel }}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
        <text
          content={state.navigating
            ? state.helpVisible ? " Threads · ? close help" : " Threads · ? help"
            : " Threads · Ctrl+T to navigate"}
          style={{ fg: theme.accent, bg: theme.panel }}
        />
        {state.helpVisible ? HELP_ROWS.map(([chord, description]) => (
          <text
            key={chord}
            content={` ${chord.padEnd(7)} ${oneLine(description, Math.max(6, width - 10))}`}
            style={{ fg: theme.muted, bg: theme.panel }}
          />
        )) : null}
        {!state.helpVisible && state.threads.length === 0 ? (
          <text
            content=" Save a user comment to create the first thread."
            style={{ fg: theme.muted, bg: theme.panel }}
          />
        ) : null}
        {state.helpVisible ? [] : state.threads.flatMap(thread => {
          return [
            <text
              key={thread.id}
              content={` ${thread.expanded ? "▾" : "▸"} ${thread.dispatching ? "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[throbberFrame % 10] : thread.completed ? "✓" : " "} ${oneLine(thread.title, Math.max(8, width - 12))} (${thread.comments.length})`}
              style={{
                fg: thread.completed && !thread.dispatching ? theme.badgeAdded : theme.text,
                bg: state.selectedKey === `thread:${thread.id}` ? theme.panelAlt : theme.panel,
              }}
              onMouseDown={() => toggleThread(thread.id)}
            />,
            ...(thread.expanded ? thread.comments.map(comment => {
              const selected = comment.id === selectedComment?.id;
              // Hunk's own verdict, as it marks a note whose line changed under it (●) or no longer shows (✗).
              const mark = comment.resolution === "stale" ? "● " : comment.resolution === "orphaned" ? "✗ " : "";
              return (
                <text
                  key={`${thread.id}:${comment.id}`}
                  content={`   ${selected ? "›" : "└"} ${mark}${oneLine(comment.body, Math.max(8, width - 7 - mark.length))}`}
                  style={{
                    fg: comment.resolution === "orphaned" ? theme.badgeRemoved : selected ? theme.accent : comment.resolution === "stale" ? theme.text : theme.muted,
                    bg: state.selectedKey === `comment:${thread.id}:${comment.id}` ? theme.panelAlt : theme.panel,
                  }}
                  onMouseDown={() => revealComment(comment, files, actions)}
                />
              );
            }) : []),
          ];
        })}
      </box>
    </scrollbox>
  );
}
