# Hunk × Herdr

A dependency-free Hunk extension for choosing a workspace-local agent and sending
it a request from the review UI. No Nix configuration or Herdr plugin installation
is required: this is a **Hunk** extension, with an editable checkout in `~/work/hunk-herdr`.

## Use

Open Hunk in a Herdr pane, then:

- **A** — actions for the currently selected Threads group: choose, prompt, inspect, reveal, or stop its agent.
- **P** — prompt the currently selected Threads group (opens its agent picker if none is assigned).
- **T** — show or hide the session-local Threads sidebar.
- **Ctrl+T** — focus Threads keyboard navigation (`j`/`k` or arrows, then Enter).
- **Esc** — leave Threads navigation and return to the review; the sidebar stays open.
- **X** — resolve the review thread at the current line/hunk.
- **Extensions → Herdr** commands also expose selection, status, reveal, hide,
  thread controls, and stopping the temporary agent. Menu grouping is named `hunk-herdr`.

## Threads interface experiment

After a user saves a review comment, the extension asks whether to assign it to
an existing thread, create a new named thread, or assign it to the session-wide
**Unassigned** group. Escaping or cancelling the selector also places the comment
in Unassigned. The selector starts on the thread chosen last; after creating a
thread, that newly created thread becomes the next default.
Creating or choosing a thread opens the right-hand Threads sidebar.

Each thread can be expanded or collapsed by clicking its row. Expanded threads
list their assigned comments; clicking a comment navigates to its source line.
Use **Ctrl+T** to navigate the sidebar by keyboard: `j`/`k` (or arrows) moves,
and Enter expands a thread or jumps to a selected comment. With a group selected,
**P** prompts its assigned agent (or opens the picker) and **A** opens its agent
actions. The picker can select any eligible running agent in the current workspace
(and matching worktree cwd when available), or start a new temporary agent. Agents
started by this extension are labeled with their assigned group when shown in a
later picker. Each prompt includes an authoritative list of that group's comment
IDs and explicitly prohibits acting on any other review comments. Press **Ctrl+R** on
either a thread or one of its comments to move that entire displayed group into
**Unassigned**, another thread, or a new named thread. **T** only changes sidebar
visibility, while Esc only leaves keyboard navigation.
Assignments and thread names are session-local prototype state: they do not
change Hunk's native reply relationships and disappear when Hunk exits.

Thread resolution is experimental. Hunk does not currently persist a separate
resolved state, so resolving removes the root comment and every reply, leaf-first,
after one confirmation. If no thread is present, or multiple threads share the
current location, the extension shows a notice and changes nothing. It never opens
a thread picker.

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
before submission. The notification means **submitted**, not completed; use
**Check agent status** or reveal the agent for progress/results. Status-row text
(where supported) is last-known state, not a background poll. Failed submissions
retain the draft; uncertain delivery is never automatically retried.

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
`default_agent` must be in `agents`; it is shown first (initially highlighted)
in the temporary-agent picker and named in its title. You must still confirm;
nothing is automatically launched or selected from existing panes.
Without a default, the configured list order is used.

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
