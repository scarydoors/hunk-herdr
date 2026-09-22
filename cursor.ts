import type { ExtensionDiffFile, ExtensionReviewSnapshot, ExtensionReviewSnapshotNote } from "hunkdiff/extension";
import type { LineAddress } from "./threads.ts";

/**
 * Hunk's review cursor moves through "stops": every diff row, plus one row per
 * visible note placed directly under the row it is anchored to. While the cursor
 * rests on a note row Hunk's selection reports no current line and never names
 * the note, so this module rebuilds the stop list from what an extension can see
 * — the file's patch and the saved notes — and replays the moves Hunk reported
 * since the last position it did state exactly.
 */
export type Stop =
  | { readonly kind: "line"; readonly hunkIndex: number; readonly side: "old" | "new"; readonly line: number }
  | { readonly kind: "note"; readonly hunkIndex: number; readonly noteId: string; readonly rootId: string; readonly side: "old" | "new"; readonly line: number };

/** A position Hunk stated outright: the current line of a command, or a note it just made active. */
export type Fix =
  | { readonly kind: "line"; readonly fileId: string; readonly hunkIndex: number; readonly side: "old" | "new"; readonly line: number }
  | { readonly kind: "note"; readonly noteId: string };

/** One reported cursor move, in stop-list terms. */
export type Move =
  | { readonly kind: "step"; readonly delta: 1 | -1 }
  | { readonly kind: "note"; readonly delta: 1 | -1 }
  /** To the first row of the adjacent hunk, or of the adjacent hunk that has a note. */
  | { readonly kind: "hunk"; readonly delta: 1 | -1; readonly annotated: boolean };

const STEP_MOVES: Record<string, Move> = {
  "hunk.review.stepDown": { kind: "step", delta: 1 },
  "hunk.review.stepUp": { kind: "step", delta: -1 },
  "hunk.review.nextNote": { kind: "note", delta: 1 },
  "hunk.review.previousNote": { kind: "note", delta: -1 },
  "hunk.review.nextHunk": { kind: "hunk", delta: 1, annotated: false },
  "hunk.review.previousHunk": { kind: "hunk", delta: -1, annotated: false },
  "hunk.review.nextAnnotatedHunk": { kind: "hunk", delta: 1, annotated: true },
  "hunk.review.previousAnnotatedHunk": { kind: "hunk", delta: -1, annotated: true },
};

/** Commands that move the cursor somewhere this module cannot follow. */
const LOSING_MOVES = new Set([
  "hunk.review.pageDown", "hunk.review.pageUp", "hunk.review.halfPageDown", "hunk.review.halfPageUp",
  "hunk.review.jumpToTop", "hunk.review.jumpToBottom",
  "hunk.review.nextFile", "hunk.review.previousFile", "hunk.review.nextAnnotatedFile", "hunk.review.previousAnnotatedFile",
  "hunk.review.deleteActiveNote", "hunk.app.refresh",
]);

/** How a reported command changes the tracked position: a replayable move, a loss, or nothing. */
export function moveForCommand(commandId: string): Move | "lost" | undefined {
  if (STEP_MOVES[commandId]) return STEP_MOVES[commandId];
  return LOSING_MOVES.has(commandId) ? "lost" : undefined;
}

/**
 * The diff rows of a unified patch, in Hunk's render order. A deleted row is
 * addressed on the old side, an added row on the new side, and a context row by
 * Hunk's canonical new-side number.
 */
export function patchLineStops(patch: string): Extract<Stop, { kind: "line" }>[] {
  const stops: Extract<Stop, { kind: "line" }>[] = [];
  let hunkIndex = -1;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      hunkIndex++;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("diff ") || raw.startsWith("--- ") && stops.length === 0) { inHunk = false; continue; }
    const marker = raw[0];
    if (marker === "-") { stops.push({ kind: "line", hunkIndex, side: "old", line: oldLine }); oldLine++; }
    else if (marker === "+") { stops.push({ kind: "line", hunkIndex, side: "new", line: newLine }); newLine++; }
    else if (marker === " ") { stops.push({ kind: "line", hunkIndex, side: "new", line: newLine }); oldLine++; newLine++; }
    else if (marker === "\\") continue; // "\ No newline at end of file"
    else if (raw === "") continue;
    else inHunk = false; // another file's header
  }
  return stops;
}

/** Maps a snapshot note to the root of its native thread. */
function rootIdOf(note: ExtensionReviewSnapshotNote, byId: ReadonlyMap<string, ExtensionReviewSnapshotNote>): string {
  let current = note;
  const seen = new Set<string>();
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

/**
 * The stop list for one file: its rows interleaved with the notes anchored to
 * them, notes in snapshot order (live notes first, then user notes by creation),
 * each directly after its anchor row. `showAgentNotes` mirrors Hunk's toggle.
 */
export function fileStops(file: Pick<ExtensionDiffFile, "id" | "patch">, snapshot: ExtensionReviewSnapshot, showAgentNotes: boolean): Stop[] {
  const semantic = snapshot.files.find(candidate => candidate.runtimeId === file.id);
  const rows = patchLineStops(file.patch);
  if (!semantic) return rows;
  const notes = snapshot.notes.filter(note => note.fileKey === semantic.fileKey && note.resolution === "active" && (showAgentNotes || note.source === "user"));
  const byId = new Map(snapshot.notes.map(note => [note.id, note]));
  const byRow = new Map<string, Stop[]>();
  for (const note of notes) {
    const at = note.anchor.preferred;
    if (!at) continue;
    const key = `${at.side}:${at.line}`;
    byRow.set(key, [...(byRow.get(key) ?? []), {
      kind: "note", hunkIndex: note.anchor.ownerHunkIndex ?? -1, noteId: note.id, rootId: rootIdOf(note, byId), side: at.side, line: at.line,
    }]);
  }
  return rows.flatMap(row => {
    // A note anchored to a context row carries the new-side address, as the row does.
    const under = byRow.get(`${row.side}:${row.line}`) ?? [];
    return [row, ...under.map(note => note.hunkIndex >= 0 ? note : { ...note, hunkIndex: row.hunkIndex })];
  });
}

function indexOfFix(stops: readonly Stop[], fix: Fix): number {
  return stops.findIndex(stop => fix.kind === "note"
    ? stop.kind === "note" && stop.noteId === fix.noteId
    : stop.kind === "line" && stop.hunkIndex === fix.hunkIndex && stop.side === fix.side && stop.line === fix.line);
}

/**
 * Where the cursor is after `moves` from `fix`, following Hunk's own rules: a
 * step goes to the adjacent stop and clamps at the ends; next/previous note goes
 * to the adjacent note stop, or from a line to the nearest note that way.
 * Undefined when the fix is not in this list or a move leaves it.
 */
export function replayMoves(stops: readonly Stop[], fix: Fix, moves: readonly Move[]): Stop | undefined {
  let index = indexOfFix(stops, fix);
  if (index < 0) return undefined;
  for (const move of moves) {
    if (move.kind === "step") {
      index = Math.min(Math.max(index + move.delta, 0), stops.length - 1);
      continue;
    }
    if (move.kind === "hunk") {
      // Hunk lands on the first row of the target hunk. A target outside this
      // file, or a wrap around the review, is beyond this list.
      const current = stops[index]!.hunkIndex;
      const annotated = new Set(stops.flatMap(stop => stop.kind === "note" ? [stop.hunkIndex] : []));
      const target = stops.find(stop => stop.kind === "line"
        && (move.delta > 0 ? stop.hunkIndex > current : stop.hunkIndex < current)
        && (!move.annotated || annotated.has(stop.hunkIndex)));
      const chosen = move.delta > 0 ? target : [...stops].reverse().find(stop => stop.kind === "line"
        && stop.hunkIndex < current && (!move.annotated || annotated.has(stop.hunkIndex)));
      if (!chosen) return undefined;
      const first = stops.findIndex(stop => stop.kind === "line" && stop.hunkIndex === chosen.hunkIndex);
      if (first < 0) return undefined;
      index = first;
      continue;
    }
    const noteIndexes = stops.flatMap((stop, at) => stop.kind === "note" ? [at] : []);
    const next = move.delta > 0 ? noteIndexes.find(at => at > index) : [...noteIndexes].reverse().find(at => at < index);
    // No note that way in this file: Hunk continues into another file's notes, or
    // stays if there are none anywhere. One file's list cannot tell which.
    if (next === undefined) return undefined;
    index = next;
  }
  return stops[index];
}

/** The cursor as `nearestToCursor` consumes it: a line, or the note whose row it rests on. */
export function stopAddress(stop: Stop): { at: LineAddress | null; noteId?: string } {
  return stop.kind === "line" ? { at: { side: stop.side, line: stop.line } } : { at: null, noteId: stop.rootId };
}

// --- Tracked state ------------------------------------------------------------

let fix: Fix | undefined;
let moves: Move[] = [];
let showAgentNotes = true;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** Notifies when the tracked position changes, so a pane can re-render. */
export function onCursorChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Record a position Hunk stated exactly; earlier moves no longer matter. */
export function recordFix(next: Fix): void {
  fix = next;
  moves = [];
  changed();
}

/** Record a built-in command Hunk reported as executed. */
export function recordCommand(commandId: string): void {
  if (commandId === "hunk.view.toggleAgentNotes") { showAgentNotes = !showAgentNotes; changed(); return; }
  const move = moveForCommand(commandId);
  if (!move) return;
  if (move === "lost") { fix = undefined; moves = []; }
  else moves.push(move);
  changed();
}

/** The note Hunk just made active, while no move has been reported since. */
export function pendingNoteFix(): string | undefined {
  return fix?.kind === "note" && moves.length === 0 ? fix.noteId : undefined;
}

/** Forget everything, e.g. on a reload that renumbers files. */
export function resetCursorTracking(options: { showAgentNotes?: boolean } = {}): void {
  fix = undefined;
  moves = [];
  showAgentNotes = options.showAgentNotes ?? true;
  changed();
}

export function agentNotesShown(): boolean {
  return showAgentNotes;
}

/**
 * The stop the cursor should be on in `file`, replayed from the last fix. The
 * caller checks it against whatever Hunk does report (selected hunk, whether a
 * note is active) before trusting it.
 */
export function trackedStop(file: Pick<ExtensionDiffFile, "id" | "patch">, snapshot: ExtensionReviewSnapshot): Stop | undefined {
  if (!fix) return undefined;
  if (fix.kind === "line" && fix.fileId !== file.id) return undefined;
  return replayMoves(fileStops(file, snapshot, showAgentNotes), fix, moves);
}
