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
npm run build          # builds the UI and the server
npm start -- /path/to/repository
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

**Keys are never returned to the browser.** `/api/providers` and `/api/settings` report only whether a credential
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
- **Changes** — recent commits, branch comparison, and the working tree. Each one loads the diff and produces a change explainer plus a hunk-level diff viewer.
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
