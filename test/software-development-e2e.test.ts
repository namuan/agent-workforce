import { strict as assert } from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createSoftwareDevelopmentTools } from "../teams/software-development/tools.ts";
import {
  createChatClient,
  createE2EScope,
  createJsonMock,
  createModelMock,
  expectApproval,
  type ModelMessage,
  originalUserMessage,
  toolCall,
} from "./e2e-helpers.ts";

const modelResponse = (messages: ModelMessage[]): unknown => {
  const system = messages[0]?.content ?? "";
  const hasToolResult = messages.some((message) => message.role === "tool");
  const hasDelegated = messages.some((message) =>
    message.tool_calls?.some((call) => call.function.name === "delegate")
  );
  const request = originalUserMessage(messages);

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
                  : request.includes("CREATE")
                    ? "frontend-engineer"
                    : "backend-engineer",
              }),
            ],
          },
        },
      ],
    };
  }

  if (
    system.includes("You are the backend engineer.") ||
    system.includes("You are the frontend engineer.")
  ) {
    if (!hasToolResult) {
      if (request.includes("CREATE")) {
        return {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  toolCall("create_workspace_file", {
                    content: request.includes("EXISTING")
                      ? "<h1>Replacement</h1>\n"
                      : "<h1>Snake</h1>\n",
                    path: request.includes("EXISTING")
                      ? "existing.html"
                      : "snake.html",
                  }),
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
  const scope = createE2EScope(t);
  const dataDirectory = await scope.temporaryDirectory("software-team-data-");
  const workspaceDirectory = await scope.temporaryDirectory(
    "software-team-workspace-"
  );
  const externalDirectory = await scope.temporaryDirectory(
    "external-directory-"
  );
  await mkdir(join(workspaceDirectory, "src"));
  await writeFile(
    join(workspaceDirectory, "src", "service.ts"),
    "export const enabled = false;\n"
  );

  let modelRequestCount = 0;
  const model = createModelMock<{ messages: ModelMessage[] }>(
    ({ messages }) => {
      modelRequestCount += 1;
      return modelResponse(messages);
    }
  );
  const github = createJsonMock((request) => {
    assert.equal(request.headers.authorization, "Bearer github-test-token");
    return {
      number: 42,
      state: "open",
      title: "Mock pull request",
    };
  });
  const modelOrigin = await scope.start(model);
  const githubOrigin = await scope.start(github.server);
  scope.setEnvironment({
    DATA_DIR: dataDirectory,
    DEV_WORKSPACE_DIR: workspaceDirectory,
    GITHUB_API_BASE_URL: githubOrigin,
    GITHUB_TOKEN: "github-test-token",
    MODEL_NAME: "e2e-model",
    MODEL_URL: `${modelOrigin}/v1`,
  });

  const { createAppServer } = await import("../src/server.ts");
  const apiOrigin = await scope.start(createAppServer());
  const chat = createChatClient(apiOrigin, "software-development");

  await t.test(
    "backend change pauses before replacing a workspace file",
    async () => {
      const pending = await chat.start({
        message: "IMPLEMENT E2E",
        principalId: "backend-user",
      });
      assert.equal(
        await readFile(join(workspaceDirectory, "src", "service.ts"), "utf8"),
        "export const enabled = false;\n"
      );
      const result = await chat.approve(expectApproval(pending));
      assert.equal(result.text, "Development-team handoff complete.");
      assert.equal(
        await readFile(join(workspaceDirectory, "src", "service.ts"), "utf8"),
        "export const enabled = true;\n"
      );
    }
  );

  await t.test(
    "new-file tool rejects traversal and external symlink parents",
    async () => {
      await symlink(externalDirectory, join(workspaceDirectory, "external"));
      const createFile = createSoftwareDevelopmentTools({
        agent: "frontend-engineer",
        delegate: async () => ({}),
        loadSkill: async () => "",
        principalId: "frontend-user",
        requestApproval: () => ({ approvalId: "approval-id", message: "" }),
        specialists: ["frontend-engineer"],
      }).find((tool) => tool.name === "create_workspace_file");
      if (!createFile) {
        throw new Error("Expected create_workspace_file to be available.");
      }

      await assert.rejects(
        createFile.run({
          content: "<h1>Escape</h1>\n",
          path: "../escape.html",
        }),
        /must stay inside the approved workspace/
      );
      await assert.rejects(
        createFile.run({
          content: "<h1>Escape</h1>\n",
          path: "external/escape.html",
        }),
        /must be created in the workspace root/
      );
      await assert.rejects(
        readFile(join(externalDirectory, "escape.html"), "utf8")
      );
    }
  );

  await t.test(
    "new file creation pauses and blocks chat until approval",
    async () => {
      const pending = await chat.start({
        message: "CREATE E2E",
        principalId: "frontend-user",
      });
      const approval = expectApproval(pending);
      await assert.rejects(
        readFile(join(workspaceDirectory, "snake.html"), "utf8")
      );

      const requestsBeforeStatus = modelRequestCount;
      const status = await chat.continue({
        message: "What is the progress?",
        sessionId: approval.sessionId,
      });
      assert.equal(status.approvalId, approval.approvalId);
      assert.match(status.text, /Create workspace file snake\.html/);
      assert.equal(modelRequestCount, requestsBeforeStatus);

      const result = await chat.approve(approval);
      assert.equal(result.text, "Development-team handoff complete.");
      assert.equal(
        await readFile(join(workspaceDirectory, "snake.html"), "utf8"),
        "<h1>Snake</h1>\n"
      );
    }
  );

  await t.test(
    "new file creation cannot overwrite a file added before approval",
    async () => {
      const pending = await chat.start({
        message: "CREATE EXISTING E2E",
        principalId: "frontend-user",
      });
      const approval = expectApproval(pending);
      await writeFile(
        join(workspaceDirectory, "existing.html"),
        "<h1>Original</h1>\n"
      );

      const response = await fetch(`${apiOrigin}/chat`, {
        body: JSON.stringify(approval),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(response.status, 400);
      assert.equal(
        await readFile(join(workspaceDirectory, "existing.html"), "utf8"),
        "<h1>Original</h1>\n"
      );
    }
  );

  await t.test("code review reads a mocked GitHub pull request", async () => {
    const result = await chat.start({
      message: "REVIEW E2E",
      principalId: "reviewer-user",
    });
    assert.equal(result.text, "Development-team handoff complete.");
    assert.deepEqual(
      github.calls.map((call) => call.path),
      ["/repos/acme/widget/pulls/42"]
    );
  });
});
