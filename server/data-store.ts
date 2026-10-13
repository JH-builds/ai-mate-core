import { existsSync } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function getDataDir() {
  return path.resolve(process.env.AI_MATE_DATA_DIR || "data");
}

type StoreRead<T> = { status: "ready"; data: T } | { status: "missing" | "unavailable"; data: null };

// Synchronous, existing-store reads only. The connection is read-only and the
// transaction keeps all queries in one snapshot; no schema/cache preparation.
export function readDatabaseSnapshot<T>(databasePath: string, read: (database: DatabaseSync) => T): StoreRead<T> {
  if (!existsSync(databasePath)) return { status: "missing", data: null };
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("BEGIN");
    const data = read(database);
    database.exec("COMMIT");
    return { status: "ready", data };
  } catch { return { status: "unavailable", data: null }; }
  finally { database?.close(); }
}

export async function readText(relativePath: string, fallback: string) {
  const fullPath = path.join(getDataDir(), relativePath);
  if (!existsSync(fullPath)) return fallback;
  return readFile(fullPath, "utf8");
}

// Absolute-file reader for bounded source documents; never returns a prefix as
// a complete document. This does not initialize or write the data directory.
export async function readBoundedFile(file: string | URL, maxBytes: number) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("source_too_large");
    return buffer.subarray(0, length).toString("utf8");
  } finally { await handle.close(); }
}

export async function readJson<T>(relativePath: string, fallback: T): Promise<T> {
  const text = await readText(relativePath, "");
  if (!text.trim()) return fallback;
  return JSON.parse(text) as T;
}

export async function writeJson(relativePath: string, data: unknown) {
  const fullPath = path.join(getDataDir(), relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function readJsonl<T>(relativePath: string): Promise<T[]> {
  const text = await readText(relativePath, "");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function appendJsonl(relativePath: string, entry: unknown) {
  const fullPath = path.join(getDataDir(), relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
}
