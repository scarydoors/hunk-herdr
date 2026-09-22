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
}

let board: ThreadBoardSnapshot = { threads: [] };
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
  publish({ threads: [...board.threads, thread] });
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
  if (assigned) publish({ threads });
  return assigned;
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
  if (changed) publish({ threads });
}

export function removeAssignedComment(noteId: string): void {
  let changed = false;
  const threads = board.threads.map(thread => {
    const comments = thread.comments.filter(comment => comment.id !== noteId);
    if (comments.length === thread.comments.length) return thread;
    changed = true;
    return { ...thread, comments };
  });
  if (changed) publish({ threads });
}

export function toggleThread(threadId: string): void {
  publish({
    threads: board.threads.map(thread => thread.id === threadId
      ? { ...thread, expanded: !thread.expanded }
      : thread),
  });
}

export function resetThreadBoard(): void {
  publish({ threads: [] });
}

function oneLine(text: string, width: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > width ? `${normalized.slice(0, Math.max(1, width - 1))}…` : normalized;
}

/** Session-local prototype UI for grouping saved user comments into orchestration threads. */
export function ThreadsPane({ files, theme, actions, width }: ExtensionPaneProps): ReactNode {
  const state = useThreadBoard();
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
        <text content=" Threads · session only" style={{ fg: theme.accent, bg: theme.panel }} />
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
            style={{ fg: theme.text, bg: theme.panel }}
            onMouseDown={() => toggleThread(thread.id)}
          />,
          ...(thread.expanded ? thread.comments.map(comment => (
            <text
              key={`${thread.id}:${comment.id}`}
              content={`   └ ${oneLine(comment.body, Math.max(8, width - 7))}`}
              style={{ fg: theme.muted, bg: theme.panel }}
              onMouseDown={() => {
                const file = files.find(candidate => candidate.path === comment.filePath);
                if (!file) {
                  actions.notify(`Comment file is not visible: ${comment.filePath}`, "warning");
                  return;
                }
                actions.revealLine(file.id, comment.side, comment.line);
              }}
            />
          )) : []),
        ])}
      </box>
    </scrollbox>
  );
}
