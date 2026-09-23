import type {
  ExtensionReviewSelection,
  ExtensionReviewSnapshot,
  ExtensionReviewSnapshotNote,
} from "hunkdiff/extension";
import type { PromptConversation, Run } from "./bridge.ts";

export type ThreadMatch =
  | { kind: "found"; root: ExtensionReviewSnapshotNote; notes: readonly ExtensionReviewSnapshotNote[] }
  | { kind: "none"; message: string }
  | { kind: "ambiguous"; message: string };

/** The line geometry of a saved comment, as both snapshot notes and Threads comments carry it. */
export interface LineAnchor {
  readonly oldRange?: readonly [number, number];
  readonly newRange?: readonly [number, number];
  readonly preferred?: { readonly side: "old" | "new"; readonly line: number };
}

export interface LineAddress {
  readonly side: "old" | "new";
  readonly line: number;
}

/**
 * How far an anchor sits from a line on that side: 0 when its range contains
 * the line, otherwise the gap to the nearer edge. An anchor with no range on
 * that side is measured from its preferred line when that is on the side.
 */
export function distanceToLine(anchor: LineAnchor, at: LineAddress): number {
  const range = at.side === "old" ? anchor.oldRange : anchor.newRange;
  if (range !== undefined) {
    if (at.line >= range[0] && at.line <= range[1]) return 0;
    return at.line < range[0] ? range[0] - at.line : at.line - range[1];
  }
  if (anchor.preferred?.side === at.side) return Math.abs(anchor.preferred.line - at.line);
  return Number.POSITIVE_INFINITY;
}

export type Nearest<T> =
  | { kind: "one"; item: T; distance: number }
  | { kind: "tie"; count: number }
  | { kind: "none" };

/** The one item nearest a line by `distanceToLine`; an exact tie is reported as such. */
export function nearestToLine<T>(items: readonly T[], anchorOf: (item: T) => LineAnchor, at: LineAddress): Nearest<T> {
  let best: { item: T; distance: number } | undefined;
  let tied = 0;
  for (const item of items) {
    const distance = distanceToLine(anchorOf(item), at);
    if (!best || distance < best.distance) { best = { item, distance }; tied = 1; }
    else if (distance === best.distance) tied++;
  }
  if (!best) return { kind: "none" };
  if (tied > 1) return { kind: "tie", count: tied };
  return { kind: "one", item: best.item, distance: best.distance };
}

function containsLine(note: ExtensionReviewSnapshotNote, side: "old" | "new", line: number): boolean {
  const range = side === "old" ? note.anchor.oldRange : note.anchor.newRange;
  return (range !== undefined && line >= range[0] && line <= range[1])
    || (note.anchor.preferred?.side === side && note.anchor.preferred.line === line);
}

function rootId(note: ExtensionReviewSnapshotNote, byId: ReadonlyMap<string, ExtensionReviewSnapshotNote>): string | null {
  let current = note;
  const visited = new Set<string>();
  while (current.parentId) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

function depth(note: ExtensionReviewSnapshotNote, byId: ReadonlyMap<string, ExtensionReviewSnapshotNote>): number {
  let current = note;
  let value = 0;
  const visited = new Set<string>();
  while (current.parentId) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
    value++;
  }
  return value;
}

/**
 * Find one thread at the review cursor without guessing between threads: the
 * thread whose note contains the current line, else the only thread in the
 * selected hunk. Used by X from the review; every other action takes its
 * target from the Threads sidebar, which Hunk can reveal exactly.
 */
export function threadAtSelection(snapshot: ExtensionReviewSnapshot, selection: ExtensionReviewSelection): ThreadMatch {
  if (!selection.file || selection.hunkIndex === null) {
    return { kind: "none", message: "No review thread at the current location." };
  }
  const file = snapshot.files.find(candidate => candidate.runtimeId === selection.file!.id);
  if (!file) return { kind: "none", message: "The selected file changed; no thread was resolved." };

  const notes = snapshot.notes.filter(note => note.fileKey === file.fileKey && note.resolution === "active");
  const byId = new Map(notes.map(note => [note.id, note]));
  const atHunk = notes.filter(note => note.anchor.ownerHunkIndex === selection.hunkIndex
    || note.anchor.intersectingHunkIndices.includes(selection.hunkIndex!));
  const atLine = selection.currentLine
    ? atHunk.filter(note => containsLine(note, selection.currentLine!.side, selection.currentLine!.line))
    : [];
  const located = atLine.length > 0 ? atLine : atHunk;
  const roots = new Set(located.map(note => rootId(note, byId)).filter((id): id is string => id !== null));

  if (roots.size === 0) return { kind: "none", message: "No review thread at the current location." };
  if (roots.size > 1) {
    return { kind: "ambiguous", message: `${roots.size} review threads share this location; nothing was resolved.` };
  }

  const [id] = roots;
  const root = byId.get(id!);
  if (!root) return { kind: "none", message: "The review thread is no longer available." };
  const thread = notes
    .filter(note => rootId(note, byId) === root.id)
    .sort((left, right) => depth(right, byId) - depth(left, byId));
  return { kind: "found", root, notes: thread };
}

type SessionList = {
  sessions?: Array<{ sessionId?: string; snapshot?: { state?: { reviewPublication?: { generation?: string } } } }>;
};

/** Returns every active native thread that contains any requested comment ID. */
export function threadsForCommentIds(snapshot: ExtensionReviewSnapshot, commentIds: ReadonlySet<string>): readonly ExtensionReviewSnapshotNote[] {
  const active = snapshot.notes.filter(note => note.resolution === "active");
  const byId = new Map(active.map(note => [note.id, note]));
  const roots = new Set(active
    .filter(note => commentIds.has(note.id))
    .map(note => rootId(note, byId))
    .filter((id): id is string => id !== null));
  return active
    .filter(note => {
      const root = rootId(note, byId);
      return root !== null && roots.has(root);
    })
    .sort((left, right) => depth(right, byId) - depth(left, byId));
}

/** The one live Hunk session publishing this review generation; anything else is refused. */
export async function sessionIdForGeneration(run: Run, cwd: string, generation: string): Promise<string> {
  const listed = JSON.parse(await run("hunk", ["session", "list", "--json"], cwd)) as SessionList;
  const matches = (listed.sessions ?? []).filter(session => session.snapshot?.state?.reviewPublication?.generation === generation);
  if (matches.length !== 1 || !matches[0]!.sessionId) {
    throw new Error(matches.length > 1
      ? "Multiple Hunk sessions matched this review"
      : "The live Hunk session could not be identified");
  }
  return matches[0]!.sessionId;
}

export async function removeThread(run: Run, cwd: string, generation: string, notes: readonly ExtensionReviewSnapshotNote[]): Promise<void> {
  let sessionId: string;
  try {
    sessionId = await sessionIdForGeneration(run, cwd, generation);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; nothing was resolved.`);
  }
  for (const note of notes) {
    await run("hunk", ["session", "comment", "rm", sessionId, note.id, "--json"], cwd);
  }
}

/**
 * Hunk's verdict on a saved note, corrected for one gap in it: a note whose file has
 * left the review (its change was reverted) keeps reporting "active" at its old anchor,
 * yet Hunk no longer renders it and refuses replies to it. Such a note counts as
 * orphaned until its file is back, when Hunk shows it again under the same ID.
 */
export function shownResolution(note: ExtensionReviewSnapshotNote, snapshot: ExtensionReviewSnapshot): ExtensionReviewSnapshotNote["resolution"] {
  return snapshot.files.some(file => file.fileKey === note.fileKey) ? note.resolution : "orphaned";
}

/**
 * Each requested root comment's conversation as the agent should read it: the
 * root, then its replies in saved order. Roots Hunk no longer renders, or no
 * longer holds, are returned as skipped rather than sent.
 */
export function conversationsForPrompt(snapshot: ExtensionReviewSnapshot, rootIds: readonly string[]): { conversations: PromptConversation[]; skipped: string[] } {
  const byId = new Map(snapshot.notes.map(note => [note.id, note]));
  const paths = new Map(snapshot.files.map(file => [file.fileKey, file.path]));
  const conversations: PromptConversation[] = [];
  const skipped: string[] = [];
  for (const id of rootIds) {
    const root = byId.get(id);
    const at = root && (root.anchor.preferred
      ?? (root.anchor.newRange ? { side: "new" as const, line: root.anchor.newRange[0] } : undefined)
      ?? (root.anchor.oldRange ? { side: "old" as const, line: root.anchor.oldRange[0] } : undefined));
    if (!root || shownResolution(root, snapshot) === "orphaned" || !at) { skipped.push(id); continue; }
    const notes = snapshot.notes.filter(note => shownResolution(note, snapshot) !== "orphaned" && rootId(note, byId) === root.id);
    conversations.push({
      replyTo: root.id,
      filePath: paths.get(root.fileKey) ?? root.fileKey,
      side: at.side,
      line: at.line,
      stale: root.resolution === "stale",
      messages: notes.map(note => ({
        from: note.source === "user" ? "user" : note.author || "agent",
        text: [note.summary, note.rationale].filter(Boolean).join("\n"),
      })),
    });
  }
  return { conversations, skipped };
}
