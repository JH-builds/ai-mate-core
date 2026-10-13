import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "./data-store.ts";

type Overrides = Record<string, boolean>;
let cache: { flags: Overrides; loadedAt: number; path: string } | undefined;
const cacheTtlMs = 1500;

// Storage is shared; the application owns its feature catalog and migrations.
export function readRuntimeFeatureFlag(id: string, envVar: string): boolean {
  const override = readRuntimeFeatureFlags()[id];
  return typeof override === "boolean" ? override
    : ["1", "true", "yes", "on"].includes(String(process.env[envVar] || "").trim().toLowerCase());
}

export function readRuntimeFeatureFlags(fresh = false): Overrides {
  const filePath = flagsFilePath();
  const now = Date.now();
  if (!fresh && cache?.path === filePath && now - cache.loadedAt < cacheTtlMs) return cache.flags;
  const values: Overrides = {};
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { flags?: Record<string, unknown> };
      const flags = parsed.flags && typeof parsed.flags === "object" ? parsed.flags : {};
      for (const [id, value] of Object.entries(flags)) {
        if (typeof value === "boolean") values[id] = value;
      }
    } catch (error) {
      console.error("runtime_feature_flags_read_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!fresh) cache = { flags: values, loadedAt: now, path: filePath };
  return values;
}

export function writeRuntimeFeatureFlags(flags: Partial<Record<string, boolean>>) {
  const filePath = flagsFilePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ flags }, null, 2)}\n`, "utf8");
  cache = undefined;
}

function flagsFilePath() {
  return path.join(getDataDir(), "runtime", "feature-flags.json");
}
