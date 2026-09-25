import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AGENT_KINDS } from "./config.ts";
import { sessionIdForGeneration } from "./threads.ts";
import { setTimeout as delay } from "node:timers/promises";

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
/** One native review conversation a group prompt asks the agent to answer. */
export interface PromptConversation {
  /** The conversation's root comment: the one ID the agent replies to. */
  readonly replyTo: string;
  readonly filePath: string;
  readonly side: "old" | "new";
  readonly line: number;
  /** Hunk reports the code at this line changed after the comment was written. */
  readonly stale: boolean;
  /** Root first, then its replies in the order they were saved. */
  readonly messages: readonly { readonly from: string; readonly text: string }[];
  /** The latest message is an agent's, so nothing in this conversation awaits a reply. */
  readonly answered: boolean;
}

export interface GroupPrompt {
  /** Where `hunk skill path hunk-review` resolved the skill at submission time. */
  readonly skill: string;
  /** True when this agent was already told to read this exact skill file. */
  readonly skillRead: boolean;
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly author: string;
  readonly conversations: readonly PromptConversation[];
  /** Typed text from the prompt field; it adds to the task rather than replacing it. */
  readonly guidance?: string;
}

/** A free-form request that starts a group of its own, before any comment exists. */
export interface RequestPrompt {
  readonly skill: string;
  readonly skillRead: boolean;
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  /** The exact comment author Threads files this request's comments by. */
  readonly author: string;
  readonly request: string;
}

function indent(text: string): string {
  return text.split(/\r?\n/).join("\n     ");
}

/**
 * The prompt a group's agent receives. Command syntax is left to the Hunk skill,
 * which updates with Hunk; this text holds only the task, its rules and data.
 */
function preamble(prompt: { skill: string; skillRead: boolean; sessionId: string; cwd: string }, answer: string): string[] {
  return [
    `You're helping with a live Hunk code review from a background Herdr pane that nobody is watching. Don't wait for input here; anything you need to say goes in ${answer}.`,
    prompt.skillRead
      ? `You've already read the Hunk review skill at ${JSON.stringify(prompt.skill)}; read it again if it's no longer in your context.`
      : `Before starting, read the Hunk review skill at ${JSON.stringify(prompt.skill)}; it documents the \`hunk session\` commands.`,
    `Use session ${JSON.stringify(prompt.sessionId)} as the session selector for every \`hunk session\` command. Review working directory: ${JSON.stringify(prompt.cwd)}; your own cwd may differ.`,
  ];
}

function listConversation(conversation: PromptConversation, index: number): string {
  return [
    `${index + 1}. reply to: ${conversation.replyTo} — ${conversation.filePath}, ${conversation.side} line ${conversation.line}`
      + (conversation.stale ? " (stale: the code at this line has changed since it was written)" : ""),
    ...conversation.messages.map(message => `   ${message.from}: ${indent(message.text)}`),
  ].join("\n");
}

/**
 * Only a conversation whose latest message is the user's is put to the agent. One it
 * already answered is shown as context when typed guidance may refer to it, and is
 * otherwise left out, so a re-prompt never has the agent answer its own reply.
 */
export function buildPrompt(prompt: GroupPrompt): string {
  const pending = prompt.conversations.filter(conversation => !conversation.answered);
  const answered = prompt.conversations.filter(conversation => conversation.answered);
  const context = prompt.guidance ? answered : [];
  const task = pending.length
    ? [
      `Task: answer each review conversation listed under "Awaiting a reply", from the group ${JSON.stringify(prompt.title)}, with a reply in that conversation.`,
      "- Use each conversation's reply-to ID exactly as written; it is the only comment you may reply to in that conversation.",
      "- Answer the user's latest message in each conversation; earlier messages are history. Never reply to your own or another agent's message.",
      `- Only the conversations under "Awaiting a reply" are in scope.${context.length ? " Conversations under \"Already answered\" are context: reply there only if the user's guidance below asks for it." : ""} Don't reply to or start any other comment, and never resolve or delete a comment.`,
    ]
    : [
      `Task: carry out the user's guidance below for the group ${JSON.stringify(prompt.title)}. Every conversation in it already has your reply; they are listed as context.`,
      "- Reply only where the guidance asks you to, once per conversation it concerns, using that conversation's reply-to ID exactly as written.",
      "- Don't reply to or start any other comment, and never resolve or delete a comment.",
    ];
  return [
    ...preamble(prompt, "a review reply"),
    "",
    ...task,
    "- Don't edit files unless the user's guidance below explicitly asks you to. Where a fix is warranted, describe it or include a short patch in the reply.",
    "- If a comment is unclear, reply with a specific question and move on. If a reply fails because its comment no longer exists, skip it.",
    "- Don't move the user's view, highlight code, reload the review, launch the Hunk TUI, restart the Hunk daemon, or change Herdr focus or zoom.",
    `- Set the reply author to ${JSON.stringify(prompt.author)}.`,
    pending.length ? "- Finish your turn once every conversation awaiting a reply has one." : "- Finish your turn once the guidance is done.",
    "- Where the skill's general guidance conflicts with these rules, these rules win.",
    ...(pending.length ? ["", "Awaiting a reply (the complete list):", ...pending.map(listConversation)] : []),
    ...(context.length ? ["", "Already answered (context only):", ...context.map(listConversation)] : []),
    ...(prompt.guidance ? ["", "Additional guidance from the user:", prompt.guidance] : []),
  ].join("\n");
}

/**
 * The prompt for a request typed with no comment to answer. The agent reports back in
 * new root comments, and the author it sets on them is how Threads files every one
 * under the request's group.
 */
export function buildRequestPrompt(prompt: RequestPrompt): string {
  return [
    ...preamble(prompt, "a review comment"),
    "",
    `Task: carry out the user's request below, for the Threads group ${JSON.stringify(prompt.title)}.`,
    "- Report what you find or change as new review comments, one per point, each on the line it concerns. A comment can only sit on a line the review shows; if you change files, the review reloads to show them.",
    `- Set the author of every comment to ${JSON.stringify(prompt.author)}, exactly. That is how Threads files your comments under this request.`,
    "- Don't reply to, resolve or delete any existing comment.",
    "- Edit files only if the request asks for changes.",
    "- Don't move the user's view, highlight code, reload the review, launch the Hunk TUI, restart the Hunk daemon, or change Herdr focus or zoom.",
    "- If nothing warrants a comment, leave none. Finish your turn once the request is done.",
    "- Where the skill's general guidance conflicts with these rules, these rules win.",
    "",
    "Request from the user:",
    prompt.request,
  ].join("\n");
}

export class Bridge {
  owned: Owned | undefined;
  readonly cwd: string;
  readonly exec: Run;
  readonly env: NodeJS.ProcessEnv;
  readonly settleResize: () => Promise<void>;
  constructor(cwd: string, exec: Run = run, env: NodeJS.ProcessEnv = process.env,
    settleResize: () => Promise<void> = () => delay(200)) {
    this.cwd = cwd;
    this.exec = exec;
    this.env = env;
    this.settleResize = settleResize;
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
  async spawn(kind: string, model?: string): Promise<Pane> {
    if (this.owned) throw new Error("A temporary pane already exists. Stop it before creating another.");
    if (!(AGENT_KINDS as readonly string[]).includes(kind)) throw new Error("Unsupported agent kind");
    const caller = await this.caller();
    const layout = await this.layout(caller);
    // Splitting clears Herdr's zoom. Create the sibling first, then zoom Hunk
    // once, rather than zooming immediately before Herdr undoes it.
    const { pane } = await this.api<{ pane: Pane }>([
      "pane", "split", caller.pane_id, "--direction", layout.area.width >= layout.area.height * 2.5 ? "right" : "down",
      "--cwd", this.cwd, "--no-focus",
    ]);
    const name = `hunk-${randomUUID().slice(0, 8)}`;
    this.owned = { pane, name }; // Track immediately, including blocked/failed startups.
    // OpenTUI 0.5.6 debounces terminal resize by 100 ms and ignores a resize
    // back to its cached dimensions. An immediate split -> zoom can therefore
    // lose terminal cells without invalidating Hunk's render buffer. Let the
    // smaller layout settle before restoring full size. This is a timing
    // workaround, not a renderer acknowledgement; keep it injectable for tests.
    await this.settleResize();
    await this.zoom(true);
    try {
      await this.api(["agent", "start", name, "--kind", kind, "--pane", pane.pane_id, "--timeout", "30000", ...(model ? ["--", "--model", model] : [])], 35_000);
      const agent = (await this.agents()).find(a => a.pane_id === pane.pane_id && a.terminal_id === pane.terminal_id);
      if (!agent) throw new Error("Started agent was not found in this workspace");
      this.owned.pane = agent;
      return agent;
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}. Temporary pane ${pane.pane_id} retained; use Reveal temporary pane to handle startup or Stop temporary agent to discard it. No prompt was sent.`);
    }
  }
  /** The one call that runs `hunk` rather than `herdr`; kept here so every child process is mockable in one place. */
  async skillPath(): Promise<string> {
    return this.exec("hunk", ["skill", "path", "hunk-review"], this.cwd);
  }
  /** The live Hunk session publishing this review generation. */
  async sessionId(generation: string): Promise<string> {
    return sessionIdForGeneration(this.exec, this.cwd, generation);
  }
  /** Herdr's own notification, seen even when Hunk isn't; best effort, never throws. */
  async notify(title: string, body: string, sound: "done" | "request" | "none"): Promise<void> {
    await this.api(["notification", "show", title, "--body", body, "--sound", sound]).catch(() => {});
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
  /** Queues delivery through Herdr, then waits for the submitted work to settle. */
  async promptWhenReady(target: Pane, text: string): Promise<Pane> {
    // A zero exec timeout preserves Herdr's indefinite wait instead of imposing
    // this extension's polling cadence or an arbitrary queue deadline.
    await this.api(["agent", "wait", target.pane_id], 0);
    const agent = await this.validate(target);
    if (!["idle", "done"].includes(agent.agent_status || "")) {
      throw new Error(`Agent is ${agent.agent_status || "unknown"}; it did not become ready for the queued prompt.`);
    }
    try {
      await this.api(["agent", "prompt", agent.pane_id, text, "--wait"], 0);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}. Delivery or completion may be uncertain; inspect the agent before retrying.`);
    }
    return this.validate(target);
  }
}
