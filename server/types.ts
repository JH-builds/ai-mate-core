export type RuntimeMode = "default" | "work";

export type JsonLine = Record<string, any>;

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonLine;
  };
};

export type ChatToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatTextContentBlock = {
  type: "text";
  text: string;
};

export type ChatImageContentBlock = {
  type: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  dataUrl: string;
  name?: string;
  size?: number;
};

export type ChatContentBlock = ChatTextContentBlock | ChatImageContentBlock;

export type ChatMessage = {
  role: string;
  content: string | null;
  contentBlocks?: ChatContentBlock[];
  promptCacheBreakpoint?: true;
  responsesOutputItems?: JsonLine[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: ChatToolCall[];
};

export type ModelResult = {
  provider: string;
  model: string;
  requestedModel: string;
  actualModel: string;
  reply: string;
  finishReason?: string;
  emptyModelContent: boolean;
  fallbackUsed: boolean;
  fallbackModel?: string;
  providerErrorType?: ProviderErrorType;
  providerBlockedSignal?: string;
  providerStatusCode?: number;
  providerRequestId?: string;
  latencyMs?: number;
  usage?: unknown;
  responseContentType?: string;
  responseBodyKind?: ProviderResponseBodyKind;
  sseChunkCount?: number;
  sseContentChars?: number;
  retryCount?: number;
  providerAttempts?: ProviderAttemptSummary[];
  toolCalls?: ChatToolCall[];
  responsesOutputItems?: JsonLine[];
  reasoningSummary?: string;
};

export type ChatCompletionResponse = {
  id?: string;
  model?: string;
  usage?: unknown;
  choices?: Array<{
    finish_reason?: string;
    finishReason?: string;
    message?: { content?: unknown; tool_calls?: ChatToolCall[]; toolCalls?: ChatToolCall[] };
    delta?: { content?: unknown; tool_calls?: ChatToolCall[]; toolCalls?: ChatToolCall[] };
    text?: string;
  }>;
};

export type ProviderErrorType = "blocked" | "empty_content" | "network_error" | "non_2xx" | "provider_error" | "timeout" | "parse_error" | "missing_key" | "unknown";
export type ProviderResponseBodyKind = "empty" | "html" | "json" | "json_like" | "sse" | "plain_text" | "text" | "unknown";

export type ProviderAttemptSummary = {
  // Provider-local attempt/retry index. The persisted array order is the
  // authoritative order across provider and tool-round calls.
  attempt: number;
  provider?: string;
  baseHost?: string;
  model?: string;
  providerErrorType?: ProviderErrorType | null;
  skipped?: boolean;
  skipReason?: string;
  providerStatusCode?: number;
  providerDurationMs?: number;
  providerRequestId?: string;
  responseContentType?: string;
  responseBodyLength?: number;
  responseBodyKind?: ProviderResponseBodyKind;
  responseBodyPrefixSafe?: string;
  parseErrorMessage?: string;
  sseChunkCount?: number;
  sseContentChars?: number;
};

export type ProviderErrorSummary = {
  providerErrorType: ProviderErrorType;
  providerBlockedSignal?: string;
  providerStatusCode?: number;
  providerDurationMs?: number;
  providerRequestId?: string;
  providerName?: string;
  providerMode?: string;
  responseContentType?: string;
  responseBodyLength?: number;
  responseBodyKind?: ProviderResponseBodyKind;
  responseBodyPrefixSafe?: string;
  parseErrorMessage?: string;
  sseChunkCount?: number;
  sseContentChars?: number;
  retryCount?: number;
  providerAttempts?: ProviderAttemptSummary[];
};

export type MemoryEntry = JsonLine & {
  id?: string;
  category?: string;
  key?: string;
  value?: string;
  text?: string;
  priority?: string;
  status?: string;
};

export type ConversationEntry = JsonLine & {
  id?: string;
  role?: string;
  content?: string;
  // "redacted": kept in the file (原文留底) but excluded from every reader —
  // model history, proactive context, and the app UI (2026-07-11 incident).
  status?: "pending" | "complete" | "error" | "redacted";
  meta?: JsonLine;
};

export type CapabilityContext = Record<string, {
  available: boolean;
  detail: string;
}>;

export type Reminder = JsonLine & {
  id: string;
  due_at: string;
  type: string;
  payload: JsonLine;
  todayItem?: { userId: string; todoId: string };
  status: "pending" | "processing" | "done" | "error" | "cancelled";
  created_at: string;
  updated_at: string;
  error?: string;
};

export type ReminderUpdate = Partial<Pick<Reminder, "due_at" | "type" | "payload">>;

export type ReminderState = {
  version: number;
  updatedAt: string;
  reminders: Reminder[];
};
