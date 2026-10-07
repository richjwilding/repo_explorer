# Architecture

How Repo Explorer turns a directory into an explainer, and where the seams are.

## Shape of the system

```
src/
  core/                     # everything that can run without a browser
    types.ts                # the whole domain model (plain, JSON-serialisable)
    config.ts               # env + ~/.repo-explorer/config.json
    logger.ts               # levelled console logger
    store.ts                # file-backed persistence per repository
    service.ts              # RepoService: owns open repos, analysis, changes
    analysis/
      analyzeRepo.ts        # the pipeline that produces a RepoModel
      languages.ts          # language/category/noise classification
      imports.ts            # import + binding + symbol extraction, resolution
      bodies.ts             # body-extent detection (braces / indent / end)
      callgraph.ts          # call graph, reachability, routes, dead code
      stack.ts              # manifests, frameworks, CI, external services
    index/
      chunker.ts            # symbol-level chunking
      bm25.ts               # BM25 ranking with path/symbol boost
      indexer.ts            # build/load/snapshot the search index
    llm/
      http.ts               # fetch helpers: JSON, NDJSON, SSE, timeouts
      json.ts               # tolerant JSON extraction and repair
      ollama.ts             # native Ollama /api/chat (num_ctx, think: false always)
      openai.ts             # any OpenAI-compatible /chat/completions
      anthropic.ts          # Messages API
      mock.ts               # deterministic provider for tests/offline
      registry.ts           # provider discovery and auto-selection
    agent/
      tools.ts              # the tool set the model can call
      explorer.ts           # the investigate-then-write loop
    chat/
      prompts.ts            # system prompts, section requirements, seeds
      retrieval.ts          # chunk merging and context-pack assembly
      chat.ts               # streaming Q&A with citation resolution
    explain/
      digest.ts             # bounded structural summaries for prompts
      schema.ts             # explainer contract + defensive normalisation
      generate.ts           # cache-aware explainer orchestration
      structural.ts         # static fallback when no model is available
      exportHtml.ts         # self-contained interactive HTML export
  server/                   # Fastify HTTP + SSE layer
    index.ts                # app wiring, static UI, error handling, CLI entry
    sse.ts                  # Server-Sent Events over a hijacked reply
    clientModel.ts          # trims the analysis for shipping to the browser
    routes/{repos,explain,changes,chat}.ts
  web/                      # Vite + React SPA
    App.tsx                 # shell, tabs, repo open, explainer orchestration
    lib/{api,markdown,highlight,format}.ts
    components/{ExplainerView,SectionRenderer,DiagramView,ArchitecturePanel,
                ChatPanel,ChangesView,FilesView}.tsx
```

Two rules keep this manageable:

1. **`core` never imports from `server` or `web`.** The browser gets a trimmed copy of the model, not the core types.
2. **Only `core` talks to a model.** The server is transport; the SPA is presentation.

## The analysis pipeline

`analyzeRepo(root)` runs in fixed stages and reports progress percentages. Nothing in this pipeline calls a language model.

1. **Layout** — `git ls-files --cached --others --exclude-standard` where possible (so `.gitignore` applies), else a filesystem walk that prunes known noise. Then a hard filter removes paths containing `node_modules`, `dist`, `build`, `vendor`, `.venv`, `__pycache__`, and friends — *even when they are committed to git*, which happens more often than you would hope.
2. **Manifests + git** — package.json/requirements/pyproject/go.mod/Cargo.toml/pom.xml/build.gradle/Gemfile/composer.json/csproj, plus branch, contributors, weekly activity, and per-file **churn** over the last 400 commits.
3. **Files** — read (bounded), detect language, classify category, extract symbols and imports with local bindings. Reading is done with a 24-way concurrency pool; content is dropped as soon as it is no longer needed.
4. **Import resolution** — relative paths with extension/index fallbacks, TS/JS alias roots, Python dotted relative imports (`.models`, `..utils`), Go/Rust/JVM/PHP module paths.
5. **Module tree** — every ancestor directory becomes a module with direct and recursive LOC, language mix, and an `ancillary` flag for tests/fixtures/generated/docs.
6. **Components** — workspace globs (`packages/*`, pnpm-workspace) *plus* any directory that owns a build manifest or Dockerfile. Deeper anchors claim their files first, so one umbrella `services/` directory becomes the actual microservices. A directory that owns no manifest and contains several substantial child directories is treated as a **container, not a unit**, and its children become the components (at most twice, and abandoned if it would produce more than 24). Without this a single-package project anchored on `src/` and reported the whole system as one component called "src" — a one-box shape diagram. Names drop a conventional source root, so `src/server` is "server" and `src/core/analysis` is "core/analysis". A component's size ignores lockfiles and generated output, and a component with no source of its own is marked ancillary. Each component is classified by the **import specifiers and manifest dependencies** of its files, not by substring-matching source text (a comment mentioning "react" is not a UI).
7. **Call graph** — see below.
8. **Entrypoints** — manifest `main`/`bin`, npm scripts, conventional filenames, shebangs, HTTP bootstrap calls, Dockerfile `CMD`, and every detected route handler. Ranked so that `http-server` and `cli` outrank one-off `patch_*.py` scripts, which are capped in number.
9. **Dependencies, concepts, flows, graph** — external dependencies discovered from evidence (see below); recurring compound vocabulary; data flows traced along the component dependency graph from HTTP entrypoints; a navigation graph of root → components → modules.
10. **Hotspots** — `commits × log10(lines)` over files that still exist: where change and size meet.

### Call graph construction

This is the part that makes the app useful rather than decorative.

- **Body extents.** Brace matching (string/comment aware) for C-like languages, indentation for Python, `end` matching for Ruby, with a bounded fallback. Clamping to the next declaration applies to functions but **not** to classes, whose bodies legitimately contain the following declarations.
- **Ownership.** A definition belongs to the innermost enclosing class/struct, determined *after* body extents are known rather than inferred from declaration order.
- **Call extraction.** Bare `f(…)`, `obj.m(…)`, optional chaining, `new X(…)`, and callbacks passed by name. Language keywords are filtered; a definition's own signature line is not counted as a call to itself.
- **JS/TS symbol extraction.** Only column-zero declarations are definitions, plus class members at the class's member indentation. This matters: treating every `const` as a symbol splits enclosing function bodies in half and corrupts call attribution, ownership, and dead-code detection.
- **Resolution.** Local definition → imported binding (with the remote name) → `self`/`this` member → class or namespace member. Everything else is recorded as unresolved, optionally annotated with the external package name.
- **Reachability.** BFS from route handlers, entrypoint symbols, and package surfaces (`__init__.py`, `index.*`, `mod.rs`, `lib.rs`). Reaching a class implies reaching its members.
- **Dead code.** A symbol is only a candidate if it has no resolved callers **and** no reachable file imports the module it lives in. That second condition is what stops every callback and decorator from being reported as dead.

## External dependencies are discovered, not enumerated

There is deliberately **no list of products**. An earlier version scanned file bodies with a curated table of
~45 product regexes, and it failed in three ways at once: it was incomplete by construction, it drifted, and
because some patterns matched several products (`/elasticsearch|opensearch/`) it reported the *wrong* product
with total confidence — which then propagated into generated explainers and quizzes.

Dependencies now come from four kinds of evidence, in descending order of authority:

| Failure mode | What went wrong | What prevents it |
| --- | --- | --- |
| An absence claimed in a dimension the project does not have | "No migrations" is meaningless for a repository with no database | Every check returns null when it does not apply, so only real absences are reported |
| A fixed window reading the next handler | A 40-line window from a route handler ran into the following route's error handling, so a handler with none of its own looked handled | The window ends at the next handler in the same file |
| A weak finding dressed as a strong one | "No observability library" fires for a library or a script, which has no production output to look at | The check requires something actually deployed — a container, infrastructure, or routes |
| A verdict instead of an observation | "This code has no tests" reads as a criticism, and the reader cannot tell which facts it rests on | Every finding carries its evidence and is phrased as what is absent and why it might matter |

| --- | --- | --- |
| A column type swallowing its own constraints | `id BIGSERIAL PRIMARY KEY` reported the type as "BIGSERIAL PRIMARY KEY" | A SQL type stops at the first constraint keyword |
| A flag contradicting the note beside it | A primary key column was marked optional because its line omitted `NOT NULL`, while still being labelled "nullable" | Primary key columns are forced non-null and the contradictory note is cleared |
| A test fixture presented as deployed storage | A repository whose tests mention `postgres://` and `amqp://` was reported as using PostgreSQL and AMQP | A store named only in tests or fixtures is listed separately, the same rule already applied to environment variables |
| Every line number one too high | Parsers added one to the declaration's line, so a field on line 2 was reported at line 3 | The body capture begins with the newline after `{`, so its first element is the declaration's own line |

| --- | --- | --- |
| A helper counted as a test that broke the naming convention | Every file under `tests/` was treated as a test, so `tests/helpers/fixtureRepo.ts` produced a false exception | Only files that declare test cases define the placement and naming conventions; `testCaseFiles` is passed in |
| An exception message naming the wrong component | The back-edge violation said a file imported the component it belongs to | The message names `depends`, the component the file imports, rather than `dependency`, the one it sits in |
| A weak majority promoted to a rule | 71% adherence would have been stated as a convention and used to flag the remaining 29% | Rules need 80% adherence and five supporting cases; anything between 50% and 80% is reported as a deliberately mixed pattern with no rule to break |
| A generic rule asserted at a repository | A rule stated from general practice would be wrong in any codebase that chose differently | Every rule is derived from the measured majority behaviour of the repository being analysed |

| --- | --- | --- |
| A keyword in a string counted as a branch | `"if you want, for the while case"` is prose, not five decisions | `stripNonCode` replaces comment and string contents before anything is counted |
| An indented object literal counted as nesting | A nested config object looked as deep as nested branches | A brace opens a level only when preceded by a control head or a function head |
| The function's own body counted as a level | Every definition was reported one deeper than it was, and disagreed with the indentation measure used for Python | The first brace outside parentheses is the frame; and a destructured parameter is inside parentheses, so it is skipped |
| A callback body hidden by an unclosed parenthesis | `items.map((x) => { ... })` still has the call's parenthesis open, so the whole callback body was treated as a parameter list and reported at depth 0 | The parenthesis guard applies only before the body opens, which raised the measured depth of most React components |
| Two incomparable scores in one ranking | A 4,531-line lockfile outranked the branchiest function in the codebase, because size×churn and complexity×churn are different scales | Measured files are ranked on complexity and come first; unmeasured ones follow, labelled "by size" |

| --- | --- | --- |
| A hub file presented as a hidden dependency | A file that changes in every commit co-occurs with everything, so its pairs have perfect confidence and would dominate the list | Files changed in more than ~40% of commits are excluded, with an absolute floor so short histories are not filtered to nothing |
| A merge read as coupling | A merge or whole-repo reformat touches every file, coupling all of them | Commits touching more than 40 files are skipped, counted, and disclosed to the reader |
| One shared commit read as a relationship | Two files edited together once is a coincidence | A minimum co-occurrence scaled to the length of history, plus a confidence floor |
| A single-author repository flagged as key-person risk everywhere | Every component in a one-person project has one author, which is a fact about the project, not about any component | Key-person risk requires more than one author, at least ten commits, and an 80% share |

| --- | --- | --- |
| A dependency's name standing in for its deployment | Five OpenSearch containers plus an app that never ships a container looked the same from the dependency list | `ops.ts` reads CI, Dockerfiles, compose and infrastructure manifests; `describeOperations` never infers a target from a package name |
| An empty panel read as a broken feature | A repository with no CI showed nothing, which is indistinguishable from an analysis that failed | Every absence is stated: "no CI definitions found — nothing automatically verifies a change" |
| A `COPY` destination mistaken for a source | `COPY package.json ./` ends in `./`, so the manifest copy looked like the source tree and every correctly cached Dockerfile was reported as uncached | `copySources()` drops the destination operand; caching is judged by manifest-before-source order across the build |
| Fixture configuration presented as production configuration | A `DATABASE_URL` used only by a test fixture appeared alongside real settings | `EnvVar.testOnly` is derived from a segment-aware path test, and test-only names are demoted and counted separately |
| A test file mistaken for a source file about tests | A loose substring match on `test` treated `src/core/analysis/tests.ts` as a test path | `isTestOrFixturePath` matches whole path segments and filename conventions |

| Evidence | Source | Example identifier |
| --- | --- | --- |
| Container images | `docker-compose*`, `Dockerfile` `FROM`, Kubernetes/Helm manifests | `opensearchproject/opensearch:2.11.0` |
| Service-naming env vars | `.env*` files, `process.env.X`, `os.environ`/`os.getenv` | `OPENSEARCH_HOST`, `DATABASE_URL` |
| Connection-string schemes | string literals anywhere in config or source | `postgres`, `redis`, `amqp` |
| Package specifiers | imports that did not resolve inside the repository | `opensearchpy`, `@aws-sdk/client-sqs` |

The **name is always the literal identifier found** — never an inferred or substituted product. Configuration
evidence outranks imports when ranking, because an `image:` line or an env key is a statement of fact.

Resolution rules that keep the inventory honest:

- **Language built-ins are not dependencies.** Python's standard library (from CPython's own
  `sys.stdlib_module_names`) and Node's `builtinModules` are filtered out, so `os`, `json`, `path` and `fs` never
  appear.
- **First-party modules are not dependencies.** A module whose top-level name matches a top-level directory, a
  directory containing `__init__.py`, a manifest package name, or a helper file inside a package/test directory
  is this repository's own code. Manifest directories are also added as import roots, so `from app.config import …`
  inside a service resolves to that service's file instead of looking like an external `app` package.
- **File gates matter.** Container images are only read from compose files, Dockerfiles and Kubernetes/Helm
  manifests. Without that gate, a Python `from x import y` line inside a Dockerfile heredoc matched a
  case-insensitive `FROM`.
- **Shape checks matter.** A dotted identifier with no registry path and no tag (`onyx.db.models`) is a module
  path, not an image. Credential and schema env keys (`*_USER`, `*_PASSWORD`, `*_DB_NAME`) are properties of a
  service we already know about, not services themselves.

Category assignment is additive metadata and can never rename anything:

- a small table keyed by **exact** identifier supplies a category and an optional human label (`opensearchpy` →
  search, "OpenSearch client") — there is no fuzzy fallback, so an unrecognised name is never attributed to a
  product that merely shares a segment with it;
- structural rules derive the category from the shape of scoped SDK specifiers (`@aws-sdk/client-sqs` → queue,
  `@google-cloud/storage` → storage) so the long tail is covered without enumeration;
- anything unrecognised is reported as category `dependency` — visible and honest rather than dropped.

Two rules keep this from repeating the original mistake: matching is **exact** (the last path segment is used
only for container image names, where Docker namespacing makes it the real repository name), and base images
such as `node:20-alpine` are never matched against package names that merely end in `node`.

URL schemes are the one place where a fixed list remains, and deliberately so: **protocols are a closed set**
(`postgres`, `redis`, `amqp`, `mongodb`, `s3`) whereas products are open-ended. The list names a protocol, never
a vendor, so it cannot misattribute one product to another.

## The agent

`explore(ctx, task, options)` in `core/agent/explorer.ts`.

- The system prompt contains the audience, style rules, diagram rules, the JSON contract, scope-specific section requirements, and the full tool catalogue.
- The user prompt contains the structural digest (and, for changes, the diff and file history).
- The model replies with exactly one JSON object per turn: either a tool call or `{"final": …}`. We use a JSON protocol rather than provider-native tool calling so the same code path works everywhere.
### Finalisation protocol

Every safeguard below exists because a real model did the wrong thing during development:

- **Investigate first.** A final answer before `minTools` tool calls is refused once, with instructions.
- **One final answer, many shapes.** `{"final": …}`, a bare explainer object, `{"tool":"final","args":…}`, and the provider tool-call shapes (`{name, arguments}`, `{tool_calls:[{function:{…}}]}`, `{"list_dir": {…}}`) are all normalised to the same thing.
- **No repeated work.** An identical tool call is not re-executed, and more than five slices of the same file triggers a nudge to broaden the investigation.
- **Budget visibility.** Every observation carries `[Tool calls used: n of m]`, so the model can plan.
- **Context stays affordable.** Once observations exceed the character budget, the oldest half is elided — the earliest reads matter least by then.
- **Gap fill, not regeneration.** If the explainer is missing required section types, the model is asked for *only those sections*, in up to two rounds (the second is a diagram-only request that includes a literal, repo-specific JSON example). Asking a small model to rewrite everything rarely works; asking for two forgotten sections usually does.
- **Token ceilings are ceilings.** `num_predict` is generous (4 000) even on tool-call turns, because a model that decides to write during a planning turn was otherwise truncated mid-JSON.
- **A quiz is guaranteed.** If the model omits it, a short factual quiz is derived from routes, components, churn and services. Never applied to the static fallback.
- **Last chance.** If the loop exhausts its budget without a final answer, one more call is made that forbids tool use, so an investigation is never thrown away.
- Every step is streamed to the UI with its thought, tool, arguments, and a one-line summary.

Diagnostics that make failures legible: `dropped an unusable diagram section (…)`, `Ollama stopped at the token limit (num_predict=…)`, `model response looks truncated`, and `gap-fill round N produced nothing usable` are all logged at debug level.

Tools read real data only — no tool ever calls a model, and none writes to disk.

## The explainer contract

One shape for every kind of explainer (`core/explain/schema.ts`):

```jsonc
{
  "title": "…", "subtitle": "…", "tldr": "…",
  "sections": [
    {"type": "prose",   "title": "…", "markdown": "…", "level": "deep|narrow"},
    {"type": "callout", "variant": "concept|warning|edge|tip", "title": "…", "markdown": "…"},
    {"type": "diagram", "title": "…", "diagram": {"kind": "flow|layers|tree|compare|sequence|ui", …}},
    {"type": "code",    "title": "…", "language": "…", "file": "…", "startLine": 1, "code": "…"},
    {"type": "list" | "steps" | "table", …}
  ],
  "quiz": [{"question": "…", "options": ["…"], "answer": 0, "explanation": "…"}],
  "next":  [{"label": "…", "hint": "…"}],
  "sources": [{"path": "…", "startLine": 1, "endLine": 9}]
}
```

Model output is **normalised defensively**: unusable sections are dropped rather than failing the request, quiz answers are clamped into range, diagram nodes are validated and edges referencing missing nodes are discarded, and prose is truncated to a sane length. `next` is seeded from the static graph so drill-down is never hallucinated.

Explainers are cached per repository. On a model failure the structural fallback is generated, cached, and clearly labelled as such in the UI.

## Rendering and export

### Diagrams

Two rendering paths, chosen by the model per diagram:

- **Mermaid → SVG.** `flowchart` for the shape of a system, `sequenceDiagram` for an end-to-end job. A real graph
  engine draws branching and merging properly, and a sequence diagram is exactly the right shape for a lifecycle.
  The browser loads Mermaid on demand (code-split, so first paint is unaffected), renders with
  `securityLevel: 'strict'` and `htmlLabels: false`, caches by source, and falls back to showing the source if a
  diagram will not parse. The source is validated server-side against a list of supported diagram types before it
  is ever stored, so an unusable diagram is dropped at normalisation rather than failing in the reader's browser.
- **Structured HTML/CSS.** `layers`, `tree`, `compare`, `ui`, plus small `flow`/`sequence` shapes. Right for
  non-graph layouts, and they need no library at all.

Exports embed the SVG the browser drew. The client sends a map of `mermaidSvgKey(source) → svg` with the export
request; the server re-sanitises each SVG (rejecting `<script`, `on*=` handlers and `javascript:` URLs) before
inlining it, so the exported file is small, offline, and readable without JavaScript. Without a supplied SVG the
diagram source is shown with a note, which is what a headless export produces.

The same section model drives two renderers:

- `web/components/SectionRenderer.tsx` — React, with syntax highlighting (highlight.js, ~25 languages registered) and an interactive quiz that scores your answers.
- `core/explain/exportHtml.ts` — a single self-contained HTML file with inlined CSS/JS, real HTML/CSS diagrams, and the same interactive quiz. Markdown is escaped before parsing and sanitised afterwards; `<pre>` blocks always carry `white-space: pre-wrap`.

### Exports go deeper, not just wider

A one-level export is a dead end: "Where to go next" promises detail that the file does not contain. So an
export also generates the first *N* child explainers (default 3, max 8) and embeds them in the same file:

- each child gets an anchor (`#go-0`, `#go-1`, …) and a real link from the "Where to go next" card, with the
  child's section ids prefixed so nothing collides;
- the table of contents grows a "Deeper" group, each child gets its own heading, TL;DR, quiz and a
  "back to the top" link;
- targets that were not embedded are listed explicitly rather than silently dropped;
- children are served from the explainer cache, so re-exporting after drilling down in the app is instant.

Because a cold export can mean several model runs, the endpoint streams Server-Sent Events with per-child
progress instead of blocking on a single response.

### Caching and freshness

- An explainer is reused whenever it is structurally readable (`version === EXPLAINER_VERSION`). Being older than the analysis, or describing files that have since changed, is **reported as staleness** rather than triggering a silent rewrite: regeneration costs minutes and tokens and is the reader's call.
- Each explainer records `scope`: a content hash, size and mtime per file in scope, plus the commit it was written at. `checkStaleness()` compares that record with the working tree.
- A moved mtime is only a hint. `contentDiffers()` re-reads and hashes the file before reporting a change, so checkouts and formatters that rewrite identical bytes do not produce false positives. The baseline is one consistent snapshot — taking mtimes from disk and the hash from the analysis flagged every edited file permanently.
- The decision is the content-confirmed file list; the aggregate fingerprint is used only when a scope is too large to track file by file (over 4000 files), where the summary says so.
- `checkAnalysisStaleness()` does the same for the analysis itself, because a working-tree edit does not move `HEAD`.
- `ANALYSIS_VERSION` is part of the model cache key, so changing the analysis logic invalidates stored models instead of silently serving stale ones.
- Opening a repository by **path** or by **id** both resolve to the same cache entry — the path is mapped to its repo id before any lookup.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness, data and export directories |
| GET | `/api/providers` | provider status, models, availability |
| POST | `/api/providers/select` | switch provider |
| GET | `/api/repos` | recently opened repositories |
| DELETE | `/api/repos/:repoId` | forget a repository and delete its cache |
| POST | `/api/repos/open` | **SSE** analyse/open a repository |
| POST | `/api/repos/:repoId/analyze` | **SSE** force re-analysis |
| GET | `/api/repos/:repoId/model` | client model (heavy fields stripped) |
| GET | `/api/repos/:repoId/files?path=` | one level of the file tree |
| GET | `/api/repos/:repoId/file?path=` | file contents, symbols, chunk ranges |
| GET | `/api/repos/:repoId/symbols?q=&path=` | symbol search |
| GET | `/api/repos/:repoId/symbol?id=` | one symbol with callers and callees |
| GET | `/api/repos/:repoId/search?q=` | full-text search |
| GET | `/api/repos/:repoId/history` | commits and branches |
| POST | `/api/repos/:repoId/change` | build/cache a change |
| POST | `/api/repos/:repoId/change/explain` | **SSE** load a change and explain it |
| POST | `/api/repos/:repoId/explain` | **SSE** generate an explainer |
| GET | `/api/repos/:repoId/explainer?kind=&id=` | cached explainer |
| POST | `/api/repos/:repoId/explain/export` | write standalone HTML |
| GET/POST/DELETE | `/api/repos/:repoId/chat` | conversations (**SSE** for answers) |

SSE is used rather than WebSockets because every stream is one-directional (progress, tokens, a final payload) and SSE survives proxies. A 15-second heartbeat keeps connections alive through long local model runs.

## Failure modes we have already hit, and what the code does about them

Each of these was a real bug found by running the app on a real repository. They are documented because they are
the kind of thing that silently returns plausible nonsense.

| Symptom | Cause | Guard in the code |
| --- | --- | --- |
| Chat sat on "thinking" forever; no answer | The model streamed its reasoning to `message.thinking` while `message.content` stayed empty, and only `content` was read | Ollama requests always send `think: false`; a thinking-only stream raises a clear error; the chat route emits an explanation as a token if nothing was streamed, so the bubble can never hang |
| The explainer screen offered to "explain this repository" when one already existed | The UI only set explainer state from a generation stream, never from the cache | Opening a repository fetches the cached explainer first; the call to action says "Generate the explainer" |
| A quiz claimed Elasticsearch in an OpenSearch repository | A merged detector pattern reported the wrong product | Dependency names are exact identifiers, never substituted (see above) |
| Export "Where to go next" was a dead end | The export rendered the drill-down list as plain text | Exports embed the deeper explainers with real anchors |
| A quiz rendered twice in the export | Quiz sections were rendered in the body and again in a dedicated block | Single render, with a test asserting one quiz per explanation |
| Every server start re-analysed the repository | Opening by path passed a path where a repo id was expected, so the cache was never found | Paths are resolved to repo ids before any lookup |
| The model truncated mid-JSON | A tight `num_predict` on planning turns | Output ceilings are generous: `num_predict` is a ceiling, not a target |
| A finished run still showed the "live progress" panel | The step trace rendered in full whether or not the run was still going | It collapses to "Investigated with N tool calls" with a show/hide toggle once finished |
| Clicking "Go deeper" looked like nothing happened | The previous explainer stayed on screen, and the reader was scrolled to the bottom of it | Drilling clears the view, jumps to the top, and names the target being explained |
| Drill-down cards failed or did nothing | A model may suggest its own `next` targets, in any shape — including file paths where a directory was expected | `pruneNext` resolves each target or drops it, applied on both generation *and* cache reads, and turns a file path into its parent directory |
| A good answer was thrown away and the static outline shown instead | Markdown fields contain real newlines, which JSON forbids; a long answer was also cut off mid-JSON and salvaged into a fragment | The JSON repair escapes control characters inside strings and handles a dangling backslash, and a cut-off answer is re-requested once, more tersely |
| 12 tool calls for a single directory | One investigation budget for every scope | Budgets by scope: repo 12, component 10, flow 8, change 10, module 6 |
| A component was explained as "the seven files and what flows between them" | Nothing told the model which unit to use at which level, and diagram nodes were labelled with filenames | Prompts state the unit per scope with a worked example; `humaniseNodeLabel`/`humaniseMermaidLabels` rewrite filename labels to the responsibility, keeping the filename as detail; `cleanSectionTitle` drops a leading file count |
| "Go deeper" offered a sibling component | `next` mixed sub-directories with dependents under one heading, and the breadcrumb nested every jump | Targets carry a relation of `child`, `parent` or `related`, rendered as three labelled sections; parents are added deterministically; cross-references start a new trail |
| An explainer for a component that was later renamed or deleted reported "no files in scope" | The scope resolved to nothing, which is not the same as being current | A component or directory target that no longer resolves is reported as describing something that no longer exists in the analysis |
| A freshly written explainer reported itself out of date | The file baseline mixed on-disk mtimes with the analysis's content hash, so anything edited since the analysis looked permanently changed | The baseline is one consistent snapshot, and a moved mtime is confirmed by re-reading and hashing before a change is reported |
| A single-package repository was reported as one component called "src" | No workspace manifests, so the fallback anchored on the top-level source root | Anchors that own no manifest and contain several substantial child directories are descended through; a lockfile no longer inflates any component, and a source-less component is ancillary |
| Body extent stopped on the declaration line | A destructured parameter — `function f({ a, b }) {` — opened the body at its `{` and closed it at its `}`, both on that line. Every symbol taking an object parameter had a one-line body, so nothing inside it was scanned. Braces inside parentheses no longer count as the body, and an inline object return type is recognised because the next significant character is a brace, bracket, pipe or `=` |
| JSX was not a call | `<DiagramView />` renders one component from another but is not a call expression, so the call graph missed the primary composition mechanism of every React codebase, and everything downstream read that absence as "nothing renders this" | JSX element usage is extracted as a `jsx` call, with a lookbehind that keeps generic type arguments such as `Map<K, V>` out |
| `.js` import specifiers never resolved | TypeScript compiled to ESM must write `./thing.js` although the file on disk is `thing.ts`. The resolver only appended extensions, so it never found the file — 255 of 296 relative imports in a standard NodeNext project were unresolved, which emptied the import graph, the call graph and reachability | A JavaScript extension in a specifier is also tried as its TypeScript equivalent, after the literal path so a real `.js` file still wins |
| A test was counted from a string | Test-case detection matched anywhere in a file, so a fixture holding generated sample code was counted as a test that reaches nothing | Declarations are matched at the start of a line, which is how a formatter writes them |
| Freshness judged only by HEAD | A directory that gained version control kept its cached non-git analysis forever, because only the commit id was compared | The repository state is compared as well as the commit id |
| Verdicts about "dead code" were noisy | Local variables were captured as symbols, and class bodies produced duplicate call edges | Column-zero declarations only, class bodies excluded from call extraction, and a file-reachability condition on dead code |

## Credentials

One rule: **model settings live in `config.json`, credentials live in `.env`.**

- **`core/dotenv.ts`** is a small reader/writer: `KEY=value`, `export`, quoted values (single and double, with
  escapes inside double quotes), comments, values spanning lines, BOM/CRLF tolerance. Deliberately no variable
  interpolation or command substitution.
- **Loading.** `loadConfig` folds `.env` into `process.env` *before* reading any setting, and only for keys that
  are not already set, so a real environment variable always wins. Lookup order is working directory, then the
  app config directory.
- **Provenance.** `wasInjectedByDotEnv()` records which keys the loader actually supplied, so a key mentioned in
  `.env` but overridden by the shell is reported as `env`, not `dotenv`. `ProviderStatus.credential` reports
  `{ present, source }` and is populated on *every* status path — including authentication failures, which is
  exactly when a reader needs to know whether a key was sent.
- **Writing.** `saveCredentials` writes the conventional name (`OPENAI_API_KEY`) rather than the internal field
  name, preserves surrounding comments, and writes `0600` in a `0700` directory. Clearing a value removes the
  line instead of leaving an empty key.
- **Migration.** A key found in `config.json` is moved into `.env` once and deleted from the JSON.
- **Redaction is centralised.** `core/util/redact.ts` scrubs registered secret *values* (exact match, so a key
  that looks like ordinary text is still caught) plus credential *shapes*. It is applied at four chokepoints: the
  logger, the provider status builder, SSE frames, and the HTTP error handler. This exists because an upstream
  401 body quotes the key you just sent, and that string was being rendered into the UI.
- **Tests are hermetic.** `REPO_EXPLORER_DOTENV=0` in the server test and temp homes everywhere, so the suite
  never reads a developer's real `.env` or `config.json`.

## Known limitations

Stated plainly, because a tool that overstates its certainty is worse than one that does not:

- **No full parser.** Body extents and symbol extraction are heuristic. Deeply nested declarations, macros, and template metaprogramming will confuse the call graph.
- **Dynamic dispatch is invisible.** Reflection, dependency-injection containers, decorator registries, string-based routing, and dynamic imports leave edges unresolved. That is *why* dead code is labelled a question rather than a verdict.
- **Reachability is a lower bound.** A symbol not marked reachable may still run; a symbol marked reachable is genuinely called from an entrypoint through resolved edges.
- **Component classification is inferential.** It is based on imports and manifests, which is reliable for `api`/`ui`/`library` and less so for a component that does several things at once.
- **Churn needs history.** Shallow clones report no hotspots.
- **Local model quality varies.** The agent loop, the gap fill, and the structural fallback exist so that a weak model still produces something accurate. Larger models produce noticeably better explainers. A small local model reliably produces the prose, component list, complexity callout, quiz and a layered diagram, and less reliably produces sequence diagrams with concrete example data.
- **Each gap-fill round costs a model call.** The loop is capped at two rounds so a repository explainer does not take an unbounded amount of time on a slow local model.
- **Single-threaded analysis.** A 20k-file repository takes tens of seconds; the UI streams progress so it never looks hung.

## Testing

`npm test` runs 79 tests across five files:

- `text-and-json.test.ts` — tokenisation, truncation, tolerant JSON extraction (fences, trailing commas, truncation, delimiter-order repair).
- `analysis.test.ts` — classification, import bindings, specifier resolution (including Python relative imports), body extents, call extraction, call-graph resolution and reachability, route extraction, symbol extraction across languages.
- `analysis-e2e.test.ts` — the full pipeline against a multi-language fixture repository, search retrieval, explainer normalisation, HTML escaping, and the service layer.
- `agent.test.ts` — every tool against a real analysis, plus the exploration loop including the failure modes real models exhibit.
- `server.test.ts` — the HTTP API end to end, with SSE, change handling, chat persistence, export, and error status codes.

The fixture repository (`tests/helpers/fixtureRepo.ts`) is a small monorepo with TypeScript, TSX, Python, committed `node_modules` and `dist` output, and two git commits — chosen so that the interesting cases are all exercised.
