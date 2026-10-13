import type { MemoryV2Database } from "./memory-v2-store.ts";
import type { ReflectionObservationMetaInput } from "./memory-v2-types.ts";

// Preserve historical exclusions even if a record later changes type.
// Eligible reflection rows use ordinary memory retrieval, not a persona lane.
export function runtimeEligibleReflectionClause(memoryReference: string) {
  return `NOT EXISTS (
    SELECT 1 FROM reflection_meta rm
    WHERE rm.memory_id = ${memoryReference}.id
      AND rm.runtime_eligibility = 'excluded'
  )`;
}

export function listRuntimeIneligibleReflectionMemoryIds(database: MemoryV2Database): Set<number> {
  const rows = database.prepare("SELECT memory_id FROM reflection_meta WHERE runtime_eligibility = 'excluded'").all();
  return new Set(rows.map(row => Number(row.memory_id)));
}

export function insertReflectionObservationMeta(
  database: MemoryV2Database,
  memoryId: number,
  input: ReflectionObservationMetaInput,
) {
  database
    .prepare(`
      INSERT INTO reflection_meta (
        memory_id, origin, claimed_status, runtime_eligibility, created_at, review_note, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      memoryId,
      input.origin,
      input.claimedStatus,
      input.runtimeEligibility,
      input.createdAt || new Date().toISOString(),
      input.reviewNote ?? null,
      input.reviewedAt ?? null,
    );
}
