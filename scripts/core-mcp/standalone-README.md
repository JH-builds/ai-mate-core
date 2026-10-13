# Standalone read-only Core

This package runs the same
Core readers and three MCP tools used by ai-mate. It is not a new Agent runtime,
a Codex-specific connector or a copy of anyone's persona and memories.

## Run

Requires Node.js 22.16 or newer. In the standalone source repository, run
`npm ci` and `npm run build`. The parent ai-mate repository uses `npm run build:core`.
The resulting `dist/core` directory can be moved elsewhere. Keyword retrieval
and MCP need no additional install in that directory; dependencies are bundled.
Keep `LICENSE` and `THIRD-PARTY-NOTICES.txt` with the runtime. Core is licensed
under MIT (Copyright (c) 2026 JH-builds); bundled dependencies retain their own
licenses, whose full texts and actual versions are included in the notices.

For a fictional demonstration, run the separate **offline** preparation command,
then start the read-only server from this package directory:

```sh
node core-data.mjs import --data-dir ./demo-data --from ./example-import.json
node core.mjs --data-dir ./demo-data --identity-file ./example-identity.md
```

Alternatively, create current-schema empty stores with
`node core-data.mjs init --data-dir ./empty-data`. Choose **init or import** for a
new directory, not both in sequence. Both commands refuse an existing destination
(even an empty directory); its parent directory must already exist. They do not
read ambient data paths or initialize the ai-mate application's real data.

This is a stdio MCP server: a trusted local MCP host starts that command and
exchanges protocol messages over stdin/stdout. Running it in a terminal waits
for those messages; it does not open a website or an HTTP port. No global host
registration, automatic persona injection or new OAuth grant is installed.

Both source arguments are mandatory. Missing, blank or oversized identity files
fail startup instead of falling back to the repository's private identity.
The entire selected identity is readable by the host; choose it intentionally.
No `.env` file is loaded. The selected directory controls feature-flag reads;
an inherited `AI_MATE_DATA_DIR` does not select another data store.

## Offline JSON import (schema version 1)

`core-data.mjs` is a local setup utility, **not an MCP write tool**. It uses the
existing database migrations and writers to prepare a new dataset. It does not
connect to the cloud, call a model, merge into an existing store or export anything.
Input is one UTF-8 JSON file (maximum 8 MiB); `example-import.json` is entirely
fictional. The required root field is `schemaVersion: 1`. Optional fields:

- `memories`: array of records with required `type`, `category`, `content` and
  `createdAt`. Types: `fact`, `observation`, `reflection`, `event`; categories:
  `general`, `private`. Optional `domain` (`relationship`, `life`, `work`,
  `private_world`, `self`, `other`, or null), `tag` (up to 80 characters or null),
  `source` (`manual`, `migration`, `extraction`; defaults to `migration`), and
  `updatedAt` (defaults to `createdAt`). Existing content/tag normalization applies.
- A reflection also requires `reflectionMeta`: `origin` (`chat`, `nightly_review`,
  `legacy`), `claimedStatus` (`raw`, `claimed`, `unreviewed`, `uncertain`,
  `not_claimed`, `withdrawn`, `archived`), and `runtimeEligibility` (`eligible`,
  `excluded`). Optional metadata `createdAt` defaults to the memory's creation
  date; `reviewNote` and `reviewedAt` may be null. Metadata is also accepted on
  other record types to preserve historical exclusions. Import does not decide
  that a hypothesis is a fact or that an excluded reflection is now eligible.
- `today`: array of `{ date, summary, updatedAt }`, with one row per `YYYY-MM-DD`.
  This is the **internal daily summary**, not todos, plans or calendar events.
  Summaries are nonblank, at most 1,200 characters, and use existing whitespace
  normalization. Only the `main` scope is populated.
- `continuation`: `{ updatedAt, items }`, where each item has `text`,
  `sourceMessageIds` (strings, each at most 128 characters), and optional
  `supportedAt`. At most 30 items and 16 KiB serialized, matching the shared reader.
  Original timestamps are retained: importing an expired card does not refresh it.
  Start the reader with `--continuation` to opt in; normal expiry still applies.

Timestamps must be valid ISO date-times with a timezone. Unknown fields are
rejected. Only deliberately selected **active** memories are supported; this is
not an ai-mate backup-restoration format. Raw database rows, deleted/superseded
records, old numeric IDs, attachments, diary, chat archive, vectors and persona
documents are not imported. New memory IDs follow input order, starting at 1;
existing `memory:N` references from another store do not transfer automatically.
Private memories retain `private` classification and remain excluded by the
read-only tools. General does not mean public: keep your import file private.

Success prints only record counts. Errors omit data contents and private paths.
The source file is never changed. Stores are built and closed in a temporary
sibling directory before reserving the new destination. Ordinary failures clean
up that newly created data; no existing destination is removed or replaced.
Start readers **after success**, not during preparation. A process kill or power
loss can leave a partial new destination or `.core-data-*` sibling; this is not a
crash-atomic live migration. Inspect such leftovers before removing them and
retry with a fresh destination. Identity remains separately supplied, never
embedded in the import or copied out of the repository.

## Existing read-only data

An empty directory returns explicit missing-memory/Today states. Existing data
must already use the schema of this edition:

- `memory/memory.sqlite`: active eligible general memories only;
- `today/today.sqlite`: dated internal summary, not the todo UI;
- `continuation/apiv2-card.json`: recent continuation, enabled with `--continuation`.

Raw database compatibility is edition-specific. For the generated standalone
source edition, see `SOURCE-MANIFEST.json` for its storage dialect. Its private
classification and anchor names are neutral; do not assume an application database
can be mounted unchanged. Initialize new stores or use the documented JSON import
with explicit category mapping. The importer rejects unknown categories rather
than silently turning a restricted record into a general one.

The MCP server does not initialize/migrate databases, import data, generate memories,
update summaries, run jobs or write back. Never point an experimental host at
real private data merely to check startup. Use a synthetic fixture or a deliberately
authorized data source. Missing and unreadable stores remain distinguishable.
SQLite may create empty WAL/shared-memory coordination files while reading a
WAL-mode store; read-only here means no business writes or schema changes, not
an absolute guarantee that no filesystem metadata/coordination file is touched.

Tools: `core_get_context`, `core_recall`, `core_read_source`. Shared privacy,
eligibility, source revalidation and output limits are unchanged. There are no
diary, full-chat-archive, worldbook, workshop or write tools. MCP service metadata
uses the generic `ai-mate-core-readonly` name and configured-identity wording;
it does not select an identity.

## Optional local semantic retrieval

No model is loaded by default, even if the parent shell has embedding settings.
To use an existing compatible local index, install the transformers package at
the version recorded in `package.json` under `coreLocalEmbedding`, and pass
`--local-embedding-model-dir /absolute/path/to/model`. The existing pinned local
model format/validation and matching index model are required; there is no model
download, remote embedding request or index refresh. A disabled memory-vector
override in the selected data directory still applies. Unavailable inference
is reported and keyword retrieval remains available.

## Trust and scope

Local process/OS access is the trust boundary: any host you configure to launch
this command can read the selected permitted data. This is not account, project
or session attestation. Remote access must keep the authenticated HTTP gateway;
do not expose stdio using an unauthenticated network bridge.

The cloud gateway and ai-mate login are unchanged. Shared application wording has
been separated; the source delivery includes a reviewed standalone dependency
lock, and the runtime includes third-party notices. The MIT grant covers the
standalone code and documentation delivered here, not the private parent
application, real personas or user data. The public repository uses a clean
history; do not add the application repository or its history. Optional
inference dependencies/model weights are not bundled or cleared for redistribution.
This offline importer does not provide ongoing memory extraction, cross-device
synchronization or automatic vector indexing.
`private: true` prevents accidental npm publication; nothing is uploaded by build.
