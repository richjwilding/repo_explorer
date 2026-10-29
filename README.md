# Repo Explorer

A local-first desktop app that helps an engineering manager or CTO get comfortable with a codebase they have never seen.

Point it at a repository. It builds a real dependency and **call graph**, then an **agent** reads the code with that graph in hand and:

1. **Explains the architecture progressively** — a high-level map first (ancillary services, tooling and generated code deliberately hidden), then drill-down explainers per component, directory, and data flow as you click.
2. **Answers questions about the codebase** — citation-grounded chat where every claim links to a file and line range you can open.
3. **Explains commits, branches and PRs** — background, intuition, a grouped code walkthrough, and an interactive quiz, in the spirit of [`explain-diff-html`](https://gist.github.com/geoffreylitt/a29df1b5f9865506e8952488eac3d524).

It runs on Linux and macOS, works entirely offline through [Ollama](https://ollama.com), and never writes into the repository you are analysing.

---

## How discovery works

This is **not** "dump the repo into an LLM". The understanding comes from static analysis; the model's job is to investigate with tools and then write.

**Static analysis (deterministic, no model):**

| Stage | What it produces |
| --- | --- |
| File discovery | `git ls-files` (so `.gitignore` is honoured), then vendored/generated directories are hard-excluded even if committed |
| Language detection | 60+ languages, categories (source/test/docs/config/generated), noise detection |
| Import graph | Per-language import parsing **with local bindings**, resolved to real files (relative, alias roots, Python relative dots, index/extension fallbacks) |
| Module tree | Directory ownership, LOC, languages, roles, ancillary flags |
| Components | Workspace-aware (`package.json` workspaces, pnpm, per-directory manifests), classified by what they actually import |
| **Call graph** | Function/class/constructor/method edges resolved through imports, `self`/`this`, class members, and namespaces — with every unresolved edge left explicitly unresolved |
| **Reachability** | Breadth-first from route handlers, entrypoints and package surfaces → what is load-bearing vs. unreachable |
| Routes | FastAPI/Flask, Express/Fastify/Koa, Gin/Echo/Fiber, Spring, ASP.NET, Rails, Actix/Axum, gRPC, Next.js/SvelteKit/Remix file routing |
| Churn & hotspots | Per-file commit counts from git history weighted by size |
| External dependencies | Discovered from evidence — container images, service-naming env vars, connection-string schemes and unresolved package specifiers — never from a curated product list |
| Retrieval index | Symbol-level chunking plus a BM25 index with path/symbol boosting |

**The agent (the model with tools):**

The model is given the structural map plus a tool catalogue — `read_file`, `search_code`, `find_symbol`, `callers_of`, `callees_of`, `trace_calls`, `list_routes`, `find_hotspots`, `find_dead_code`, `git_log`, `component_summary` and more. It works in a loop:

```
{"thought": "…", "tool": "callers_of", "args": {"symbol": "resolve_tenant"}}
        ↓  (observation returned)
{"thought": "…", "tool": "read_file", "args": {"path": "…", "startLine": 40}}
        ↓
{"final": { …the explainer… }}
```

Every step is streamed to the UI, so you watch the investigation happen. The protocol is plain JSON rather than provider-native tool calling, so it behaves identically on Ollama, OpenAI-compatible servers, and Anthropic.

**Nothing here is presented as certain when it is not.** Unresolved calls stay unresolved, unreachable code is labelled "a question to investigate, not proof", and if the model is unavailable the app still shows the structural analysis.

---

## Requirements

- Node.js 20.11 or newer
- Git (optional but recommended)
- A model: **Ollama** running locally (default), or an OpenAI-compatible endpoint, or an Anthropic API key

## Install and run

```bash
npm install
npm start -- /path/to/repository
```

`npm start` builds the first time, and rebuilds whenever the sources are newer
than the build. A clean build takes a few seconds. `dist/` is not committed, so
there is nothing to download ready-made.

To build explicitly — for a deploy, or to see build errors on their own:

```bash
npm run build
```

Or use the launcher, which builds on first run and opens your browser:

```bash
node bin/repo-explorer.mjs /path/to/repository
```

For UI development with hot reload:

```bash
npm run dev            # Vite on :5173 proxying /api to :5178
```

## Choosing a model

Click **Model** in the top bar (or *use a hosted model* on the welcome screen) and pick one:

| Option | What to enter |
| --- | --- |
| **Anthropic** | An API key. Models are discovered automatically (`claude-opus-4`, `claude-sonnet-4`, …). |
| **OpenAI-compatible** | A base URL and, if required, an API key. Works with OpenAI (`https://api.openai.com/v1`), Azure-style gateways, Groq, OpenRouter, Together, vLLM, LM Studio, llama.cpp — anything exposing `/chat/completions` and `/models`. |
| **Ollama (on-device)** | Nothing, if it is already running on `http://127.0.0.1:11434`. |

Model settings are written to `~/.repo-explorer/config.json`; API keys go to `~/.repo-explorer/.env`. Both are remembered.
If a chosen provider cannot be reached, the choice is saved, the app keeps working on the previous model, and the
panel tells you what failed — it never silently pretends to have switched.

The same thing from a terminal:

```bash
# Hosted model via environment variables
export ANTHROPIC_API_KEY=sk-ant-...        # or:
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1
npm start -- /path/to/repository

# Or write the config file directly
cat > ~/.repo-explorer/config.json <<'JSON'
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5"
}
JSON
```

Note that **environment variables win over the config file**, which is what you want in containers and CI. If you
set a key in the app and it appears to be ignored, the panel will tell you which environment variable is
overriding it.

Auto-detection order when no explicit choice is made: Anthropic → OpenAI-compatible → **Ollama** → built-in
offline fallback.

**Ollama (default, fully local):**

```bash
ollama serve
ollama pull qwen3          # or any capable chat model
```

The app picks the strongest local model it can find and requests a 64k context window (Ollama's default silently
truncates long prompts). It always sends `think: false`: reasoning models such as qwen3 otherwise stream their
chain of thought into a field the reader never sees, which makes answers arrive blank and roughly four times
slower. Embedding-only models are never selected.

**OpenAI-compatible** (OpenAI, DeepSeek, Together, Groq, OpenRouter, vLLM, LM Studio, llama.cpp):

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1   # or http://localhost:1234/v1
```

**DeepSeek** — either paste the key in the app under *Model*, or put this in `~/.repo-explorer/.env`:

```ini
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com/v1
REPO_EXPLORER_MODEL=deepseek-chat
REPO_EXPLORER_PROVIDER=openai
```

Use `deepseek-chat`, not `deepseek-reasoner`. Explainer generation asks for a long structured JSON answer, and a
reasoning model emits its chain of thought before any answer: the app discards that monologue (it is not the
answer) and, if a model produces reasoning and no answer at all, says so plainly rather than appearing to hang.
Reasoning output is recognised for both `reasoning_content` (DeepSeek) and `reasoning` (other vendors).

**Anthropic:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Models that reject a request parameter

Model APIs change faster than any list of model names survives. If a model
rejects `temperature` — Claude's current models call it deprecated, and OpenAI's
reasoning models reject it outright — the app drops the parameter for that model,
retries, and remembers, so the cost is one round trip the first time and nothing
after that. Everything the request needs to work is discovered this way rather
than assumed from a name.

## Configuration

Any of these can be set as environment variables, or written to `~/.repo-explorer/config.json`:

| Setting | Environment variable | Default |
| --- | --- | --- |
| Data directory | `REPO_EXPLORER_HOME` | `~/.repo-explorer` |
| Port | `REPO_EXPLORER_PORT` | `5178` |
| Provider | `REPO_EXPLORER_PROVIDER` | `auto` — also settable in the app |
| OpenAI base URL | `REPO_EXPLORER_OPENAI_BASE_URL` / `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| OpenAI key | `REPO_EXPLORER_OPENAI_API_KEY` / `OPENAI_API_KEY` | unset |
| Anthropic key | `REPO_EXPLORER_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` | unset |
| Model | `REPO_EXPLORER_MODEL` | auto-detected |
| Export directory | `REPO_EXPLORER_EXPORT_DIR` | `~/RepoExplorer` |
| Ollama URL | `OLLAMA_HOST` | `http://127.0.0.1:11434` |
| Max files analysed | `REPO_EXPLORER_MAX_FILES` | `20000` |
| LLM request timeout | `REPO_EXPLORER_LLM_TIMEOUT_MS` | `900000` (15 min — local models are slow) |
| Ollama context window | `REPO_EXPLORER_OLLAMA_NUM_CTX` | `65536` |
| Ignore `.env` | `REPO_EXPLORER_DOTENV` | unset (set to `0` to disable) |
| Deeper explainers per export | `children` in the export request | `3` (max 8) |
| Log level | `REPO_EXPLORER_LOG` | `info` |

## When a provider cannot be used

Saving a model choice always records it, even if the provider cannot be reached. The app never silently pretends
to have switched, and it never stops working:

- the top bar shows **what you chose**, and adds a warning naming the provider that is answering instead;
- the settings panel says *"Saved, but Anthropic Claude cannot be used yet — still running on Ollama"*, and shows
  the provider's own error (for example `HTTP 401 — API key is invalid`), rather than a success message;
- a model name belongs to a provider, so switching between them does not carry a model across — `qwen3.6:latest`
  is meaningless to Anthropic.

If a key was pasted into the wrong provider, use *Remove the stored key* next to the field and paste it again.

## Where your API key is stored

In **`.env`** — one file, one rule:

```
~/.repo-explorer/.env          # or a .env in the working directory
```

```ini
OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_BASE_URL=https://api.openai.com/v1
```

Typing a key into the settings panel writes it to that file (`0600`, inside a `0700` directory). Model settings —
provider, model, base URL — live in `config.json`. **Credentials never go in `config.json`**, and if an older
version left one there it is moved into `.env` on startup.

Precedence when reading a key: **real environment variable → `.env` in the working directory → `.env` in the app
config directory.** So `export OPENAI_API_KEY=...` in a shell session still wins, which is what you want in a
container or CI, and the settings panel tells you when something is overriding the file.

```bash
export REPO_EXPLORER_DOTENV=0        # ignore .env entirely
export REPO_EXPLORER_HOME=~/somewhere # move both files
```

**Selecting a provider and entering a key is one action: **Save and test** writes
the key to `.env` and reports whether the provider is now reachable. If it is not,
the panel says which of the two things is wrong — the key was rejected, or the
provider was never configured — rather than that it does not know the provider.

Keys are never returned to the browser.** `/api/providers` and `/api/settings` report only whether a credential
is present and where it came from, and every user-visible string — provider status details, error messages, SSE
frames and log lines — passes through a redactor that strips both known key values and anything shaped like one
(`sk-…`, `sk-ant-…`, `Bearer …`, `x-api-key: …`, `AIza…`, `hf_…`). That matters because an upstream 401 body
quotes the key you just sent.

## What gets stored, and where

Everything lives under `~/.repo-explorer`:

```
~/.repo-explorer/
  config.json
  data/repos.json                  # the repositories you have opened
  data/repos/<id>/model.json       # the analysis
  data/repos/<id>/index.json       # the BM25 snapshot
  data/repos/<id>/explainers/*.json
  data/repos/<id>/changes/*.json
  data/repos/<id>/chats/*.json
```

Nothing is ever written into the repository under analysis. Exported explainers are self-contained HTML files written to `~/RepoExplorer` with a `YYYY-MM-DD-` prefix so they sort by date and stay out of version control.

**Privacy:** with Ollama, no source code leaves your machine. With a hosted provider, the prompts (which include code excerpts) are sent to that provider — the top bar marks local providers explicitly.

## Levels, not inventories

Explanations are written at the level you are looking at, and the unit changes with it:

- **Repository** — subsystems, and what flows between them. Individual files are never enumerated.
- **Component** — the responsibilities it performs. Two modules that do one job together are one part, named after
  the job. Files appear only as evidence.
- **Directory** — here the files *are* the units, and the explanation says what each is for.

Diagram nodes follow the same rule. A node labelled `generate.ts` says where code lives, not what it does, so
filename labels are rewritten to the responsibility (`generate`) with the filename kept as supporting detail. The
model is also told not to title a section by counting files: *"Seven files, four responsibilities"* becomes
*"Four responsibilities"*.

Navigation is explicit about direction:

| Section | Meaning |
| --- | --- |
| **Go deeper** | inside what is on screen — its sub-directories |
| **Part of** | the scope that contains it, for zooming out |
| **Where this is used** | other components that depend on it — alongside, not inside |

Following a cross-reference starts a new trail rather than nesting under what you were reading, so the breadcrumb
never implies a hierarchy that is not there.

## What is measured, and how

Everything the app asserts about structure comes from static analysis, and the
language model investigates with those results rather than reading the repository
blind. The measurements are listed here because each one is a claim the model is
allowed to make.

| Measured | How | What it is not |
| --- | --- | --- |
| Call graph | symbol-level, resolved across files through imports and bindings; includes `new`, methods, callbacks and JSX element usage | not a type-checked graph — a call through a dynamically chosen property will not appear |
| Reachability | breadth-first from detected entrypoints over resolved edges | unreached is a question to investigate, never a verdict |
| Test coverage | a source file is *reached* when a test file imports it, calls into it, or gets there within two hops through fixtures | says something exercises the code, **not** that the code is correct |
| Hotspots | commit count weighted by size | churn is not risk |
| Dependency names | the exact identifiers found in imports, container images, environment variables and connection strings | no curated product list, so an unfamiliar name is reported as written |

### Test coverage

The Tests tab answers the question an engineering leader asks first. It is
derived from the import and call graphs, so it is exact rather than sampled:

- **By component**, least covered first, so the weakest area is the first thing
  you see.
- **The riskiest gaps** — files no test reaches that also carry the most commit
  history, which is where churn meets absence of verification.
- **Files no test reaches**, largest first.
- **Tests that reach no source file at all**, which usually means they exercise a
  library or a fixture rather than this repository's own code.

A file under `tests/` only counts as a test if it actually declares a test case.
A fixture or helper is not evidence of coverage, and neither is a file that
merely mentions a test case inside a string.

### How it runs

The **Running it** tab answers the question that reading source cannot: if I
change this, what runs, what checks it, and how does it reach production? It is
read from files whose whole purpose is to state those facts, never inferred from
a dependency's name:

| Read from | What it tells you |
| --- | --- |
| CI definitions (GitHub, GitLab, CircleCI, Buildkite, Azure, Jenkins, …) | triggers, jobs, the exact commands a merge must pass, the actions used |
| `Dockerfile`s | stages and base images, exposed ports, entrypoint, `USER`, healthcheck, and whether dependencies are cached or rebuilt on every source change |
| Compose files | services, images, ports, start ordering, environment names |
| Kubernetes, Terraform, Helm, CloudFormation, Serverless | the resources declared, and the container images actually deployed |
| Package and build scripts | which script is the test, the build, the lint, the migration, the deploy |
| `.env` files, code accessors, shell `export` | the configuration somebody has to set to run the thing |

**An absence is reported as plainly as a presence.** "No CI definitions found —
nothing automatically verifies a change" is a finding an engineering leader can
act on, and it is not the same statement as "I did not look". The same applies
to a container with no `USER` (it runs as root), or with no healthcheck.

Environment variables that appear only in tests or fixtures are listed
separately and never head the list, so a fixture's `DATABASE_URL` is not
mistaken for a deployment requirement.

### Complexity, not size

Line count is the cheapest proxy for "this is hard" and a poor one: a 400-line
table of constants is easy, and a 40-line function with eight nested branches is
not. So complexity is **measured** per definition:

- **Decision points** — the branches a reader has to hold in their head.
- **Control-flow nesting** — how deep those are stacked, weighted twice in the
  score, because holding an outer condition while reasoning about an inner one
  is the expensive part.
- **Blast radius** — how many callers depend on it. Changing a branchy function
  nothing calls is cheap; changing one with thirty callers is not.

The History tab ranks the hardest definitions to change safely, and ranks files
by complexity × churn rather than size × churn.

Three things the measurement deliberately excludes, because each would make the
numbers untrustworthy:

- **Keywords in strings and comments.** `"if you want, for the while case"` is
  not five branches. Code is stripped of comments and string contents first.
- **An indented object literal.** A brace opens a nesting level only when what
  precedes it is a control construct or a function head, so a nested config
  object is not counted as complexity.
- **A file with no function bodies.** A heavily edited stylesheet or lockfile
  has no measurable complexity, so it is ranked by size and *labelled* as such
  rather than mixed into the same ranking as if the numbers were comparable.

### Coupling and ownership

The History tab also reads history rather than code, because the import graph
shows the architecture a project *declares* and history shows the one it *has*:

- **Files that change together.** Confidence is "when one changes, the other
  usually does". Pairs spanning two components are listed first — those are
  dependencies the import graph does not show, and usually the reason a small
  change turns out to be large.
- **Who owns what**, per component, with the share contributed by the most
  active author.
- **Bus factor** — how many people have to leave before nobody is left who has
  written half a component's history. A component where one person wrote at
  least 80% of the history over enough commits to make the pattern real is
  flagged as key-person risk.

Three things are deliberately not reported, because reporting them would be
noise rather than signal: a pair seen together once, a file that changes in
almost every commit (it couples with everything, which says nothing), and a
commit touching more than forty files (a merge or a whole-repo reformat).
Excluded large commits are counted and disclosed.

Comparing a `FeatureBranch` against a base is not needed for any of this — it
all comes from one pass over the default branch's log.

### Contracts and the data model

The Contracts tab holds the interfaces and the data: the endpoints the code
declares, the API definitions it publishes, and the shape of what it stores. A
schema is a claim the system makes about the world and is usually the most
stable thing in a repository, which makes it a fast route in.

Read from the files that declare the shape, never inferred from usage:

| Format | What is read |
| --- | --- |
| SQL (`.sql`) | tables, columns with types extracted separately from their constraints, primary keys including composites, foreign keys from both column definitions and later `ALTER TABLE`s, and the order migrations would apply |
| Prisma | models, fields with `?` and `[]` separated from the base type, `@id` and `@@id` keys, enums |
| GraphQL | types, inputs, interfaces, unions, field nullability, and `Query`/`Mutation` fields as operations |
| Protobuf | messages, field labels, enums, services and their `rpc`s |
| OpenAPI / Swagger | component schemas, required fields, and operations |
| JSON Schema | properties and required fields |

Two things are stated plainly rather than left blank:

- **A database with no schema in the repository.** If the dependencies name a
  store but no table or model is found, the tab says the schema lives elsewhere.
  That is worth knowing before reaching for a migration.
- **A store only a test mentions.** `postgres://` inside a fixture is not a
  PostgreSQL deployment, so a store named only in tests is listed separately and
  never presented as production storage.

### Conventions, and where the code breaks them

The Conventions tab is the step from describing a codebase to reviewing it.
Every rule is **inferred by measuring this repository's own behaviour** — the
majority direction of its imports, the names it actually uses, where its tests
actually live — and is only stated when it is both well supported (at least five
cases) and closely followed (at least 80%). A rule followed by three files is
not a convention.

Rules that can be derived this way:

| Rule | Derived from |
| --- | --- |
| Dependency direction — "`core/chat` depends on `core/agent`, not the reverse" | the majority direction of each component pair in the import graph |
| File naming per directory and extension | the names of the files themselves |
| Where tests live, and what they are called | the placement and names of files that actually declare test cases |
| Single-door configuration — "configuration is read through `config.ts`" | which file holds most of the environment reads |
| Single-door logging | which files import the project's own logger |
| Directory barrels | whether multi-module directories re-export through an `index` |

A convention here is a **description, not an opinion**: it says what the code
does, not what is generally considered good practice. An exception is a question
worth asking rather than a defect.

Two things are deliberately kept out:

- **A helper is not a test.** A fixture under `tests/` does not follow the test
  naming convention because it is not a test, so counting it would manufacture
  an exception that does not exist.
- **A pattern that is genuinely mixed is reported as mixed**, not promoted to a
  rule and then used to flag half the repository. A mutual dependency between
  two components is a finding in its own right, but it is not one of them
  breaking a rule.

### What the repository does not say

The Gaps tab reports **negative space** — what is absent, which is harder to see
than what is present and often more useful. A missing migration or an untested
complex path is invisible in a list of what exists, and it is exactly what an
incoming leader needs to know.

Two rules govern every finding:

1. **Only report an absence derivable from a measured fact.** "No test reaches
   this file" comes from the coverage graph. "This is insecure" is not derivable
   and is never said.
2. **An absence is an observation, not a verdict.** A project can have no CI, or
   no licence, for a good reason that is not visible from here. Each entry names
   the facts behind it and leaves the judgement to the reader.

What is checked:

| | |
| --- | --- |
| Verification | no CI at all; CI that does not appear to run the tests it has; no tests at all; the hardest-to-change functions with no test reaching them |
| Running it | no deployment definition; containers without a healthcheck; no observability library named for something that is deployed |
| Data | a store in use with no declared schema; tables declared with no migration history |
| Onboarding | no lockfile; configuration read but no `.env.example`; no README; no licence |
| Robustness | route handlers whose opening shows no error handling (stated as a reading of the handler, not a guarantee); unreachable definitions |

Findings are ordered by how much they usually matter, and every expectation that
*is* met is listed alongside them, so the report reads as a balance rather than a
list of complaints.

## Pull requests

A pull request is read from **GitHub's API**, not from your clone. That is a
deliberate choice on two counts: `git fetch origin pull/N/head` would write refs
into the repository being analysed, and most PRs you are asked to read were never
checked out locally.

Give it a number and it fetches the whole PR — title, description, the commit
list, and every changed file with its patch — then runs the ordinary change
explainer over it. So a PR explainer gets the same Background, Intuition,
walkthrough and quiz as a commit, and the same self-contained HTML export.

```
Changes → Pull request → 25 → Explain this pull request
```

It uses the `origin` remote of the open repository. An `owner`/`repo` pair can be
passed to read a PR somewhere else.

**Private repositories need a token.** Add `GITHUB_TOKEN` (or `GH_TOKEN`) to
`~/.repo-explorer/.env`. Without one GitHub allows 60 requests an hour, which is
enough for casual use and not much else. The token is used only for these
requests, is never returned to the browser, and is scrubbed from logs like every
other credential.

### What a PR failure tells you

Reading a PR can fail in ways that look identical and are not, so each one is
reported distinctly:

| | |
| --- | --- |
| Not found | the number is wrong — **or** the repository is private and you have no token. The message says both, because they are otherwise indistinguishable |
| Rejected token | `GITHUB_TOKEN` is set but wrong |
| Rate limited | says when the limit resets, and that a token raises it |
| No `origin` remote | there is no GitHub repository to ask about; set one, or pass the owner and repository |
| Unreachable / unreadable | GitHub is down or answered something unexpected |

Only the last two are reported as server errors; a missing remote or a wrong
number is a 400 or 404, because it is a problem with the request rather than with
the app.

## When an explanation cannot be written

If the model cannot produce one, the app says which of several things happened
rather than offering a guess:

- the agent used its whole investigation budget without writing — usually
  transient, and it says so;
- no provider is configured, or the credential was rejected;
- the provider could not be reached;
- the reply could not be read as an explainer.

The structural outline is always shown, clearly labelled as an outline rather
than an explanation, so a failure degrades to something readable instead of an
empty panel.

Before it falls back, it tries hard not to: the investigation loop never abandons
work it has already done on the grounds that the model stopped responding, and
the recovery attempts run on a much smaller context than the one that failed —
the seed and a note of what was verified, rather than the whole transcript.

## Repositories without git

Architecture and source explanations work on any directory, tracked or not. Commit, PR and diff explainers need
version control, and an empty Changes tab always says which of the four cases you are in rather than showing a
blank list:

| Situation | What the app says |
| --- | --- |
| Not a git repository | *"This directory is not a git repository"* — with the two likely fixes: open the repository root, or `git init` here |
| A git repository with no commits | *"This repository has no commits yet"* |
| git exists but cannot read the history | *"git could not read this repository's history"*, with git's own message (shallow clone, missing binary, unusual state) |
| Commits exist | the normal commit, branch and working-tree views |

The top bar also carries a quiet notice when the opened directory is not under version control, so the empty tab is
not a surprise.

## Keeping explanations honest about time

An explainer is a snapshot of an understanding, and code keeps moving. Rather than guess, each explainer records
what it was written against: a content hash, size and modification time for every file in its scope, plus the
commit it was generated at.

When you open one, the app checks that record against the code and tells you if it is behind:

> **Out of date — the code has changed since this was written.**
> Out of date: 2 of 6 file(s) changed. It is still shown in full, and it is usually worth reading; regenerate when
> you want it rewritten against the current code. `[Show what changed (2)] [Regenerate]`

Three rules:

- **Nothing is hidden, deleted or silently regenerated.** A slightly stale explanation of a component is usually
  still the most useful thing on screen. Regenerating costs minutes and tokens, so it is your decision.
- **Only real changes count.** A moved modification time is treated as a hint: the file is re-read and hashed
  before anything is reported, so a `git checkout` or a formatter rewriting identical bytes does not raise a
  false alarm.
- **Scope is per explainer.** Editing `src/core/llm` marks the LLM explainer out of date and leaves the
  `src/core/agent` one alone. Explanations of a committed change never go out of date, since a diff is immutable.

The **analysis** has its own freshness check for the same reason: a working-tree edit does not move `HEAD`, so
without it the analysis could quietly fall behind. When it does, the app says so and offers a re-analyse.

Drill-down cards for child explainers that are already written and out of date carry an **out of date** chip, so
you can see it before you open one.

## Diagrams

The two diagrams that matter most — **the shape of the system** and **one job end to end** — are drawn with
Mermaid, rendered to SVG by a real graph engine:

- a `flowchart` for the system, so branching and merging are legible rather than flattened into a row of boxes;
- a `sequenceDiagram` for a request or job lifecycle, which is the clearest possible view of an ordered exchange.

Mermaid is loaded on demand (the initial page load is unaffected), and every diagram uses real names from the
analysis — components, files and endpoints — never placeholders.

Small, non-graph shapes (layers, trees, before/after comparisons, UI regions) are still rendered as plain HTML/CSS,
because a graph engine is the wrong tool for those.

**Exports embed the rendered SVG.** When you export, the browser sends the SVGs it drew, so the file contains real
diagrams, needs no JavaScript to display them, and stays small — an explainer with two diagrams is around 84 KB
rather than the megabytes that inlining a diagram library would cost. A diagram that fails to draw shows its
source instead of an empty box.

`npx tsx scripts/mermaid-dump.ts diagram.mmd` renders a diagram headlessly, which is handy when checking why one
did not draw.

## The interface

- **Overview → Explainer** — the progressive explainer, with drill-down cards that generate child explainers, plus an export button.
- **Overview → Architecture** — components (with a toggle for supporting components), detected endpoints, churn hotspots, possibly-unreachable code, an inventory of what the system depends on (with provenance), entrypoints, and the codebase's vocabulary.
- **Chat** — streaming answers with clickable citations, saved conversations, and starter questions derived from the analysis.
- **Changes** — recent commits, branch comparison, and the working tree. Each one loads the diff and produces a change explainer plus a hunk-level diff viewer. A branch can be read two ways: its own commits since it diverged from the base (the default, and the better answer to "what is this branch about"), or its tip against the base tip. The second is used automatically when the first would be empty — a branch that is already merged has no commits of its own, and saying so with an empty diff is how that used to be reported.
- **Export HTML** — writes a self-contained file to `~/RepoExplorer` that includes the first three *deeper* explainers as full sections, so "Where to go next" links actually work offline. Nested explainers are served from cache when you have already opened them.
- **Files** — file tree, symbol search (with caller counts), full-text search, and a code viewer that shows *callers* and *callees* for any symbol.

## Development

```bash
npm run dev          # server + Vite
npm run typecheck    # strict TypeScript, no emit
npm test             # 79 tests: analysis, call graph, index, agent loop, HTTP API
npm run build        # UI + server
npx tsx scripts/analyze.ts /path/to/repo            # print the analysis
npx tsx scripts/analyze.ts /path/to/repo --agent    # run the agent and print each step
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map, the analysis pipeline, and the honest list of limitations.

## License

MIT
