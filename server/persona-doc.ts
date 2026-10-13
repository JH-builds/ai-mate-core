import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readBoundedFile } from "./data-store.ts";

// One approved source, one content-version algorithm. No cache, generated
// persona, relationship duplication, or host-specific identity is introduced.
// sourcePath is a trusted server option (also used by Core's synthetic tests),
// never a model-supplied path. Core retains its existing byte-bounded read.
export async function readIdentityDocument(options: {
  sourcePath?: string | URL;
  maxBytes?: number;
} = {}) {
  const source = "base-docs/identity.md";
  const file = options.sourcePath ?? new URL(`../${source}`, import.meta.url);
  const content = options.maxBytes === undefined
    ? await readFile(file, "utf8")
    : await readBoundedFile(file, options.maxBytes);
  if (!content.trim()) throw new Error("identity_document_empty");
  return { source, version: createHash("sha256").update(content).digest("hex").slice(0, 16), content };
}
