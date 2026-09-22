import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ConfigurableAgentKind = "pi" | "claude";
export type ModelDefaults = Partial<Record<ConfigurableAgentKind, string>>;

const configurableKinds = new Set<ConfigurableAgentKind>(["pi", "claude"]);

export function isConfigurableAgentKind(kind: string): kind is ConfigurableAgentKind {
  return configurableKinds.has(kind as ConfigurableAgentKind);
}

export function modelDefaultsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "hunk-herdr", "model-defaults.json");
}

function validModel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 500;
}

export function loadModelDefaults(path = modelDefaultsPath()): ModelDefaults {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const defaults: ModelDefaults = {};
    for (const kind of ["pi", "claude"] as const) {
      const model = (value as Record<string, unknown>)[kind];
      if (validModel(model)) defaults[kind] = model.trim();
    }
    return defaults;
  } catch {
    return {};
  }
}

/** Persist only model identifiers; they are passed as separate argv values, never to a shell. */
export function saveModelDefaults(defaults: ModelDefaults, path = modelDefaultsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const safe: ModelDefaults = {};
  for (const kind of ["pi", "claude"] as const) if (validModel(defaults[kind])) safe[kind] = defaults[kind].trim();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(safe, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}
