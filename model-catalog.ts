import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigurableAgentKind } from "./model-defaults.ts";

export interface ModelOption { label: string; model?: string }

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

export function piStoreOptions(path = join(process.env.HOME || homedir(), ".pi", "agent", "models-store.json")): ModelOption[] {
  const parsed = readJson(path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const options: ModelOption[] = [];
  for (const [provider, catalog] of Object.entries(parsed)) {
    const models = catalog && typeof catalog === "object" && !Array.isArray(catalog) ? (catalog as Record<string, unknown>).models : undefined;
    if (!Array.isArray(models)) continue;
    for (const entry of models) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const { id, name } = entry as Record<string, unknown>;
      if (typeof id !== "string" || !id) continue;
      const model = `${provider}/${id}`;
      options.push({ label: `${typeof name === "string" && name ? name : id} · ${model}`, model });
    }
  }
  return options;
}

export function claudeCatalogOptions(directory = join(process.env.HOME || homedir(), ".claude", "cache", "model-catalog")): ModelOption[] {
  try {
    const files = readdirSync(directory).filter(file => file.endsWith(".json")).sort().reverse();
    for (const file of files) {
      const parsed = readJson(join(directory, file));
      const models = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? ((parsed as Record<string, unknown>).catalog as Record<string, unknown> | undefined)?.config as Record<string, unknown> | undefined
        : undefined;
      const entries = models?.models;
      if (!Array.isArray(entries)) continue;
      const options = entries.flatMap(entry => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const { id, name } = entry as Record<string, unknown>;
        return typeof id === "string" && id ? [{ label: `${typeof name === "string" && name ? name : id} · ${id}`, model: id }] : [];
      });
      if (options.length) return options;
    }
  } catch {}
  return [];
}

export function modelOptions(kind: ConfigurableAgentKind): readonly ModelOption[] {
  const discovered = kind === "pi" ? piStoreOptions() : claudeCatalogOptions();
  return [{ label: kind === "pi" ? "Default (no Pi override)" : "Default (let Claude choose)" }, ...discovered];
}
