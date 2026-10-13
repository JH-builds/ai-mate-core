import type { RuntimeMode } from "./types.ts";
import type { TodayContext } from "./today-context-types.ts";
import { createTodayContextService, getDefaultTodayContextScopeId } from "./today-context-service.ts";
import { getTodayContextDatabasePath, type TodayContextDatabase } from "./today-context-store.ts";
import { readDatabaseSnapshot } from "./data-store.ts";

export type TodayContextRetrieval = {
  context: TodayContext | null;
  content: string;
  chars: number;
};

export function retrieveTodayContext(input: {
  mode: RuntimeMode;
  updateNotice?: string;
  now?: Date;
  database?: TodayContextDatabase;
}): TodayContextRetrieval {
  if (input.mode !== "default") return emptyTodayContext();
  const date = todayDateKey(input.now || new Date());
  try {
    const read = (database: TodayContextDatabase) => createTodayContextService(database).getContext(getDefaultTodayContextScopeId(), date);
    const snapshot = input.database
      ? { status: "ready" as const, data: read(input.database) }
      : readDatabaseSnapshot(getTodayContextDatabasePath(), read);
    if (snapshot.status === "unavailable") {
      console.warn("today_context_retrieve_failed", "database_unavailable");
      return emptyTodayContext();
    }
    const context = snapshot.data;
    if (!context?.summary.trim()) return emptyTodayContext(context);
    const content = [
      "## Today Context / 今日工作记忆",
      `今天仍可能成立的情境：${context.summary.trim()}`,
      input.updateNotice ?? "这些是短期情境，不等于长期事实；若用户明确更新，以当前对话为准。",
    ].join("\n");
    return { context, content, chars: content.length };
  } catch (error) {
    console.warn("today_context_retrieve_failed", error instanceof Error ? error.message : String(error || "unknown_error"));
    return emptyTodayContext();
  }
}

export function todayDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function emptyTodayContext(context: TodayContext | null = null): TodayContextRetrieval {
  return { context, content: "", chars: 0 };
}
