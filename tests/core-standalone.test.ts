import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openInitializedMemoryV2Database } from "../server/memory-v2-store.ts";
import { createMemoryV2Service } from "../server/memory-v2-service.ts";
import { openInitializedTodayContextDatabase } from "../server/today-context-store.ts";
import { createTodayContextService } from "../server/today-context-service.ts";
import { todayDateKey } from "../server/today-context-retrieval.ts";

let root: string;
let entry: string;
before(async () => {
  await mkdir(".cache", { recursive: true });
  root = await mkdtemp(path.resolve(".cache/core-standalone-"));
  // Dynamic import lets the contract fail clearly before the entrypoint exists.
  const { buildStandaloneCore } = await import("../scripts/build-core.mjs");
  await buildStandaloneCore(path.join(root, "package"));
  entry = path.join(root, "package/core.mjs");
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test("standalone package contains no persona/data export and requires explicit sources", async () => {
  assert.deepEqual((await readdir(path.dirname(entry))).sort(), ["LICENSE", "README.md", "THIRD-PARTY-NOTICES.txt", "core-data.mjs", "core.mjs", "example-identity.md", "example-import.json", "package.json"]);
  const manifest = JSON.parse(await readFile(path.join(root, "package/package.json"), "utf8"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  const cwd = path.join(root, "unrelated-workspace");
  await mkdir(cwd);
  await writeFile(path.join(cwd, ".env"), "AI_MATE_DATA_DIR=do-not-use\n");
  for (const args of [[], ["--data-dir", cwd], ["--identity-file", path.join(cwd, "missing.md")], ["--unknown"]]) {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Core startup failed/);
    assert.ok(!result.stderr.includes(cwd), "startup errors do not echo private paths");
  }
  const help = spawnSync(process.execPath, [entry, "--help"], { cwd, encoding: "utf8", timeout: 10000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--identity-file/);
});

test("standalone runtime carries complete notices for its bundled dependencies", async () => {
  const notices = await readFile(path.join(root, "package/THIRD-PARTY-NOTICES.txt"), "utf8");
  for (const name of ["@modelcontextprotocol/sdk", "zod"]) {
    const packageDir = path.resolve("node_modules", name);
    const metadata = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
    const license = await readFile(path.join(packageDir, "LICENSE"), "utf8");
    assert.ok(notices.includes(name + "@" + metadata.version));
    assert.ok(notices.includes(license), "complete upstream license: " + name);
  }
  assert.ok(!notices.includes("@huggingface/transformers"), "optional inference is not bundled");
  const manifest = JSON.parse(await readFile(path.join(root, "package/package.json"), "utf8"));
  assert.ok(manifest.files.includes("THIRD-PARTY-NOTICES.txt"));
  assert.equal(manifest.license, "MIT");
  assert.ok(manifest.files.includes("LICENSE"));
  assert.deepEqual(await readFile(path.join(root, "package/LICENSE")), await readFile("scripts/core-mcp/standalone-LICENSE"));
});

function prepareData(...args: string[]) {
  return spawnSync(process.execPath, [path.join(root, "package/core-data.mjs"), ...args], {
    cwd: root, encoding: "utf8", timeout: 10000,
    env: { ...process.env, AI_MATE_DATA_DIR: path.join(root, "never-use-ambient-data") },
  });
}

test("offline init creates current empty stores without importing persona or ambient data", async () => {
  const dataDir = path.join(root, "initialized-data");
  const result = prepareData("init", "--data-dir", dataDir);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { memories: 0, today: 0, continuation: 0 });
  assert.deepEqual((await readdir(dataDir)).sort(), ["memory", "today"]);
  for (const [file, table] of [["memory/memory.sqlite", "memories"], ["today/today.sqlite", "today_contexts"]]) {
    const db = new DatabaseSync(path.join(dataDir, file), { readOnly: true });
    try {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
      if (table === "memories") {
        assert.ok(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get("memories")?.sql).includes("\'private\'"));
        assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get("private_memory_anchors")?.name, "private_memory_anchors");
      }
    }
    finally { db.close(); }
  }
  assert.ok(!(await readdir(root)).includes("never-use-ambient-data"));
});

test("offline import preserves dates, private classification and reflection eligibility through real MCP", async t => {
  const dataDir = path.join(root, "imported-data");
  const source = path.join(root, "import.json");
  const now = new Date();
  const oldDate = "2026-01-02T03:04:05.000Z";
  const reflectionMeta = { origin: "nightly_review", claimedStatus: "unreviewed", runtimeEligibility: "excluded", createdAt: oldDate, reviewNote: "synthetic review", reviewedAt: oldDate };
  const memories = [
    { type: "fact", category: "general", domain: "life", tag: "garden", content: "Cedar jasmine preference", source: "manual", createdAt: oldDate, updatedAt: oldDate },
    { type: "fact", category: "private", content: "Cedar jasmine private", createdAt: oldDate },
    { type: "reflection", category: "general", content: "Cedar jasmine excluded", createdAt: oldDate, reflectionMeta },
    { type: "observation", category: "general", content: "Cedar jasmine former reflection", createdAt: oldDate, reflectionMeta },
  ];
  const continuation = { updatedAt: oldDate, items: [{ text: "expired synthetic topic", sourceMessageIds: ["example-message"], supportedAt: oldDate }] };
  await writeFile(source, JSON.stringify({ schemaVersion: 1, memories, today: [{ date: todayDateKey(now), summary: "Cedar garden tasks", updatedAt: now.toISOString() }], continuation }));
  const sourceBefore = await readFile(source);
  const result = prepareData("import", "--data-dir", dataDir, "--from", source);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { memories: 4, today: 1, continuation: 1 });
  assert.deepEqual(await readFile(source), sourceBefore);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "continuation/apiv2-card.json"), "utf8")), continuation);
  const db = new DatabaseSync(path.join(dataDir, "memory/memory.sqlite"), { readOnly: true });
  try {
    const saved = db.prepare("SELECT type, category, created_at, updated_at, source FROM memories ORDER BY id").all();
    assert.deepEqual(saved.map(row => [row.type, row.category, row.created_at, row.updated_at]), memories.map(row => [row.type, row.category, oldDate, oldDate]));
    assert.deepEqual(saved.map(row => row.source), ["manual", "migration", "migration", "migration"]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM reflection_meta WHERE runtime_eligibility = 'excluded' AND created_at = ? AND reviewed_at = ?").get(oldDate, oldDate)?.n, 2);
  } finally { db.close(); }
  const client = new Client({ name: "import-contract", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, cwd: root, stderr: "pipe",
    args: [entry, "--data-dir", dataDir, "--identity-file", path.join(root, "package/example-identity.md"), "--continuation"],
  }));
  const resultContext = await client.callTool({ name: "core_get_context", arguments: { query: "jasmine" } });
  const context = JSON.parse((resultContext.content as Array<{ text: string }>)[0].text);
  assert.deepEqual(context.memory.data.map((item: { sourceRef: string }) => item.sourceRef), ["memory:1"]);
  assert.equal(context.today.data.content, "Cedar garden tasks");
  assert.deepEqual(context.continuation.items, [], "import does not freshen stale continuation");
  for (const id of [2, 3, 4]) {
    const resultSource = await client.callTool({ name: "core_read_source", arguments: { sourceRef: `memory:${id}` } });
    assert.equal(JSON.parse((resultSource.content as Array<{ text: string }>)[0].text).memory.data, null);
  }
});

test("offline import rejects lossy or ambiguous input without leaving stores or echoing content", async () => {
  const source = path.join(root, "invalid-import.json");
  const dataDir = path.join(root, "invalid-import-target");
  const memory = { type: "fact", category: "general", content: "SECRET-CONTENT-CANARY", createdAt: "2026-01-02T03:04:05.000Z" };
  const valid = { schemaVersion: 1, memories: [memory] };
  const invalid = [
    { ...valid, schemaVersion: 2 }, { ...valid, identity: "SECRET-CONTENT-CANARY" },
    { ...valid, memories: null }, { ...valid, today: null },
    ...[
      { category: undefined }, { category: "invalid" }, { status: "superseded" }, { deleted_at: memory.createdAt },
      { id: 99 }, { createdAt: "2026-02-30T00:00:00Z" }, { type: "reflection" },
      { reflectionMeta: { origin: "chat", claimedStatus: "claimed", runtimeEligibility: "unknown" } },
      { tag: "x".repeat(81) },
    ].map(change => ({ ...valid, memories: [memory, { ...memory, ...change }] })),
    { ...valid, today: [{ date: "2026-02-30", summary: "test", updatedAt: memory.createdAt }] },
    { ...valid, today: [{ date: "2026-01-02", summary: "x".repeat(1201), updatedAt: memory.createdAt }] },
    { ...valid, today: Array(2).fill({ date: "2026-01-02", summary: "duplicate", updatedAt: memory.createdAt }) },
    { ...valid, continuation: { updatedAt: memory.createdAt, items: [{ text: "topic", sourceMessageIds: ["x"], supportedAt: "invalid" }] } },
    { ...valid, continuation: { updatedAt: memory.createdAt, items: [{ text: "x".repeat(16384), sourceMessageIds: [] }] } },
  ];
  for (const input of [...invalid.map(value => JSON.stringify(value)), "not JSON SECRET-CONTENT-CANARY"]) {
    await writeFile(source, input);
    const result = prepareData("import", "--data-dir", dataDir, "--from", source);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Core data preparation failed/);
    assert.ok(!result.stderr.includes("SECRET-CONTENT-CANARY") && !result.stderr.includes(root));
    assert.equal(await readFile(source, "utf8"), input);
    assert.ok(!(await readdir(root)).includes(path.basename(dataDir)));
    assert.ok(!(await readdir(root)).some(name => name.startsWith(".core-data-")));
  }
});

test("offline commands refuse existing destinations and ambiguous invocation; packaged example imports", async () => {
  const dataDir = path.join(root, "preserved-target");
  const source = path.join(root, "package/example-import.json");
  await mkdir(dataDir);
  for (const command of ["init", "import"]) {
    const result = prepareData(command, "--data-dir", dataDir, ...(command === "import" ? ["--from", source] : []));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /target_exists/);
    assert.deepEqual(await readdir(dataDir), []);
  }
  await writeFile(path.join(dataDir, "keep.txt"), "keep");
  assert.equal(prepareData("import", "--data-dir", dataDir, "--from", source).status, 1);
  assert.equal(await readFile(path.join(dataDir, "keep.txt"), "utf8"), "keep");
  for (const args of [[], ["init"], ["import", "--data-dir", path.join(root, "unused")], ["init", "--data-dir", path.join(root, "unused"), "--from", source], ["delete", "--data-dir", dataDir]]) {
    assert.equal(prepareData(...args).status, 1);
  }
  assert.equal(prepareData("--help").status, 0);
  const result = prepareData("import", "--data-dir", path.join(root, "example-data"), "--from", source);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).memories > 0);
});

test("standalone real MCP uses the shared read contract without web/auth or writeback", async t => {
  const dataDir = path.join(root, "synthetic-data");
  const identityPath = path.join(root, "synthetic-identity.md");
  await writeFile(identityPath, "I am Cedar, a fictional test companion.\n");
  const writer = openInitializedMemoryV2Database({ dataDir });
  const memory = createMemoryV2Service(writer);
  const fact = memory.createMemory({ type: "fact", content: "synthetic jasmine preference" });
  const privateItem = memory.createMemory({ type: "fact", category: "private", content: "synthetic private canary jasmine" });
  writer.close();
  const now = new Date();
  const todayWriter = openInitializedTodayContextDatabase({ dataDir });
  createTodayContextService(todayWriter).upsertSummary({ scope_id: "main", date: todayDateKey(now), summary: "synthetic daily summary", now });
  todayWriter.close();
  await mkdir(path.join(dataDir, "continuation"));
  await writeFile(path.join(dataDir, "continuation/apiv2-card.json"), JSON.stringify({
    updatedAt: now.toISOString(), items: [{ text: "synthetic ongoing topic", sourceMessageIds: ["synthetic-1"] }],
  }));
  // Snapshot every input file, including databases, rather than trusting annotations.
  const files = (await readdir(dataDir, { recursive: true, withFileTypes: true })).filter(file => file.isFile());
  const paths = files.map(file => path.join(file.parentPath, file.name));
  const beforeReads = await Promise.all(paths.map(file => readFile(file)));
  const beforeNames = (await readdir(dataDir, { recursive: true })).sort();
  const client = new Client({ name: "standalone-contract", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--data-dir", dataDir, "--identity-file", identityPath, "--continuation"],
    cwd: root, stderr: "pipe",
    env: { AI_MATE_DATA_DIR: path.join(root, "wrong-root"), EMBEDDING_PROVIDER: "remote", API_V2_MEMORY_VECTOR_ENABLED: "true" },
  });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(client.getServerVersion()?.name, "ai-mate-core-readonly");
  assert.deepEqual(listed.tools.map(tool => tool.name), ["core_get_context", "core_recall", "core_read_source"]);
  assert.ok(listed.tools.every(tool => tool.annotations?.readOnlyHint));
  const call = async (name: string, args: Record<string, string>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined);
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  };
  const context = await call("core_get_context", { query: "jasmine" });
  assert.equal(context.persona.content, "I am Cedar, a fictional test companion.\n");
  assert.equal(context.semantic, "disabled", "ambient embedding settings cannot enable remote or local inference");
  assert.equal(context.today.data.content, "synthetic daily summary");
  assert.deepEqual(context.continuation.items.map((item: { content: string }) => item.content), ["synthetic ongoing topic"]);
  assert.deepEqual(context.memory.data.map((item: { sourceRef: string }) => item.sourceRef), [`memory:${fact.id}`]);
  const recalled = await call("core_recall", { query: "jasmine" });
  assert.deepEqual(recalled.memory, context.memory);
  const source = await call("core_read_source", { sourceRef: `memory:${fact.id}` });
  assert.equal(source.memory.data.content, "synthetic jasmine preference");
  assert.equal((await call("core_read_source", { sourceRef: `memory:${privateItem.id}` })).memory.data, null);
  for (const [name, args] of [
    ["core_write", { query: "jasmine" }],
    ["core_recall", { query: "jasmine", scope: "private" }],
    ["core_read_source", { sourceRef: "../identity.md" }],
  ] as const) assert.equal((await client.callTool({ name, arguments: args })).isError, true);
  assert.deepEqual(await Promise.all(paths.map(file => readFile(file))), beforeReads);
  const extra = (await readdir(dataDir, { recursive: true })).filter(name => !beforeNames.includes(name));
  assert.ok(extra.every(name => /^(memory[\\/]memory|today[\\/]today)\.sqlite-(wal|shm)$/.test(name)));
  for (const name of extra.filter(name => name.endsWith("-wal"))) {
    assert.equal((await readFile(path.join(dataDir, name))).byteLength, 0, "read-only WAL coordination must not contain writes");
  }
});

test("missing stores remain missing and standalone continuation is explicitly selected", async t => {
  const dataDir = path.join(root, "empty-stores");
  const identityPath = path.join(root, "empty-store-identity.md");
  await mkdir(path.join(dataDir, "runtime"), { recursive: true });
  await writeFile(path.join(dataDir, "runtime/feature-flags.json"), JSON.stringify({ flags: { continuation: true } }));
  await writeFile(identityPath, "Synthetic empty-store identity.");
  const beforeNames = (await readdir(dataDir, { recursive: true })).sort();
  const client = new Client({ name: "empty-contract", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [entry, "--data-dir", dataDir, "--identity-file", identityPath],
    cwd: root, stderr: "pipe", env: { API_V2_CONTINUATION_ENABLED: "true" },
  }));
  const result = await client.callTool({ name: "core_get_context", arguments: { query: "" } });
  assert.equal(result.isError, undefined);
  const context = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  assert.equal(context.memory.status, "missing");
  assert.equal(context.today.status, "missing");
  assert.equal(context.continuation.status, "disabled");
  assert.deepEqual((await readdir(dataDir, { recursive: true })).sort(), beforeNames);
  await writeFile(identityPath, " ");
  const invalid = await client.callTool({ name: "core_get_context", arguments: { query: "" } });
  assert.deepEqual(JSON.parse((invalid.content as Array<{ text: string }>)[0].text).persona, { status: "unavailable" });
});
