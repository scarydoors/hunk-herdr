import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ExtensionDiffFile, ExtensionPaneProps, ExtensionReviewNote, ExtensionReviewSnapshot, ExtensionReviewSnapshotNote } from "hunkdiff/extension";
import { onCursorChange, patchLineStops, pendingNoteFix, stopAddress, trackedStop } from "./cursor.ts";
import { nearestToCursor, nearestToLine, rowIndexOf, type CursorPosition, type LineAddress, type LineAnchor, type RowIndex } from "./threads.ts";

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
  /** The assigned comment nearest the review cursor, as the pane last saw it. */
  readonly cursorCommentId?: string;
}

/** Shown by `?` while Threads navigation is focused. */
const HELP_ROWS: readonly (readonly [string, string])[] = [
  ["j / k", "move selection"],
  ["↓ / ↑", "move selection"],
  ["Enter", "expand group or jump to comment"],
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

/** Refresh native comment-ID anchors after Hunk updates or reloads the review. */
export function syncThreadCommentNavigation(snapshot: ExtensionReviewSnapshot | null | undefined): void {
  // Older Hunk event contexts do not expose snapshots; preserve known anchors then.
  if (snapshot === undefined) return;
  navigationByCommentId.clear();
  if (!snapshot || !Array.isArray(snapshot.notes)) return;
  for (const note of snapshot.notes) navigationByCommentId.set(note.id, note.anchor);
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
 * when no group has a comment there. Measured the way the cursor lookup is.
 */
export function nearestThreadForNote(note: Pick<ExtensionReviewNote, "id" | "filePath" | "side" | "line">): ReviewThread | undefined {
  const inFile = allComments().filter(({ comment }) => comment.filePath === note.filePath && comment.id !== note.id);
  const nearest = nearestToLine(inFile, ({ comment }) => commentAnchor(comment), { side: note.side, line: note.line });
  // A tie between groups is broken by board order, so a new comment is never left unfiled.
  if (nearest.kind === "tie") return inFile.map(({ thread }) => thread).find(() => true);
  return nearest.kind === "one" ? nearest.item.thread : undefined;
}

/**
 * The assigned comment the review cursor is on or nearest to, within the selected
 * file and hunk — the same rule `threadAtSelection` uses for commands, including
 * a cursor on a note row. Undefined when the hunk holds no assigned comment, or
 * when two are equally near.
 */
export function commentAtCursor(filePath: string | undefined, hunkIndex: number | null, cursor: CursorPosition | LineAddress | null | undefined, rows?: RowIndex): AssignedComment | undefined {
  if (!filePath || hunkIndex === null) return undefined;
  const inHunk = allComments().filter(({ comment }) => comment.filePath === filePath && comment.hunkIndex === hunkIndex);
  const position: CursorPosition | null = cursor && "at" in cursor ? cursor : { at: cursor ?? null };
  const nearest = nearestToCursor(inHunk, ({ comment }) => commentAnchor(comment), position, ({ comment }) => comment.id, rows);
  return nearest.kind === "one" ? nearest.item.comment : undefined;
}

/** The review snapshot as of the last command, kept so the pane can rebuild Hunk's stop list. */
let knownSnapshot: ExtensionReviewSnapshot | undefined;
/** Between commands, what the note events reveal: notes by id, and which file key each file id has. */
const learnedNotes = new Map<string, ExtensionReviewSnapshotNote>();
const learnedFileKeys = new Map<string, string>();
const pendingFileIds = new Map<string, string>();

export function rememberSnapshot(snapshot: ExtensionReviewSnapshot | null | undefined): void {
  // Older hosts hand event contexts a bare object; only a real snapshot is worth keeping.
  if (!snapshot || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.notes)) return;
  knownSnapshot = snapshot;
  learnedNotes.clear();
  for (const file of snapshot.files) learnedFileKeys.set(file.runtimeId, file.fileKey);
}

/** A saved note names its file by runtime id; the matching `note_changed` names the file key. */
export function rememberNoteFile(noteId: string, fileId: string): void {
  pendingFileIds.set(noteId, fileId);
}

/** Applies one `note_changed` event to what the pane knows. */
export function rememberNoteChange(kind: "created" | "updated" | "removed", note: ExtensionReviewSnapshotNote): void {
  const fileId = pendingFileIds.get(note.id);
  if (fileId) { learnedFileKeys.set(fileId, note.fileKey); pendingFileIds.delete(note.id); }
  if (knownSnapshot) {
    const notes = knownSnapshot.notes.filter(candidate => candidate.id !== note.id);
    knownSnapshot = { ...knownSnapshot, notes: kind === "removed" ? notes : [...notes, note] };
    return;
  }
  if (kind === "removed") learnedNotes.delete(note.id);
  else learnedNotes.set(note.id, note);
}

export function forgetSnapshot(): void {
  knownSnapshot = undefined;
  learnedNotes.clear();
  learnedFileKeys.clear();
  pendingFileIds.clear();
}

/** The best snapshot the pane has: the last command's, or one assembled from note events. */
function snapshotForPane(): ExtensionReviewSnapshot | undefined {
  if (knownSnapshot) return knownSnapshot;
  if (!learnedNotes.size) return undefined;
  const files = [...learnedFileKeys].map(([runtimeId, fileKey]) => ({ runtimeId, fileKey })) as unknown as ExtensionReviewSnapshot["files"];
  return { generation: "", stateRevision: 0, files, notes: [...learnedNotes.values()] };
}

/**
 * Where the review cursor is for `file`, as the pane can tell: Hunk's current
 * line when it paints one (split layout); the note Hunk just made active when
 * nothing has moved since; otherwise the stop replayed from the last exact
 * position, when it lands in the selected hunk.
 */
export function paneCursor(file: ExtensionDiffFile | undefined, hunkIndex: number | null, at: LineAddress | null): CursorPosition {
  if (at) return { at };
  const justSaved = pendingNoteFix();
  if (justSaved) return { at: null, noteId: justSaved };
  const snapshot = snapshotForPane();
  if (!file || hunkIndex === null || !snapshot) return { at: null };
  const stop = trackedStop(file, snapshot);
  return stop && stop.hunkIndex === hunkIndex ? stopAddress(stop) : { at: null };
}

/** Records which comment the pane is showing as active; a no-op when unchanged. */
export function setCursorComment(commentId: string | undefined): void {
  if (board.cursorCommentId === commentId) return;
  publish({ ...board, cursorCommentId: commentId });
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
  // Land on the comment the review cursor is at, so Ctrl+T continues where the user was reading.
  const atCursor = board.cursorCommentId
    ? items.find(item => item.kind === "comment" && item.comment.id === board.cursorCommentId)
      ?? items.find(item => item.kind === "thread" && item.thread.comments.some(comment => comment.id === board.cursorCommentId))
    : undefined;
  publish({ ...board, navigating: true, selectedKey: board.selectedKey ?? selectionKey(atCursor ?? first) });
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
  forgetSnapshot();
  publish({ threads: [], navigating: false, helpVisible: false });
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
  const preferred = navigationByCommentId.get(comment.id)?.preferred;
  if (preferred) {
    actions.revealLine(file.id, preferred.side, preferred.line);
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
export function ThreadsPane({ files, theme, actions, width, selectedFileId, selectedHunkIndex, currentLine }: ExtensionPaneProps): ReactNode {
  const state = useThreadBoard();
  // Cursor moves arrive outside React (Hunk reports them as executed commands), so re-render on each.
  const [, setCursorTick] = useState(0);
  useEffect(() => onCursorChange(() => setCursorTick(tick => tick + 1)), []);
  const cursorFile = selectedFileId === null ? undefined : files.find(file => file.id === selectedFileId);
  const at = currentLine ? { side: currentLine.side, line: currentLine.line } : null;
  const rows = cursorFile ? rowIndexOf(patchLineStops(cursorFile.patch)) : undefined;
  const active = commentAtCursor(cursorFile?.path, selectedHunkIndex, paneCursor(cursorFile, selectedHunkIndex, at), rows);
  useEffect(() => { setCursorComment(active?.id); }, [active?.id]);
  // A closed pane shows nothing, so it must not keep steering review-side keys.
  useEffect(() => () => setCursorComment(undefined), []);
  const dispatching = state.threads.some(thread => thread.dispatching);
  const [throbberFrame, setThrobberFrame] = useState(0);
  useEffect(() => {
    if (!dispatching) return;
    const timer = setInterval(() => setThrobberFrame(frame => frame + 1), 100);
    return () => clearInterval(timer);
  }, [dispatching]);
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
          // A collapsed group still shows that the cursor's comment is inside it.
          const holdsCursor = !thread.expanded && thread.comments.some(comment => comment.id === active?.id);
          return [
            <text
              key={thread.id}
              content={` ${thread.expanded ? "▾" : "▸"} ${thread.dispatching ? "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[throbberFrame % 10] : thread.completed ? "✓" : " "} ${oneLine(thread.title, Math.max(8, width - 12))} (${thread.comments.length})`}
              style={{
                fg: thread.completed && !thread.dispatching ? theme.badgeAdded : holdsCursor ? theme.accent : theme.text,
                bg: state.selectedKey === `thread:${thread.id}` ? theme.panelAlt : theme.panel,
              }}
              onMouseDown={() => toggleThread(thread.id)}
            />,
            ...(thread.expanded ? thread.comments.map(comment => {
              const isActive = comment.id === active?.id;
              return (
                <text
                  key={`${thread.id}:${comment.id}`}
                  content={`   ${isActive ? "›" : "└"} ${oneLine(comment.body, Math.max(8, width - 7))}`}
                  style={{ fg: isActive ? theme.accent : theme.muted, bg: state.selectedKey === `comment:${thread.id}:${comment.id}` ? theme.panelAlt : theme.panel }}
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
