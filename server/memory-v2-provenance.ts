import type { MemoryV2Category, MemoryV2Domain, MemoryV2Item, MemoryV2Type } from "./memory-v2-types.ts";
import type { RuntimeMode } from "./types.ts";

// Retrieval auditability v1 (memory-evolution/00-audit spec).
// A provenance record never copies memory content: ids, desensitized
// descriptors, scores and reason codes only.

export type MemoryProvenanceLane = "keyword" | "vector" | "pinned" | "recent";

export type MemoryProvenanceStatus =
  | "injected"
  | "isolated"
  | "budget_dropped"
  | "not_recalled"
  | "superseded"
  | "deleted"
  | "never_stored";

// One-to-one with the real filter sites in the retrieval pipeline.
export type MemoryProvenanceReasonCode =
  | "injected_brief"
  | "injected_self_anchor"
  | "iso_room_work"
  | "iso_category_choke"
  | "iso_category_lane"
  | "iso_night_lane"
  | "iso_reflection_retired"
  | "drop_budget_charcap"
  | "drop_budget_layer"
  | "drop_anchor_diversity"
  | "filtered_superseded"
  | "filtered_deleted"
  | "not_recalled"
  | "never_stored";

export type MemoryProvenanceItem = {
  memory_id: number;
  category: MemoryV2Category;
  type: MemoryV2Type;
  domain: MemoryV2Domain | null;
  tag: string | null;
  lanes: MemoryProvenanceLane[];
  keyword_rank: number | null;
  vector_score: number | null;
  vector_rank: number | null;
  fusion_score: number | null;
  fused_rank: number | null;
  status: MemoryProvenanceStatus;
  reason_code: MemoryProvenanceReasonCode;
  superseded_by: number | null;
  superseded_at: string | null;
};

export type MemoryRetrievalSummary = {
  mode: RuntimeMode;
  exclude_private_category: boolean;
  vector_lane_enabled: boolean;
  candidates_total: number;
  injected_total: number;
  excluded_by_room: number;
  excluded_by_category: number;
  excluded_by_night_lane: number;
  dropped_by_budget_charcap: number;
  dropped_by_budget_layer: boolean;
  superseded_filtered: number;
  self_anchor_count: number;
};

export type MemoryRetrievalProvenance = {
  summary: MemoryRetrievalSummary;
  items: MemoryProvenanceItem[];
};

type ProvenanceBuildInput = {
  input: {
    mode: RuntimeMode;
    excludePrivateCategory?: boolean;
    queryVector?: number[];
  };
  candidates: MemoryV2Item[];
  injectable: MemoryV2Item[];
  injected: MemoryV2Item[];
  pinnedIds: number[];
  keywordItems: MemoryV2Item[];
  semanticHits: Array<{ memoryId: number; score: number }>;
  fusedScored: Array<{ id: number; score: number }>;
  recentItems: MemoryV2Item[];
  nightReflectionIds: Set<number>;
  fusedLimit: number;
};

// Assembles request-scoped provenance from retrieval intermediates. It reads only
// what selection already produced, so it can never change ranking or injection.
export function buildMemoryProvenance(args: ProvenanceBuildInput): MemoryRetrievalProvenance {
  const pinnedIdSet = new Set(args.pinnedIds);
  const recentIdSet = new Set(args.recentItems.map((item) => item.id));
  const keywordRank = new Map(args.keywordItems.map((item, index) => [item.id, index]));
  const vectorScore = new Map(args.semanticHits.map((hit) => [hit.memoryId, hit.score]));
  const vectorRank = new Map(args.semanticHits.map((hit, index) => [hit.memoryId, index]));
  const fusionScore = new Map(args.fusedScored.map((entry) => [entry.id, entry.score]));
  const fusedRank = new Map(args.fusedScored.slice(0, args.fusedLimit).map((entry, index) => [entry.id, index]));
  const injectedIds = new Set(args.injected.map((item) => item.id));
  const injectableIds = new Set(args.injectable.map((item) => item.id));

  const items: MemoryProvenanceItem[] = args.candidates.map((item) => {
    const lanes: MemoryProvenanceLane[] = [];
    if (pinnedIdSet.has(item.id)) lanes.push("pinned");
    if (keywordRank.has(item.id)) lanes.push("keyword");
    if (vectorScore.has(item.id)) lanes.push("vector");
    if (recentIdSet.has(item.id)) lanes.push("recent");

    let status: MemoryProvenanceStatus;
    let reasonCode: MemoryProvenanceReasonCode;
    if (injectedIds.has(item.id)) {
      status = "injected";
      reasonCode = "injected_brief";
    } else if (!injectableIds.has(item.id)) {
      // Night filtering runs before the private choke, so night wins attribution
      // when both isolation rules apply.
      status = "isolated";
      reasonCode = args.nightReflectionIds.has(item.id) ? "iso_night_lane" : "iso_category_choke";
    } else {
      status = "budget_dropped";
      reasonCode = "drop_budget_charcap";
    }

    return {
      memory_id: item.id,
      category: item.category,
      type: item.type,
      domain: item.domain,
      tag: item.tag,
      lanes,
      keyword_rank: keywordRank.get(item.id) ?? null,
      vector_score: vectorScore.get(item.id) ?? null,
      vector_rank: vectorRank.get(item.id) ?? null,
      fusion_score: fusionScore.get(item.id) ?? null,
      fused_rank: fusedRank.get(item.id) ?? null,
      status,
      reason_code: reasonCode,
      superseded_by: item.superseded_by,
      superseded_at: item.superseded_at,
    };
  });

  const summary: MemoryRetrievalSummary = {
    mode: args.input.mode,
    exclude_private_category: args.input.excludePrivateCategory ?? false,
    vector_lane_enabled: Boolean(args.input.queryVector?.length),
    candidates_total: args.candidates.length,
    injected_total: args.injected.length,
    // The work-room early return never reaches this builder.
    excluded_by_room: 0,
    excluded_by_category: items.filter((item) => item.reason_code === "iso_category_choke").length,
    excluded_by_night_lane: items.filter((item) => item.reason_code === "iso_night_lane").length,
    dropped_by_budget_charcap: items.filter((item) => item.reason_code === "drop_budget_charcap").length,
    // Layer eviction is reconciled later at the debug surface.
    dropped_by_budget_layer: false,
    // Superseded rows are filtered in SQL and never fetched; do not fabricate.
    superseded_filtered: 0,
    self_anchor_count: 0, // Retained for readers of historical audit payloads.
  };

  return { summary, items };
}
