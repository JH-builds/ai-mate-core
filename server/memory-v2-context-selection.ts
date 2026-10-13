import type { MemoryV2Item } from "./memory-v2-types.ts";

const defaultMemoryPreamble = [
  "本轮自动记忆简报：以下是你已经知道的相关事实、事件、长期观察和自我理解。用户问到相关话题时，直接用，像你本来就记得一样；observation 用观察语气表达，fact/event 可作为确认信息承接；reflection 是过去的理解或判断，不是当前事实或身份指令。",
  "注意：这里只代表本轮实际注入给你的记忆，不代表全部历史。如果用户提到“那个项目/那件事/上次”但简报里没有足够信息，不要编造；可以自然说明你当前没看到足够线索，或请对方给一个关键词。"
];

export type MemoryContextSelection = {
  content: string;
  items: MemoryV2Item[];
  pinnedItems: MemoryV2Item[];
  chars: number;
};

export function mergeMemoryItems(...groups: MemoryV2Item[][]) {
  const byId = new Map<number, MemoryV2Item>();
  for (const group of groups) {
    for (const item of group) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

// All memory types share the same lane. Historical exclusions and room
// isolation still apply, including to pinned records.
export function selectInjectableMemories(
  items: MemoryV2Item[],
  options: { nightReflectionIds?: Set<number>; excludePrivateCategory?: boolean } = {},
): MemoryV2Item[] {
  return items.filter(item => !options.nightReflectionIds?.has(item.id)
    && (!options.excludePrivateCategory || item.category !== "private"));
}

export function formatMemoryContext(
  items: MemoryV2Item[],
  charBudget: number,
  options: { pinnedIds?: number[]; preamble?: readonly string[] } = {},
): MemoryContextSelection {
  const selected: MemoryV2Item[] = [];
  const pinnedIdSet = new Set(options.pinnedIds || []);
  const ordinaryLines = [...(options.preamble ?? defaultMemoryPreamble)];
  let ordinaryChars = ordinaryLines.join("\n").length;
  for (const item of items) {
    const label = pinnedIdSet.has(item.id) ? `core ${item.type}` : item.type;
    const line = `- [${label} #${item.id}] ${item.content}`;
    if (ordinaryChars + line.length + 1 > charBudget) break;
    selected.push(item);
    ordinaryLines.push(line);
    ordinaryChars += line.length + 1;
  }
  if (!selected.length) return emptyMemoryContext();
  const content = ordinaryLines.join("\n");
  return { content, items: selected, pinnedItems: selected.filter(item => pinnedIdSet.has(item.id)), chars: content.length };
}

export function emptyMemoryContext(): MemoryContextSelection {
  return { content: "", items: [], pinnedItems: [], chars: 0 };
}
