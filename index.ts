import type { ExtensionCommandContext, ExtensionEventContext, ExtensionReviewNote, HunkExtensionAPI } from "hunkdiff/extension";
import { Bridge, buildPrompt, label, run, sameAgent, type Pane } from "./bridge.ts";
import { agentConfig } from "./config.ts";
import { removeThread, threadAtSelection } from "./threads.ts";
import {
  ThreadsPane,
  activateSelectedThreadItem,
  type ReviewThread,
  assignComment,
  assignUnassignedThread,
  createThread,
  createThreadFromGroup,
  moveThreadComments,
  moveThreadToUnassigned,
  selectedThreadItem,
  UNASSIGNED_THREAD_ID,
  UNASSIGNED_THREAD_TITLE,
  moveThreadSelection,
  removeAssignedComment,
  startThreadNavigation,
  stopThreadNavigation,
  updateThreadCommentNavigation,
  threadBoardSnapshot,
  updateAssignedComment,
} from "./threads-pane.tsx";

type Context = ExtensionCommandContext;

export default function register(hunk: HunkExtensionAPI) {
  hunk.registerPane({
    id: "threads",
    title: "Threads",
    placement: "right",
    width: { preferred: 42, min: 28, max: 72, fraction: 0.3 },
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
      if (key.name === "j" || key.name === "down") return moveThreadSelection(1) ? "handled" : "pass";
      if (key.name === "k" || key.name === "up") return moveThreadSelection(-1) ? "handled" : "pass";
      if (key.name === "enter" || key.name === "return" || key.name === "space") {
        return activateSelectedThreadItem() ? "handled" : "pass";
      }
      return "pass";
    },
  });

  type ThreadAgent = { pane: Pane; bridge: Bridge; owned: boolean };
  const threadAgents = new Map<string, ThreadAgent>();
  const drafts = new Map<string, string>();
  let preferredThreadId = UNASSIGNED_THREAD_ID;
  let disposed = false;
  let pending: Promise<void> | undefined;
  let originallyZoomed: boolean | undefined;

  function client(ctx: Context): Bridge {
    return new Bridge(ctx.cwd);
  }
  function selectedGroup(ctx: Context): ReviewThread | undefined {
    const selection = selectedThreadItem();
    if (!selection) ctx.notify("Focus a Threads group or comment first (Ctrl+T).", "warning");
    return selection?.thread;
  }
  function threadAgent(thread: ReviewThread): ThreadAgent | undefined {
    return threadAgents.get(thread.id);
  }
  function agentLabel(agent: Pane): string {
    const binding = [...threadAgents.entries()].find(([, value]) => sameAgent(value.pane, agent));
    const thread = binding && threadBoardSnapshot().threads.find(candidate => candidate.id === binding[0]);
    return `${label(agent)}${thread ? ` · assigned to ${thread.title}` : ""}`;
  }
  function alive(ctx: Context): boolean {
    return !disposed && ctx.review.snapshot() !== null;
  }
  // Agent state is shown in the Threads pane and dialogs, not a persistent status row.
  function badge(_ctx: Context, _message?: string) {}
  async function choose(ctx: Context, thread = selectedGroup(ctx)): Promise<void> {
    if (!thread) return;
    if (threadAgent(thread)?.owned) {
      ctx.notify("Stop this group's temporary agent before choosing a replacement.", "warning");
      return;
    }
    const api = client(ctx);
    const config = agentConfig(hunk.config);
    const agents = (await api.agents()).filter(agent => config.agents.some(kind => kind === agent.agent)
      && (!(agent.foreground_cwd || agent.cwd) || (agent.foreground_cwd || agent.cwd) === ctx.cwd));
    if (!alive(ctx)) return;
    const create = "+ Create temporary agent (hidden sibling)";
    const options = agents.map(agent => `${threadAgent(thread)?.pane.pane_id === agent.pane_id ? "● " : "○ "}${agentLabel(agent)}`);
    const picked = await ctx.dialogs.select({
      title: `Herdr · agent for ${thread.title}`,
      options: [...options, ...(config.agents.length ? [create] : []), "Leave unchanged"],
    });
    if (!picked || picked === "Leave unchanged" || !alive(ctx)) return;
    let binding: ThreadAgent;
    if (picked === create) {
      const kind = await ctx.dialogs.select({
        title: `Temporary agent for ${thread.title} · choose kind${config.defaultAgent ? ` (default: ${config.defaultAgent})` : ""}`,
        options: [...config.agents, "Leave unchanged"],
      });
      if (!kind || kind === "Leave unchanged" || !alive(ctx)) return;
      if (!config.agents.some(allowed => allowed === kind)) throw new Error("Agent type is not enabled.");
      const caller = await api.caller();
      const layout = await api.layout(caller);
      if (!alive(ctx)) return;
      originallyZoomed ??= layout.zoomed;
      badge(ctx, `starting ${kind} for ${thread.title}…`);
      binding = { pane: await api.spawn(kind), bridge: api, owned: true };
      if (alive(ctx)) ctx.notify(`Temporary agent ready for ${thread.title}. Hunk stays zoomed; use Reveal to see it.`);
    } else {
      binding = { pane: await api.validate(agents[options.indexOf(picked)]!), bridge: api, owned: false };
    }
    threadAgents.set(thread.id, binding);
    if (alive(ctx)) badge(ctx);
  }
  async function prompt(ctx: Context): Promise<void> {
    const thread = selectedGroup(ctx);
    if (!thread) return;
    if (!threadAgent(thread)) await choose(ctx, thread);
    const binding = threadAgent(thread);
    if (!binding || !alive(ctx)) return;
    const text = await ctx.dialogs.input({
      title: `Prompt ${binding.pane.name || binding.pane.agent} · ${thread.title}`,
      placeholder: "Ask about this thread…", initial: drafts.get(thread.id) ?? "",
    });
    if (!text?.trim() || !alive(ctx)) return;
    drafts.set(thread.id, text);
    const skill = await run("hunk", ["skill", "path"], ctx.cwd);
    if (!skill) throw new Error("hunk skill path returned no path. Nothing sent.");
    if (!alive(ctx)) return;
    const payload = buildPrompt(skill, ctx.cwd, text, {
      file: ctx.selection.file?.path,
      hunk: ctx.selection.hunkIndex ?? undefined,
      thread: { title: thread.title, comments: thread.comments },
    });
    badge(ctx, `sending ${thread.title}…`);
    await binding.bridge.prompt(binding.pane, payload);
    drafts.delete(thread.id);
    if (alive(ctx)) {
      badge(ctx, `submitted ${thread.title} to ${binding.pane.name || binding.pane.agent}`);
      ctx.notify(`Prompt submitted for thread: ${thread.title} (completion not yet checked).`);
    }
  }
  async function refresh(ctx: Context): Promise<void> {
    const thread = selectedGroup(ctx);
    const binding = thread && threadAgent(thread);
    if (!thread || !binding) return choose(ctx, thread);
    binding.pane = await binding.bridge.validate(binding.pane);
    if (alive(ctx)) { badge(ctx); ctx.notify(agentLabel(binding.pane)); }
  }
  async function reveal(ctx: Context): Promise<void> {
    const thread = selectedGroup(ctx);
    const binding = thread && threadAgent(thread);
    if (!thread || !binding) return choose(ctx, thread);
    await binding.bridge.reveal(binding.pane);
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
  async function resolveThread(ctx: Context): Promise<void> {
    const before = ctx.review.snapshot();
    if (!before) return;
    const match = threadAtSelection(before, ctx.selection);
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
  async function assignUserComment(note: ExtensionReviewNote, ctx: ExtensionEventContext): Promise<void> {
    if (note.draft) return;
    const threads = threadBoardSnapshot().threads;
    const entries = threads
      .filter(thread => thread.id !== UNASSIGNED_THREAD_ID)
      .map((thread, index) => ({
        thread,
        label: `${thread.title} · ${thread.comments.length} comment${thread.comments.length === 1 ? "" : "s"} [${index + 1}]`,
      }));
    const create = "+ Create new thread…";
    const unassigned = UNASSIGNED_THREAD_TITLE;
    const options = [
      { id: UNASSIGNED_THREAD_ID, label: unassigned },
      ...entries.map(entry => ({ id: entry.thread.id, label: entry.label })),
      { id: create, label: create },
    ].sort((left, right) => Number(right.id === preferredThreadId) - Number(left.id === preferredThreadId));
    const picked = await ctx.dialogs.select({
      title: "Assign saved comment to a thread",
      // Hunk selects the first option initially; keep the last chosen thread there.
      options: options.map(option => option.label),
    });
    let assignedTitle: string;
    if (!picked || picked === unassigned) {
      const thread = assignUnassignedThread(note);
      if (picked) preferredThreadId = thread.id;
      assignedTitle = thread.title;
    } else if (picked === create) {
      const title = await ctx.dialogs.input({
        title: "New thread title",
        placeholder: "What unit of work does this comment belong to?",
      });
      if (!title?.trim()) {
        assignedTitle = assignUnassignedThread(note).title;
      } else {
        const thread = createThread(title, note);
        // "Create" is a one-off action; next time select the thread it created.
        preferredThreadId = thread.id;
        assignedTitle = thread.title;
      }
    } else {
      const entry = entries.find(candidate => candidate.label === picked);
      if (!entry || !assignComment(entry.thread.id, note)) {
        ctx.notify("That thread is no longer available; the comment was not assigned.", "warning");
        return;
      }
      preferredThreadId = entry.thread.id;
      assignedTitle = entry.thread.title;
    }
    ctx.panes.open("threads");
    ctx.notify(`Assigned comment to thread: ${assignedTitle}`);
  }
  async function reassignSelectedGroup(ctx: Context): Promise<void> {
    const selection = selectedThreadItem();
    if (!selection) {
      ctx.notify("Focus a Threads group or comment first (Ctrl+T).", "warning");
      return;
    }
    const source = selection.thread;
    if (threadAgents.has(source.id)) {
      ctx.notify("Stop or reassign this group's agent before moving its comments.", "warning");
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
      title: `Move ${source.comments.length} comment${source.comments.length === 1 ? "" : "s"} from ${source.title}`,
      options: [unassigned, ...entries.map(entry => entry.label), create, "Leave unchanged"],
    });
    if (!picked || picked === "Leave unchanged" || !alive(ctx)) return;
    let destination;
    if (picked === unassigned) {
      destination = moveThreadToUnassigned(source.id);
    } else if (picked === create) {
      const title = await ctx.dialogs.input({
        title: "New thread title",
        placeholder: "What unit of work do these comments belong to?",
      });
      if (!title?.trim() || !alive(ctx)) return;
      destination = createThreadFromGroup(source.id, title);
    } else {
      const entry = entries.find(candidate => candidate.label === picked);
      destination = entry ? moveThreadComments(source.id, entry.thread.id) : undefined;
    }
    if (!destination) {
      ctx.notify("That thread is no longer available; the group was not moved.", "warning");
      return;
    }
    preferredThreadId = destination.id;
    ctx.panes.open("threads");
    ctx.notify(`Moved ${source.comments.length} comment${source.comments.length === 1 ? "" : "s"} to thread: ${destination.title}`);
  }
  async function menu(ctx: Context): Promise<void> {
    const thread = selectedGroup(ctx);
    if (!thread) return;
    const actions = ["Choose agent…", "Prompt agent…", "Check agent status", "Reveal thread agent", "Hide siblings / zoom Hunk", "Stop temporary agent…", "Leave unchanged"];
    const picked = await ctx.dialogs.select({ title: `Herdr · ${thread.title}`, options: actions });
    if (!picked || !alive(ctx)) return;
    switch (actions.indexOf(picked)) {
      case 0: return choose(ctx, thread);
      case 1: return prompt(ctx);
      case 2: return refresh(ctx);
      case 3: return reveal(ctx);
      case 4: return client(ctx).zoom(true);
      case 5: return stop(ctx);
    }
  }
  function command(id: string, title: string, action: (ctx: Context) => Promise<void>, key?: string, needsHerdr = true) {
    hunk.registerCommand({ id, title, ...(key ? { key } : {}) }, ctx => {
      if (disposed) return;
      if (pending) { ctx.notify("Herdr operation in progress…", "warning"); return; }
      pending = (async () => {
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
      })().finally(() => { pending = undefined; });
      return pending;
    });
  }
  command("menu", "Herdr: agent actions…", menu, "A");
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
  command("pick", "Herdr: choose agent for selected Threads group…", choose);
  command("prompt", "Herdr: prompt selected Threads group…", prompt, "P");
  command("status", "Herdr: check selected Threads group agent", refresh);
  command("reveal", "Herdr: reveal selected Threads group agent", reveal);
  command("hide", "Herdr: hide siblings / zoom Hunk", ctx => client(ctx).zoom(true));
  command("stop", "Herdr: stop selected Threads group agent…", stop);
  command("resolve-thread", "Herdr: resolve review thread", resolveThread, "X", false);
  command("reassign-thread-group", "Herdr: reassign selected Threads group…", reassignSelectedGroup, "ctrl+r", false);
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
  hunk.on("note_created", ({ note }, ctx) => assignUserComment(note, ctx));
  hunk.on("note_edited", ({ note }) => {
    if (!note.draft) updateAssignedComment(note);
  });
  hunk.on("note_changed", ({ kind, note }) => {
    if (kind === "removed") removeAssignedComment(note.id);
    else updateThreadCommentNavigation(note.id, note.anchor.preferred);
  });
  hunk.on("shutdown", async () => {
    disposed = true;
    await pending;
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
