# Architecture

## Runtime

`src/runtime.ts` is the generic agent loop. `src/team-loader.ts` safely loads a requested `teams/<id>/team.ts` module, then the runtime sends OpenAI-compatible chat-completion requests with that team's JSON-schema function tools. The lead exposes `delegate`; delegation starts a fresh specialist session with only the complete brief and the shared approval map.

`src/tools.ts` holds generic tool-factory contracts only. Team-owned tool factories live beside their prompts: `teams/marketing/tools.ts` and `teams/software-development/tools.ts`. Both use native APIs only. Development tools use a `DEV_WORKSPACE_DIR` boundary, reject traversal and symlink escapes, allow only lint, typecheck, and test commands, and require approval before a file replacement or GitHub pull-request creation.

`src/cli.ts` provides the local terminal interface. `src/server.ts` exposes `GET /health` and `POST /chat` through `node:http`; in-memory sessions retain chat history and pending approval actions.

`test/marketing-e2e.test.ts` and `test/software-development-e2e.test.ts` are HTTP-level integration suites. They use deterministic model mocks and direct-service mocks. The development suite also uses an isolated temporary workspace and mocked GitHub API.

## Content

Every team owns its `instructions.md`, `subagents/<name>/instructions.md`, `skills/`, and `team.ts` module. Specialist and optional shared `skills/` folders are Markdown source, and `load_skill` reads an entire `SKILL.md` or a constrained relative reference path at runtime.

## State and safety

`.data/brand-context/brand.md` is shared. User preferences are stored under a SHA-256 hash of `principalId`. Artifacts have validated, slug-like ids, and ordinary assets use basename-only filenames to prevent traversal.

High-impact tool calls do not execute inline. They create a random, single-use approval token in the session, with a 10-minute expiry and a reviewable action summary. The CLI requires `/approve <token>` and the HTTP API requires an `approvalId`. Approval tokens are held only in memory, so restarting the process cancels pending actions.

## Integrations

The Notion, Resend, and Typefully calls are direct HTTPS requests and use environment API keys. No OAuth connector, MCP client, or remote tool discovery is present. Notion is limited to page, block, database, and user reads; search; page creation; and approved page/block updates. The HTTP API binds loopback by default. A non-loopback `HOST` requires `API_TOKEN` and a server-derived `PRINCIPAL_ID`; replace the in-memory session map before production use.
