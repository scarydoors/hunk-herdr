import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

export type Run = (binary: string, args: string[], cwd: string, timeout?: number) => Promise<string>;
export const run: Run = (binary, args, cwd, timeout = 15_000) => new Promise((resolve, reject) => {
  execFile(binary, args, { cwd, timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout.trim());
    // Never include the command line: it may contain a private user prompt.
    let detail = stderr.trim();
    try { const body = JSON.parse(detail); detail = body.error?.message ?? detail; } catch {}
    reject(new Error(`${binary} ${args.slice(0, 2).join(" ")}: ${detail.slice(0, 600) || (error.killed ? "timed out" : error.code ?? "failed")}`));
  });
});

export interface Pane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id: string;
  agent?: string;
  name?: string;
  agent_status?: string;
  agent_session?: { kind: string; value: string };
  cwd?: string;
  foreground_cwd?: string;
}
export interface Layout {
  zoomed: boolean;
  focused_pane_id: string;
  area: { width: number; height: number };
}
export interface Owned { pane: Pane; name: string }

export function sameAgent(a: Pane, b: Pane): boolean {
  return a.pane_id === b.pane_id && a.terminal_id === b.terminal_id && a.agent === b.agent
    && a.name === b.name
    && (!a.agent_session || (a.agent_session.kind === b.agent_session?.kind && a.agent_session.value === b.agent_session?.value));
}
export function workspaceAgents(agents: Pane[], caller: Pane): Pane[] {
  return agents.filter(a => a.workspace_id === caller.workspace_id && a.pane_id !== caller.pane_id && a.agent)
    .sort((a, b) => a.pane_id.localeCompare(b.pane_id, undefined, { numeric: true }));
}
export function label(a: Pane): string {
  return `${a.name || a.agent} · ${a.agent_status || "unknown"} · ${a.pane_id} · ${a.foreground_cwd || a.cwd || ""}`;
}
export function buildPrompt(skill: string, cwd: string, text: string, selection: { file?: string; hunk?: number } = {}): string {
  return [
    "The user is prompting you from a live Hunk review in Herdr.",
    "Before doing the task, run `hunk skill path` and read the returned file completely (the hunk-review skill).",
    `Hunk resolved that skill here: ${JSON.stringify(skill)}.`,
    `Review working directory: ${JSON.stringify(cwd)}. Your own cwd may differ.`,
    "Use `hunk session list --json` to locate this review; use its exact session ID for subsequent commands. If multiple sessions match and you cannot identify this window, ask rather than guess.",
    "Do not launch the Hunk TUI, restart its daemon, or change Herdr focus/zoom. Stay in the background unless the user asks otherwise.",
    selection.file ? `Selection when the prompt was composed: ${JSON.stringify(selection.file)}${selection.hunk === undefined ? "" : `, hunk ${selection.hunk + 1}`}.` : "",
    "\nUser request:", text,
  ].filter(Boolean).join("\n");
}

export class Bridge {
  owned: Owned | undefined;
  readonly cwd: string;
  readonly exec: Run;
  readonly env: NodeJS.ProcessEnv;
  constructor(cwd: string, exec: Run = run, env: NodeJS.ProcessEnv = process.env) {
    this.cwd = cwd;
    this.exec = exec;
    this.env = env;
  }

  async api<T>(args: string[], timeout?: number): Promise<T> {
    const body = JSON.parse(await this.exec("herdr", args, this.cwd, timeout));
    if (body.error) throw new Error(body.error.message || "Herdr request failed");
    if (!body.result) throw new Error("Unexpected Herdr response (missing result)");
    return body.result as T;
  }
  async caller(): Promise<Pane> {
    if (this.env.HERDR_ENV !== "1" || !this.env.HERDR_PANE_ID) {
      throw new Error("Launch Hunk inside a Herdr pane to use the agent picker.");
    }
    return (await this.api<{ pane: Pane }>(["pane", "current", "--current"])).pane;
  }
  async agents(): Promise<Pane[]> {
    const caller = await this.caller(); // Resolve moved panes; never use the focused workspace.
    return workspaceAgents((await this.api<{ agents: Pane[] }>(["agent", "list"])).agents, caller);
  }
  async validate(target: Pane): Promise<Pane> {
    const current = (await this.agents()).find(a => sameAgent(target, a));
    if (!current) throw new Error("Agent exited, moved, or changed identity. Pick an agent again.");
    return current;
  }
  async layout(caller: Pane): Promise<Layout> {
    return (await this.api<{ layout: Layout }>(["pane", "layout", "--pane", caller.pane_id])).layout;
  }
  async zoom(on: boolean): Promise<void> {
    const caller = await this.caller();
    await this.api(["pane", "zoom", caller.pane_id, on ? "--on" : "--off"]);
  }
  async spawn(kind: string): Promise<Pane> {
    if (this.owned) throw new Error("A temporary pane already exists. Stop it before creating another.");
    if (!["pi", "claude", "codex", "gemini", "opencode"].includes(kind)) throw new Error("Unsupported agent kind");
    const caller = await this.caller();
    const layout = await this.layout(caller);
    // Zoom first so the split is never deliberately revealed. Do not steal focus.
    await this.zoom(true);
    const { pane } = await this.api<{ pane: Pane }>([
      "pane", "split", caller.pane_id, "--direction", layout.area.width >= layout.area.height * 2.5 ? "right" : "down",
      "--cwd", this.cwd, "--no-focus",
    ]);
    const name = `hunk-${randomUUID().slice(0, 8)}`;
    this.owned = { pane, name }; // Track immediately, including blocked/failed startups.
    await this.zoom(true);
    try {
      await this.api(["agent", "start", name, "--kind", kind, "--pane", pane.pane_id, "--timeout", "30000"], 35_000);
      const agent = (await this.agents()).find(a => a.pane_id === pane.pane_id && a.terminal_id === pane.terminal_id);
      if (!agent) throw new Error("Started agent was not found in this workspace");
      this.owned.pane = agent;
      return agent;
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}. Temporary pane ${pane.pane_id} retained; use Reveal temporary pane to handle startup or Stop temporary agent to discard it. No prompt was sent.`);
    }
  }
  async reveal(target: Pane): Promise<void> {
    const agent = await this.validate(target);
    const caller = await this.caller();
    if (agent.tab_id === caller.tab_id) await this.zoom(false);
    await this.api(["agent", "focus", agent.pane_id]);
  }
  async revealOwned(): Promise<void> {
    if (!this.owned) throw new Error("No temporary pane");
    const caller = await this.caller();
    const { pane } = await this.api<{ pane: Pane }>(["pane", "get", this.owned.pane.pane_id]);
    if (pane.terminal_id !== this.owned.pane.terminal_id || pane.workspace_id !== caller.workspace_id || pane.tab_id !== caller.tab_id) {
      throw new Error("Temporary pane moved or changed; manage it in Herdr.");
    }
    // Leave focus on Hunk, but reveal the sibling even when agent startup was blocked.
    await this.zoom(false);
  }
  async stop(): Promise<void> {
    const owned = this.owned;
    if (!owned) return;
    const caller = await this.caller();
    const { pane } = await this.api<{ pane: Pane }>(["pane", "get", owned.pane.pane_id]);
    const occupant = (await this.agents()).find(a => a.pane_id === pane.pane_id);
    if (pane.terminal_id !== owned.pane.terminal_id || pane.workspace_id !== caller.workspace_id || pane.tab_id !== caller.tab_id
      || (pane.agent && occupant?.name !== owned.name)
      || (owned.pane.agent_session && occupant && !sameAgent(owned.pane, occupant))) {
      throw new Error("Temporary pane moved or changed occupant; refusing to close it. Manage it in Herdr.");
    }
    await this.api(["pane", "close", pane.pane_id]);
    this.owned = undefined;
  }
  async prompt(target: Pane, text: string): Promise<void> {
    const agent = await this.validate(target);
    if (!["idle", "done"].includes(agent.agent_status || "")) {
      throw new Error(`Agent is ${agent.agent_status || "unknown"}; wait until ready or reveal it. Nothing sent.`);
    }
    try {
      await this.api(["agent", "prompt", agent.pane_id, text]);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}. Delivery may be uncertain; inspect the agent before retrying.`);
    }
  }
}
