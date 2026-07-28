import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Tool, ToolFactoryContext } from "../../src/tools.ts";

const execFileAsync = promisify(execFile);
const maxFileLength = 200_000;
const maxOutputLength = 50_000;
const implementationSpecialists = new Set([
  "backend-engineer",
  "frontend-engineer",
  "test-engineer",
]);

const schema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  additionalProperties: false,
  properties,
  required,
  type: "object",
});

const stringSchema = (
  description: string,
  maxLength = 100_000
): Record<string, unknown> => ({ description, maxLength, type: "string" });

const object = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tool input must be an object.");
  }
  return input as Record<string, unknown>;
};

const text = (
  input: Record<string, unknown>,
  field: string,
  max = 100_000
): string => {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(
      `${field} must be a non-empty string of at most ${max} characters.`
    );
  }
  return value;
};

const workspaceRoot = async (): Promise<string> => {
  const configured = process.env.DEV_WORKSPACE_DIR;
  if (!configured) {
    throw new Error(
      "DEV_WORKSPACE_DIR must name the approved development workspace."
    );
  }
  return realpath(configured);
};

const workspacePath = async (path: string): Promise<string> => {
  if (isAbsolute(path) || path.includes("\0")) {
    throw new Error("Workspace paths must be relative.");
  }
  const root = await workspaceRoot();
  const target = resolve(root, path);
  if (relative(root, target).startsWith("..") || target === root) {
    throw new Error("Workspace paths must stay inside the approved workspace.");
  }
  const resolvedExisting = await realpath(target);
  if (
    !(resolvedExisting === root || resolvedExisting.startsWith(`${root}${sep}`))
  ) {
    throw new Error("Workspace paths may not traverse through symlinks.");
  }
  return target;
};

const newWorkspacePath = async (path: string): Promise<string> => {
  if (isAbsolute(path) || path.includes("\0")) {
    throw new Error("Workspace paths must be relative.");
  }
  const root = await workspaceRoot();
  const target = resolve(root, path);
  if (relative(root, target).startsWith("..") || target === root) {
    throw new Error("Workspace paths must stay inside the approved workspace.");
  }
  if (dirname(target) !== root) {
    throw new Error(
      "New workspace files must be created in the workspace root."
    );
  }
  return target;
};

const replaceWorkspaceFile = async (
  path: string,
  content: string
): Promise<void> => {
  const target = await workspacePath(path);
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags must be combined bitwise.
  const flags = constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW;
  const handle = await open(target, flags);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error("Workspace writes must target a regular file.");
    }
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
};

const createWorkspaceFile = async (
  path: string,
  content: string
): Promise<void> => {
  const target = await newWorkspacePath(path);
  const flags =
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags must be combined bitwise.
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW;
  const handle = await open(target, flags, 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
};

const listWorkspaceFiles = async (): Promise<string[]> => {
  const root = await workspaceRoot();
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", ".next"].includes(entry.name)) {
        continue;
      }
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relative(root, fullPath));
        if (files.length >= 500) {
          return;
        }
      }
    }
  };
  await walk(root);
  return files.sort((a, b) => a.localeCompare(b));
};

const safeGitHubPath = (value: string): string => {
  if (!/^[a-zA-Z0-9_./-]+$/.test(value) || value.includes("..")) {
    throw new Error("Invalid GitHub API path.");
  }
  return value;
};

const githubRequest = async (
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for GitHub tools.");
  }
  const baseUrl = (
    process.env.GITHUB_API_BASE_URL ?? "https://api.github.com"
  ).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}${safeGitHubPath(path)}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    method,
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub request failed (${response.status}): ${responseBody.slice(0, 1000)}`
    );
  }
  try {
    return JSON.parse(responseBody);
  } catch {
    return responseBody;
  }
};

const approval = (
  context: Pick<ToolFactoryContext, "requestApproval">,
  description: string,
  action: () => Promise<unknown>
): Promise<unknown> =>
  Promise.resolve(context.requestApproval(description, action));

const workspaceCheck = async (check: string): Promise<unknown> => {
  const command = {
    lint: ["run", "check"],
    test: ["test"],
    typecheck: ["run", "typecheck"],
  }[check];
  if (!command) {
    throw new Error("Unsupported check. Choose lint, test, or typecheck.");
  }
  const root = await workspaceRoot();
  const environment = {
    CI: "1",
    HOME: root,
    PATH: process.env.PATH ?? "",
  };
  try {
    const result = await execFileAsync("pnpm", command, {
      cwd: root,
      env: environment,
      maxBuffer: maxOutputLength,
      timeout: 120_000,
    });
    return {
      ok: true,
      output: `${result.stdout}\n${result.stderr}`.slice(0, maxOutputLength),
    };
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    return {
      ok: false,
      output: `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.slice(
        0,
        maxOutputLength
      ),
    };
  }
};

export const createSoftwareDevelopmentTools = (
  factoryContext: ToolFactoryContext
): Tool[] => {
  const { agent, delegate, loadSkill, requestApproval, specialists } =
    factoryContext;
  const context = { requestApproval };
  const tools: Tool[] = [
    {
      description:
        "List files in the approved development workspace. Excludes dependencies, build output, and Git internals.",
      name: "list_workspace_files",
      parameters: schema({}),
      run: async () => ({ files: await listWorkspaceFiles() }),
    },
    {
      description:
        "Read a UTF-8 file inside the approved development workspace.",
      name: "read_workspace_file",
      parameters: schema(
        { path: stringSchema("Relative workspace path.", 500) },
        ["path"]
      ),
      run: async (input) => {
        const path = text(object(input), "path", 500);
        const content = await readFile(await workspacePath(path), "utf8");
        return {
          content: content.slice(0, maxFileLength),
          path,
          truncated: content.length > maxFileLength,
        };
      },
    },
    {
      description:
        "Propose replacing one existing workspace file. This always requires approval and cannot create files or leave the approved workspace.",
      name: "write_workspace_file",
      parameters: schema(
        {
          content: stringSchema(
            "Complete replacement file content.",
            maxFileLength
          ),
          path: stringSchema("Existing relative workspace path.", 500),
        },
        ["path", "content"]
      ),
      run: async (input) => {
        const value = object(input);
        const path = text(value, "path", 500);
        const content = text(value, "content", maxFileLength);
        await workspacePath(path);
        return approval(
          context,
          `Replace workspace file ${path}.`,
          async () => {
            await replaceWorkspaceFile(path, content);
            return { path, written: true };
          }
        );
      },
    },
    {
      description:
        "Propose creating one new file in the workspace root. This always requires approval, cannot overwrite a file, and cannot leave the approved workspace.",
      name: "create_workspace_file",
      parameters: schema(
        {
          content: stringSchema("Complete new file content.", maxFileLength),
          path: stringSchema(
            "New relative filename in the workspace root.",
            500
          ),
        },
        ["path", "content"]
      ),
      run: async (input) => {
        const value = object(input);
        const path = text(value, "path", 500);
        const content = text(value, "content", maxFileLength);
        await newWorkspacePath(path);
        return approval(context, `Create workspace file ${path}.`, async () => {
          await createWorkspaceFile(path, content);
          return { created: true, path };
        });
      },
    },
    {
      description:
        "Run one allowlisted workspace check: lint, typecheck, or test. No arbitrary shell commands are available.",
      name: "run_workspace_check",
      parameters: schema(
        { check: { enum: ["lint", "typecheck", "test"], type: "string" } },
        ["check"]
      ),
      run: async (input) => workspaceCheck(text(object(input), "check", 30)),
    },
    {
      description:
        "Read the Git working-tree status for the approved workspace.",
      name: "get_workspace_git_status",
      parameters: schema({}),
      run: async () => {
        const root = await workspaceRoot();
        const result = await execFileAsync("git", ["status", "--short"], {
          cwd: root,
          env: { CI: "1", HOME: root, PATH: process.env.PATH ?? "" },
          maxBuffer: maxOutputLength,
        });
        return { status: result.stdout.slice(0, maxOutputLength) };
      },
    },
    {
      description:
        "Read a GitHub pull request. Use only a repository slug and PR number you were given or obtained from a tool.",
      name: "github_get_pull_request",
      parameters: schema(
        {
          number: { maximum: 10_000_000, minimum: 1, type: "integer" },
          repository: stringSchema("owner/repository", 200),
        },
        ["repository", "number"]
      ),
      run: async (input) => {
        const value = object(input);
        const repository = text(value, "repository", 200);
        const number = value.number;
        if (!Number.isInteger(number) || (number as number) < 1) {
          throw new Error("number must be a positive integer.");
        }
        return githubRequest("GET", `/repos/${repository}/pulls/${number}`);
      },
    },
    {
      description:
        "Create a GitHub pull request from an existing branch. Always requires approval.",
      name: "github_create_pull_request",
      parameters: schema(
        {
          base: stringSchema("Target branch.", 200),
          body: stringSchema("Pull request body.", 20_000),
          head: stringSchema("Source branch.", 200),
          repository: stringSchema("owner/repository", 200),
          title: stringSchema("Pull request title.", 300),
        },
        ["repository", "head", "base", "title", "body"]
      ),
      run: async (input) => {
        const value = object(input);
        const repository = text(value, "repository", 200);
        const head = text(value, "head", 200);
        const base = text(value, "base", 200);
        const title = text(value, "title", 300);
        const body = text(value, "body", 20_000);
        return approval(
          context,
          `Create GitHub pull request ${repository} (${head} -> ${base}): ${title}. Body: ${body.replace(/\s+/g, " ").slice(0, 500)}`,
          () =>
            githubRequest("POST", `/repos/${repository}/pulls`, {
              base,
              body,
              head,
              title,
            })
        );
      },
    },
    {
      description:
        "Load a software-development skill or a constrained reference file before applying it.",
      name: "load_skill",
      parameters: schema(
        {
          name: stringSchema("Skill name.", 100),
          reference: stringSchema("Optional relative reference path.", 200),
        },
        ["name"]
      ),
      run: async (input) => {
        const value = object(input);
        return {
          content: await loadSkill(
            text(value, "name", 100),
            typeof value.reference === "string" ? value.reference : undefined
          ),
        };
      },
    },
  ];
  if (agent === "lead") {
    tools.push({
      description:
        "Delegate one complete brief to the appropriate software-development specialist.",
      name: "delegate",
      parameters: schema(
        {
          brief: stringSchema("Complete technical brief and constraints."),
          specialist: { enum: specialists, type: "string" },
        },
        ["specialist", "brief"]
      ),
      run: async (input) => {
        const value = object(input);
        const specialist = text(value, "specialist", 100);
        if (!specialists.includes(specialist)) {
          throw new Error("Unsupported software-development specialist.");
        }
        return delegate(specialist, text(value, "brief"));
      },
    });
  }
  if (implementationSpecialists.has(agent)) {
    return tools;
  }
  return tools.filter(
    (tool) =>
      ![
        "github_create_pull_request",
        "run_workspace_check",
        "create_workspace_file",
        "write_workspace_file",
      ].includes(tool.name)
  );
};
