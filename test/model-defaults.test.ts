import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { claudeCatalogOptions, piStoreOptions } from "../model-catalog.ts";
import { isConfigurableAgentKind, loadModelDefaults, modelDefaultsPath, saveModelDefaults } from "../model-defaults.ts";

test("stores Pi and Claude defaults in the XDG state directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "hunk-herdr-"));
  try {
    const path = modelDefaultsPath({ XDG_STATE_HOME: directory });
    saveModelDefaults({ pi: "anthropic/claude-sonnet-4-5", claude: "sonnet" }, path);
    assert.deepEqual(loadModelDefaults(path), { pi: "anthropic/claude-sonnet-4-5", claude: "sonnet" });
    assert.match(readFileSync(path, "utf8"), /"pi"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("builds Pi and Claude choices from their local catalogs", () => {
  const directory = mkdtempSync(join(tmpdir(), "hunk-herdr-"));
  try {
    const piPath = join(directory, "models-store.json");
    writeFileSync(piPath, JSON.stringify({ anthropic: { models: [{ id: "claude-sonnet", name: "Sonnet" }] } }));
    assert.deepEqual(piStoreOptions(piPath), [{ label: "Sonnet · anthropic/claude-sonnet", model: "anthropic/claude-sonnet" }]);
    const claudeDirectory = join(directory, "catalog");
    mkdirSync(claudeDirectory);
    writeFileSync(join(claudeDirectory, "catalog.json"), JSON.stringify({ catalog: { config: { models: [{ id: "claude-sonnet", name: "Sonnet" }] } } }));
    assert.deepEqual(claudeCatalogOptions(claudeDirectory), [{ label: "Sonnet · claude-sonnet", model: "claude-sonnet" }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ignores malformed defaults and recognizes only Pi and Claude", () => {
  assert.equal(isConfigurableAgentKind("pi"), true);
  assert.equal(isConfigurableAgentKind("claude"), true);
  assert.equal(isConfigurableAgentKind("codex"), false);
  const directory = mkdtempSync(join(tmpdir(), "hunk-herdr-"));
  try {
    const path = join(directory, "models.json");
    saveModelDefaults({ pi: "  " }, path);
    assert.deepEqual(loadModelDefaults(path), {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
