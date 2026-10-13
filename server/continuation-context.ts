import { readRuntimeFeatureFlag } from "./runtime-feature-store.ts";
import { readJson } from "./data-store.ts";
import type { RuntimeMode } from "./types.ts";

export const continuationCardPath = "continuation/apiv2-card.json";
export const continuationMaxItems = 6;

export type ContinuationV1Item = {
  text: string;
  sourceMessageIds: string[];
  supportedAt?: string;
};

export type ContinuationStateSource = {
  updatedAt: string;
  privateReadScope?: boolean;
  items: ContinuationV1Item[];
};
export type ContinuationV1Card = ContinuationStateSource;

export function readContinuationMaxAgeMinutes() {
  const raw = process.env.API_V2_CONTINUATION_MAX_AGE_MINUTES;
  const value = Number(raw === undefined || raw === "" ? 1440 : raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1440;
}

export function activeContinuationItems(
  card: ContinuationStateSource | null | undefined,
  now = new Date(),
  maxAgeMinutes = readContinuationMaxAgeMinutes(),
) {
  if (!card?.items.length) return [];
  return card.items.filter((item) => {
    const ageMs = now.getTime() - Date.parse(item.supportedAt || card.updatedAt);
    return Number.isFinite(ageMs) && ageMs <= maxAgeMinutes * 60_000;
  });
}

export type ContinuationContextRetrieval = {
  enabled: boolean;
  content: string;
  card?: ContinuationV1Card;
};

export function isContinuationEnabled(): boolean {
  return readRuntimeFeatureFlag("continuation", "API_V2_CONTINUATION_ENABLED");
}

export async function retrieveContinuationContext(input: {
  mode: RuntimeMode;
  now?: Date;
  visibleSourceMessageIds?: string[];
  excludePrivate?: boolean;
  preamble?: readonly string[];
}): Promise<ContinuationContextRetrieval> {
  if (input.mode !== "default" || !isContinuationEnabled()) {
    return { enabled: false, content: "" };
  }
  const stored = await readJson<ContinuationV1Card | null>(continuationCardPath, null);
  const card = stored ? publicContinuationCard(stored) : null;
  if (!card || !card.items.length) {
    return { enabled: true, content: "" };
  }
  if (input.excludePrivate && card.privateReadScope === true) return { enabled: true, content: "" };
  const now = input.now || new Date();
  const activeItems = activeContinuationItems(card, now, readContinuationMaxAgeMinutes());
  if (!activeItems.length) {
    return { enabled: true, content: "", card };
  }
  const visibleSourceMessageIds = new Set(input.visibleSourceMessageIds || []);
  const items = visibleSourceMessageIds.size === 0
    ? activeItems
    : activeItems.filter((item) => (
      item.sourceMessageIds.length === 0
      || item.sourceMessageIds.some((id) => !visibleSourceMessageIds.has(id))
    ));
  return {
    enabled: true,
    content: formatContinuationContext({ ...card, items }, input.preamble),
    card,
  };
}

export function formatContinuationContext(card: ContinuationV1Card | null | undefined, preamble?: readonly string[]): string {
  if (!card?.items.length) return "";
  const lines = card.items.slice(0, continuationMaxItems).map((item) => `- ${item.text}`);
  return [
    ...(preamble ?? [
      "最近对话里仍然悬着的线索。不是记忆，不是待办，也不是今天的日程。",
      "不要主动复述这个清单；只在用户的话和某条线索明确同题时才自然接上，像你本来就没忘一样。",
      "词面沾边不算相关：不要因为一个词相似就把用户的新话题往旧线索上牵——牵错一次，后面会越接越歪。拿不准相关性时，当这条线索不存在。",
    ]),
    "",
    ...lines,
  ].join("\n");
}

export function publicContinuationCard(card: ContinuationV1Card): ContinuationV1Card {
  return { updatedAt: card.updatedAt, items: card.items, ...(card.privateReadScope ? { privateReadScope: true } : {}) };
}
