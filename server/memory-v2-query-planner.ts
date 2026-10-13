import type { MemoryV2Domain } from "./memory-v2-types.ts";

export function buildMemorySearchQueries(userMessage: string, recentUserMessages: string[] = [], extraStopTerms: readonly string[] = []) {
  const current = normalizeQuery(userMessage);
  if (!current) return [];
  const recentWindow = hasVagueMemoryReference(current) ? 4 : 2;
  const recent = recentUserMessages
    .map(normalizeQuery)
    .filter(Boolean)
    .slice(-recentWindow);
  const currentTerms = extractSearchTerms(current, extraStopTerms);
  const recentTerms = extractSearchTerms(recent.join("\n"), extraStopTerms);
  const topicTerms = dedupeStrings([...recentTerms, ...currentTerms]);
  const queries = [
    current,
    ...topicTerms,
    ...recent.slice(-1).map((message) => normalizeQuery(`${message}\n${current}`)),
    ...(recent.length >= 2 ? [normalizeQuery(`${recent.join("\n")}\n${current}`)] : []),
  ];
  return dedupeStrings(queries)
    .map(truncateQuery)
    .filter(Boolean)
    .slice(0, 5);
}

export type MemoryDomainHintPatterns = Partial<Record<MemoryV2Domain, readonly RegExp[]>>;

export function buildMemoryDomainHints(
  userMessage: string, recentUserMessages: string[] = [], extraPatterns: MemoryDomainHintPatterns = {},
): MemoryV2Domain[] {
  const combined = normalizeQuery([userMessage, ...recentUserMessages.slice(-3)].join("\n")).toLowerCase();
  const hints: MemoryV2Domain[] = [];
  for (const [domain, patterns] of memoryDomainHintPatterns) {
    if ([...patterns, ...(extraPatterns[domain] || [])].some((pattern) => pattern.test(combined))) hints.push(domain);
  }
  return hints;
}

function normalizeQuery(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractSearchTerms(value: string, extraStopTerms: readonly string[]) {
  const normalized = normalizeQuery(value);
  const terms: string[] = [];
  const cjkChunks = normalized.match(/[\u3400-\u9fff]{2,}/g) || [];
  for (const chunk of cjkChunks) {
    terms.push(...splitCjkSearchTerms(chunk));
  }
  const latinTerms = normalized.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g) || [];
  terms.push(...latinTerms.filter((term) => !latinStopWords.has(term.toLowerCase())));
  return dedupeStrings(terms.filter(term => isUsefulSearchTerm(term) && !extraStopTerms.includes(term))).slice(0, 4);
}

function splitCjkSearchTerms(value: string) {
  return normalizeCjkChunk(value)
    .split(cjkQuerySplitPattern)
    .map((term) => term.trim())
    .filter(Boolean);
}

function normalizeCjkChunk(value: string) {
  return value
    .replace(/[0-9]+/g, "")
    .replace(/百分之/g, "")
    .replace(/继续/g, "")
    .replace(/再次/g, "")
    .replace(/一下/g, "")
    .replace(/^[哼啊呀呢吗的了着过]+/, "")
    .replace(/[哼啊呀呢吗的了着过]+$/, "");
}

function isUsefulSearchTerm(value: string) {
  if (value.length < 2 || value.length > 12) return false;
  return !cjkStopTerms.has(value);
}

function truncateQuery(value: string) {
  return value.length > 500 ? value.slice(-500).trim() : value;
}

function hasVagueMemoryReference(value: string) {
  return vagueMemoryReferencePatterns.some((pattern) => pattern.test(value.toLowerCase()));
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

const vagueMemoryReferencePatterns = [
  /\b(that|this|those|these|previous|earlier|last time|the project|the thing)\b/i,
  /那个|这个|上次|刚才|前面|之前|那件事|这件事|那个项目|这项目|上一回|前几天/,
];

const memoryDomainHintPatterns: Array<[MemoryV2Domain, RegExp[]]> = [
  ["work", [
    /\b(career|job|portfolio|project|resume|work)\b/i,
    /工作|职业|简历|产品|面试|公司/,
  ]],
  ["self", [
    /\b(identity|memory|model|reflection|self|tool)\b/i,
    /身份|记忆|模型|工具|连续性|你自己|自我|反思|锚点/,
  ]],
  ["relationship", [
    /\b(anniversary|relationship)\b/i,
    /关系|纪念日/,
  ]],
  ["life", [
    /\b(birthday|family|health|life|money|sleep)\b/i,
    /生活|现实|生日|名字|姓名|家里|吃饭|睡觉|身体/,
  ]],
  ["private_world", [
    /\b(game)\b/i,
    /游戏|玩/,
  ]],
];

const latinStopWords = new Set([
  "about",
  "after",
  "again",
  "earlier",
  "like",
  "likes",
  "remember",
  "said",
  "talk",
  "talked",
  "talking",
  "that",
  "the",
  "this",
  "was",
  "what",
  "when",
  "with",
]);

const cjkQuerySplitPattern = /把|什么样|什么|哪个|怎么|是不是|是否|多少|几|你|我|他|她|它|还|再|又|喜欢|知道|记得|回忆|检索|测试|判断题|简答题|回答|一个|精确|范围|含量|的|了|吗|呢|啊|呀|和|跟|与|是|在|有|就|都|也|很|更|最/g;

const cjkStopTerms = new Set([
  "喜欢",
  "知道",
  "记得",
  "回忆",
  "检索",
  "测试",
  "判断题",
  "简答题",
  "回答",
  "精确",
  "范围",
  "含量",
  "长期记忆",
  "记忆",
  "类型",
]);
