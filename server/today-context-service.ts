import type { TodayContextDatabase } from "./today-context-store.ts";
import type {
  TodayContext,
  TodayContextStateEntry,
  UpsertTodayContextInput,
} from "./today-context-types.ts";

const defaultScopeId = "main";
// Hashes of the persisted message IDs and their source content, not a second
// copy of private chat text. This is a turn receipt, not a source-order watermark.
export type TodayContextTurnSource = { key: string; fingerprint: string; privateReadScope?: boolean };
export type TodaySummaryPartial = { source: TodayContextTurnSource; offset: number };

export type TodaySummaryFold = {
  version: number;
  baseRevision: number;
  sources: TodayContextTurnSource[];
  summary: string;
  partial: TodaySummaryPartial | null;
};

export function isTodaySourcePrefix(prefix: TodayContextTurnSource[], sources: TodayContextTurnSource[]) {
  return prefix.length <= sources.length && prefix.every((source, i) =>
    source.key === sources[i].key && source.fingerprint === sources[i].fingerprint
    && (source.privateReadScope === true) === (sources[i].privateReadScope === true));
}

export class TodayContextService {
  constructor(private readonly database: TodayContextDatabase) {}

  getContext(scopeId: string, date: string) {
    const row = this.database
      .prepare("SELECT * FROM today_contexts WHERE scope_id = ? AND date = ?")
      .get(normalizeScopeId(scopeId), normalizeDateKey(date));
    return row ? toTodayContext(row) : null;
  }

  // One row read binds the memo to its internal version. Do not expose the
  // version as a source-order watermark or add it to the public context DTO.
  getSummarySnapshot(scopeId: string, date: string) {
    const row = this.database.prepare("SELECT * FROM today_contexts WHERE scope_id = ? AND date = ?")
      .get(normalizeScopeId(scopeId), normalizeDateKey(date));
    return { context: row ? toTodayContext(row) : null, revision: row ? Number(row.revision) : 0 };
  }

  getOrCreateContext(scopeId: string, date: string, now = new Date()) {
    const normalizedScopeId = normalizeScopeId(scopeId);
    const normalizedDate = normalizeDateKey(date);
    const existing = this.getContext(normalizedScopeId, normalizedDate);
    if (existing) return existing;

    const timestamp = now.toISOString();
    this.database
      .prepare(`
        INSERT INTO today_contexts (scope_id, date, summary, created_at, updated_at)
        VALUES (?, ?, '', ?, ?)
        ON CONFLICT(scope_id, date) DO NOTHING
      `)
      .run(normalizedScopeId, normalizedDate, timestamp, timestamp);
    return this.requireContext(normalizedScopeId, normalizedDate);
  }

  getPreviousContext(scopeId: string, beforeDate: string) {
    const row = this.database
      .prepare(`
        SELECT *
        FROM today_contexts
        WHERE scope_id = ?
          AND date < ?
          AND summary <> ''
        ORDER BY date DESC
        LIMIT 1
      `)
      .get(normalizeScopeId(scopeId), normalizeDateKey(beforeDate));
    return row ? toTodayContext(row) : null;
  }

  upsertSummary(input: UpsertTodayContextInput) {
    const scopeId = normalizeScopeId(input.scope_id);
    const date = normalizeDateKey(input.date);
    const summary = normalizeSummary(input.summary);
    const timestamp = (input.now || new Date()).toISOString();
    this.database
      .prepare(`
        INSERT INTO today_contexts (scope_id, date, summary, created_at, updated_at, revision)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(scope_id, date)
        DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at, revision = today_contexts.revision + 1
      `)
      .run(scopeId, date, summary, timestamp, timestamp);
    return this.requireContext(scopeId, date);
  }

  getAppliedTurnStatus(scopeId: string, date: string, source: TodayContextTurnSource) {
    const receipt = this.getState(`summary_turn:${normalizeScopeId(scopeId)}:${normalizeDateKey(date)}:${source.key}`);
    if (!receipt) return null;
    return receipt.value === source.fingerprint ? "already_applied" as const : "source_changed" as const;
  }

  // Admission stores only source identity/version, never a second private
  // transcript. It precedes cooldown/model work; it does not schedule a replay.
  registerTurn(scopeId: string, date: string, source: TodayContextTurnSource, now = new Date()) {
    scopeId = normalizeScopeId(scopeId);
    date = normalizeDateKey(date);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const applied = this.getAppliedTurnStatus(scopeId, date, source);
      if (applied) {
        this.database.exec("COMMIT");
        return applied;
      }
      this.database.prepare(`INSERT INTO today_context_pending_turns (scope_id, date, source_key, fingerprint, accepted_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope_id, date, source_key) DO NOTHING`)
        .run(scopeId, date, source.key, source.fingerprint, now.toISOString());
      this.database.prepare("UPDATE today_context_pending_turns SET conflicted = 1 WHERE scope_id = ? AND date = ? AND source_key = ? AND fingerprint <> ?")
        .run(scopeId, date, source.key, source.fingerprint);
      const pending = this.database.prepare("SELECT fingerprint, conflicted FROM today_context_pending_turns WHERE scope_id = ? AND date = ? AND source_key = ?")
        .get(scopeId, date, source.key);
      this.database.exec("COMMIT");
      return pending?.fingerprint === source.fingerprint && !pending.conflicted ? null : "source_changed" as const;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getState(key: string) {
    const normalizedKey = normalizeStateKey(key);
    const row = this.database.prepare("SELECT * FROM today_context_state WHERE key = ?").get(normalizedKey);
    return row ? toTodayContextStateEntry(row) : null;
  }

  hasUnpublishedSummary(scopeId: string, date: string) {
    return Boolean(this.database.prepare("SELECT 1 FROM today_context_folds WHERE scope_id = ? AND date = ? AND published = 0")
      .get(normalizeScopeId(scopeId), normalizeDateKey(date)));
  }

  // Rotate persisted backlog dates, plus yesterday for a completion whose
  // after-turn admission never ran. Claim the scan even when its archive is
  // unavailable, so one broken date cannot monopolize every scheduler tick.
  claimSummaryRecoveryDay(scopeId: string, today: string, now: Date, retryMs: number, checkMs: number) {
    scopeId = normalizeScopeId(scopeId); today = normalizeDateKey(today);
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`WITH candidates AS (
        SELECT date, 1 AS unfinished FROM today_context_folds WHERE scope_id = ? AND published = 0
        UNION ALL SELECT date, 1 FROM today_context_pending_turns WHERE scope_id = ? AND conflicted = 0
        UNION ALL SELECT ?, 0
      ), dates AS (SELECT date, MAX(unfinished) AS unfinished FROM candidates WHERE date < ? GROUP BY date)
      SELECT d.date FROM dates d LEFT JOIN today_context_state s ON s.key = 'summary_recovery:' || ? || ':' || d.date
      WHERE s.updated_at IS NULL OR s.updated_at <= CASE WHEN d.unfinished = 1 THEN ? ELSE ? END
      ORDER BY COALESCE(s.updated_at, ''), d.date LIMIT 1`)
        .get(scopeId, scopeId, yesterday, today, scopeId,
          new Date(now.getTime() - retryMs).toISOString(), new Date(now.getTime() - checkMs).toISOString());
      const date = row ? String(row.date) : null;
      if (date) this.setState(`summary_recovery:${scopeId}:${date}`, "attempted", now);
      this.database.exec("COMMIT");
      return date;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // Private checkpoint only. A legacy/public memo with unknown coverage is
  // never used as a replay base. Versions survive resets to fence late workers.
  claimSummaryFold(input: {
    scope_id: string; date: string; sources: TodayContextTurnSource[];
    policy: string; now: Date; intervalMs: number;
  }): { reason: "already_applied" | "not_due" | "no_sources" } | { fold: TodaySummaryFold } {
    const scopeId = normalizeScopeId(input.scope_id), date = normalizeDateKey(input.date);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM today_context_folds WHERE scope_id = ? AND date = ?").get(scopeId, date);
      if (!row && !input.sources.length) {
        this.database.exec("COMMIT");
        return { reason: "no_sources" };
      }
      this.getOrCreateContext(scopeId, date, input.now);
      const snapshot = this.getSummarySnapshot(scopeId, date);
      const sources = row ? JSON.parse(String(row.sources)) as TodayContextTurnSource[] : [];
      const partial = row?.partial ? JSON.parse(String(row.partial)) as TodaySummaryPartial : null;
      const reusable = row && Number(row.base_revision) === snapshot.revision
        && row.policy === input.policy && isTodaySourcePrefix(
          partial ? [...sources, partial.source] : sources, input.sources);
      if (reusable && row.published && sources.length === input.sources.length) {
        this.database.exec("COMMIT");
        return { reason: "already_applied" };
      }
      // Attempts, including failures and unpublished chunks, share the same
      // budget. Public.updated_at cannot rate-limit a private rebuild.
      if (row && Date.parse(String(row.attempted_at)) + input.intervalMs > input.now.getTime()) {
        this.database.exec("COMMIT");
        return { reason: "not_due" };
      }
      const fold: TodaySummaryFold = {
        version: Number(row?.version || 0) + 1, baseRevision: snapshot.revision,
        sources: reusable ? sources : [], summary: reusable ? String(row.summary) : "",
        partial: reusable ? partial : null,
      };
      this.database.prepare(`INSERT INTO today_context_folds
        (scope_id, date, version, base_revision, policy, sources, summary, published, attempted_at, partial)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(scope_id, date) DO UPDATE SET version = excluded.version, base_revision = excluded.base_revision,
          policy = excluded.policy, sources = excluded.sources,
          summary = excluded.summary, published = 0, attempted_at = excluded.attempted_at, partial = excluded.partial`)
        .run(scopeId, date, fold.version, fold.baseRevision, input.policy,
          JSON.stringify(fold.sources), fold.summary, input.now.toISOString(), fold.partial ? JSON.stringify(fold.partial) : null);
      this.database.exec("COMMIT");
      return { fold };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  saveSummaryFold(input: {
    scope_id: string; date: string; fold: TodaySummaryFold; sources: TodayContextTurnSource[];
    target: TodayContextTurnSource[]; summary: string; now: Date; partial: TodaySummaryPartial | null;
  }) {
    const scopeId = normalizeScopeId(input.scope_id), date = normalizeDateKey(input.date);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const snapshot = this.getSummarySnapshot(scopeId, date);
      const row = this.database.prepare("SELECT version FROM today_context_folds WHERE scope_id = ? AND date = ?").get(scopeId, date);
      if (snapshot.revision !== input.fold.baseRevision || Number(row?.version) !== input.fold.version) {
        this.database.exec("COMMIT");
        return { updated: false, reason: "summary_conflict", context: snapshot.context };
      }
      const covered = input.partial ? [...input.sources, input.partial.source] : input.sources;
      for (const source of covered) {
        const applied = this.getAppliedTurnStatus(scopeId, date, source);
        const pending = this.database.prepare("SELECT fingerprint, conflicted FROM today_context_pending_turns WHERE scope_id = ? AND date = ? AND source_key = ?")
          .get(scopeId, date, source.key);
        if (applied === "source_changed" || (!applied && (pending?.fingerprint !== source.fingerprint || pending.conflicted))) {
          this.database.exec("COMMIT");
          return { updated: false, reason: "source_changed", context: snapshot.context };
        }
      }
      if (!isTodaySourcePrefix(covered, input.target)) throw new Error("today_fold_prefix_mismatch");
      const complete = !input.partial && input.sources.length === input.target.length;
      const context = complete ? this.upsertSummary({ scope_id: scopeId, date, summary: input.summary, now: input.now }) : snapshot.context;
      if (complete) {
        for (const source of input.sources) {
          this.setState(`summary_turn:${scopeId}:${date}:${source.key}`, source.fingerprint, input.now);
          this.database.prepare("DELETE FROM today_context_pending_turns WHERE scope_id = ? AND date = ? AND source_key = ? AND fingerprint = ?")
            .run(scopeId, date, source.key, source.fingerprint);
        }
        this.setState(`last_updated:${scopeId}:${date}`, input.now.toISOString(), input.now);
        // Carryover skips empty summaries. Fence every derived day through the
        // first later nonempty context, including intervening empty drafts;
        // normal recovery rebuilds them without overwriting their public memo.
        if (snapshot.context?.summary !== normalizeSummary(input.summary)) {
          this.database.prepare(`UPDATE today_context_folds SET published = 0, version = version + 1
            WHERE scope_id = ? AND date > ? AND date <= COALESCE(
              (SELECT MIN(date) FROM today_contexts WHERE scope_id = ? AND date > ? AND summary <> ''), '9999-12-31')`)
            .run(scopeId, date, scopeId, date);
        }
      }
      this.database.prepare(`UPDATE today_context_folds SET version = version + 1, base_revision = ?,
        sources = ?, summary = ?, published = ?, partial = ? WHERE scope_id = ? AND date = ?`)
        .run(snapshot.revision + (complete ? 1 : 0), JSON.stringify(input.sources),
          normalizeSummary(input.summary), complete ? 1 : 0, input.partial ? JSON.stringify(input.partial) : null, scopeId, date);
      this.database.exec("COMMIT");
      return { updated: complete, reason: complete ? "published" : "draft_saved", context };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  setState(key: string, value: string | number, now = new Date()) {
    const normalizedKey = normalizeStateKey(key);
    const normalizedValue = normalizeStateValue(value);
    const updatedAt = now.toISOString();
    this.database
      .prepare(`
        INSERT INTO today_context_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(normalizedKey, normalizedValue, updatedAt);
    return this.getState(normalizedKey);
  }

  private requireContext(scopeId: string, date: string) {
    const context = this.getContext(scopeId, date);
    if (!context) throw new Error(`today_context_not_found:${scopeId}:${date}`);
    return context;
  }

}

export function createTodayContextService(database: TodayContextDatabase) {
  return new TodayContextService(database);
}

export function normalizeTodayContextSummary(value: string) {
  return normalizeSummary(value);
}

export function getDefaultTodayContextScopeId() {
  return defaultScopeId;
}

export function todayContextDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeScopeId(value: string) {
  const text = String(value || "").trim() || defaultScopeId;
  if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(text)) throw new Error(`invalid_today_context_scope:${value}`);
  return text;
}

function normalizeDateKey(value: string) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`invalid_today_context_date:${value}`);
  return text;
}

function normalizeSummary(value: string) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 1200);
}

function normalizeStateKey(value: string) {
  const text = String(value || "").trim();
  if (!/^[a-zA-Z0-9_.:-]{1,140}$/.test(text)) throw new Error(`invalid_today_context_state_key:${value}`);
  return text;
}

function normalizeStateValue(value: string | number) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("empty_today_context_state_value");
  if (text.length > 1200) throw new Error("today_context_state_value_too_long");
  return text;
}

function toTodayContext(row: Record<string, unknown>): TodayContext {
  return {
    id: Number(row.id),
    scope_id: String(row.scope_id || ""),
    date: String(row.date || ""),
    summary: String(row.summary || ""),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

function toTodayContextStateEntry(row: Record<string, unknown>): TodayContextStateEntry {
  return {
    key: String(row.key || ""),
    value: String(row.value || ""),
    updated_at: String(row.updated_at || ""),
  };
}
