import { stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCoreMcpServer } from "../scripts/core-mcp/server.mjs";
import { CoreContextService } from "./core-context-service.ts";
import { coreContextOutput } from "./core-context-output.ts";
import { readBoundedFile } from "./data-store.ts";

// Dedicated local process, not an HTTP listener or a replacement for the web
// runtime. Sources are owner-supplied startup arguments, never model arguments.
async function main() {
  const { values } = parseArgs({ options: {
    "data-dir": { type: "string" },
    "identity-file": { type: "string" },
    "local-embedding-model-dir": { type: "string" },
    continuation: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  }, strict: true, allowPositionals: false });
  if (values.help) {
    console.log("Usage: node core.mjs --data-dir <existing directory> --identity-file <file> [--continuation] [--local-embedding-model-dir <directory>]");
    return;
  }
  if (!values["data-dir"]?.trim() || !values["identity-file"]?.trim()) throw new Error("sources_required");
  const dataDir = path.resolve(values["data-dir"]);
  const identityPath = path.resolve(values["identity-file"]);
  if (!(await stat(dataDir)).isDirectory()) throw new Error("data_directory_required");
  if (!(await readBoundedFile(identityPath, coreContextOutput.persona.maxBytes)).trim()) throw new Error("identity_required");

  // Pin the shared feature-flag reader to this process's explicit data root.
  // Never load .env, default persona files, an API key or remote embeddings.
  process.env.AI_MATE_DATA_DIR = dataDir;
  const modelDir = values["local-embedding-model-dir"];
  if (modelDir !== undefined) {
    if (!modelDir.trim() || !(await stat(path.resolve(modelDir))).isDirectory()) throw new Error("model_directory_required");
    process.env.EMBEDDING_PROVIDER = "local";
    process.env.LOCAL_EMBEDDING_MODEL_DIR = path.resolve(modelDir);
    process.env.API_V2_MEMORY_VECTOR_ENABLED = "true";
  }
  const service = new CoreContextService({
    dataDir, identityPath, continuationEnabled: values.continuation,
    ...(modelDir === undefined ? { semanticQuery: async () => ({ status: "disabled" as const }) } : {}),
  });
  const server = createCoreMcpServer(async (name: string, args: { query?: string; sourceRef?: string }) => {
    switch (name) {
      case "core_get_context": return service.resolve(args.query!);
      case "core_recall": return service.recall(args.query!);
      case "core_read_source": return service.readSource(args.sourceRef!);
      default: throw new Error("unknown_tool");
    }
  });
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  console.error("Core startup failed. Check --data-dir, --identity-file and optional local model directory; use --help for usage.");
  process.exitCode = 1;
});
