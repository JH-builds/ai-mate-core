import type { MemoryV2Database } from "./memory-v2-store.ts";
import type {
  CreateMemoryV2Input,
  MemoryV2Category,
  MemoryV2Domain,
  MemoryV2Item,
  MemoryV2Source,
  MemoryV2Status,
  MemoryV2Type,
  SearchMemoryV2Input,
  SupersedeMemoryV2Input,
  UpdateMemoryV2Input,
} from "./memory-v2-types.ts";
import { insertReflectionObservationMeta, runtimeEligibleReflectionClause } from "./reflection-observation-meta.ts";

type SqlValue = null | number | string;

const memoryTypes = new Set<MemoryV2Type>(["fact", "observation", "reflection", "event"]);
const memorySources = new Set<MemoryV2Source>(["manual", "migration", "extraction"]);
const memoryCategories = new Set<MemoryV2Category>(["general", "private"]);
const memoryDomains = new Set<MemoryV2Domain>(["relationship", "life", "work", "private_world", "self", "other"]);
const memoryStatuses = new Set<MemoryV2Status>(["active", "superseded"]);

export class MemoryV2Service {
  constructor(private readonly database: MemoryV2Database) {}

  createMemory(input: CreateMemoryV2Input) {
    const type = validateType(input.type);
    const category = validateCategory(input.category || "general");
    const domain = validateOptionalDomain(input.domain);
    const tag = validateOptionalTag(input.tag);
    const source = validateSource(input.source || "manual");
    const content = normalizeContent(input.content);
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        INSERT INTO memories (type, category, domain, tag, status, content, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `)
      .run(type, category, domain, tag, content, source, now, now);
    return this.requireMemory(Number(result.lastInsertRowid));
  }

  getMemory(id: number, options: { includeDeleted?: boolean; includeSuperseded?: boolean } = {}) {
    const row = this.database.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    if (!row) return null;
    const item = toMemoryV2Item(row);
    if (!options.includeDeleted && item.deleted_at) return null;
    if (!options.includeSuperseded && item.status === "superseded") return null;
    return item;
  }

  listMemories(options: {
    includeDeleted?: boolean;
    includeSuperseded?: boolean;
    limit?: number;
    types?: MemoryV2Type[];
    categories?: MemoryV2Category[];
    domains?: MemoryV2Domain[];
    statuses?: MemoryV2Status[];
    excludeNightReflections?: boolean;
  } = {}) {
    const filter = buildFilter(options);
    const whereSql = appendNightReflectionExclusion(filter.whereSql, "memories", options.excludeNightReflections);
    return this.database
      .prepare(`SELECT * FROM memories ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...filter.values, clampLimit(options.limit))
      .map(toMemoryV2Item);
  }

  searchMemories(input: SearchMemoryV2Input) {
    const query = normalizeSearchQuery(input.query);
    if (!query) return [];
    const filter = buildFilter({
      types: input.types,
      categories: input.categories,
      domains: input.domains,
      statuses: input.statuses,
      includeSuperseded: input.includeSuperseded,
    });
    const ftsWhereSql = appendNightReflectionExclusion(filter.whereSql, "m", input.excludeNightReflections);
    const likeWhereSql = appendNightReflectionExclusion(filter.whereSql, "memories", input.excludeNightReflections);
    const limit = clampLimit(input.limit);
    const byId = new Map<number, MemoryV2Item>();

    try {
      const ftsRows = this.database
        .prepare(`
          SELECT m.*
          FROM memories_fts f
          JOIN memories m ON m.id = f.rowid
          ${ftsWhereSql ? `${ftsWhereSql} AND` : "WHERE"} memories_fts MATCH ?
          ORDER BY rank, m.updated_at DESC
          LIMIT ?
        `)
        .all(...filter.values, query, limit)
        .map(toMemoryV2Item);
      for (const item of ftsRows) byId.set(item.id, item);
    } catch {
      // Some user text is not valid FTS syntax; LIKE fallback below keeps search useful.
    }

    const like = `%${escapeLike(query)}%`;
    const likeRows = this.database
      .prepare(`
        SELECT *
        FROM memories
        ${likeWhereSql ? `${likeWhereSql} AND` : "WHERE"} (
          content LIKE ? ESCAPE '\\'
          OR type LIKE ? ESCAPE '\\'
        )
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `)
      .all(...filter.values, like, like, limit)
      .map(toMemoryV2Item);
    for (const item of likeRows) byId.set(item.id, item);

    return [...byId.values()].slice(0, limit);
  }

  findSimilarMemory(type: MemoryV2Type, content: string, category: MemoryV2Category = "general") {
    const validatedType = validateType(type);
    const validatedCategory = validateCategory(category);
    const normalizedContent = normalizeContentForSimilarity(content);
    if (!normalizedContent) return null;
    const reflectionEligibilitySql = validatedType === "reflection"
      ? `AND ${runtimeEligibleReflectionClause("memories")}`
      : "";
    const rows = this.database
      .prepare(`
        SELECT *
        FROM memories
        WHERE deleted_at IS NULL AND status = 'active' AND type = ? AND category = ?
          ${reflectionEligibilitySql}
        ORDER BY updated_at DESC, id DESC
        LIMIT 100
      `)
      .all(validatedType, validatedCategory)
      .map(toMemoryV2Item);
    return rows.find((item) => isSimilarMemoryContent(normalizedContent, item.content)) || null;
  }

  // Read-only conflict surfacer (memory P1 #2 / audit gap 2). After the dedup pass has NOT
  // skipped, look for ACTIVE same-(type,category,domain,tag) memories whose content is a
  // near-restatement — looser than dedup, but not a dedup-grade match. These are the
  // "held, not adjudicated" contradictions: they are surfaced as an advisory, never
  // written/merged/superseded here. A shared (domain,tag) axis is required, so an untagged
  // save never fires; dedup-grade matches stay with the existing silent-skip. Returns ≤3.
  findPossibleConflicts(
    type: MemoryV2Type,
    content: string,
    category: MemoryV2Category = "general",
    domain: MemoryV2Domain | null = null,
    tag: string | null = null,
  ): MemoryV2Item[] {
    const normalizedTag = validateOptionalTag(tag);
    if (!domain || !normalizedTag) return [];
    const validatedType = validateType(type);
    const validatedCategory = validateCategory(category);
    const validatedDomain = validateDomain(domain);
    const normalizedContent = normalizeContentForSimilarity(content);
    if (!normalizedContent) return [];
    const reflectionEligibilitySql = validatedType === "reflection"
      ? `AND ${runtimeEligibleReflectionClause("memories")}`
      : "";
    const rows = this.database
      .prepare(`
        SELECT *
        FROM memories
        WHERE deleted_at IS NULL AND status = 'active'
          AND type = ? AND category = ? AND domain = ? AND tag = ?
          ${reflectionEligibilitySql}
        ORDER BY updated_at DESC, id DESC
        LIMIT 100
      `)
      .all(validatedType, validatedCategory, validatedDomain, normalizedTag)
      .map(toMemoryV2Item);
    const conflicts: MemoryV2Item[] = [];
    for (const item of rows) {
      if (isSimilarMemoryContent(normalizedContent, item.content)) continue; // dedup owns the silent-skip
      if (isPossibleConflictContent(normalizedContent, item.content)) conflicts.push(item);
      if (conflicts.length >= maxSurfacedConflicts) break;
    }
    return conflicts;
  }

  updateMemory(input: UpdateMemoryV2Input) {
    const before = this.requireMemory(input.id, { includeDeleted: true, includeSuperseded: true });
    if (before.deleted_at) throw new Error(`memory_v2_deleted:${input.id}`);
    const nextType = input.type === undefined ? before.type : validateType(input.type);
    const nextCategory = input.category === undefined ? before.category : validateCategory(input.category);
    const nextDomain = input.domain === undefined ? before.domain : validateOptionalDomain(input.domain);
    const nextTag = input.tag === undefined ? before.tag : validateOptionalTag(input.tag);
    const nextStatus = input.status === undefined ? before.status : validateStatus(input.status);
    const nextSupersededBy = input.superseded_by === undefined ? before.superseded_by : validateOptionalId(input.superseded_by, "invalid_memory_v2_superseded_by");
    const nextSupersededAt = input.superseded_at === undefined ? before.superseded_at : validateOptionalDateText(input.superseded_at);
    const nextSource = input.source === undefined ? before.source : validateSource(input.source);
    const nextContent = input.content === undefined ? before.content : normalizeContent(input.content);
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE memories SET type = ?, category = ?, domain = ?, tag = ?, status = ?, superseded_by = ?, superseded_at = ?, content = ?, source = ?, updated_at = ? WHERE id = ?")
      .run(nextType, nextCategory, nextDomain, nextTag, nextStatus, nextSupersededBy, nextSupersededAt, nextContent, nextSource, now, input.id);
    return this.requireMemory(input.id, { includeSuperseded: true });
  }

  supersedeMemory(input: SupersedeMemoryV2Input) {
    const before = this.requireMemory(input.id, { includeSuperseded: true });
    if (before.deleted_at) throw new Error(`memory_v2_deleted:${input.id}`);
    if (before.status !== "active") throw new Error(`memory_v2_not_active:${input.id}`);
    const replacementType = validateType(input.replacement.type || before.type);
    const replacementCategory = validateCategory(input.replacement.category || before.category);
    const replacementDomain = validateOptionalDomain(input.replacement.domain === undefined ? before.domain : input.replacement.domain);
    const replacementTag = validateOptionalTag(input.replacement.tag);
    const replacementSource = validateSource(input.replacement.source || "extraction");
    const replacementContent = normalizeContent(input.replacement.content);
    const now = new Date().toISOString();

    this.database.exec("BEGIN");
    try {
      const result = this.database
        .prepare(`
          INSERT INTO memories (type, category, domain, tag, status, content, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
        `)
        .run(replacementType, replacementCategory, replacementDomain, replacementTag, replacementContent, replacementSource, now, now);
      const replacementId = Number(result.lastInsertRowid);
      if (input.reflectionMeta) {
        if (replacementType !== "reflection") throw new Error("reflection_meta_requires_reflection");
        insertReflectionObservationMeta(this.database, replacementId, {
          ...input.reflectionMeta,
          createdAt: input.reflectionMeta.createdAt || now,
        });
      }
      this.database
        .prepare("UPDATE memories SET status = 'superseded', superseded_by = ?, superseded_at = ?, updated_at = ? WHERE id = ?")
        .run(replacementId, now, now, input.id);
      this.database.exec("COMMIT");
      return {
        superseded: this.requireMemory(input.id, { includeSuperseded: true }),
        replacement: this.requireMemory(replacementId),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteMemory(id: number) {
    const before = this.requireMemory(id, { includeSuperseded: true });
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
    return { ...before, deleted_at: now, updated_at: now };
  }

  private requireMemory(id: number, options: { includeDeleted?: boolean; includeSuperseded?: boolean } = {}) {
    const item = this.getMemory(id, options);
    if (!item) throw new Error(`memory_v2_not_found:${id}`);
    return item;
  }
}

export function createMemoryV2Service(database: MemoryV2Database) {
  return new MemoryV2Service(database);
}

function buildFilter(options: {
  includeDeleted?: boolean;
  includeSuperseded?: boolean;
  types?: MemoryV2Type[];
  categories?: MemoryV2Category[];
  domains?: MemoryV2Domain[];
  statuses?: MemoryV2Status[];
}) {
  const clauses: string[] = [];
  const values: SqlValue[] = [];
  if (!options.includeDeleted) clauses.push("deleted_at IS NULL");
  if (options.statuses?.length) {
    const statuses = options.statuses.map(validateStatus);
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    values.push(...statuses);
  } else if (!options.includeSuperseded) {
    clauses.push("status = 'active'");
  }
  if (options.types?.length) {
    const types = options.types.map(validateType);
    clauses.push(`type IN (${types.map(() => "?").join(", ")})`);
    values.push(...types);
  }
  if (options.categories?.length) {
    const categories = options.categories.map(validateCategory);
    clauses.push(`category IN (${categories.map(() => "?").join(", ")})`);
    values.push(...categories);
  }
  if (options.domains?.length) {
    const domains = options.domains.map(validateDomain);
    clauses.push(`domain IN (${domains.map(() => "?").join(", ")})`);
    values.push(...domains);
  }
  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function appendNightReflectionExclusion(whereSql: string, tableName: string, exclude = false) {
  if (!exclude) return whereSql;
  const clause = runtimeEligibleReflectionClause(tableName);
  return whereSql ? `${whereSql} AND ${clause}` : `WHERE ${clause}`;
}

function validateType(value: string) {
  if (!memoryTypes.has(value as MemoryV2Type)) throw new Error(`invalid_memory_v2_type:${value}`);
  return value as MemoryV2Type;
}

function validateSource(value: string) {
  if (!memorySources.has(value as MemoryV2Source)) throw new Error(`invalid_memory_v2_source:${value}`);
  return value as MemoryV2Source;
}

function validateCategory(value: string) {
  if (!memoryCategories.has(value as MemoryV2Category)) throw new Error(`invalid_memory_v2_category:${value}`);
  return value as MemoryV2Category;
}

function validateDomain(value: string) {
  if (!memoryDomains.has(value as MemoryV2Domain)) throw new Error(`invalid_memory_v2_domain:${value}`);
  return value as MemoryV2Domain;
}

function validateOptionalDomain(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`invalid_memory_v2_domain:${String(value)}`);
  return validateDomain(value);
}

function validateStatus(value: string) {
  if (!memoryStatuses.has(value as MemoryV2Status)) throw new Error(`invalid_memory_v2_status:${value}`);
  return value as MemoryV2Status;
}

function validateOptionalTag(value: unknown) {
  if (value === undefined || value === null) return null;
  const tag = String(value).trim();
  if (!tag) return null;
  if (tag.length > 80) throw new Error("invalid_memory_v2_tag");
  return tag;
}

function validateOptionalId(value: unknown, code: string) {
  if (value === undefined || value === null) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(code);
  return id;
}

function validateOptionalDateText(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function normalizeContent(value: string) {
  const content = String(value || "").trim();
  if (!content) throw new Error("empty_memory_v2_content");
  return content;
}

function normalizeContentForSimilarity(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?;；:："“”"'‘’（）()\[\]{}<>《》\-—_]/g, "");
}

function isSimilarMemoryContent(normalizedContent: string, existingContent: string) {
  const normalizedExisting = normalizeContentForSimilarity(existingContent);
  if (!normalizedExisting) return false;
  if (normalizedContent === normalizedExisting) return true;

  const shorter = normalizedContent.length <= normalizedExisting.length ? normalizedContent : normalizedExisting;
  const longer = normalizedContent.length > normalizedExisting.length ? normalizedContent : normalizedExisting;
  const lengthRatio = shorter.length / longer.length;
  if (shorter.length >= 12 && lengthRatio >= 0.65 && longer.includes(shorter)) return true;

  const prefixLength = Math.min(18, shorter.length);
  return prefixLength >= 12
    && lengthRatio >= 0.8
    && normalizedContent.slice(0, prefixLength) === normalizedExisting.slice(0, prefixLength);
}

// Conflict surfacer loose bar (memory P1 #2): a near-restatement that differs in its *value*
// ("住城西" -> "住城东") crosses this bar, while a genuinely unrelated same-(domain,tag) save
// does not. Character-bigram overlap (Dice) — a token-overlap variant over the same dedup
// normalization — scores whole-string similarity, so it does NOT fire on a merely shared
// subject prefix (e.g. two facts that both start with the same name). Deliberately lexical:
// it catches contradictions phrased as near-identical strings, not semantic opposites with
// low surface overlap (that would need embeddings/NLI, out of this advisory-only scope).
const possibleConflictThreshold = 0.55;
const possibleConflictMinLength = 6;
const maxSurfacedConflicts = 3;

function isPossibleConflictContent(normalizedContent: string, existingContent: string) {
  const normalizedExisting = normalizeContentForSimilarity(existingContent);
  if (normalizedContent.length < possibleConflictMinLength || normalizedExisting.length < possibleConflictMinLength) return false;
  return bigramDiceCoefficient(normalizedContent, normalizedExisting) >= possibleConflictThreshold;
}

function bigramDiceCoefficient(a: string, b: string) {
  const bigramsA = countBigrams(a);
  const bigramsB = countBigrams(b);
  let total = 0;
  let shared = 0;
  for (const count of bigramsA.values()) total += count;
  for (const [bigram, count] of bigramsB) {
    total += count;
    shared += Math.min(bigramsA.get(bigram) || 0, count);
  }
  return total === 0 ? 0 : (2 * shared) / total;
}

function countBigrams(value: string) {
  const bigrams = new Map<string, number>();
  for (let i = 0; i < value.length - 1; i += 1) {
    const bigram = value.slice(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
  }
  return bigrams;
}

function normalizeSearchQuery(value: string) {
  return String(value || "").trim();
}

function clampLimit(limit = 10) {
  return Math.min(50, Math.max(0, Math.floor(limit)));
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toMemoryV2Item(row: Record<string, unknown>): MemoryV2Item {
  return {
    id: Number(row.id),
    type: validateType(String(row.type)),
    category: validateCategory(String(row.category || "general")),
    domain: row.domain === null || row.domain === undefined || row.domain === "" ? null : validateDomain(String(row.domain)),
    tag: row.tag === null || row.tag === undefined || row.tag === "" ? null : String(row.tag),
    status: validateStatus(String(row.status || "active")),
    superseded_by: row.superseded_by === null || row.superseded_by === undefined ? null : Number(row.superseded_by),
    superseded_at: row.superseded_at === null || row.superseded_at === undefined ? null : String(row.superseded_at),
    content: String(row.content),
    source: validateSource(String(row.source)),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    deleted_at: row.deleted_at === null ? null : String(row.deleted_at),
  };
}
