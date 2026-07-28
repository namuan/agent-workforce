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
- A software-development team with a tech lead, backend and frontend engineers, test engineer, and code reviewer. Its workspace tools are path-scoped, have no general shell, and require approval before creating or replacing a file or creating a pull request.

## How a request runs

The runtime does not choose a fixed sequence of agents. The model chooses from the tools available to the current agent. This is the complete request flow:

1. You start the CLI with `TEAM=<team-id>` or send the first `POST /chat` request with a `team`. The CLI creates one local session. The HTTP API creates a session and returns its `sessionId`.
2. The runtime records the session's team and principal. An HTTP session cannot change teams. The HTTP server accepts unauthenticated requests only when it binds to a loopback address. A non-loopback server requires `API_TOKEN` and takes the principal from `PRINCIPAL_ID`.
3. The runtime validates the team id, resolves `teams/<team-id>/`, rejects unsafe paths and symlinks, and loads that team's `team.ts` registry. The registry supplies the specialist list, delegation guidance, and a tool factory.
4. The runtime builds the lead's system prompt from the team's `instructions.md`, the specialist descriptions, and the delegation guidance. It creates only the lead's tools and sends the prompt, session history, user message, and JSON schemas for those tools to the configured OpenAI-compatible `POST /chat/completions` endpoint.
5. The model either returns text or requests one or more tool calls. For each tool call, the runtime parses its JSON arguments, runs the matching narrow tool, and adds the tool result to the conversation. Ordinary tool failures become tool results for the model to handle. A terminal delegated-specialist failure stops the request. The loop allows at most 12 model turns.
6. A lead can call `delegate`. The runtime then starts the requested specialist in a fresh session with the delegation brief as its only task context. The specialist gets its own `instructions.md`, tools, and list of available Markdown skills. It can call `load_skill` to read a `SKILL.md` or a safe reference file before acting.
7. Specialist tools read or change only the resources their team exposes. For example, marketing tools use `.data/` and configured service APIs. Software-development tools stay inside `DEV_WORKSPACE_DIR`, reject traversal and symlink escapes, and expose no general shell. Workspace paths are relative, such as `snake.html`, not `/workspace/snake.html`. New files are limited to the workspace root. File creation and replacement need approval. The specialist's final result becomes the `delegate` tool result for the lead.
8. A tool that needs consent does not act immediately. It stores the exact deferred action in the session, generates a single-use approval id, and returns a description. The action expires after 10 minutes. No external write happens before approval.
9. You approve the action with `/approve <id>` in the CLI or by posting the returned `sessionId` and `approvalId` to `/chat`. The runtime runs the saved action, adds its result to the original tool call, and resumes the lead so it can report the confirmed outcome without repeating the action.
10. The HTTP API retains session history and pending approvals only in memory. Restarting the process removes them. The CLI retains its session only until you exit.

### Example software-development request

Suppose you run the CLI with an approved worktree and ask: 'Change the default value in `src/config.ts` from `false` to `true`, then type-check the project.' The request can run as follows:

1. You start `TEAM=software-development DEV_WORKSPACE_DIR=/absolute/path/to/worktree pnpm dev`. The CLI creates a session for the software-development team. `DEV_WORKSPACE_DIR` is the only workspace its tools can use.
2. The software-development lead receives your request. It does not edit code. It may inspect the workspace or ask for missing acceptance criteria, then calls `delegate` with a complete brief for the backend engineer.
3. The backend engineer starts with a fresh session. It reads its instructions, loads the engineering skill, and reads `src/config.ts` through `read_workspace_file`. It cannot use a shell or read files outside the approved worktree.
4. If the engineer confirms the change, it calls `write_workspace_file` with the existing relative path and the complete replacement content. The runtime does not write the file. It returns an approval id and a summary such as 'Replace workspace file src/config.ts.'
5. You review that summary and enter `/approve <approval-id>`. The runtime uses the saved action to verify that the path is still inside the worktree, is not a symlink, and is a regular existing file. It then replaces that file only.
6. The runtime adds the confirmed write result to the lead's conversation and asks the lead to continue. The lead can delegate again, for example to the test engineer, which can run only `pnpm run check`, `pnpm run typecheck`, or `pnpm test` through `run_workspace_check`.
7. The lead returns the recorded tool output. It can say that the file changed only after approval. It can say that type-checking passed only if the check tool returned a successful result. If a check did not run or failed, it must say so.

The model decides whether to inspect, delegate, run an allowlisted check, or ask a question at each point. The runtime enforces the workspace boundary, tool input validation, approval pause, and 12-turn limit regardless of the model's choice.

## Run locally

Node 24 or newer is required.

```bash
pnpm install
TEAM=marketing pnpm dev
```

Run the software-development example with an approved workspace:

```bash
TEAM=software-development DEV_WORKSPACE_DIR=/absolute/path/to/worktree pnpm dev
```

The workspace does not need to be a Git repository. The Git-status tool reports that Git is unavailable when it is not one.

The default model endpoint matches the prior local setup:

```bash
MODEL_URL=http://localhost:9090/v1
MODEL_NAME=qwen3-8b
MODEL_API_KEY=optional-token
MODEL_TIMEOUT_MS=120000
```

Model requests time out after 120 seconds by default. Set `MODEL_TIMEOUT_MS` to an integer from 1 to 600000 when your model needs a different limit.

The CLI accepts `/exit`. When an action needs consent, it returns a token; run `/approve <token>` to perform that exact pending action. Tokens expire after 10 minutes.

## Debug processing

Set `DEBUG=1` to print a live trace while the runtime handles each request:

```bash
DEBUG=1 TEAM=software-development DEV_WORKSPACE_DIR=/absolute/path/to/worktree pnpm dev
```

`DEBUG=1` reports agent starts, model turns, tool names, delegation, approval pauses, and completion. It does not print prompts, user messages, tool arguments, tool output, or credentials.

Set `DEBUG=2` when you need to diagnose a tool failure. It includes sanitized declared scalar tool arguments, safe model and delegated-agent failure categories, and a failure detail. Credential-like fields are redacted, undeclared and nested arguments are omitted, and remote response bodies or structured error payloads are omitted. Do not use it where the remaining file paths or scalar arguments would be sensitive.

The HTTP server writes the same trace to standard error when started with either debug level.

## Session logs

Every session writes one JSON Lines file. By default, files are stored in `.data/session-logs/<session-id>.jsonl`. Set `SESSION_LOG_DIR` to use another central location.

The file records user messages, lead and specialist activity, model requests and raw responses, tool calls and results, approvals, and terminal errors. It does not record `MODEL_API_KEY`, HTTP request headers, or credentials embedded in the configured model endpoint. Logs may contain sensitive user and workspace data, so log files use owner-only permissions and must not be committed or shared without review. Logs are retained until you remove them.

Logging is best effort. A write failure does not stop a request, but `DEBUG=1` or `DEBUG=2` reports it with a `[log]` line.

## HTTP API

```bash
pnpm start
curl http://localhost:3000/health
curl -X POST http://localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"team":"marketing","principalId":"alex","message":"Help me sharpen our positioning"}'
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
