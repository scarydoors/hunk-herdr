import type {
  ExtensionReviewSelection,
  ExtensionReviewSnapshot,
  ExtensionReviewSnapshotNote,
} from "hunkdiff/extension";
import type { Run } from "./bridge.ts";

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

/**
 * The one item nearest a line, by `distanceToLine`. Without a line every item is
 * equally near, so more than one is a tie. This is the single rule behind the
 * Threads pane's active comment and the thread a command acts on.
 */
export function nearestToLine<T>(items: readonly T[], anchorOf: (item: T) => LineAnchor, at: LineAddress | null | undefined): Nearest<T> {
  let best: { item: T; distance: number } | undefined;
  let tied = 0;
  for (const item of items) {
    const distance = at ? distanceToLine(anchorOf(item), at) : 0;
    if (!best || distance < best.distance) { best = { item, distance }; tied = 1; }
    else if (distance === best.distance) tied++;
  }
  if (!best) return { kind: "none" };
  if (tied > 1) return { kind: "tie", count: tied };
  return { kind: "one", item: best.item, distance: best.distance };
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
 * Find the thread the cursor is on or nearest to within the selected hunk.
 *
 * The user's own threads in the hunk are ranked by their distance to the current
 * line, so a hunk with several comments resolves to the closest one — the same
 * comment the Threads pane highlights. Agent and AI threads count only when the
 * hunk holds none of the user's. Only an exact tie between two threads is
 * refused; without a current line, several threads in one hunk are a tie.
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

  // Rank each thread by its closest note; the cursor line is compared against the
  // side it addresses, since context rows carry the new-side number.
  const rootsInHunk = new Map<string, ExtensionReviewSnapshotNote[]>();
  for (const note of atHunk) {
    const root = rootId(note, byId);
    if (root === null) continue;
    rootsInHunk.set(root, [...(rootsInHunk.get(root) ?? []), note]);
  }
  // Threads groups hold the user's own root comments, so those are what a key at
  // the cursor means; an agent's comment beside yours must not make it ambiguous.
  const roots = [...rootsInHunk.entries()];
  const own = roots.filter(([id]) => byId.get(id)?.source === "user");
  const nearest = nearestToLine(own.length ? own : roots, ([, group]) => closestAnchor(group, selection.currentLine), selection.currentLine);
  if (nearest.kind === "none") return { kind: "none", message: "No review thread at the current location." };
  if (nearest.kind === "tie") {
    return {
      kind: "ambiguous",
      message: selection.currentLine
        ? `${nearest.count} of your comments are equally close to this line; move onto one of them.`
        : `${nearest.count} of your comments share this hunk and no line is current; move onto one of them.`,
    };
  }
  const [id] = nearest.item;

  const root = byId.get(id);
  if (!root) return { kind: "none", message: "The review thread is no longer available." };
  const thread = notes
    .filter(note => rootId(note, byId) === root.id)
    .sort((left, right) => depth(right, byId) - depth(left, byId));
  return { kind: "found", root, notes: thread };
}

/** A thread is as near as its nearest note, so rank it by that note's anchor. */
function closestAnchor(group: readonly ExtensionReviewSnapshotNote[], at: LineAddress | null): LineAnchor {
  if (!at) return group[0]!.anchor;
  const nearest = nearestToLine(group, note => note.anchor, at);
  return nearest.kind === "one" ? nearest.item.anchor : group[0]!.anchor;
}

type SessionList = {
  sessions?: Array<{ sessionId?: string; snapshot?: { state?: { reviewPublication?: { generation?: string } } } }>;
};

/** Remove descendants before their parents so Hunk never leaves dangling replies. */
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

export async function removeThread(run: Run, cwd: string, generation: string, notes: readonly ExtensionReviewSnapshotNote[]): Promise<void> {
  const listed = JSON.parse(await run("hunk", ["session", "list", "--json"], cwd)) as SessionList;
  const matches = (listed.sessions ?? []).filter(session => session.snapshot?.state?.reviewPublication?.generation === generation);
  if (matches.length !== 1 || !matches[0]!.sessionId) {
    throw new Error(matches.length > 1
      ? "Multiple Hunk sessions matched this review; nothing was resolved."
      : "The live Hunk session could not be identified; nothing was resolved.");
  }
  for (const note of notes) {
    await run("hunk", ["session", "comment", "rm", matches[0]!.sessionId!, note.id, "--json"], cwd);
  }
}
