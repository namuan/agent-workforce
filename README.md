# Agent Workforce

This is a framework-free set of marketing and software-development agent examples. It uses Node.js standard-library modules and `fetch` only: no agent framework, AI SDK, MCP client, or runtime package dependency.

Each directory under `teams/` is a self-contained example: prompts, skills, agent registry, and tool factory. The shared runtime in `src/` discovers and loads a requested team module without knowing team names or integrations.

## What it includes

- A lead that loads shared brand context and user preferences, then delegates to product marketing, content, social, SEO, or email specialists.
- Fresh specialist sessions and an explicit delegate tool.
- Markdown skill discovery and on-demand loading, including reference files.
- Local filesystem storage for brand context, per-user preferences, artifacts, and assets in `.data/`.
- Native model calls to an OpenAI-compatible `/chat/completions` endpoint.
- Native HTTP calls for public web reading, Notion, Typefully, and Resend.
- Approval tokens for destructive actions, Typefully scheduling/deletion, Notion updates/deletion, and all Resend sends.
- A terminal chat loop and a small JSON HTTP API implemented with `node:http`.
- A software-development team with a tech lead, backend and frontend engineers, test engineer, and code reviewer. Its workspace tools are path-scoped, have no general shell, and require approval before file replacement or pull-request creation.

## Run locally

Node 24 or newer is required.

```bash
pnpm install
TEAM=marketing pnpm dev
```

Run the software-development example with an approved repository worktree:

```bash
TEAM=software-development DEV_WORKSPACE_DIR=/absolute/path/to/worktree pnpm dev
```

The default model endpoint matches the prior local setup:

```bash
MODEL_URL=http://localhost:9090/v1
MODEL_NAME=qwen3-8b
MODEL_API_KEY=optional-token
```

The CLI accepts `/exit`. When an action needs consent, it returns a token; run `/approve <token>` to perform that exact pending action. Tokens expire after 10 minutes.

## HTTP API

```bash
pnpm start
curl http://localhost:3000/health
curl -X POST http://localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"principalId":"alex","message":"Help me sharpen our positioning"}'
```

Pass the returned `sessionId` to retain conversation state. To approve an action, post `{ "sessionId": "...", "approvalId": "..." }` to the same endpoint. The server binds to `127.0.0.1` by default. Setting `HOST` to a non-loopback address requires `API_TOKEN`; send it as `Authorization: Bearer <API_TOKEN>`. In that mode, identity comes from `PRINCIPAL_ID`, never from request JSON.

Include a valid `team` in the first `/chat` request, for example `"team":"marketing"` or `"team":"software-development"`. A session cannot change teams; approval follow-up requests use the session's stored team.

## Optional direct service credentials

The runtime uses direct REST calls rather than OAuth brokers or MCP. Set only the credentials for services you choose to use:

```bash
NOTION_API_KEY=secret_...
RESEND_API_KEY=re_...
TYPEFULLY_API_KEY=...
TYPEFULLY_API_BASE_URL=https://api.typefully.com/v1
DATA_DIR=.data
HOST=127.0.0.1
API_TOKEN=required-only-for-non-loopback-hosts
```

The software-development team additionally requires an explicit workspace path. GitHub reads require `GITHUB_TOKEN`; pull-request creation always pauses for approval.

```bash
DEV_WORKSPACE_DIR=/absolute/path/to/approved-worktree
GITHUB_TOKEN=github_pat_...
GITHUB_API_BASE_URL=https://api.github.com
```

`notion_request` is available to all specialists. The email specialist has a deliberately narrow Resend surface: domain listing, broadcast drafts, and explicitly approved sends. The social specialist calls the configured Typefully REST-compatible API. Do not expose the HTTP server without adding authentication and durable session storage.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Interactive terminal chat |
| `pnpm start` | Native JSON HTTP server |
| `pnpm build` | Type-check the runtime |
| `pnpm validate` | Lint and type-check |
| `pnpm test:e2e` | Run both teams against mocked model, service, workspace, and GitHub APIs |

## End-to-end tests

`pnpm test:e2e` starts in-process HTTP mocks for the OpenAI-compatible model, direct marketing services, GitHub, and an isolated development workspace. It runs both leads and specialists through the native `/chat` API, verifies approval pauses, then approves marketing publication actions and a workspace file replacement. No external credentials or network services are used.

See [ARCHITECTURE.md](./ARCHITECTURE.md) and [CUSTOMIZING.md](./CUSTOMIZING.md) for the runtime layout and extension points.
