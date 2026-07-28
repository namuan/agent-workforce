# Customizing the native runtime

## Change a team

Add a specialist entry to `teams/<team>/team.ts`, then create `teams/<team>/subagents/<id>/instructions.md` and its skills. Add agent-specific tools in that team's `tools.ts` factory.

## Add a team

Create `teams/<id>/team.ts`, a lead `instructions.md`, specialist prompts and skills, and a separate narrow tool factory. The generic loader discovers the directory by id. Pass `team: "<id>"` when creating an HTTP chat session or set `TEAM=<id>` for the CLI. Keep storage and workspace boundaries separate between teams.

## Change prompts and skills

Edit Markdown instructions and skills in `teams/<id>/`. The runtime reads them at each new conversation, so no build step is needed. Skills require a `description:` frontmatter entry for the specialist to see them in its available-skill list.

## Add a tool

Add a `Tool` object in the team's tool factory. Give it a narrow JSON Schema, validate every input again at runtime, and require approval around irreversible actions. Do not accept arbitrary filesystem paths, arbitrary commands, or arbitrary external URLs.

## Change storage

Set `DATA_DIR` to move marketing state. To use a database or object store, update the owning team's storage helpers while preserving namespace and identifier checks.

For software-development work, set `DEV_WORKSPACE_DIR` to an approved worktree. The native tools read and replace existing files only within that directory, reject traversal and symlink escapes, and only run allowlisted `pnpm` checks.

## Change the model provider

Point `MODEL_URL` at any endpoint implementing OpenAI-compatible `POST /chat/completions`; set `MODEL_NAME`, and `MODEL_API_KEY` when required. The tool loop expects standard `tool_calls` responses.
