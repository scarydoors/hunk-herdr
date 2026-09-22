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

/** Find one thread at the command's review location without guessing between threads. */
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
