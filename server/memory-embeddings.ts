import { readRuntimeFeatureFlag } from "./runtime-feature-store.ts";
import process from "node:process";
import type { MemoryV2Database } from "./memory-v2-store.ts";
import type { MemoryV2Domain } from "./memory-v2-types.ts";
import { runtimeEligibleReflectionClause } from "./reflection-observation-meta.ts";
import { embedLocalTexts, localEmbeddingModel } from "./local-embedding.ts";

// Semantic retrieval path for memory-v2 (vector index v1).
// Scale reality: a few hundred memories — vectors live as JSON in a sqlite
// table and search is brute-force cosine, microseconds per query. No vector
// database, no new infrastructure. The selected pinned-local or remote
// transport stays dark until the vector feature and provider are configured.

export function isMemoryVectorEnabled(): boolean {
  return readRuntimeFeatureFlag("memory_vector", "API_V2_MEMORY_VECTOR_ENABLED");
}

// Shared source rule for external embedding and its derived indexes. This
// permission says nothing about local private recall or scene activation.
export function sourceEligibleForEmbedding(category: unknown): category is "general" {
  return category === "general";
}

function memoryVectorSource(database: MemoryV2Database, id: number) {
  return database.prepare(`SELECT m.id, m.content, m.category FROM memories m
    WHERE m.id = ? AND m.deleted_at IS NULL AND m.status = 'active'
      AND ${runtimeEligibleReflectionClause("m")}`)
    .get(id) as { id: number; content: string; category: string } | undefined;
}

// The backfill selects only vector-eligible memories: private rows are never
// re-indexed, so a future backfill can never re-leak what the purge cleared.
// Exported so the backfill script and its test share one source of truth.
export function memoryVectorBackfillSql(): string {
  return `SELECT m.id, m.content FROM memories m
         LEFT JOIN memory_vectors v ON v.memory_id = m.id AND v.model = ?
         WHERE m.deleted_at IS NULL AND m.status = 'active' AND m.category = 'general'
           AND ${runtimeEligibleReflectionClause("m")}
           AND v.memory_id IS NULL
         ORDER BY m.id`;
}

function embeddingConfig() {
  const provider = String(process.env.EMBEDDING_PROVIDER || "remote").trim().toLowerCase();
  if (provider === "local") {
    const modelDirectory = String(process.env.LOCAL_EMBEDDING_MODEL_DIR || "").trim();
    return {
      provider,
      model: localEmbeddingModel.indexName,
      modelDirectory,
      baseUrl: "",
      apiKey: "",
      configured: Boolean(modelDirectory),
    };
  }
  const baseUrl = String(process.env.EMBEDDING_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL || "").trim().replace(/\/$/, "");
  const apiKey = String(process.env.EMBEDDING_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || "").trim();
  const model = String(process.env.EMBEDDING_MODEL || "text-embedding-3-small").trim();
  return { provider, model, modelDirectory: "", baseUrl, apiKey, configured: provider === "remote" && Boolean(baseUrl && apiKey) };
}

export function embeddingModelName(): string {
  return embeddingConfig().model;
}

// Maintenance callers must carry source classification too. Never infer it
// from wording, tags, the current scene, or the fact that text is a summary.
export async function embedTexts(sources: Array<{ content: string; category: string }>): Promise<number[][]> {
  if (sources.some((source) => !sourceEligibleForEmbedding(source.category))) {
    throw new Error("embedding_source_not_authorized");
  }
  return requestEmbeddings(sources.map((source) => source.content), "document");
}

async function requestEmbeddings(texts: string[], purpose: "document" | "query"): Promise<number[][]> {
  if (!texts.length) return [];
  const config = embeddingConfig();
  if (!config.configured) throw new Error("embedding_not_configured");
  if (config.provider === "local") {
    return embedLocalTexts(config.modelDirectory, texts, purpose);
  }
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: config.model, input: texts }),
  }).catch(() => { throw new Error("embedding_request_failed"); });
  if (!response.ok) {
    // Providers may echo the input or credentials in an error body.
    await response.body?.cancel().catch(() => {});
    throw new Error(`embedding_http_${response.status}`);
  }
  const payload = await response.json().catch(() => { throw new Error("embedding_bad_response_shape"); }) as { data?: Array<{ index: number; embedding: number[] }> };
  if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
    throw new Error("embedding_bad_response_shape");
  }
  return payload.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.embedding);
}

export function ensureMemoryVectorTable(database: MemoryV2Database) {
  database.exec(`
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`);
}

export function upsertMemoryVector(database: MemoryV2Database, memoryId: number, model: string, vector: number[]) {
  if (!sourceEligibleForEmbedding(memoryVectorSource(database, memoryId)?.category)) {
    throw new Error("memory_not_vector_eligible");
  }
  ensureMemoryVectorTable(database);
  database
    .prepare(
      "INSERT INTO memory_vectors (memory_id, model, dims, vector_json, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dims = excluded.dims, vector_json = excluded.vector_json, updated_at = excluded.updated_at",
    )
    .run(memoryId, model, vector.length, JSON.stringify(vector), new Date().toISOString());
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Queries never initialize or repair an index; writes/backfills own that work.
export function searchMemoryVectors(
  database: MemoryV2Database,
  queryVector: number[],
  options: { limit?: number; categories?: string[]; domains?: MemoryV2Domain[] } = {},
): Array<{ memoryId: number; score: number }> {
  if (!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'").get()) return [];
  const limit = options.limit ?? 6;
  const categories = (options.categories ?? ["general"]).filter(sourceEligibleForEmbedding);
  if (!categories.length) return [];
  const placeholders = categories.map(() => "?").join(",");
  const domains = options.domains;
  const domainClause = domains?.length
    ? ` AND m.domain IN (${domains.map(() => "?").join(",")})`
    : "";
  const rows = database
    .prepare(
      `SELECT v.memory_id, v.vector_json FROM memory_vectors v
       JOIN memories m ON m.id = v.memory_id
       WHERE m.deleted_at IS NULL AND m.status = 'active' AND m.category IN (${placeholders})
         AND ${runtimeEligibleReflectionClause("m")}${domainClause}
         AND v.model = ? AND v.dims = ?`,
    )
    .all(...categories, ...(domains || []), embeddingModelName(), queryVector.length) as Array<{ memory_id: number; vector_json: string }>;
  const scored: Array<{ memoryId: number; score: number }> = [];
  for (const row of rows) {
    try {
      const vector = JSON.parse(row.vector_json) as number[];
      scored.push({ memoryId: row.memory_id, score: cosineSimilarity(queryVector, vector) });
    } catch {
      // skip corrupt rows; backfill repairs them
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Reciprocal Rank Fusion: parameter-free merge of keyword and semantic
// rankings. k=60 is the standard constant from the RRF paper.
//
// rrfMergeScored keeps the fused score alongside each id; rrfMerge is the
// id-only view built on top of it, so both orderings are guaranteed identical.
// The scored variant exists so retrieval auditability can capture the fusion
// score that was otherwise computed here and discarded — provenance only, it
// never changes what rrfMerge returns.
export function rrfMergeScored(rankings: number[][], k = 60): Array<{ id: number; score: number }> {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}

export function rrfMerge(rankings: number[][], k = 60): number[] {
  return rrfMergeScored(rankings, k).map((entry) => entry.id);
}

// Fire-and-forget embed on writes; backfill repairs any gaps. Private
// memories return before anything leaves the process.
export async function indexMemoryVectors(database: MemoryV2Database, ids: number[]): Promise<number> {
  const sources = ids.map((id) => memoryVectorSource(database, id))
    .filter((source): source is NonNullable<typeof source> => Boolean(source && sourceEligibleForEmbedding(source.category)));
  const model = embeddingModelName();
  const vectors = await embedTexts(sources.map((source) => ({ ...source, content: source.content.slice(0, 2000) })));
  let indexed = 0;
  sources.forEach((source, index) => {
    const current = memoryVectorSource(database, source.id);
    if (!current || !sourceEligibleForEmbedding(current.category) || current.content !== source.content) return;
    upsertMemoryVector(database, source.id, model, vectors[index]);
    indexed += 1;
  });
  return indexed;
}

export function scheduleMemoryVectorUpsert(memoryId: number) {
  if (!isMemoryVectorEnabled()) return;
  return (async () => {
    const { openInitializedMemoryV2Database } = await import("./memory-v2-store.ts");
    const database = openInitializedMemoryV2Database();
    try {
      await indexMemoryVectors(database, [memoryId]);
    } finally {
      database.close();
    }
  })().catch((error) => {
    console.warn("memory_vector_upsert_failed", { memoryId, error: error instanceof Error ? error.message : error });
  });
}

// Query-side embed used by the context bundle (retrieval itself stays sync).
// Best-effort: any failure just means keyword-only retrieval for this turn.
// Local mode has no remote fallback: a missing/corrupt local model degrades this
// turn to keyword retrieval rather than sending private query text elsewhere.
export async function embedQueryVectorSafe(query: string): Promise<number[] | undefined> {
  if (!isMemoryVectorEnabled()) return undefined;
  try {
    const [vector] = await requestEmbeddings([String(query || "").slice(0, 1000)], "query");
    return vector;
  } catch (error) {
    console.warn("memory_query_embed_failed", error instanceof Error ? error.message : error);
    return undefined;
  }
}
