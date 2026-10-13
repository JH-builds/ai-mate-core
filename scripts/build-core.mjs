import { builtinModules } from "node:module";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const packageFiles = ["LICENSE", "core.mjs", "core-data.mjs", "package.json", "README.md", "example-identity.md", "example-import.json", "THIRD-PARTY-NOTICES.txt"];

// Build the existing implementation, not a second source tree. The explicit
// asset list excludes base-docs, .env, databases, logs and repository history.
export async function buildStandaloneCore(directory = path.join(root, "dist/core")) {
  const outDir = path.resolve(directory);
  const existing = await readdir(outDir).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  if (existing.some(name => !packageFiles.includes(name))) throw new Error("core_output_directory_not_clean");
  const result = await build({
    absWorkingDir: root, entryPoints: { core: "server/core-standalone.ts", "core-data": "server/core-data.ts" },
    outdir: outDir, outExtension: { ".js": ".mjs" }, write: false, bundle: true,
    platform: "node", format: "esm", target: "node22", metafile: true,
    external: ["@huggingface/transformers"],
    banner: { js: 'import { createRequire as coreCreateRequire } from "node:module"; const require = coreCreateRequire(import.meta.url);' },
    logLevel: "silent",
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const entry of output.imports) {
      if (!entry.external || (!entry.path.startsWith("node:") && !builtinModules.includes(entry.path) && entry.path !== "@huggingface/transformers")) {
        throw new Error("core_bundle_has_unbundled_dependency");
      }
    }
  }
  // esbuild identifies the dependencies actually included, including nested copies.
  const packageRoots = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const [input, detail] of Object.entries(output.inputs)) {
      if (!detail.bytesInOutput) continue;
      const parts = input.replaceAll("\\", "/").split("/");
      const index = parts.lastIndexOf("node_modules");
      if (index >= 0) packageRoots.add(parts.slice(0, index + (parts[index + 1].startsWith("@") ? 3 : 2)).join("/"));
    }
  }
  const notices = ["Third-party notices\nThese licenses apply to the bundled dependencies, not to the Core project's own code."];
  for (const directory of [...packageRoots].sort()) {
    const location = path.resolve(root, directory);
    const metadata = JSON.parse(await readFile(path.join(location, "package.json"), "utf8"));
    // Only the license families covered by the standalone dependency review.
    if (!["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC"].includes(metadata.license)) throw new Error("core_bundle_license_requires_review");
    const licenseFiles = (await readdir(location)).filter(name => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(name)).sort();
    if (!licenseFiles.length) throw new Error("core_bundle_dependency_license_missing");
    notices.push(metadata.name + "@" + metadata.version + " (" + metadata.license + ")");
    for (const file of licenseFiles) notices.push(await readFile(path.join(location, file), "utf8"));
  }
  const appPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await mkdir(outDir, { recursive: true });
  for (const file of result.outputFiles) await writeFile(file.path, file.contents);
  await writeFile(path.join(outDir, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n") + "\n");
  await writeFile(path.join(outDir, "package.json"), JSON.stringify({
    name: "ai-mate-core-standalone", version: "0.1.0", private: true, license: "MIT", type: "module",
    engines: { node: ">=22.16.0" }, scripts: { start: "node core.mjs" },
    files: packageFiles.filter(name => name !== "package.json"),
    coreLocalEmbedding: appPackage.coreLocalEmbedding ?? { package: "@huggingface/transformers", version: appPackage.dependencies["@huggingface/transformers"], installOnlyForLocalVectors: true },
  }, null, 2) + "\n");
  await copyFile(path.join(root, "scripts/core-mcp/standalone-README.md"), path.join(outDir, "README.md"));
  await copyFile(path.join(root, "scripts/core-mcp/standalone-LICENSE"), path.join(outDir, "LICENSE"));
  await copyFile(path.join(root, "scripts/core-mcp/example-identity.md"), path.join(outDir, "example-identity.md"));
  await copyFile(path.join(root, "scripts/core-mcp/example-import.json"), path.join(outDir, "example-import.json"));
  return outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildStandaloneCore();
  console.log("Built standalone Core at dist/core. Nothing uploaded.");
}
