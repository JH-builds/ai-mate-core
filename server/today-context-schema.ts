export const todayContextMigrationId = "today_context_v1";

export const todayContextSchemaSql = `
CREATE TABLE IF NOT EXISTS today_contexts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  date TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope_id, date)
);

CREATE INDEX IF NOT EXISTS idx_today_contexts_scope_date
  ON today_contexts(scope_id, date);
`;

export const todayContextStateMigrationId = "today_context_state_v1";

export const todayContextStateSchemaSql = `
CREATE TABLE IF NOT EXISTS today_context_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const todayEventsMigrationId = "today_events_v1";

export const todayEventsSchemaSql = `
CREATE TABLE IF NOT EXISTS today_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  date TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  salience INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  closed_by_event_id INTEGER REFERENCES today_events(id),
  source TEXT NOT NULL DEFAULT 'conversation',
  intimacy TEXT NOT NULL DEFAULT 'none'
);

CREATE INDEX IF NOT EXISTS idx_today_events_scope_date_effective
  ON today_events(scope_id, date, effective_at, id);

CREATE INDEX IF NOT EXISTS idx_today_events_scope_status
  ON today_events(scope_id, status);
`;

export const todayContextAdmissionMigrationId = "today_context_admission_v1";

export const todayContextAdmissionSchemaSql = `
ALTER TABLE today_contexts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE today_context_pending_turns (
  scope_id TEXT NOT NULL,
  date TEXT NOT NULL,
  source_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  conflicted INTEGER NOT NULL DEFAULT 0 CHECK (conflicted IN (0, 1)),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(scope_id, date, source_key)
);
`;

export const todayContextFoldMigrationId = "today_context_fold_v1";
export const todayContextFoldSchemaSql = `
CREATE TABLE today_context_folds (
  scope_id TEXT NOT NULL,
  date TEXT NOT NULL,
  version INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  policy TEXT NOT NULL,
  sources TEXT NOT NULL,
  summary TEXT NOT NULL,
  published INTEGER NOT NULL CHECK (published IN (0, 1)),
  attempted_at TEXT NOT NULL,
  PRIMARY KEY(scope_id, date)
);
`;

export const todayContextFragmentMigrationId = "today_context_fragment_v1";
export const todayContextFragmentSchemaSql = `
ALTER TABLE today_context_folds ADD COLUMN partial TEXT;
`;
