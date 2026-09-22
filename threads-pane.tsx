import { useSyncExternalStore, type ReactNode } from "react";
import type { ExtensionPaneProps, ExtensionReviewNote } from "hunkdiff/extension";

export interface AssignedComment {
  readonly id: string;
  readonly parentId?: string;
  readonly body: string;
  readonly filePath: string;
  readonly hunkIndex: number;
  readonly side: "old" | "new";
  readonly line: number;
}

export interface ReviewThread {
  readonly id: string;
  readonly title: string;
  readonly expanded: boolean;
  readonly comments: readonly AssignedComment[];
}

export interface ThreadBoardSnapshot {
  readonly threads: readonly ReviewThread[];
  readonly navigating: boolean;
  readonly selectedKey?: string;
}

export type ThreadSelection =
  | { readonly kind: "thread"; readonly thread: ReviewThread }
  | { readonly kind: "comment"; readonly thread: ReviewThread; readonly comment: AssignedComment };

export const UNASSIGNED_THREAD_ID = "thread:unassigned";
export const UNASSIGNED_THREAD_TITLE = "Unassigned";

let board: ThreadBoardSnapshot = { threads: [], navigating: false };
const listeners = new Set<() => void>();

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

export function threadForComment(commentId: string | undefined): ReviewThread | undefined {
  if (!commentId) return undefined;
  return board.threads.find(thread => thread.comments.some(comment => comment.id === commentId));
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
  };
}

export function createThread(title: string, note: ExtensionReviewNote): ReviewThread {
  const thread: ReviewThread = {
    id: `thread:${note.id}`,
    title: title.trim() || suggestedThreadTitle(note),
    expanded: true,
    comments: [assignedComment(note)],
  };
  publish({ ...board, threads: [...board.threads, thread] });
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
  if (assigned) publish({ ...board, threads });
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
  publish({ ...board, threads: [...board.threads, thread] });
  return thread;
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
  const first = selections()[0];
  if (!first) return false;
  publish({ ...board, navigating: true, selectedKey: board.selectedKey ?? selectionKey(first) });
  return true;
}

export function stopThreadNavigation(): void {
  if (board.navigating || board.selectedKey) publish({ ...board, navigating: false, selectedKey: undefined });
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
  publish({ threads: [], navigating: false });
}

function oneLine(text: string, width: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > width ? `${normalized.slice(0, Math.max(1, width - 1))}…` : normalized;
}

let revealSelectedComment: (() => void) | undefined;

function revealComment(comment: AssignedComment, files: ExtensionPaneProps["files"], actions: ExtensionPaneProps["actions"]): void {
  const file = files.find(candidate => candidate.path === comment.filePath);
  if (!file) {
    actions.notify(`Comment file is not visible: ${comment.filePath}`, "warning");
    return;
  }
  actions.revealLine(file.id, comment.side, comment.line);
}

/** Activates the keyboard-selected row; threads expand/collapse and comments reveal their source. */
export function activateSelectedThreadItem(): boolean {
  const selection = selectedThreadItem();
  if (!selection) return false;
  if (selection.kind === "thread") toggleThread(selection.thread.id);
  else revealSelectedComment?.();
  return true;
}

/** Session-local prototype UI for grouping saved user comments into orchestration threads. */
export function ThreadsPane({ files, theme, actions, width }: ExtensionPaneProps): ReactNode {
  const state = useThreadBoard();
  const selection = selectedThreadItem();
  revealSelectedComment = selection?.kind === "comment"
    ? () => revealComment(selection.comment, files, actions)
    : undefined;
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
          content={state.navigating ? " Threads · j/k move · Enter open · Esc return" : " Threads · Ctrl+T to navigate"}
          style={{ fg: theme.accent, bg: theme.panel }}
        />
        {state.threads.length === 0 ? (
          <text
            content=" Save a user comment to create the first thread."
            style={{ fg: theme.muted, bg: theme.panel }}
          />
        ) : null}
        {state.threads.flatMap(thread => [
          <text
            key={thread.id}
            content={` ${thread.expanded ? "▾" : "▸"} ${oneLine(thread.title, Math.max(8, width - 10))} (${thread.comments.length})`}
            style={{ fg: theme.text, bg: state.selectedKey === `thread:${thread.id}` ? theme.panelAlt : theme.panel }}
            onMouseDown={() => toggleThread(thread.id)}
          />,
          ...(thread.expanded ? thread.comments.map(comment => (
            <text
              key={`${thread.id}:${comment.id}`}
              content={`   └ ${oneLine(comment.body, Math.max(8, width - 7))}`}
              style={{ fg: theme.muted, bg: state.selectedKey === `comment:${thread.id}:${comment.id}` ? theme.panelAlt : theme.panel }}
              onMouseDown={() => revealComment(comment, files, actions)}
            />
          )) : []),
        ])}
      </box>
    </scrollbox>
  );
}
