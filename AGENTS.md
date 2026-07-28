# AGENTS.md

This repository is a native Node.js multi-team agent runtime. Do not add an agent framework, web framework, AI SDK, MCP client, or runtime dependency unless the user explicitly asks for one.

## Commands

```bash
pnpm install
pnpm dev
pnpm start
pnpm validate
```

Node 24 runs TypeScript directly with `--experimental-strip-types`. `pnpm validate` must pass after edits.

## Layout

- `src/runtime.ts`, `src/team-loader.ts`, and `src/tools.ts`: team-agnostic tool loop, team loader, and contracts.
- `src/cli.ts` and `src/server.ts`: terminal and HTTP surfaces.
- `teams/<team>/team.ts`: team registry and tool-factory entry point.
- `teams/<team>/**/*.md`: team prompt and skill content.

Use native Node APIs and `fetch`. Keep tool schemas narrow, validate inputs, prevent filesystem traversal, and require approval tokens for destructive or audience-facing actions. Development workspace tools must remain path-scoped and allowlisted; never add a general shell. Never store credentials in source.
