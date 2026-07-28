import { strict as assert } from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
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
  const scope = createE2EScope(t);
  const dataDirectory = await scope.temporaryDirectory("software-team-data-");
  const workspaceDirectory = await scope.temporaryDirectory(
    "software-team-workspace-"
  );
  await mkdir(join(workspaceDirectory, "src"));
  await writeFile(
    join(workspaceDirectory, "src", "service.ts"),
    "export const enabled = false;\n"
  );

  const model = createModelMock<{ messages: ModelMessage[] }>(({ messages }) =>
    modelResponse(messages)
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
  const chat = createChatClient(
    await scope.start(createAppServer()),
    "software-development"
  );

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
