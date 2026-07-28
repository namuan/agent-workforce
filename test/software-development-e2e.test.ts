import { strict as assert } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDirectory = await mkdtemp(join(tmpdir(), "software-team-data-"));
const workspaceDirectory = await mkdtemp(
  join(tmpdir(), "software-team-workspace-")
);
await mkdir(join(workspaceDirectory, "src"));
await writeFile(
  join(workspaceDirectory, "src", "service.ts"),
  "export const enabled = false;\n"
);
process.env.DATA_DIR = dataDirectory;
process.env.DEV_WORKSPACE_DIR = workspaceDirectory;

interface ModelMessage {
  readonly content: string | null;
  readonly role: string;
  readonly tool_calls?: Array<{ readonly function: { readonly name: string } }>;
}

const listen = async (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine mock-server port."));
        return;
      }
      resolve(address.port);
    });
  });

const close = async (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

const readJson = async (
  request: import("node:http").IncomingMessage
): Promise<unknown> => {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body ? JSON.parse(body) : undefined;
};

const respond = (
  response: import("node:http").ServerResponse,
  value: unknown
): void => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
};

const toolCall = (name: string, input: Record<string, unknown>) => ({
  function: { arguments: JSON.stringify(input), name },
  id: `call-${name}`,
});

const originalRequest = (messages: readonly ModelMessage[]): string =>
  messages.find(
    (message) =>
      message.role === "user" &&
      !message.content?.startsWith("The requested action was approved")
  )?.content ?? "";

const modelResponse = (messages: ModelMessage[]): unknown => {
  const system = messages[0]?.content ?? "";
  const hasToolResult = messages.some((message) => message.role === "tool");
  const hasDelegated = messages.some((message) =>
    message.tool_calls?.some((call) => call.function.name === "delegate")
  );
  const request = originalRequest(messages);

  if (system.includes("You lead a software-development team.")) {
    if (hasDelegated) {
      return {
        choices: [
          { message: { content: "Development-team handoff complete." } },
        ],
      };
    }
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              toolCall("delegate", {
                brief: request,
                specialist: request.includes("REVIEW")
                  ? "code-reviewer"
                  : "backend-engineer",
              }),
            ],
          },
        },
      ],
    };
  }

  if (system.includes("You are the backend engineer.")) {
    if (!hasToolResult) {
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                toolCall("read_workspace_file", { path: "src/service.ts" }),
              ],
            },
          },
        ],
      };
    }
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              toolCall("write_workspace_file", {
                content: "export const enabled = true;\n",
                path: "src/service.ts",
              }),
            ],
          },
        },
      ],
    };
  }

  if (hasToolResult) {
    return { choices: [{ message: { content: "Review complete." } }] };
  }
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            toolCall("github_get_pull_request", {
              number: 42,
              repository: "acme/widget",
            }),
          ],
        },
      },
    ],
  };
};

test("software-development team runs against a safe workspace and mocked GitHub", async (t) => {
  const model = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    const body = (await readJson(request)) as { messages: ModelMessage[] };
    respond(response, modelResponse(body.messages));
  });
  const githubCalls: string[] = [];
  const github = createServer(async (request, response) => {
    githubCalls.push(request.url ?? "");
    assert.equal(request.headers.authorization, "Bearer github-test-token");
    respond(response, {
      number: 42,
      state: "open",
      title: "Mock pull request",
    });
  });
  const modelPort = await listen(model);
  const githubPort = await listen(github);
  process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${githubPort}`;
  process.env.GITHUB_TOKEN = "github-test-token";
  process.env.MODEL_NAME = "e2e-model";
  process.env.MODEL_URL = `http://127.0.0.1:${modelPort}/v1`;

  const { createAppServer } = await import("../src/server.ts");
  const api = createAppServer();
  const apiPort = await listen(api);
  t.after(async () => {
    await Promise.all([close(api), close(model), close(github)]);
    await Promise.all([
      rm(dataDirectory, { force: true, recursive: true }),
      rm(workspaceDirectory, { force: true, recursive: true }),
    ]);
  });

  const chat = async (
    body: Record<string, unknown>
  ): Promise<Record<string, string>> => {
    const payload = body.approvalId
      ? body
      : { ...body, team: "software-development" };
    const response = await fetch(`http://127.0.0.1:${apiPort}/chat`, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<Record<string, string>>;
  };

  await t.test(
    "backend change pauses before replacing a workspace file",
    async () => {
      const pending = await chat({
        message: "IMPLEMENT E2E",
        principalId: "backend-user",
      });
      assert.ok(pending.approvalId);
      assert.equal(
        await readFile(join(workspaceDirectory, "src", "service.ts"), "utf8"),
        "export const enabled = false;\n"
      );
      const result = await chat({
        approvalId: pending.approvalId,
        sessionId: pending.sessionId,
      });
      assert.equal(result.text, "Development-team handoff complete.");
      assert.equal(
        await readFile(join(workspaceDirectory, "src", "service.ts"), "utf8"),
        "export const enabled = true;\n"
      );
    }
  );

  await t.test("code review reads a mocked GitHub pull request", async () => {
    const result = await chat({
      message: "REVIEW E2E",
      principalId: "reviewer-user",
    });
    assert.equal(result.text, "Development-team handoff complete.");
    assert.deepEqual(githubCalls, ["/repos/acme/widget/pulls/42"]);
  });
});
