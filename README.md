# Hunk × Herdr

A dependency-free Hunk extension for choosing a workspace-local agent and sending
it a request from the review UI. No Nix configuration or Herdr plugin installation
is required: this is a **Hunk** extension, with an editable checkout in `~/work/hunk-herdr`.

## Use

Open Hunk in a Herdr pane, then:

The happy path is **save a comment → Ctrl+T → P → Enter → Enter**: the comment
joins a group on its own, Ctrl+T focuses the Threads sidebar on the comment you just
saved, P acts on that comment's group, the first picker row starts the default agent,
and an empty prompt tells it to address the group's comments.

The sidebar is the cursor for comments. Hunk never tells an extension which note its
own review cursor is on, but it will reveal any line exactly, so the relationship runs
the other way: as you move the sidebar selection with `j`/`k`, the diff scrolls to the
selected comment, and **P**, **A**, **Ctrl+R** and **X** act on the selected row.

- **Ctrl+T** — focus Threads keyboard navigation. It starts on the comment you saved
  last; `j`/`k` (or arrows) move, the diff follows, and Enter expands or collapses a group.
- **A** — actions for the selected group: choose, prompt, inspect, reveal, or stop its agent.
- **P** — prompt the selected group (opens its agent picker if none is assigned).
- **Ctrl+R** — move the selected group or comment to another thread, or name a new one.
- **T** — show or hide the session-local Threads sidebar.
- **Esc** — leave Threads navigation and return to the review; the sidebar stays open.
- **Ctrl+L** — choose a saved default model for Pi or Claude.
- **?** — while Threads navigation is focused, toggle its keybinding list in the pane.
- **X** — resolve the selected group or comment; from the review, the native thread at
  the current line or hunk. Resolving works while an
  agent is still running; once a group's last comment is resolved the group is retired,
  and a temporary agent Herdr started for it is closed. Agents you picked keep running.
- **Extensions → Herdr** commands also expose selection, status, reveal, hide,
  thread controls, and stopping the temporary agent. Menu grouping is named `hunk-herdr`.

## Threads interface experiment

When a user saves a root review comment, it joins the Threads group that already
holds the closest comment in the same file; a file with no assigned comment yet
puts it in the session-wide **Unassigned** group. No dialog is shown: a toast names
the group, and **Ctrl+R** moves the comment elsewhere or into a new named thread.
Native replies remain in their root conversation and are never assigned. Saving a
comment opens the right-hand Threads sidebar.

Each thread can be expanded or collapsed by clicking its row or pressing Enter on it.
Expanded threads list their assigned comments; clicking a comment navigates to its
source line.

**Ctrl+T** focuses the sidebar, landing on the comment you saved last. While it is
focused, `j`/`k` (or arrows) move the selection and the diff scrolls to the selected
comment, so the sidebar works as a cursor over your comments. **P**, **A**, **Ctrl+R**
and **X** act on the selected row; pressed from the review instead, they say to focus
Threads first. This is deliberate: Hunk exposes no "which note is the cursor on"
signal to extensions, and in the unified layout it paints no current line for panes,
so any review-side guess is an approximation. Revealing a line from the sidebar is
exact.

**P** prompts the group's assigned agent, or opens the picker if it has none. The
picker's first row starts the configured default agent (or the only configured kind),
naming its saved model; below it are the eligible running agents in the current
workspace (and matching worktree cwd when available), then **Start another kind…**
when more kinds are configured. Agents started by this extension are labeled with
their assigned group when shown in a later picker. The prompt field then opens with a
placeholder: pressing Enter on an empty field sends
"Address every listed review comment and reply in its thread."; typed text is sent
instead. A spinning indicator on a group means Herdr is starting its agent or
sending it work; after Herdr observes its response, the indicator becomes a green
checkmark. When creating an agent for **P**, the prompt field opens while it starts,
and both delivery and the agent's turn are followed in the background, so every other
command stays usable while a group is working. Each prompt includes an authoritative list of that group's comment
IDs and explicitly prohibits acting on any other review comments. Press **Ctrl+R** on
a thread heading to move the whole displayed group, or on a comment to move only
that comment, into **Unassigned**, another thread, or a new named thread. With a
Threads group selected, **X** confirms resolving that displayed group and all its
native review comments; its temporary agent is closed during cleanup. With a comment
selected, **X** resolves only that comment's native review thread and leaves other
displayed group comments open. Existing user-owned agents are never closed. **T**
only changes sidebar visibility, while Esc only leaves keyboard navigation.
Assignments and thread names are session-local prototype state: they do not
change Hunk's native reply relationships and disappear when Hunk exits.

Thread resolution is experimental. Hunk does not currently persist a separate
resolved state, so resolving removes the root comment
and every reply, leaf-first,
after one confirmation. In Threads navigation, **X** resolves the selected group's
native threads when its heading is focused, or only the selected comment's native
thread when a comment is focused. From the review, **X** resolves the native thread
whose note contains the current line, else the only thread in the selected hunk; a
hunk holding several threads shows a notice and changes nothing.

The picker lists agents from the calling pane's **live workspace**, across tabs,
with their name/kind, state, pane ID and cwd. It excludes Hunk's own pane. Selecting
an agent doesn't send anything. Escape or **Leave unchanged** cancels selection.
The selection lasts for this Hunk process, not across restarts.

Temporary agents support Pi, Claude, Codex, Gemini and OpenCode (the chosen CLI
must already be installed and authenticated). Creation:

1. Splits a sibling right/down based on available geometry, preserving the review
   cwd and passing `--no-focus`.
2. Waits 200 ms for Hunk's debounced resize handling, then zooms Hunk's Herdr
   pane. Without this pause, a fast split/zoom can leave stale cells because
   OpenTUI skips resizing when the dimensions return to their cached value.
   This is a timing workaround, not a guaranteed repaint acknowledgement.
3. Starts a uniquely named `hunk-…` agent and waits for Herdr's startup readiness.

This is a normal interactive agent hidden by zoom, **not a headless process**.
**Reveal selected agent** unzooms the shared tab and focuses the agent.
**Reveal temporary pane** just unzooms Hunk, including when startup is blocked by
login/trust/approval UI. Neither startup nor prompting answers those dialogs.
Switch back to Hunk and choose **Hide siblings / zoom Hunk** to hide it again.

Only one temporary pane is owned at a time. **Stop temporary agent** asks before
closing it and terminating running work. Graceful Hunk shutdown also attempts to
close the owned pane and restore the initial unzoomed state; that cleanup is
best-effort because Hunk bounds shutdown time. A crash, force-kill, slow request,
or moved/changed pane may leave it running. Use Herdr to manage any leftover
`hunk-…` agent. Existing agents are never closed by this extension.

## Prompting

The prompt sent through `herdr agent prompt` includes:

- Instructions to run **`hunk skill path` and read the returned review skill**.
- The path resolved by Hunk at submission time.
- Review cwd and the selected file/hunk at composition time.
- An explicit instruction to read user-authored review comments and answer relevant
  ones as replies in their existing threads, not as detached root comments.
- Your request, unchanged.

Agents are instructed to discover the matching live Hunk session and use its exact
ID. Multiple indistinguishable sessions require clarification rather than guessing.
No patch or saved notes are exported automatically. The agent can inspect the live
review using the Hunk skill. The extension doesn't restrict the agent's normal
permissions: ask for read-only work if that's what you want.

Only `idle`/`done` agents receive prompts. Identity and workspace are revalidated
before submission. Sending notifies immediately; a second notification reports the
agent's turn finishing, and the group's spinner runs in between. Herdr's waits are
indefinite by design, so an agent that never reaches `idle`, `done`, or `blocked`
leaves that spinner running — resolving the group or stopping its agent ends it, and
neither is blocked by the wait. Use **Check agent status** or reveal the agent for
progress/results. Status-row text
(where supported) is last-known state, not a background poll. The typed request is
cleared from the group's draft as soon as it is handed to Herdr, so pressing **P**
during the turn starts from an empty prompt; a failed hand-off restores it.
Uncertain delivery is never automatically retried.

## Configuration

Use Hunk's native config in `~/.config/hunk/config.toml` (or its XDG location):

```toml
[extension.hunk-herdr]
agents = ["claude", "pi"]
default_agent = "claude"
```

`agents` controls both the existing-agent picker and temporary agent types.
Supported values: `pi`, `claude`, `codex`, `gemini`, `opencode`. Omitted means
all five; an empty list disables agent choices. Duplicates are removed.
`default_agent` must be in `agents`; it becomes the picker's first row
(**+ Start claude (default)**), so Enter starts it. You must still confirm;
nothing is automatically launched or selected from existing panes. Without a
default, that row appears only when a single kind is configured; otherwise
**Start temporary agent…** asks for the kind in the configured order.

Press **Ctrl+L** to configure Pi or Claude. The
model list is populated from Pi's local model store or Claude Code's cached model
catalog; no model names are hardcoded. Choosing an agent normally afterwards starts
it with the saved model (`--model <id>`). Choose the list's **Default** entry to clear
an override. Defaults are local user state, stored at
`$XDG_STATE_HOME/hunk-herdr/model-defaults.json` (or
`~/.local/state/hunk-herdr/model-defaults.json` when `XDG_STATE_HOME` is unset), not
in the repository or Hunk configuration.

Repository `.hunk/config.toml` overrides user settings key by key. Values are
validated against the fixed supported types; arbitrary commands are not allowed.
Invalid configuration reports a warning when opening the picker rather than
silently enabling other agents. Restart Hunk after changing configuration.
For Nix-managed configuration, set these values in the Nix source instead.

## Local installation

Current source directory:

```text
~/work/hunk-herdr/
```

Hunk auto-loads it through a two-line forwarding entry:

```text
~/.config/hunk/extensions/hunk-herdr.ts
```

The loader re-exports this directory's `index.ts`. A real loader is used because
this Hunk build does not discover symlinked extension directories.

Restart existing Hunk windows to load changes. To test explicitly without installing:

```sh
hunk --extension ~/work/hunk-herdr herdr-check
hunk diff --extension ~/work/hunk-herdr
```

`herdr-check` is a noninteractive, read-only diagnostic: it verifies extension
loading and prints API version, caller identity and available workspace agents.
It never starts agents or changes zoom/focus. Run the diff command yourself in a
terminal; do not pipe a Hunk TUI into another process.

To disable, remove only the Hunk loader, or launch Hunk with `--no-extensions`.
No changes to your Nix-managed `config.toml` are needed. Optional key remapping:

```toml
[keybindings]
"hunk-herdr.menu" = "A"
"hunk-herdr.prompt" = "P"
"hunk-herdr.threads" = "T"
"hunk-herdr.focus-threads" = "ctrl+t"
"hunk-herdr.models" = "ctrl+l"
"hunk-herdr.resolve-thread" = "X"
```

## Development / publishing later

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Node 22.6+ is required for tests (tested with Node 24). Runtime has no npm
dependencies: Hunk loads TypeScript directly and provides the extension API.
All npm packages are development-only; installed runtime engines may emit warnings
on older Node versions, but tests do not load Hunk's renderer.

The manifest and folder layout are ready to move into a separate git repository.
Before publishing, choose a license, tag a release and add the `hunk-extension`
GitHub topic. Hunk's npm 0.22.0 declarations lag its bundled API-28 skill docs, so
status-row support is feature-detected; the required base API is 10.

Tests cover workspace isolation, identity checks, split/zoom ordering, startup
failure recovery, cancellation, stale reviews, concurrent actions, prompt
construction and owned-pane cleanup. Actual TUI interaction and real agent
startup should be smoke-tested manually in a disposable workspace.
