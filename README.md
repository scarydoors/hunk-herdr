# Hunk × Herdr

A dependency-free Hunk extension for choosing a workspace-local agent and sending
it a request from the review UI. No Nix configuration or Herdr plugin installation
is required: this is a **Hunk** extension, stored alongside your Herdr configuration.

## Use

Open Hunk in a Herdr pane, then:

- **A** — agent actions: choose an existing agent or create a temporary one.
- **P** — prompt the selected agent (opens the picker if none is selected).
- **Extensions → Herdr** commands also expose selection, status, reveal, hide,
  and stopping the temporary agent. Menu grouping is named `hunk-herdr`.

The picker lists agents from the calling pane's **live workspace**, across tabs,
with their name/kind, state, pane ID and cwd. It excludes Hunk's own pane. Selecting
an agent doesn't send anything. Escape or **Leave unchanged** cancels selection.
The selection lasts for this Hunk process, not across restarts.

Temporary agents support Pi, Claude, Codex, Gemini and OpenCode (the chosen CLI
must already be installed and authenticated). Creation:

1. Zooms Hunk's Herdr pane.
2. Splits a sibling right/down based on available geometry, preserving the review
   cwd and passing `--no-focus`.
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

## Local installation

Current source directory:

```text
~/.config/herdr/hunk-extensions/hunk-herdr/
```

Hunk auto-loads it through a two-line forwarding entry:

```text
~/.config/hunk/extensions/hunk-herdr.ts
```

The loader re-exports this directory's `index.ts`. A real loader is used because
this Hunk build does not discover symlinked extension directories.

Restart existing Hunk windows to load changes. To test explicitly without installing:

```sh
hunk --extension ~/.config/herdr/hunk-extensions/hunk-herdr herdr-check
hunk diff --extension ~/.config/herdr/hunk-extensions/hunk-herdr
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

Tests cover workspace isolation, identity checks, zoom/split ordering, startup
failure recovery, cancellation, stale reviews, concurrent actions, prompt
construction and owned-pane cleanup. Actual TUI interaction and real agent
startup should be smoke-tested manually in a disposable workspace.
