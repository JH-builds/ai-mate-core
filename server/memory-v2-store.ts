import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDataDir } from "./data-store.ts";
import {
  memoryV2CategoryMigrationId,
  memoryV2CategoryMigrationSql,
  memoryV2LifecycleMigrationId,
  memoryV2LifecycleMigrationSql,
  memoryV2MigrationId,
  memoryV2PrivateAnchorMigrationId,
  memoryV2PrivateAnchorSql,
  memoryV2ReflectionMetaMigrationId,
  memoryV2ReflectionMetaSql,
  memoryV2ReflectionReviewMigrationId,
  memoryV2ReflectionTruthMigrationId,
  memoryV2ReflectionTruthSql,
  memoryV2SchemaSql,
} from "./memory-v2-schema.ts";

export type MemoryV2Database = DatabaseSync;

export function getMemoryV2Dir(dataDir = getDataDir()) {
  return path.join(dataDir, "memory");
}

export function getMemoryV2DatabasePath(dataDir = getDataDir()) {
  return path.join(getMemoryV2Dir(dataDir), "memory.sqlite");
}

export function openMemoryV2Database(options: { dataDir?: string; databasePath?: string } = {}) {
  const databasePath = options.databasePath || getMemoryV2DatabasePath(options.dataDir);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  return new DatabaseSync(databasePath);
}

export function initializeMemoryV2Database(database: MemoryV2Database) {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  let applied = false;

  applied = applyMigration(database, memoryV2MigrationId, () => {
    database.exec(memoryV2SchemaSql);
  }) || applied;

  applied = applyMigration(database, memoryV2CategoryMigrationId, () => {
    if (!columnExists(database, "memories", "category")) database.exec(memoryV2CategoryMigrationSql);
    else database.exec("CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)");
  }) || applied;

  applied = applyMigration(database, memoryV2LifecycleMigrationId, () => {
    if (!columnExists(database, "memories", "domain")) database.exec("ALTER TABLE memories ADD COLUMN domain TEXT CHECK (domain IN ('relationship', 'life', 'work', 'private_world', 'self', 'other'))");
    if (!columnExists(database, "memories", "tag")) database.exec("ALTER TABLE memories ADD COLUMN tag TEXT");
    if (!columnExists(database, "memories", "status")) database.exec("ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded'))");
    if (!columnExists(database, "memories", "superseded_by")) database.exec("ALTER TABLE memories ADD COLUMN superseded_by INTEGER REFERENCES memories(id)");
    if (!columnExists(database, "memories", "superseded_at")) database.exec("ALTER TABLE memories ADD COLUMN superseded_at TEXT");
    database.exec(memoryV2LifecycleMigrationSql.split("\n").filter((line) => line.trim().startsWith("CREATE INDEX")).join("\n"));
  }) || applied;

  applied = applyMigration(database, memoryV2ReflectionMetaMigrationId, () => {
    database.exec(memoryV2ReflectionMetaSql);
  }) || applied;

  applied = applyMigration(database, memoryV2ReflectionTruthMigrationId, () => {
    if (!columnExists(database, "reflection_meta", "origin")) {
      database.exec(memoryV2ReflectionTruthSql);
    } else {
      database.exec("CREATE INDEX IF NOT EXISTS idx_reflection_meta_runtime_eligibility ON reflection_meta(runtime_eligibility)");
    }
  }) || applied;

  applied = applyMigration(database, memoryV2ReflectionReviewMigrationId, () => {
    if (!columnExists(database, "reflection_meta", "review_note")) {
      database.exec("ALTER TABLE reflection_meta ADD COLUMN review_note TEXT");
    }
    if (!columnExists(database, "reflection_meta", "reviewed_at")) {
      database.exec("ALTER TABLE reflection_meta ADD COLUMN reviewed_at TEXT");
    }
    database.exec("CREATE INDEX IF NOT EXISTS idx_reflection_meta_reviewed_at ON reflection_meta(reviewed_at)");
  }) || applied;

  applied = applyMigration(database, memoryV2PrivateAnchorMigrationId, () => {
    database.exec(memoryV2PrivateAnchorSql);
  }) || applied;

  return { applied, migrationId: applied ? memoryV2PrivateAnchorMigrationId : memoryV2MigrationId };
}

export function openInitializedMemoryV2Database(options: { dataDir?: string; databasePath?: string } = {}) {
  const database = openMemoryV2Database(options);
  initializeMemoryV2Database(database);
  return database;
}

// Server startup owns upgrades for existing stores before context reads begin.
// A fresh install stays missing until an actual writer creates its first store.
export function migrateExistingMemoryV2Database(dataDir = getDataDir()) {
  const databasePath = getMemoryV2DatabasePath(dataDir);
  if (!existsSync(databasePath)) return;
  const database = new DatabaseSync(databasePath);
  try { initializeMemoryV2Database(database); }
  finally { database.close(); }
}

function applyMigration(database: MemoryV2Database, id: string, apply: () => void) {
  const existing = database.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(id);
  if (existing) return false;

  database.exec("BEGIN");
  try {
    apply();
    database
      .prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)")
      .run(id, id, new Date().toISOString());
    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function columnExists(database: MemoryV2Database, table: string, column: string) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((row) => String(row.name) === column);
}
