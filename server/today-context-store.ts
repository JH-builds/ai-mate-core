import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDataDir } from "./data-store.ts";
import {
  todayContextMigrationId,
  todayContextSchemaSql,
  todayContextStateMigrationId,
  todayContextStateSchemaSql,
  todayEventsMigrationId,
  todayEventsSchemaSql,
  todayContextAdmissionMigrationId,
  todayContextAdmissionSchemaSql,
  todayContextFoldMigrationId,
  todayContextFoldSchemaSql,
  todayContextFragmentMigrationId,
  todayContextFragmentSchemaSql,
} from "./today-context-schema.ts";

export type TodayContextDatabase = DatabaseSync;

export function getTodayContextDir(dataDir = getDataDir()) {
  return path.join(dataDir, "today");
}

export function getTodayContextDatabasePath(dataDir = getDataDir()) {
  return path.join(getTodayContextDir(dataDir), "today.sqlite");
}

export function openTodayContextDatabase(options: { dataDir?: string; databasePath?: string } = {}) {
  const databasePath = options.databasePath || getTodayContextDatabasePath(options.dataDir);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  return new DatabaseSync(databasePath);
}

export function initializeTodayContextDatabase(database: TodayContextDatabase) {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const migrations = [
    { id: todayContextMigrationId, sql: todayContextSchemaSql },
    { id: todayContextStateMigrationId, sql: todayContextStateSchemaSql },
    { id: todayEventsMigrationId, sql: todayEventsSchemaSql },
    { id: todayContextAdmissionMigrationId, sql: todayContextAdmissionSchemaSql },
    { id: todayContextFoldMigrationId, sql: todayContextFoldSchemaSql },
    { id: todayContextFragmentMigrationId, sql: todayContextFragmentSchemaSql },
  ];
  const applied = migrations.map((migration) => applyMigration(database, migration.id, migration.sql));
  return { applied: applied.some(Boolean), migrationId: migrations[migrations.length - 1].id };
}

export function openInitializedTodayContextDatabase(options: { dataDir?: string; databasePath?: string } = {}) {
  const database = openTodayContextDatabase(options);
  initializeTodayContextDatabase(database);
  return database;
}

function applyMigration(database: TodayContextDatabase, id: string, sql: string) {
  const existing = database.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(id);
  if (existing) return false;

  database.exec("BEGIN IMMEDIATE");
  try {
    if (database.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(id)) {
      database.exec("COMMIT");
      return false;
    }
    database.exec(sql);
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
