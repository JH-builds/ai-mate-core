import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { readBoundedFile } from "./data-store.ts";
import { coreContextOutput } from "./core-context-output.ts";
import { openMemoryV2Database, initializeMemoryV2Database } from "./memory-v2-store.ts";
import { createMemoryV2Service } from "./memory-v2-service.ts";
import { insertReflectionObservationMeta } from "./reflection-observation-meta.ts";
import { openTodayContextDatabase, initializeTodayContextDatabase } from "./today-context-store.ts";
import { createTodayContextService } from "./today-context-service.ts";

// Offline preparation only. Never imported by the read-only MCP entrypoint.
function check(condition: unknown): asserts condition {
  if (!condition) throw new Error("invalid_import");
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  check(Object.keys(value).every(key => keys.includes(key)));
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] { check(Array.isArray(value)); return value; }
function text(value: unknown): string { check(typeof value === "string" && value.trim()); return value; }
function optionalText(value: unknown): string | null {
  check(value == null || typeof value === "string");
  return value == null ? null : value;
}
function choice<const T extends string>(value: unknown, values: readonly T[]): T {
  check(typeof value === "string" && (values as readonly string[]).includes(value));
  return value as T;
}
function dateKey(value: unknown): string {
  const date = text(value);
  check(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date);
  return date;
}
function timestamp(value: unknown): string {
  const date = text(value);
  check(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(date) && Number.isFinite(Date.parse(date)));
  dateKey(date.slice(0, 10));
  return date;
}

function parseImport(value: unknown) {
  const input = object(value, ["schemaVersion", "memories", "today", "continuation"]);
  check(input.schemaVersion === 1);
  const memories = array(input.memories === undefined ? [] : input.memories).map(value => {
    const row = object(value, ["type", "category", "domain", "tag", "content", "source", "createdAt", "updatedAt", "reflectionMeta"]);
    const type = choice(row.type, ["fact", "observation", "reflection", "event"]);
    const createdAt = timestamp(row.createdAt);
    // Missing metadata must not silently make a reflection eligible.
    check(type !== "reflection" || row.reflectionMeta != null);
    const meta = row.reflectionMeta === undefined ? undefined : object(row.reflectionMeta, ["origin", "claimedStatus", "runtimeEligibility", "createdAt", "reviewNote", "reviewedAt"]);
    return {
      type, category: choice(row.category, ["general", "private"]), content: text(row.content),
      domain: row.domain == null ? null : choice(row.domain, ["relationship", "life", "work", "private_world", "self", "other"]),
      tag: optionalText(row.tag), source: row.source === undefined ? "migration" as const : choice(row.source, ["manual", "migration", "extraction"]),
      createdAt, updatedAt: row.updatedAt === undefined ? createdAt : timestamp(row.updatedAt),
      reflectionMeta: meta ? {
        origin: choice(meta.origin, ["chat", "nightly_review", "legacy"]),
        claimedStatus: choice(meta.claimedStatus, ["raw", "claimed", "unreviewed", "uncertain", "not_claimed", "withdrawn", "archived"]),
        runtimeEligibility: choice(meta.runtimeEligibility, ["eligible", "excluded"]),
        createdAt: meta.createdAt === undefined ? createdAt : timestamp(meta.createdAt),
        reviewNote: optionalText(meta.reviewNote), reviewedAt: meta.reviewedAt == null ? null : timestamp(meta.reviewedAt),
      } : undefined,
    };
  });
  const today = array(input.today === undefined ? [] : input.today).map(value => {
    const row = object(value, ["date", "summary", "updatedAt"]);
    const summary = text(row.summary);
    check(summary.length <= 1200); // Existing writer normalizes whitespace and caps at 1,200.
    return { date: dateKey(row.date), summary, updatedAt: timestamp(row.updatedAt) };
  });
  check(new Set(today.map(row => row.date)).size === today.length);
  let continuation: string | undefined;
  let continuationCount = 0;
  if (input.continuation !== undefined) {
    const card = object(input.continuation, ["updatedAt", "items"]);
    const items = array(card.items).map(value => {
      const item = object(value, ["text", "sourceMessageIds", "supportedAt"]);
      const sourceMessageIds = array(item.sourceMessageIds).map(text);
      check(sourceMessageIds.every(id => id.length <= 128));
      return { text: text(item.text), sourceMessageIds, ...(item.supportedAt === undefined ? {} : { supportedAt: timestamp(item.supportedAt) }) };
    });
    check(items.length <= coreContextOutput.continuation.storedItemsMax);
    continuation = JSON.stringify({ updatedAt: timestamp(card.updatedAt), items }) + "\n";
    check(Buffer.byteLength(continuation) <= coreContextOutput.continuation.fileMaxBytes);
    continuationCount = items.length;
  }
  return { memories, today, continuation, continuationCount };
}

async function prepareData(target: string, input: ReturnType<typeof parseImport>) {
  // No merge/overwrite, including empty directories and symlinks. Parent must exist.
  await lstat(target).then(() => { throw new Error("target_exists"); }, error => { if (error.code !== "ENOENT") throw error; });
  const staging = await mkdtemp(path.join(path.dirname(target), ".core-data-"));
  let ownsTarget = false;
  try {
    const memoryDb = openMemoryV2Database({ dataDir: staging });
    try {
      initializeMemoryV2Database(memoryDb);
      const service = createMemoryV2Service(memoryDb);
      const setDates = memoryDb.prepare("UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?");
      memoryDb.exec("BEGIN IMMEDIATE");
      for (const row of input.memories) {
        const saved = service.createMemory(row);
        setDates.run(row.createdAt, row.updatedAt, saved.id);
        if (row.reflectionMeta) insertReflectionObservationMeta(memoryDb, saved.id, row.reflectionMeta);
      }
      memoryDb.exec("COMMIT");
    } finally { memoryDb.close(); }
    const todayDb = openTodayContextDatabase({ dataDir: staging });
    try {
      initializeTodayContextDatabase(todayDb);
      const service = createTodayContextService(todayDb);
      todayDb.exec("BEGIN IMMEDIATE");
      for (const row of input.today) service.upsertSummary({ scope_id: "main", date: row.date, summary: row.summary, now: new Date(row.updatedAt) });
      todayDb.exec("COMMIT");
    } finally { todayDb.close(); }
    if (input.continuation !== undefined) {
      await mkdir(path.join(staging, "continuation"));
      await writeFile(path.join(staging, "continuation/apiv2-card.json"), input.continuation, { mode: 0o600 });
    }
    // Exclusive reservation prevents a concurrent initializer from being overwritten.
    // Only publish closed stores; this is offline setup, not a live database swap.
    await mkdir(target, { mode: 0o700 });
    ownsTarget = true;
    for (const directory of ["memory", "today", ...(input.continuation === undefined ? [] : ["continuation"])]) {
      await rename(path.join(staging, directory), path.join(target, directory));
    }
  } catch (error) {
    if (ownsTarget) await rm(target, { recursive: true, force: true });
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { memories: input.memories.length, today: input.today.length, continuation: input.continuationCount };
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "data-dir": { type: "string" }, from: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Offline Core preparation (new directory only):\n  node core-data.mjs init --data-dir <new-directory>\n  node core-data.mjs import --data-dir <new-directory> --from <schema-v1.json>\nThe parent directory must exist. Choose init OR import, then start the read-only Core.");
  } else {
    const command = positionals[0];
    if (positionals.length !== 1 || !values["data-dir"]?.trim() || !["init", "import"].includes(command) || (command === "init" ? values.from !== undefined : !values.from?.trim())) throw new Error("usage");
    const input = command === "init" ? parseImport({ schemaVersion: 1 }) : parseImport(JSON.parse(await readBoundedFile(path.resolve(values.from!), 8 * 1024 * 1024)));
    console.log(JSON.stringify(await prepareData(path.resolve(values["data-dir"]), input)));
  }
} catch (error) {
  // Never echo imported text, private paths, SQL or the original parser exception.
  const message = error instanceof Error ? error.message : "";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const reason = code === "EEXIST" ? "target_exists" : ["usage", "target_exists", "invalid_import", "source_too_large"].includes(message) ? message : "check_input_and_destination";
  console.error(`Core data preparation failed: ${reason}. See README or --help. No existing store was updated.`);
  process.exitCode = 1;
}
