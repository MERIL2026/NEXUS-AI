# NEXUS AI — Local-First AI Workstation CLI

NEXUS AI is a local-first, cross-platform AI workstation CLI that orchestrates local language models (via Ollama), retrieves private knowledge (RAG), manages project context, executes permission-controlled tools, and performs full coding-agent workflows — entirely on your own machine.

## Installation

### Requirements

- **Node.js** `>=20.0.0` — [nodejs.org](https://nodejs.org)
- **Ollama** — [ollama.com/download](https://ollama.com/download)
- At least one local model (e.g. `qwen2.5:3b`)

### Install NEXUS AI CLI

```bash
npm install -g @nexus-ai-nexoralabs/cli
```

### Install a local model (if you haven't already)

```bash
ollama pull qwen2.5:3b
```

### Launch NEXUS

```bash
nexus
```

That's it. NEXUS will initialize your workspace and configuration automatically on first run.

---

## First-Run Experience

When you run `nexus` for the first time, NEXUS will:

1. Create your personal workspace at `~/NEXUS-Workspace` (Windows: `%USERPROFILE%\NEXUS-Workspace`)
2. Initialize the local database at `%APPDATA%\NEXUS AI\data\nexus.sqlite` (Windows) or `~/.nexus-ai/data/nexus.sqlite`
3. Detect available Ollama models
4. Display the interactive dashboard

If Ollama is not installed or not running, NEXUS will display a clear, actionable setup guide instead of crashing.

---

## CLI Commands

Once inside NEXUS:

| Command         | Description                              |
| --------------- | ---------------------------------------- |
| `/help`         | Show all available commands              |
| `/models`       | List available local AI models           |
| `/model <id>`   | Switch to a specific model               |
| `/tasks`        | Show recent tasks                        |
| `/preview`      | Preview the latest completed web project |
| `/preview stop` | Stop the preview server                  |
| `/clear`        | Clear the screen                         |
| `/exit`         | Exit NEXUS                               |

---

## Subsystem Architecture

- `src/config/` — Environment configuration & production path resolution
- `src/storage/` — SQLite persistence & workspace abstraction
- `src/intelligence/` — Local Ollama gateway & model registry
- `src/knowledge/` — RAG document indexing & retrieval
- `src/tools/` — Controlled filesystem, search & terminal adapters
- `src/orchestration/` — Agent planning, execution & verification
- `src/preview/` — Local web project preview server
- `src/api/` — Application API contracts & health checks

---

## Developer Setup

```bash
# 1. Clone and install
npm install

# 2. Copy environment template
cp .env.example .env

# 3. Type check
npm run typecheck

# 4. Lint
npm run lint

# 5. Run tests
npm test

# 6. Build
npm run build

# 7. Run CLI in development mode
npm run agent
```

## Testing & Acceptance Verification

NEXUS uses a multi-tier verification strategy:

### A. Unit & Fast Integration Tests

```bash
npm test
```

Runs unit tests for isolated subsystems (routing, parsing, approval gate, tool execution, storage, config).

### B. In-Process Integration Acceptance

```bash
npx tsx scripts/verify_decomposition_acceptance.ts
```

Tests end-to-end task decomposition, multi-unit dependency resolution, and preview gating in-process via `ApplicationApi`.

### C. Real Installed CLI Black-Box End-to-End Acceptance

```bash
npm run test:e2e:cli
```

Spawns the actual installed `nexus` executable as a separate OS process, submitting prompts through interactive stdin, verifying dynamic CLI stdout, task plan cards, real child unit execution, `/tasks`, `/preview`, live HTTP preview responses, substance checks, and process restart/resume.

---

## License

MIT
