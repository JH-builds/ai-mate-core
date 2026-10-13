import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const localEmbeddingModel = {
  hubId: "Xenova/bge-small-zh-v1.5",
  revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
  indexName: "local:bge-small-zh-v1.5@75c43b069aac4d136ba6bc1122f995fedcfd2781:q8:cls512:v1",
  files: [
    { file: "config.json", sha256: "d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f" },
    { file: "tokenizer.json", sha256: "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26" },
    { file: "tokenizer_config.json", sha256: "e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a" },
    { file: "special_tokens_map.json", sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3" },
    { file: "onnx/model_quantized.onnx", sha256: "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc" },
  ],
} as const;

type Extractor = ((
  input: string[],
  options: { pooling: "cls"; normalize: true; truncation: true; max_length: 512 },
) => Promise<{ tolist(): unknown }>) & { tokenizer: Tokenizer };

type Tokenizer = {
  encode(input: string, options: { add_special_tokens: false }): number[];
  decode(
    tokenIds: number[],
    options: { skip_special_tokens: true; clean_up_tokenization_spaces: false },
  ): string;
};

type LocalEmbeddingRuntime = { extractor: Extractor; tokenizer: Tokenizer };

export type LocalEmbeddingTokenChunk = {
  chunkIndex: number;
  tokenStart: number;
  tokenEnd: number;
  tokenIds: number[];
};

export type LocalEmbeddingDocumentChunk = Omit<LocalEmbeddingTokenChunk, "tokenIds"> & {
  content: string;
};

const documentTokenBudget = 510;
const documentTokenOverlap = 48;

let loaded: { directory: string; runtime: Promise<LocalEmbeddingRuntime> } | undefined;
let inferenceTail = Promise.resolve();

async function loadRuntime(modelDirectory: string): Promise<LocalEmbeddingRuntime> {
  const directory = path.resolve(modelDirectory);
  if (loaded?.directory === directory) return loaded.runtime;
  const runtime = (async () => {
    await verifyLocalEmbeddingModel(directory);
    try {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.useFSCache = false;
      const extractor = await pipeline("feature-extraction", directory, {
        dtype: "q8",
        device: "cpu",
        local_files_only: true,
        session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
      }) as unknown as Extractor;
      return { tokenizer: extractor.tokenizer, extractor };
    } catch {
      throw new Error("local_embedding_load_failed");
    }
  })();
  loaded = { directory, runtime };
  return runtime;
}

export async function verifyLocalEmbeddingModel(modelDirectory: string): Promise<void> {
  try {
    for (const expected of localEmbeddingModel.files) {
      const bytes = await readFile(path.join(modelDirectory, expected.file));
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected.sha256) throw new Error("mismatch");
    }
  } catch {
    throw new Error("local_embedding_model_invalid");
  }
}

export async function embedLocalTexts(
  modelDirectory: string,
  texts: string[],
  purpose: "document" | "query",
): Promise<number[][]> {
  if (!texts.length) return [];
  const run = async () => {
    const { extractor } = await loadRuntime(modelDirectory);
    const inputs = purpose === "query"
      ? texts.map((text) => `为这个句子生成表示以用于检索相关文章：${text}`)
      : texts;
    try {
      const output = await extractor(inputs, {
        pooling: "cls",
        normalize: true,
        truncation: true,
        max_length: 512,
      });
      const vectors = output.tolist();
      if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error("shape");
      for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== 512 || !vector.every(Number.isFinite)) {
          throw new Error("shape");
        }
      }
      return vectors as number[][];
    } catch {
      throw new Error("local_embedding_inference_failed");
    }
  };
  const result = inferenceTail.then(run, run);
  inferenceTail = result.then(() => undefined, () => undefined);
  return result;
}

export function splitLocalEmbeddingTokenIds(
  tokenIds: number[],
  options: { maxTokens?: number; overlapTokens?: number } = {},
): LocalEmbeddingTokenChunk[] {
  const maxTokens = options.maxTokens ?? documentTokenBudget;
  const overlapTokens = options.overlapTokens ?? documentTokenOverlap;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error("local_embedding_chunk_size_invalid");
  if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error("local_embedding_chunk_overlap_invalid");
  }
  const chunks: LocalEmbeddingTokenChunk[] = [];
  const stride = maxTokens - overlapTokens;
  for (let tokenStart = 0; tokenStart < tokenIds.length; tokenStart += stride) {
    const tokenEnd = Math.min(tokenStart + maxTokens, tokenIds.length);
    chunks.push({
      chunkIndex: chunks.length,
      tokenStart,
      tokenEnd,
      tokenIds: tokenIds.slice(tokenStart, tokenEnd),
    });
    if (tokenEnd === tokenIds.length) break;
  }
  return chunks;
}

export async function splitLocalEmbeddingDocument(
  modelDirectory: string,
  content: string,
): Promise<LocalEmbeddingDocumentChunk[]> {
  try {
    const { tokenizer } = await loadRuntime(modelDirectory);
    const tokenIds = tokenizer.encode(content, { add_special_tokens: false });
    return splitLocalEmbeddingTokenIds(tokenIds).map(({ tokenIds: chunkIds, ...chunk }) => ({
      ...chunk,
      content: tokenizer.decode(chunkIds, {
        skip_special_tokens: true,
        clean_up_tokenization_spaces: false,
      }),
    }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("local_embedding_")) throw error;
    throw new Error("local_embedding_tokenize_failed");
  }
}
