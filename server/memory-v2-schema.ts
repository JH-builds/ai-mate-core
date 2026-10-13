export const memoryV2MigrationId = "002_memory_v2_init";
export const memoryV2CategoryMigrationId = "003_memory_v2_category";
export const memoryV2LifecycleMigrationId = "004_memory_v2_lifecycle";
export const memoryV2ReflectionMetaMigrationId = "005_reflection_meta";
export const memoryV2ReflectionTruthMigrationId = "006_reflection_truth_status";
export const memoryV2ReflectionReviewMigrationId = "007_reflection_review_result";
export const memoryV2PrivateAnchorMigrationId = "008_private_memory_anchors";

export const memoryV2SchemaSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('fact', 'observation', 'reflection', 'event')),
  category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'private')),
  domain TEXT CHECK (domain IN ('relationship', 'life', 'work', 'private_world', 'self', 'other')),
  tag TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  superseded_by INTEGER REFERENCES memories(id),
  superseded_at TEXT,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'migration', 'extraction')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  type,
  content='memories',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO memories_fts(rowid, content, type)
  VALUES (new.id, new.content, new.type);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories
WHEN old.deleted_at IS NULL
BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, type)
  VALUES ('delete', old.id, old.content, old.type);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories
BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, type)
  SELECT 'delete', old.id, old.content, old.type
  WHERE old.deleted_at IS NULL;

  INSERT INTO memories_fts(rowid, content, type)
  SELECT new.id, new.content, new.type
  WHERE new.deleted_at IS NULL;
END;

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_superseded_by ON memories(superseded_by);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_deleted_at ON memories(deleted_at);
`;

export const memoryV2CategoryMigrationSql = `
ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'private'));
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
`;

// Sidecar table for nightly reflection entries; the initial version
// wrote pure defaults into the reserved
// organization columns. The later low-frequency organizer may fill review
// status and an abstract possible tendency while preserving the original row.
// A reflection_meta row also marks its memories row as night-lane (initially the
// only writer), which is what keeps those bodies out of normal retrieval.
export const memoryV2ReflectionMetaSql = `
CREATE TABLE IF NOT EXISTS reflection_meta (
  memory_id INTEGER PRIMARY KEY REFERENCES memories(id),
  candidate_tags TEXT,
  possible_tendency TEXT,
  counter_evidence TEXT,
  applies_when TEXT,
  does_not_apply_when TEXT,
  identity_candidate_proposed INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reflection_meta_needs_review ON reflection_meta(needs_review);
`;

// Self-observation truth status. Existing reflection_meta rows are all
// nightly-review originals, so these defaults faithfully classify old data.
// Ordinary legacy reflections have no sidecar row and remain readable until
// the separate legacy-review queue gives them a more precise status.
export const memoryV2ReflectionTruthSql = `
ALTER TABLE reflection_meta ADD COLUMN origin TEXT NOT NULL DEFAULT 'nightly_review'
  CHECK (origin IN ('chat', 'nightly_review', 'legacy'));
ALTER TABLE reflection_meta ADD COLUMN claimed_status TEXT NOT NULL DEFAULT 'raw'
  CHECK (claimed_status IN ('raw', 'claimed', 'unreviewed', 'uncertain', 'not_claimed', 'withdrawn', 'archived'));
ALTER TABLE reflection_meta ADD COLUMN runtime_eligibility TEXT NOT NULL DEFAULT 'excluded'
  CHECK (runtime_eligibility IN ('eligible', 'excluded'));
CREATE INDEX IF NOT EXISTS idx_reflection_meta_runtime_eligibility ON reflection_meta(runtime_eligibility);
`;

export const memoryV2LifecycleMigrationSql = `
ALTER TABLE memories ADD COLUMN domain TEXT CHECK (domain IN ('relationship', 'life', 'work', 'private_world', 'self', 'other'));
ALTER TABLE memories ADD COLUMN tag TEXT;
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded'));
ALTER TABLE memories ADD COLUMN superseded_by INTEGER REFERENCES memories(id);
ALTER TABLE memories ADD COLUMN superseded_at TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_superseded_by ON memories(superseded_by);
`;

// Explicit private anchor membership is an id list, never inferred from
// tags, frequency, or retrieval score. Existing storage names stay compatible.
export const memoryV2PrivateAnchorSql = `
CREATE TABLE IF NOT EXISTS private_memory_anchors (
  memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  anchored_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_private_memory_anchors_anchored_at
  ON private_memory_anchors(anchored_at);

CREATE TRIGGER IF NOT EXISTS private_memory_anchors_cleanup
AFTER UPDATE OF category, status, deleted_at ON memories
WHEN new.category != 'private' OR new.status != 'active' OR new.deleted_at IS NOT NULL
BEGIN
  DELETE FROM private_memory_anchors WHERE memory_id = new.id;
END;
`;
