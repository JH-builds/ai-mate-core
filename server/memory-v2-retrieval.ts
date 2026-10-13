import { createMemoryV2Service } from "./memory-v2-service.ts";
import { rrfMergeScored, searchMemoryVectors } from "./memory-embeddings.ts";
import {
  emptyMemoryContext,
  formatMemoryContext,
  mergeMemoryItems,
  selectInjectableMemories,
  type MemoryContextSelection,
} from "./memory-v2-context-selection.ts";
import { buildMemoryDomainHints, buildMemorySearchQueries, type MemoryDomainHintPatterns } from "./memory-v2-query-planner.ts";
import { buildMemoryProvenance, type MemoryRetrievalProvenance } from "./memory-v2-provenance.ts";
import { getMemoryV2DatabasePath, type MemoryV2Database } from "./memory-v2-store.ts";
import { readDatabaseSnapshot } from "./data-store.ts";
import { listRuntimeIneligibleReflectionMemoryIds } from "./reflection-observation-meta.ts";
import type { MemoryV2Category, MemoryV2Domain, MemoryV2Item, MemoryV2Type } from "./memory-v2-types.ts";
import type { RuntimeMode } from "./types.ts";

export type ApiV2MemoryContext = MemoryContextSelection & {
  // Retrieval-auditability v1: per-request provenance, observation-only. Built
  // after the selection is finalized (it never influences what is selected,
  // ranked, or injected) and surfaced through the existing debug channel.
  // Absent on the empty-context early returns.
  provenance?: MemoryRetrievalProvenance;
};

// Read-only state classifier (spec §Companion). Distinguishes never-stored from
// stored-but-not-recalled, and reports a specific id's isolation posture —
// states retrieval cannot see because they concern items no lane fetched.
export type MemoryStateClassification = {
  exists: boolean;
  status: "active" | "superseded" | "deleted" | "absent";
  category: MemoryV2Category | null;
  type: MemoryV2Type | null;
  domain: MemoryV2Domain | null;
  tag: string | null;
  would_isolate_in_work: boolean;
  in_vector_index: boolean;
  vector_model: string | null;
};

export type MemoryRetrievalProfile = {
  preamble?: readonly string[];
  domainHintPatterns?: MemoryDomainHintPatterns;
  queryStopTerms?: readonly string[];
};

export type ApiV2MemoryRetrievalInput = {
  profile?: MemoryRetrievalProfile;
  userMessage: string;
  recentUserMessages?: string[];
  queryVector?: number[];
  mode: RuntimeMode;
  limit?: number;
  recentLimit?: number;
  charBudget?: number;
  pinnedIds?: number[];
  // Main private chat passes false independently of scene state; work overlays,
  // background readers and Core v1 retain their general-only source projection.
  excludePrivateCategory?: boolean;
};

const defaultLimit = readPositiveIntegerEnv("API_V2_MEMORY_V2_LIMIT", 8);
const defaultCharBudget = readPositiveIntegerEnv("API_V2_MEMORY_V2_CHAR_BUDGET", 2600);
const defaultRecentLimit = readPositiveIntegerEnv("API_V2_MEMORY_V2_RECENT_LIMIT", 0);
const defaultPinnedIds = readIntegerListEnv("API_V2_MEMORY_V2_PINNED_IDS");
const defaultPinnedLimit = readPositiveIntegerEnv("API_V2_MEMORY_V2_PINNED_LIMIT", 10);

export function retrieveApiV2MemoryContext(input: ApiV2MemoryRetrievalInput): ApiV2MemoryContext {
  const query = input.userMessage.trim();
  if (!query || input.mode === "work") return emptyMemoryContext();

  const result = readDatabaseSnapshot(getMemoryV2DatabasePath(), database => retrieveMemoryContextFromDatabase(database, input));
  if (result.status === "ready") return result.data;
  if (result.status === "unavailable") {
    console.error("api_v2_memory_retrieval_failed", { error: "database_unavailable" });
  }
  return emptyMemoryContext();
}

// Shared ranking/eligibility; the caller owns the connection and its lifecycle.
// Neither this function nor the web wrapper initializes a database or table.
export function retrieveMemoryContextFromDatabase(
  database: MemoryV2Database,
  input: ApiV2MemoryRetrievalInput,
): ApiV2MemoryContext {
  const query = input.userMessage.trim();
  if (!query || input.mode === "work") return emptyMemoryContext();
  const service = createMemoryV2Service(database);
  const excludePrivateCategory = input.excludePrivateCategory !== false;
  const categories: MemoryV2Category[] = excludePrivateCategory ? ["general"] : ["general", "private"];
  const limit = input.limit ?? defaultLimit;
  const recentLimit = input.recentLimit ?? defaultRecentLimit;
  const domainHints = buildMemoryDomainHints(query, input.recentUserMessages, input.profile?.domainHintPatterns);
  const pinnedItems = loadPinnedMemories(service, input.pinnedIds ?? defaultPinnedIds, categories);
  const searchQueries = buildMemorySearchQueries(query, input.recentUserMessages, input.profile?.queryStopTerms);
  const relevantItems = searchPlannedMemoryQueries(service, searchQueries, limit, domainHints, categories);
  // Provenance observes the lane outputs and RRF scores that retrieval already
  // computes; these are captured, never consumed by selection.
  let fusedRelevantItems = relevantItems;
  let semanticHits: Array<{ memoryId: number; score: number }> = [];
  let fusedScored: Array<{ id: number; score: number }> = [];
  if (input.queryVector?.length) {
    semanticHits = searchMemoryVectors(database, input.queryVector, { limit });
    const byId = new Map(relevantItems.map((item) => [item.id, item]));
    for (const hit of semanticHits) {
      if (!byId.has(hit.memoryId)) {
        const item = service.getMemory(hit.memoryId);
        if (item) byId.set(item.id, item);
      }
    }
    fusedScored = rrfMergeScored([
      relevantItems.map((item) => item.id),
      semanticHits.map((hit) => hit.memoryId),
    ]);
    const fusedIds = fusedScored.map((entry) => entry.id).slice(0, limit);
    fusedRelevantItems = fusedIds
      .map((id) => byId.get(id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }
  const recentItems = recentLimit > 0 ? listRecentMemoryItems(service, recentLimit, domainHints, categories) : [];
  const items = mergeMemoryItems(pinnedItems, fusedRelevantItems, recentItems);
  // Preserve explicit historical exclusions, including pinned rows.
  const nightReflectionIds = listRuntimeIneligibleReflectionMemoryIds(database);
  const injectable = selectInjectableMemories(items, {
    nightReflectionIds,
    excludePrivateCategory,
  });
  const context = formatMemoryContext(
    injectable,
    input.charBudget ?? defaultCharBudget,
    {
      pinnedIds: pinnedItems.map((item) => item.id),
      preamble: input.profile?.preamble,
    },
  );
  const provenance = buildMemoryProvenance({
    input: { ...input, excludePrivateCategory },
    candidates: items,
    injectable,
    injected: context.items,
    pinnedIds: pinnedItems.map((item) => item.id),
    keywordItems: relevantItems,
    semanticHits,
    fusedScored,
    recentItems,
    nightReflectionIds,
    fusedLimit: limit,
  });
  return { ...context, provenance };
}

function searchPlannedMemoryQueries(
  service: ReturnType<typeof createMemoryV2Service>,
  queries: string[],
  limit: number,
  domainHints: MemoryV2Domain[] = [],
  categories: MemoryV2Category[] = ["general"],
) {
  const results: MemoryV2Item[] = [];
  const seen = new Set<number>();
  for (const query of queries) {
    for (const domain of domainHints) {
      for (const item of service.searchMemories({ query, limit, categories, domains: [domain], excludeNightReflections: true })) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        results.push(item);
        if (results.length >= limit) return results;
      }
    }
    for (const item of service.searchMemories({ query, limit, categories, excludeNightReflections: true })) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      results.push(item);
      if (results.length >= limit) return results;
    }
  }
  return results;
}

function listRecentMemoryItems(
  service: ReturnType<typeof createMemoryV2Service>,
  limit: number,
  domainHints: MemoryV2Domain[],
  categories: MemoryV2Category[],
) {
  const results: MemoryV2Item[] = [];
  const seen = new Set<number>();
  const addItems = (items: MemoryV2Item[]) => {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      results.push(item);
      if (results.length >= limit) return;
    }
  };
  for (const domain of domainHints) {
    addItems(service.listMemories({ limit, categories, domains: [domain], excludeNightReflections: true }));
    if (results.length >= limit) return results;
  }
  addItems(service.listMemories({ limit, categories, excludeNightReflections: true }));
  return results.slice(0, limit);
}

function loadPinnedMemories(
  service: ReturnType<typeof createMemoryV2Service>,
  ids: number[],
  categories: MemoryV2Category[],
) {
  return dedupeNumbers(ids)
    .slice(0, defaultPinnedLimit)
    .map((id) => service.getMemory(id))
    .filter((item): item is MemoryV2Item => Boolean(item && categories.includes(item.category)));
}

// Read-only state classifier (spec §Companion). Given a memory id, returns its
// state independent of any query — the only way to tell never-stored from
// stored-but-not-recalled, and to report a specific id's isolation posture.
// No writes. Opens its own connection like retrieveApiV2MemoryContext.
export function classifyMemoryState(idOrKey: number | string): MemoryStateClassification {
  const id = coerceMemoryId(idOrKey);
  const result = readDatabaseSnapshot(getMemoryV2DatabasePath(), (database): MemoryStateClassification | null => {
    const service = createMemoryV2Service(database);
    const item = service.getMemory(id, { includeDeleted: true, includeSuperseded: true });
    if (!item) return null;
    const nightReflectionIds = listRuntimeIneligibleReflectionMemoryIds(database);
    const vector = lookupMemoryVectorRow(database, id);
    return {
      exists: true,
      status: item.deleted_at ? "deleted" : item.status,
      category: item.category,
      type: item.type,
      domain: item.domain,
      tag: item.tag,
      would_isolate_in_work: item.category === "private" || nightReflectionIds.has(id),
      in_vector_index: Boolean(vector),
      vector_model: vector?.model ?? null,
    };
  });
  // An unreadable store is not evidence that the requested memory never existed.
  if (result.status === "unavailable") throw new Error("memory_database_unavailable");
  return result.data ?? {
    exists: false,
    status: "absent",
    category: null,
    type: null,
    domain: null,
    tag: null,
    would_isolate_in_work: false,
    in_vector_index: false,
    vector_model: null,
  };
}

// Resolves the classifier's id argument against the already retrieved set.
function coerceMemoryId(idOrKey: number | string): number {
  const numeric = typeof idOrKey === "number" ? idOrKey : Number(String(idOrKey).trim());
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`memory_ref_not_id:${String(idOrKey)}`);
  }
  return numeric;
}

function lookupMemoryVectorRow(
  database: MemoryV2Database,
  id: number,
): { model: string } | null {
  try {
    const row = database.prepare("SELECT model FROM memory_vectors WHERE memory_id = ?").get(id) as
      | { model?: string }
      | undefined;
    return row && row.model ? { model: String(row.model) } : null;
  } catch {
    // memory_vectors table absent on a not-yet-migrated store: treat as unindexed.
    return null;
  }
}

function dedupeNumbers(values: number[]) {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name];
  const value = Number(raw === undefined || raw === "" ? fallback : raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function readIntegerListEnv(name: string) {
  return String(process.env[name] || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}
