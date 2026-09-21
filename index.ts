import type { ExtensionCommandContext, HunkExtensionAPI } from "hunkdiff/extension";
import { Bridge, buildPrompt, label, run, type Pane } from "./bridge.ts";

// 0.22.0's published declarations predate the latest skill docs (API 26).
// Feature-detect the new status row; keep native dialogs working on API 10+.
type StatusContext = { statusLine?: { set(item: { id: string; priority?: number; spans: { text: string }[] }): void } };
type Context = ExtensionCommandContext & StatusContext;

export default function register(hunk: HunkExtensionAPI) {
  let bridge: Bridge | undefined;
  let target: Pane | undefined;
  let draft = "";
  let disposed = false;
  let pending: Promise<void> | undefined;
  let originallyZoomed: boolean | undefined;

  function client(ctx: Context): Bridge {
    return bridge ??= new Bridge(ctx.cwd);
  }
  function alive(ctx: Context): boolean {
    return !disposed && ctx.review.snapshot() !== null;
  }
  function badge(ctx: Context, message?: string) {
    ctx.statusLine?.set({ id: "agent", priority: 5, spans: [
      { text: ` Herdr · ${message || (target ? `${target.name || target.agent} · ${target.agent_status || "unknown"} (last checked)` : "no agent")} · A picker · P prompt ` },
    ] });
  }
  async function choose(ctx: Context): Promise<void> {
    const api = client(ctx);
    const agents = await api.agents();
    if (!alive(ctx)) return;
    const create = "+ Create temporary agent (hidden sibling)";
    const options = agents.map(a => `${target && a.pane_id === target.pane_id ? "● " : "○ "}${label(a)}`);
    const picked = await ctx.dialogs.select({
      title: "Herdr · agents in this workspace",
      options: [...options, create, "Leave unchanged"],
    });
    if (!picked || picked === "Leave unchanged" || !alive(ctx)) return;
    if (picked === create) {
      if (api.owned) throw new Error("A temporary pane already exists. Use Reveal temporary pane or Stop temporary agent first.");
      const kind = await ctx.dialogs.select({ title: "Temporary agent · choose kind", options: ["pi", "claude", "codex", "gemini", "opencode", "Leave unchanged"] });
      if (!kind || kind === "Leave unchanged" || !alive(ctx)) return;
      const caller = await api.caller();
      const layout = await api.layout(caller);
      if (!alive(ctx)) return;
      originallyZoomed ??= layout.zoomed;
      badge(ctx, `starting ${kind}…`);
      target = await api.spawn(kind);
      if (alive(ctx)) ctx.notify("Temporary agent ready. Hunk stays zoomed; use Reveal to see it.");
    } else {
      target = await api.validate(agents[options.indexOf(picked)]!);
    }
    if (alive(ctx)) badge(ctx);
  }
  async function prompt(ctx: Context): Promise<void> {
    if (!target) await choose(ctx);
    if (!target || !alive(ctx)) return;
    const text = await ctx.dialogs.input({
      title: `Prompt ${target.name || target.agent}`,
      placeholder: "Ask about this review…", initial: draft,
    });
    if (!text?.trim() || !alive(ctx)) return;
    draft = text;
    const skill = await run("hunk", ["skill", "path"], ctx.cwd);
    if (!skill) throw new Error("hunk skill path returned no path. Nothing sent.");
    if (!alive(ctx)) return;
    const payload = buildPrompt(skill, ctx.cwd, text, {
      file: ctx.selection.file?.path,
      hunk: ctx.selection.hunkIndex ?? undefined,
    });
    badge(ctx, "sending…");
    await client(ctx).prompt(target, payload);
    draft = "";
    if (alive(ctx)) {
      badge(ctx, `submitted to ${target.name || target.agent}`);
      ctx.notify("Prompt submitted with Hunk skill instructions (completion not yet checked).");
    }
  }
  async function refresh(ctx: Context): Promise<void> {
    if (!target) return choose(ctx);
    target = await client(ctx).validate(target);
    if (alive(ctx)) { badge(ctx); ctx.notify(label(target)); }
  }
  async function reveal(ctx: Context): Promise<void> {
    if (!target) return choose(ctx);
    await client(ctx).reveal(target);
  }
  async function stop(ctx: Context): Promise<void> {
    const api = client(ctx);
    if (!api.owned) { ctx.notify("No temporary agent owned by this Hunk session."); return; }
    if (!await ctx.dialogs.confirm({
      title: "Stop temporary agent?", body: "Closes its sibling pane and terminates any running work. Existing agents are never closed.",
      confirmLabel: "Stop agent", cancelLabel: "Leave running",
    }) || !alive(ctx)) return;
    const paneId = api.owned.pane.pane_id;
    await api.stop();
    if (target?.pane_id === paneId) target = undefined;
    badge(ctx);
    ctx.notify("Temporary agent stopped.");
  }
  async function menu(ctx: Context): Promise<void> {
    const actions = [
      "Choose agent…", "Prompt agent…", "Check agent status", "Reveal selected agent",
      "Reveal temporary pane (including startup dialogs)", "Hide siblings / zoom Hunk", "Stop temporary agent…", "Leave unchanged",
    ];
    const picked = await ctx.dialogs.select({ title: `Herdr · ${target ? target.name || target.agent : "pick an agent"}`, options: actions });
    if (!picked || !alive(ctx)) return;
    switch (actions.indexOf(picked)) {
      case 0: return choose(ctx);
      case 1: return prompt(ctx);
      case 2: return refresh(ctx);
      case 3: return reveal(ctx);
      case 4: return client(ctx).revealOwned();
      case 5: return client(ctx).zoom(true);
      case 6: return stop(ctx);
    }
  }
  function command(id: string, title: string, action: (ctx: Context) => Promise<void>, key?: string) {
    hunk.registerCommand({ id, title, ...(key ? { key } : {}) }, ctx => {
      if (disposed) return;
      if (pending) { ctx.notify("Herdr operation in progress…", "warning"); return; }
      pending = (async () => {
        try { await client(ctx).caller(); if (alive(ctx)) await action(ctx); }
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
  command("pick", "Herdr: choose agent…", choose);
  command("prompt", "Herdr: prompt agent…", prompt, "P");
  command("status", "Herdr: check status", refresh);
  command("reveal", "Herdr: reveal selected agent", reveal);
  command("reveal-temporary", "Herdr: reveal temporary pane", ctx => client(ctx).revealOwned());
  command("hide", "Herdr: hide siblings / zoom Hunk", ctx => client(ctx).zoom(true));
  command("stop", "Herdr: stop temporary agent…", stop);
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
  hunk.on("startup", (_event, ctx) => {
    if (process.env.HERDR_ENV === "1") (ctx as typeof ctx & StatusContext).statusLine?.set({ id: "agent", spans: [{ text: " Herdr · A agents · P prompt " }] });
  });
  hunk.on("shutdown", async () => {
    disposed = true;
    await pending;
    if (!bridge) return;
    // Host shutdown is bounded: cleanup is best effort, never touch existing agents.
    try { await bridge.stop(); } catch (error) { hunk.log(`Temporary pane cleanup: ${String(error)}`); }
    if (originallyZoomed === false) {
      try {
        const caller = await bridge.caller();
        const layout = await bridge.layout(caller);
        if (layout.zoomed && layout.focused_pane_id === caller.pane_id) await bridge.zoom(false);
      } catch {}
    }
  });
}
