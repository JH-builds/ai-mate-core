import type { MemoryV2Item } from "./memory-v2-types.ts";
import type { TodayContext } from "./today-context-types.ts";
import type { ContinuationStateSource } from "./continuation-context.ts";

type CorePromptDocument = { id: string; title: string; content: string; outboundEligible?: true };

// The four common sources own their presentation and length policy. Web uses
// whole optional documents, then arbitrates its combined peripheral budget;
// external v1 uses bounded evidence fields and never inherits that total budget.
const promptDocs = {
  persona: { id: "identity", title: "Identity base", outboundEligible: true as const },
  memory: { id: "memory-v2", title: "Related memories" },
  today: { id: "today-context", title: "Today Context / 今日工作记忆" },
  continuation: { id: "continuation-v1", title: "Conversation Continuation / 对话延续" },
};

export const coreContextOutput = {
  persona: {
    maxBytes: 24000,
    prompt(content: string): CorePromptDocument {
      return { id: promptDocs.persona.id, title: promptDocs.persona.title, content, outboundEligible: promptDocs.persona.outboundEligible };
    },
    evidence(document: { source: string; version: string; content: string }) {
      return { status: "ready" as const, ...document };
    },
  },
  memory: {
    doc: promptDocs.memory,
    recall: { limit: 6, charBudget: 2400 },
    sourceChars: 6000,
    eviction: { priority: 110, reason: "explicit_retrieval_memory" },
    prompt(content: string, title = promptDocs.memory.title): CorePromptDocument[] { return optionalDoc({ ...promptDocs.memory, title, content }); },
    evidence(item: MemoryV2Item, purpose: "recall" | "source") {
      return {
        sourceRef: `memory:${item.id}`, recordType: item.type, recordState: item.status,
        truthStatus: item.type === "fact" ? "stored_fact_not_independent_verification" : `historical_${item.type}`,
        source: item.source, category: item.category, domain: item.domain,
        createdAt: item.created_at, updatedAt: item.updated_at,
        ...boundedContent(item.content, purpose === "recall" ? coreContextOutput.memory.recall.charBudget : coreContextOutput.memory.sourceChars),
      };
    },
  },
  today: {
    doc: promptDocs.today,
    chars: 1600,
    eviction: { priority: 90, reason: "generic_today_context" },
    prompt(content: string): CorePromptDocument[] { return optionalDoc({ ...promptDocs.today, content }); },
    evidence(item: TodayContext | null) {
      return item ? {
        sourceRef: `today:${item.date}:${item.id}`, date: item.date, updatedAt: item.updated_at,
        truthStatus: "derived_current_day_summary", ...boundedContent(item.summary, coreContextOutput.today.chars),
      } : null;
    },
  },
  continuation: {
    doc: promptDocs.continuation,
    fileMaxBytes: 16384,
    storedItemsMax: 30,
    itemCount: 6,
    itemChars: 120,
    sourceIdCount: 8,
    eviction: { priority: 50, reason: "signed_order:continuation" },
    prompt(content: string): CorePromptDocument[] { return optionalDoc({ ...promptDocs.continuation, content }); },
    evidence(card: ContinuationStateSource, items: ContinuationStateSource["items"]) {
      return {
        status: "ready" as const, truthStatus: "temporary_conversation_bridge", updatedAt: card.updatedAt,
        items: items.slice(0, coreContextOutput.continuation.itemCount).map(item => ({
          ...boundedContent(item.text, coreContextOutput.continuation.itemChars),
          sourceMessageIds: item.sourceMessageIds.slice(0, coreContextOutput.continuation.sourceIdCount),
          supportedAt: item.supportedAt || card.updatedAt,
        })),
      };
    },
  },
};

function optionalDoc(doc: CorePromptDocument): CorePromptDocument[] { return doc.content ? [doc] : []; }
function boundedContent(content: string, limit: number) {
  return { content: content.slice(0, limit), truncated: content.length > limit };
}
