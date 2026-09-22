import { setTimeout as delay } from "node:timers/promises";
import { matchesKey } from "hunkdiff/extension";
import type { ExtensionCommandContext, ExtensionEventContext, ExtensionReviewNote, ExtensionReviewSelection, ExtensionReviewSnapshot, ExtensionReviewSnapshotNote, HunkExtensionAPI } from "hunkdiff/extension";
import { Bridge, buildPrompt, label, run, sameAgent, type Pane } from "./bridge.ts";
import { agentConfig, type AgentKind } from "./config.ts";
import { modelOptions } from "./model-catalog.ts";
import { isConfigurableAgentKind, loadModelDefaults, saveModelDefaults, type ConfigurableAgentKind, type ModelDefaults } from "./model-defaults.ts";
import { removeThread, threadAtSelection, threadsForCommentIds } from "./threads.ts";
import {
  ThreadsPane,
  activateSelectedThreadItem,
  type ReviewThread,
  type ThreadSelection,
  assignComment,
  assignUnassignedThread,
  createThreadFromComment,
  createThreadFromGroup,
  cursorPosition,
  observeCursorCommand,
  moveComment,
  moveCommentToUnassigned,
  moveThreadComments,
  moveThreadToUnassigned,
  nearestThreadForNote,
  selectedThreadItem,
  threadForComment,
  UNASSIGNED_THREAD_ID,
  UNASSIGNED_THREAD_TITLE,
  moveThreadSelection,
  toggleThreadHelp,
  removeAssignedComment,
  removeThreadGroup,
  startThreadNavigation,
  stopThreadNavigation,
  setThreadCompleted,
  setThreadDispatching,
  updateThreadCommentNavigation,
  threadBoardSnapshot,
  updateAssignedComment,
} from "./threads-pane.tsx";

type Context = ExtensionCommandContext;

/** What an empty prompt sends: the group's comments are the request. */
export const DEFAULT_REQUEST = "Address every listed review comment and reply in its thread.";

export default function register(hunk: HunkExtensionAPI) {
  hunk.registerPane({
    id: "threads",
    title: "Threads",
    placement: "right",
    width: { preferred: 42, min: 28, max: 72, fraction: 0.3 },
    // The pane highlights the comment at the review cursor, so it needs the current line.
    currentLine: true,
    component: ThreadsPane,
  });
  hunk.registerKeyboardMode({
    id: "threads",
    title: "Threads",
    onEnter: () => { startThreadNavigation(); },
    onExit: () => { stopThreadNavigation(); },
    onKey: key => {
      // Let the global visibility and focus commands keep their own bindings.
      if (key.name === "t") return "pass";
      // Hunk owns "?" globally, so the mode has to claim it before the app help opens.
      if (matchesKey("?", key)) return toggleThreadHelp() ? "handled" : "pass";
      if (key.name === "j" || key.name === "down") return moveThreadSelection(1) ? "handled" : "pass";
      if (key.name === "k" || key.name === "up") return moveThreadSelection(-1) ? "handled" : "pass";
      if (key.name === "enter" || key.name === "return" || key.name === "space") {
        return activateSelectedThreadItem() ? "handled" : "pass";
      }
      return "pass";
    },
  });

  // `model` is only known for agents Herdr started itself; an agent we attached to
  // reports no model, so the prompt screen says so rather than guessing one.
  type ThreadAgent = { pane?: Pane; bridge: Bridge; owned: boolean; ready: Promise<Pane>; model?: string };
  const threadAgents = new Map<string, ThreadAgent>();
  const dispatches = new Map<string, number>();
  const drafts = new Map<string, string>();
  let disposed = false;
  let pending: Promise<void> | undefined;
  let originallyZoomed: boolean | undefined;
  let modelDefaults = loadModelDefaults();

  function client(ctx: Context): Bridge {
    return new Bridge(ctx.cwd);
  }
  async function showThreadHelp(ctx: Context): Promise<void> {
    if (!ctx.keyboardModes.isActive("threads")) {
      ctx.notify("Focus Threads (Ctrl+T) to view Threads keybindings.", "warning");
      return;
    }
    toggleThreadHelp();
  }
  async function configureModels(ctx: Context): Promise<void> {
    const config = agentConfig(hunk.config);
    const kinds = (["pi", "claude"] as const).filter(kind => config.agents.includes(kind));
    if (!kinds.length) {
      ctx.notify("Enable Pi or Claude in the hunk-herdr agents setting first.", "warning");
      return;
    }
    const agents = kinds.map(kind => ({ kind, label: `${kind === "pi" ? "Pi" : "Claude"} · ${modelDefaults[kind] || "default"}` }));
    const pickedAgent = await ctx.dialogs.select({ title: "Configure agent model defaults", options: [...agents.map(agent => agent.label), "Leave unchanged"] });
    const agent = agents.find(candidate => candidate.label === pickedAgent);
    if (!agent || !alive(ctx)) return;
    const models = modelOptions(agent.kind);
    if (models.length === 1) {
      ctx.notify(`No cached ${agent.kind === "pi" ? "Pi" : "Claude"} model catalog is available yet. Start that agent once, then try again.`, "warning");
      return;
    }
    const pickedModel = await ctx.dialogs.select({ title: `Default ${agent.kind === "pi" ? "Pi" : "Claude"} model`, options: [...models.map(model => model.label), "Leave unchanged"] });
    const model = models.find(candidate => candidate.label === pickedModel);
    if (!model || !alive(ctx)) return;
    const next: ModelDefaults = { ...modelDefaults };
    if (model.model) next[agent.kind] = model.model;
    else delete next[agent.kind];
    saveModelDefaults(next);
    modelDefaults = next;
    ctx.notify(model.model ? `Default ${agent.kind} model saved: ${model.model}` : `Default ${agent.kind} model cleared.`);
  }
  /**
   * The Threads item a command acts on: the keyboard selection while Threads
   * navigation is focused, otherwise the comment under the review cursor.
   *
   * Rule: the comment the Threads pane shows as active is the one a review-side
   * key acts on. The pane's highlight is therefore read back here, not recomputed,
   * so what you see is what P, A, Ctrl+R and X touch. The snapshot lookup below
   * is the fallback for what the pane cannot show: a comment no group holds yet
   * (one from before this session, filed in Unassigned here), an agent's comment
   * when none of yours is in the hunk, or a pane that is closed.
   */
  function resolveThreadSelection(ctx: Context): ThreadSelection | undefined {
    if (ctx.keyboardModes.isActive("threads")) {
      const selection = selectedThreadItem();
      if (!selection) ctx.notify("Select a Threads group or comment first (j/k).", "warning");
      return selection;
    }
    const shown = threadBoardSnapshot().cursorCommentId;
    const shownThread = threadForComment(shown);
    const shownComment = shownThread?.comments.find(candidate => candidate.id === shown);
    if (shownThread && shownComment) return { kind: "comment", thread: shownThread, comment: shownComment };
    const snapshot = ctx.review.snapshot();
    if (!snapshot) return undefined;
    const cursor = cursorPosition(ctx.selection.file?.id ?? null, ctx.selection.hunkIndex, ctx.selection.currentLine);
    const match = threadAtSelection(snapshot, ctx.selection, cursor);
    if (match.kind !== "found") {
      ctx.notify(match.kind === "none" ? "No review comment at the cursor. Save one, or focus Threads (Ctrl+T)." : match.message, "warning");
      return undefined;
    }
    let thread = threadForComment(match.root.id);
    if (!thread) {
      if (match.root.source !== "user") {
        ctx.notify("The comment at the cursor was not written by you, so it has no Threads group.", "warning");
        return undefined;
      }
      thread = assignUnassignedThread(noteFromSnapshot(snapshot, match.root, ctx.selection));
    }
    const comment = thread.comments.find(candidate => candidate.id === match.root.id);
    return comment ? { kind: "comment", thread, comment } : { kind: "thread", thread };
  }
  function selectedGroup(ctx: Context): ReviewThread | undefined {
    return resolveThreadSelection(ctx)?.thread;
  }
  /** Rebuilds the lifecycle-event shape of a note from the authoritative snapshot. */
  function noteFromSnapshot(snapshot: ExtensionReviewSnapshot, root: ExtensionReviewSnapshotNote, selection: ExtensionReviewSelection): ExtensionReviewNote {
    const file = snapshot.files.find(candidate => candidate.fileKey === root.fileKey);
    const preferred = root.anchor.preferred ?? selection.currentLine ?? undefined;
    return {
      id: root.id,
      fileId: file?.runtimeId ?? selection.file?.id ?? "",
      filePath: file?.path ?? selection.file?.path ?? "",
      hunkIndex: root.anchor.ownerHunkIndex ?? root.anchor.intersectingHunkIndices[0] ?? selection.hunkIndex ?? 0,
      side: preferred?.side ?? "new",
      line: preferred?.line ?? root.anchor.newRange?.[0] ?? root.anchor.oldRange?.[0] ?? 1,
      body: root.summary,
      draft: false,
    };
  }
  function threadAgent(thread: ReviewThread): ThreadAgent | undefined {
    return threadAgents.get(thread.id);
  }
  function beginDispatch(threadId: string): () => void {
    dispatches.set(threadId, (dispatches.get(threadId) ?? 0) + 1);
    setThreadDispatching(threadId, true);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const remaining = (dispatches.get(threadId) ?? 1) - 1;
      if (remaining > 0) dispatches.set(threadId, remaining);
      else {
        dispatches.delete(threadId);
        setThreadDispatching(threadId, false);
      }
    };
  }
  async function readyAgent(binding: ThreadAgent): Promise<Pane> {
    const pane = await binding.ready;
    binding.pane = pane;
    return pane;
  }
  function modelHint(binding: ThreadAgent): string {
    if (!binding.owned) return "model: as started";
    return binding.model ? `model: ${binding.model}` : "model: agent default";
  }
  function agentLabel(agent: Pane): string {
    const binding = [...threadAgents.entries()].find(([, value]) => value.pane && sameAgent(value.pane, agent));
    const thread = binding && threadBoardSnapshot().threads.find(candidate => candidate.id === binding[0]);
    return `${label(agent)}${thread ? ` · assigned to ${thread.title}` : ""}`;
  }
  function alive(ctx: Context): boolean {
    return !disposed && ctx.review.snapshot() !== null;
  }
  // Agent state is shown in the Threads pane and dialogs, not a persistent status row.
  function badge(_ctx: Context, _message?: string) {}
  async function choose(ctx: Context, thread = selectedGroup(ctx), waitForReady = true): Promise<ThreadAgent | undefined> {
    if (!thread) return undefined;
    if (threadAgent(thread)?.owned) {
      ctx.notify("Stop this group's temporary agent before choosing a replacement.", "warning");
      return undefined;
    }
    const api = client(ctx);
    const config = agentConfig(hunk.config);
    const agents = (await api.agents()).filter(agent => config.agents.some(kind => kind === agent.agent)
      && (!(agent.foreground_cwd || agent.cwd) || (agent.foreground_cwd || agent.cwd) === ctx.cwd));
    if (!alive(ctx)) return undefined;
    // The default kind (or the only kind) starts from the first row, so Enter is
    // enough; existing idle agents and other kinds stay one row away.
    const direct = config.defaultAgent ?? (config.agents.length === 1 ? config.agents[0] : undefined);
    const directModel = direct && isConfigurableAgentKind(direct) ? modelDefaults[direct] : undefined;
    const startDirect = direct ? `+ Start ${direct}${config.defaultAgent ? " (default)" : ""}${directModel ? ` · ${directModel}` : ""}` : undefined;
    const otherKinds = config.agents.filter(kind => kind !== direct);
    const startOther = otherKinds.length ? (direct ? "+ Start another kind…" : "+ Start temporary agent…") : undefined;
    const options = agents.map(agent => `${threadAgent(thread)?.pane?.pane_id === agent.pane_id ? "● " : "○ "}${agentLabel(agent)}`);
    const picked = await ctx.dialogs.select({
      title: `Herdr · agent for ${thread.title}`,
      options: [...(startDirect ? [startDirect] : []), ...options, ...(startOther ? [startOther] : []), "Leave unchanged"],
    });
    if (!picked || picked === "Leave unchanged" || !alive(ctx)) return undefined;
    let binding: ThreadAgent;
    if (picked === startDirect || picked === startOther) {
      let kind: AgentKind | undefined = picked === startDirect ? direct : undefined;
      if (!kind) {
        const chosen = await ctx.dialogs.select({
          title: `Temporary agent for ${thread.title} · choose kind`,
          options: [...otherKinds, "Leave unchanged"],
        });
        if (!chosen || chosen === "Leave unchanged" || !alive(ctx)) return undefined;
        kind = otherKinds.find(allowed => allowed === chosen);
        if (!kind) throw new Error("Agent type is not enabled.");
      }
      const caller = await api.caller();
      const layout = await api.layout(caller);
      if (!alive(ctx)) return;
      originallyZoomed ??= layout.zoomed;
      badge(ctx, `starting ${kind} for ${thread.title}…`);
      const endStarting = beginDispatch(thread.id);
      const model = isConfigurableAgentKind(kind) ? modelDefaults[kind] : undefined;
      const ready = api.spawn(kind, model).finally(endStarting);
      // Attach a handler now: the user may cancel the prompt before startup finishes.
      void ready.catch(() => {});
      binding = { bridge: api, owned: true, ready, model };
      threadAgents.set(thread.id, binding);
      if (waitForReady) {
        await readyAgent(binding);
        if (alive(ctx)) ctx.notify(`Temporary agent ready for ${thread.title}. Hunk stays zoomed; use Reveal to see it.`);
      }
    } else {
      const pane = await api.validate(agents[options.indexOf(picked)]!);
      binding = { pane, bridge: api, owned: false, ready: Promise.resolve(pane) };
      threadAgents.set(thread.id, binding);
    }
    if (alive(ctx)) badge(ctx);
    return binding;
  }
  async function prompt(ctx: Context): Promise<void> {
    const thread = selectedGroup(ctx);
    if (!thread) return;
    const binding = threadAgent(thread) ?? await choose(ctx, thread, false);
    if (!binding || !alive(ctx)) return;
    const count = thread.comments.length;
    const text = await ctx.dialogs.input({
      title: `Prompt ${agentName(binding)} · ${modelHint(binding)} · ${thread.title}`,
      placeholder: `Enter to address the ${count} listed comment${count === 1 ? "" : "s"}, or type extra instructions…`,
      initial: drafts.get(thread.id) ?? "",
    });
    // Esc cancels; an empty submission means the listed comments are the request.
    if (text === null || text === undefined || !alive(ctx)) return;
    const typed = text.trim() ? text : undefined;
    if (typed) drafts.set(thread.id, typed);
    const skill = await binding.bridge.skillPath();
    if (!skill) throw new Error("hunk skill path returned no path. Nothing sent.");
    if (!alive(ctx)) return;
    const payload = buildPrompt(skill, ctx.cwd, typed ?? DEFAULT_REQUEST, {
      file: ctx.selection.file?.path,
      hunk: ctx.selection.hunkIndex ?? undefined,
      thread: { title: thread.title, comments: thread.comments },
    });
    badge(ctx, `sending ${thread.title}…`);
    // Herdr's waits are deliberately unbounded, and an agent that never reaches a
    // matched state never ends them. Watching the turn from inside the command would
    // therefore hold the single-operation lock for the rest of the session, so the
    // turn is watched here instead: the group's own spinner reports it, and every
    // other command — resolving, stopping this agent — stays usable meanwhile.
    watchDispatch(ctx, thread, binding, payload, typed);
    ctx.notify(`Sent to ${agentName(binding)}: ${thread.title}.`);
  }
  function agentName(binding: ThreadAgent): string {
    return binding.pane?.name || binding.pane?.agent || "starting agent";
  }
  /** Follows one dispatched prompt to completion outside the command that sent it. */
  function watchDispatch(ctx: Context, thread: ReviewThread, binding: ThreadAgent, payload: string, draft?: string): void {
    const endSending = beginDispatch(thread.id);
    // The text is on its way: a second P during the turn starts from an empty prompt.
    drafts.delete(thread.id);
    void (async () => {
      try {
        const settled = await binding.bridge.promptWhenReady(await readyAgent(binding), payload);
        if (["idle", "done"].includes(settled.agent_status || "")) setThreadCompleted(thread.id);
        if (alive(ctx)) ctx.notify(`Agent completed the prompt for thread: ${thread.title}.`);
      } catch (error) {
        // A failed hand-off keeps the typed request available for the retry.
        if (draft && !drafts.has(thread.id)) drafts.set(thread.id, draft);
        if (alive(ctx)) ctx.notify(`${thread.title}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      } finally {
        endSending();
      }
    })();
  }
  async function refresh(ctx: Context): Promise<void> {
    const thread = selectedGroup(ctx);
    const binding = thread && threadAgent(thread);
    if (!thread || !binding) { await choose(ctx, thread); return; }
    binding.pane = await binding.bridge.validate(await readyAgent(binding));
    if (alive(ctx)) { badge(ctx); ctx.notify(agentLabel(binding.pane)); }
  }
  async function reveal(ctx: Context): Promise<void> {
    const thread = selectedGroup(ctx);
    const binding = thread && threadAgent(thread);
    if (!thread || !binding) { await choose(ctx, thread); return; }
    await binding.bridge.reveal(await readyAgent(binding));
  }
  async function stop(ctx: Context): Promise<void> {
    const thread = selectedGroup(ctx);
    const binding = thread && threadAgent(thread);
    if (!thread || !binding?.owned) { ctx.notify("This thread has no temporary agent owned by this Hunk session."); return; }
    if (!await ctx.dialogs.confirm({
      title: `Stop temporary agent for ${thread.title}?`, body: "Closes its sibling pane and terminates any running work. Existing agents are never closed.",
      confirmLabel: "Stop agent", cancelLabel: "Leave running",
    }) || !alive(ctx)) return;
    await binding.bridge.stop();
    threadAgents.delete(thread.id);
    badge(ctx);
    ctx.notify(`Temporary agent stopped for ${thread.title}.`);
  }
  /**
   * A displayed group is only a container for its comments. Once the last one is
   * resolved — from the Threads pane, from the review, or by the agent itself —
   * the group goes with it, and any temporary agent Herdr started to serve that
   * group is closed. Agents the user picked are never touched.
   */
  async function retireEmptyGroup(threadId: string, ctx?: { notify: Context["notify"] }): Promise<void> {
    const thread = threadBoardSnapshot().threads.find(candidate => candidate.id === threadId);
    if (!thread || thread.comments.length) return;
    const binding = threadAgents.get(threadId);
    threadAgents.delete(threadId);
    removeThreadGroup(threadId);
    if (!binding?.owned) return;
    try {
      await binding.bridge.stop();
      ctx?.notify(`Resolved every comment in ${thread.title}; its temporary agent was closed.`);
    } catch (error) {
      hunk.log(`Temporary pane cleanup for ${thread.title}: ${String(error)}`);
      ctx?.notify(`${thread.title} is fully resolved, but its temporary agent could not be closed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }
  async function resolveThread(ctx: Context): Promise<void> {
    const before = ctx.review.snapshot();
    if (!before) return;
    const selected = ctx.keyboardModes.isActive("threads") ? selectedThreadItem() : undefined;
    if (selected) {
      return selected.kind === "thread" || selected.thread.comments.length === 1
        ? resolveSelectedThreadGroup(ctx, before, selected.thread)
        : resolveSelectedThreadComment(ctx, before, selected.thread, selected.comment.id);
    }
    const cursor = cursorPosition(ctx.selection.file?.id ?? null, ctx.selection.hunkIndex, ctx.selection.currentLine);
    const match = threadAtSelection(before, ctx.selection, cursor);
    if (match.kind !== "found") {
      ctx.notify(match.message, match.kind === "ambiguous" ? "warning" : undefined);
      return;
    }
    const count = match.notes.length;
    const confirmed = await ctx.dialogs.confirm({
      title: "Resolve this review thread?",
      body: `Removes ${count} comment${count === 1 ? "" : "s"} in this thread. This cannot be undone.`,
      confirmLabel: "Resolve thread",
      cancelLabel: "Leave open",
    });
    if (!confirmed) return;
    const current = ctx.review.snapshot();
    if (!current || current.generation !== before.generation || current.stateRevision !== before.stateRevision) {
      ctx.notify("The review changed while confirmation was open; nothing was resolved.", "warning");
      return;
    }
    await removeThread(run, ctx.cwd, before.generation, match.notes);
    if (alive(ctx)) ctx.notify(`Resolved review thread (${count} comment${count === 1 ? "" : "s"}).`);
  }
  async function resolveSelectedThreadComment(ctx: Context, before: NonNullable<ReturnType<Context["review"]["snapshot"]>>, thread: ReviewThread, commentId: string): Promise<void> {
    const notes = threadsForCommentIds(before, new Set([commentId]));
    if (!notes.length) {
      removeAssignedComment(commentId);
      ctx.notify(`Removed stale comment from Threads group: ${thread.title}.`);
      return;
    }
    const confirmed = await ctx.dialogs.confirm({
      title: `Resolve comment in ${thread.title}?`,
      body: `Removes this native review thread and its ${notes.length} comment${notes.length === 1 ? "" : "s"}. Other comments in the displayed group stay open.`,
      confirmLabel: "Resolve comment",
      cancelLabel: "Leave open",
    });
    if (!confirmed) return;
    const current = ctx.review.snapshot();
    if (!current || current.generation !== before.generation || current.stateRevision !== before.stateRevision) {
      ctx.notify("The review changed while confirmation was open; nothing was resolved.", "warning");
      return;
    }
    await removeThread(run, ctx.cwd, before.generation, notes);
    removeAssignedComment(commentId);
    if (alive(ctx)) ctx.notify(`Resolved comment in Threads group ${thread.title}.`);
    await retireEmptyGroup(thread.id, ctx);
  }
  async function resolveSelectedThreadGroup(ctx: Context, before: NonNullable<ReturnType<Context["review"]["snapshot"]>>, thread: ReviewThread): Promise<void> {
    const binding = threadAgent(thread);
    const notes = threadsForCommentIds(before, new Set(thread.comments.map(comment => comment.id)));
    if (!notes.length) {
      if (binding?.owned) await binding.bridge.stop();
      threadAgents.delete(thread.id);
      removeThreadGroup(thread.id);
      ctx.notify(`Removed empty Threads group: ${thread.title}.`);
      return;
    }
    const confirmed = await ctx.dialogs.confirm({
      title: `Resolve Threads group: ${thread.title}?`,
      body: `Removes this displayed group and ${notes.length} native review comment${notes.length === 1 ? "" : "s"}${binding?.owned ? `, then closes its temporary agent${thread.dispatching ? ", interrupting the work it is still running" : ""}` : ""}. This cannot be undone.`,
      confirmLabel: "Resolve group",
      cancelLabel: "Leave open",
    });
    if (!confirmed) return;
    const current = ctx.review.snapshot();
    if (!current || current.generation !== before.generation || current.stateRevision !== before.stateRevision) {
      ctx.notify("The review changed while confirmation was open; nothing was resolved.", "warning");
      return;
    }
    if (binding?.owned) await binding.bridge.stop();
    await removeThread(run, ctx.cwd, before.generation, notes);
    threadAgents.delete(thread.id);
    removeThreadGroup(thread.id);
    if (alive(ctx)) ctx.notify(`Resolved Threads group ${thread.title} (${notes.length} comment${notes.length === 1 ? "" : "s"}).`);
  }
  /**
   * A saved root comment joins the group holding the closest comment in the same
   * file; a file with no assigned comment yet lands in Unassigned. No dialog:
   * naming or moving is the exception, done afterwards with Ctrl+R.
   */
  function assignUserComment(note: ExtensionReviewNote, ctx: ExtensionEventContext): void {
    // Native replies belong to their root's review conversation; only roots can
    // represent an independently assignable orchestration request.
    if (note.draft || note.parentId) return;
    const nearest = nearestThreadForNote(note);
    const thread = nearest && assignComment(nearest.id, note)
      ? threadBoardSnapshot().threads.find(candidate => candidate.id === nearest.id)!
      : assignUnassignedThread(note);
    ctx.panes.open("threads");
    ctx.notify(`Added to ${thread.title} · Ctrl+R to move or name`);
  }
  async function reassignSelectedGroup(ctx: Context): Promise<void> {
    const selection = resolveThreadSelection(ctx);
    if (!selection) return;
    const source = selection.thread;
    const comment = selection.kind === "comment" ? selection.comment : undefined;
    if (threadAgents.has(source.id)) {
      ctx.notify(`Stop or reassign this group's agent before moving ${comment ? "this comment" : "its comments"}.`, "warning");
      return;
    }
    const entries = threadBoardSnapshot().threads
      .filter(thread => thread.id !== source.id && thread.id !== UNASSIGNED_THREAD_ID)
      .map((thread, index) => ({
        thread,
        label: `${thread.title} · ${thread.comments.length} comment${thread.comments.length === 1 ? "" : "s"} [${index + 1}]`,
      }));
    const create = "+ Create new thread…";
    const unassigned = UNASSIGNED_THREAD_TITLE;
    const picked = await ctx.dialogs.select({
      title: comment ? `Move comment from ${source.title}` : `Move ${source.comments.length} comment${source.comments.length === 1 ? "" : "s"} from ${source.title}`,
      options: [unassigned, ...entries.map(entry => entry.label), create, "Leave unchanged"],
    });
    if (!picked || picked === "Leave unchanged" || !alive(ctx)) return;
    let destination;
    if (picked === unassigned) {
      destination = comment ? moveCommentToUnassigned(source.id, comment.id) : moveThreadToUnassigned(source.id);
    } else if (picked === create) {
      const title = await ctx.dialogs.input({
        title: "New thread title",
        placeholder: comment ? "What unit of work does this comment belong to?" : "What unit of work do these comments belong to?",
      });
      if (!title?.trim() || !alive(ctx)) return;
      destination = comment ? createThreadFromComment(source.id, comment.id, title) : createThreadFromGroup(source.id, title);
    } else {
      const entry = entries.find(candidate => candidate.label === picked);
      destination = entry ? (comment ? moveComment(source.id, comment.id, entry.thread.id) : moveThreadComments(source.id, entry.thread.id)) : undefined;
    }
    if (!destination) {
      ctx.notify("That thread is no longer available; the group was not moved.", "warning");
      return;
    }
    ctx.panes.open("threads");
    ctx.notify(`Moved ${comment ? "comment" : `${source.comments.length} comment${source.comments.length === 1 ? "" : "s"}`} to thread: ${destination.title}`);
  }
  async function menu(ctx: Context): Promise<void> {
    const thread = selectedGroup(ctx);
    if (!thread) return;
    const actions = ["Choose agent…", "Prompt agent…", "Check agent status", "Reveal thread agent", "Hide siblings / zoom Hunk", "Stop temporary agent…", "Leave unchanged"];
    const picked = await ctx.dialogs.select({ title: `Herdr · ${thread.title}`, options: actions });
    if (!picked || !alive(ctx)) return;
    switch (actions.indexOf(picked)) {
      case 0: await choose(ctx, thread); return;
      case 1: return prompt(ctx);
      case 2: return refresh(ctx);
      case 3: return reveal(ctx);
      case 4: return client(ctx).zoom(true);
      case 5: return stop(ctx);
    }
  }
  interface CommandOptions {
    key?: string;
    /** False for commands that never talk to Herdr, so they work without a Herdr pane. */
    needsHerdr?: boolean;
    /** True for commands that neither wait for, nor block, an agent operation. */
    whilePending?: boolean;
  }
  function command(id: string, title: string, action: (ctx: Context) => Promise<void>, options: CommandOptions = {}) {
    const { key, needsHerdr = true, whilePending = false } = options;
    hunk.registerCommand({ id, title, ...(key ? { key } : {}) }, ctx => {
      if (disposed) return;
      if (pending && !whilePending) { ctx.notify("Herdr operation in progress…", "warning"); return; }
      const running = (async () => {
        try {
          if (needsHerdr) await client(ctx).caller();
          if (alive(ctx)) await action(ctx);
        }
        catch (error) {
          if (alive(ctx)) {
            badge(ctx, "needs attention");
            ctx.notify(error instanceof Error ? error.message : String(error), "warning");
          }
        }
      })();
      // A concurrent command must not claim the slot either, or it would block the next one.
      if (whilePending) return running;
      pending = running.finally(() => { pending = undefined; });
      return pending;
    });
  }
  command("menu", "Herdr: agent actions…", menu, { key: "A" });
  // Threads is independent of Herdr operations, so it remains closable while one is pending.
  hunk.registerCommand({ id: "threads", title: "Herdr: toggle threads sidebar", key: "T" }, ctx => {
    if (disposed) return;
    if (ctx.panes.isOpen("threads")) {
      ctx.keyboardModes.exitMode();
      ctx.panes.close("threads");
    } else {
      ctx.panes.open("threads");
    }
  });
  hunk.registerCommand({ id: "focus-threads", title: "Herdr: focus threads", key: "ctrl+t" }, ctx => {
    if (disposed) return;
    ctx.panes.open("threads");
    if (!threadBoardSnapshot().threads.length) {
      ctx.notify("No threads are available to navigate.", "warning");
      return;
    }
    if (!ctx.keyboardModes.isActive("threads")) ctx.keyboardModes.enterMode("threads");
  });
  command("pick", "Herdr: choose agent for the Threads group…", async ctx => { await choose(ctx); });
  // No key here: Hunk's own "?" wins the binding, so the threads mode claims the key instead.
  command("help", "Herdr: toggle Threads keybindings", showThreadHelp, { needsHerdr: false });
  command("models", "Herdr: configure Pi/Claude model defaults…", configureModels, { key: "ctrl+l", needsHerdr: false });
  command("prompt", "Herdr: prompt the Threads group…", prompt, { key: "P" });
  command("status", "Herdr: check the Threads group agent", refresh);
  command("reveal", "Herdr: reveal the Threads group agent", reveal);
  command("hide", "Herdr: hide siblings / zoom Hunk", ctx => client(ctx).zoom(true));
  command("stop", "Herdr: stop the Threads group agent…", stop);
  // Resolving is about review state, not agent work, so it runs while an agent is busy.
  command("resolve-thread", "Herdr: resolve review thread", resolveThread, { key: "X", needsHerdr: false, whilePending: true });
  command("reassign-thread-group", "Herdr: move or name the Threads item…", reassignSelectedGroup, { key: "ctrl+r", needsHerdr: false });
  hunk.registerCliCommand({ name: "herdr-check", summary: "Check Hunk/Herdr integration without opening the TUI" }, async (_args, ctx) => {
    try {
      const api = new Bridge(ctx.cwd);
      const caller = await api.caller();
      const agents = await api.agents();
      await ctx.stdout.write(JSON.stringify({ extension: "hunk-herdr", apiVersion: hunk.apiVersion, caller, agents }, null, 2) + "\n");
      return { kind: "exit", code: 0 };
    } catch (error) {
      await ctx.stderr.write(`${String(error)}\n`);
      return { kind: "exit", code: 1 };
    }
  });
  // Built-in cursor moves say which way the cursor left its last source line, which
  // is what identifies a note row: Hunk's selection reports no line while on one.
  hunk.on("command_executed", ({ commandId, canonicalCommandId }) => observeCursorCommand(canonicalCommandId ?? commandId));
  hunk.on("note_created", ({ note }, ctx) => assignUserComment(note, ctx));
  hunk.on("note_edited", ({ note }) => {
    if (!note.draft) updateAssignedComment(note);
  });
  hunk.on("note_changed", async ({ kind, note }, ctx) => {
    if (kind !== "removed") {
      updateThreadCommentNavigation(note.id, note.anchor);
      return;
    }
    // Resolving from the review, not the pane, reaches the board only through here.
    const thread = threadForComment(note.id);
    removeAssignedComment(note.id);
    if (thread) await retireEmptyGroup(thread.id, ctx);
  });
  hunk.on("shutdown", async () => {
    disposed = true;
    // Never let a stuck operation cost the cleanup below: a leaked temporary pane
    // outlives the session, while abandoning a half-finished command does not.
    await Promise.race([pending ?? Promise.resolve(), delay(2_000, undefined, { ref: false })]);
    // Host shutdown is bounded: cleanup is best effort, never touch selected existing agents.
    const owned = [...threadAgents.values()].filter(binding => binding.owned);
    await Promise.all(owned.map(async binding => {
      try { await binding.bridge.stop(); } catch (error) { hunk.log(`Temporary pane cleanup: ${String(error)}`); }
    }));
    if (originallyZoomed === false && owned[0]) {
      try {
        const caller = await owned[0].bridge.caller();
        const layout = await owned[0].bridge.layout(caller);
        if (layout.zoomed && layout.focused_pane_id === caller.pane_id) await owned[0].bridge.zoom(false);
      } catch {}
    }
  });
}
