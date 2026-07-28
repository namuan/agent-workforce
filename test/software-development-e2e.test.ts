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
    if (request.includes("DEBUG_DIRECT_MODEL_FAILURE")) {
      return { error: { message: "direct-model-sentinel" } };
    }
    if (request.includes("DEBUG_INVALID_TOOL_INPUT")) {
      if (hasToolResult) {
        return { choices: [{ message: { content: "Debug complete." } }] };
      }
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  function: {
                    arguments: "jwt-raw-sentinel",
                    name: "list_workspace_files",
                  },
                  id: "call-invalid-input",
                },
              ],
            },
          },
        ],
      };
    }
    if (request.includes("DEBUG_SENSITIVE_ARGUMENTS")) {
      if (hasToolResult) {
        return { choices: [{ message: { content: "Debug complete." } }] };
      }
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                toolCall("list_workspace_files", {
                  accessKey: "access-key-sentinel",
                  auth: "auth-sentinel",
                  credential: "credential-sentinel",
                  jwt: "jwt-sentinel",
                  key: "key-sentinel",
                  passphrase: "passphrase-sentinel",
                  privateKey: "private-key-sentinel",
                  sshKey: "ssh-key-sentinel",
                  token: "token-sentinel",
                }),
              ],
            },
          },
        ],
      };
    }
    if (request.includes("DEBUG_TOOL_NAME_SENTINEL")) {
      if (hasToolResult) {
        return { choices: [{ message: { content: "Debug complete." } }] };
      }
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [toolCall("debug-tool-name-sentinel", {})],
            },
          },
        ],
      };
    }
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
    if (request.includes("DEBUG_DELEGATE_MODEL_FAILURE")) {
      return { error: { message: "delegated-model-sentinel" } };
    }
    if (request.includes("DEBUG_FAILURE")) {
      if (hasToolResult) {
        return {
          choices: [{ message: { content: "Debug failure observed." } }],
        };
      }
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                toolCall("read_workspace_file", { path: "missing.ts" }),
              ],
            },
          },
        ],
      };
    }
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
    return {
      choices: [
        {
          message: {
            content: request.includes("DEBUG_REMOTE_FAILURE")
              ? `Review complete: ${request}`
              : "Review complete.",
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
    async ({ messages }) => {
      modelRequestCount += 1;
      if (originalUserMessage(messages).includes("DEBUG_MODEL_TIMEOUT")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return modelResponse(messages);
    }
  );
  let githubFailure = false;
  const github = createJsonMock((request, response) => {
    assert.equal(request.headers.authorization, "Bearer github-test-token");
    if (githubFailure) {
      response.statusCode = 401;
      return { token: "remote-token-sentinel" };
    }
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
  const debugEvents: string[] = [];
  const debugApiOrigin = await scope.start(
    createAppServer({ debug: (message) => debugEvents.push(message) })
  );
  const debugChat = createChatClient(debugApiOrigin, "software-development");

  await t.test(
    "backend change pauses before replacing a workspace file",
    async () => {
      const pending = await chat.start({
        message: "IMPLEMENT E2E",
        principalId: "backend-user",
      });
      const approval = expectApproval(pending);
      assert.match(
        pending.text,
        new RegExp(`Type /approve ${approval.approvalId} to continue\\.`)
      );
      assert.equal(
        await readFile(join(workspaceDirectory, "src", "service.ts"), "utf8"),
        "export const enabled = false;\n"
      );
      const result = await chat.approve(approval);
      assert.equal(result.text, "Development-team handoff complete.");
      assert.equal(
        await readFile(join(workspaceDirectory, "src", "service.ts"), "utf8"),
        "export const enabled = true;\n"
      );
    }
  );

  await t.test("debug level 1 omits tool arguments and errors", async () => {
    scope.setEnvironment({ DEBUG: "1" });
    const eventsBefore = debugEvents.length;
    const result = await debugChat.start({
      message: "REVIEW DEBUG_ONE",
      principalId: "debug-user",
    });
    assert.equal(result.text, "Development-team handoff complete.");
    const levelOneEvents = debugEvents.slice(eventsBefore);
    assert.ok(levelOneEvents.includes("lead: running tool delegate"));
    assert.ok(!levelOneEvents.some((event) => event.includes(" input ")));
    assert.ok(!levelOneEvents.some((event) => event.includes(" error ")));

    const eventsBeforeFailure = debugEvents.length;
    githubFailure = true;
    try {
      const failure = await debugChat.start({
        message: "REVIEW DEBUG_ONE_FAILURE",
        principalId: "debug-user",
      });
      assert.equal(failure.text, "Development-team handoff complete.");
    } finally {
      githubFailure = false;
    }
    const levelOneFailureEvents = debugEvents.slice(eventsBeforeFailure);
    assert.ok(
      levelOneFailureEvents.includes(
        "code-reviewer: tool github_get_pull_request failed"
      )
    );
    assert.ok(
      !levelOneFailureEvents.some((event) => event.includes(" error "))
    );
    assert.ok(
      !levelOneFailureEvents.some((event) =>
        event.includes("remote-token-sentinel")
      )
    );
  });

  await t.test(
    "debug level 2 traces sanitized tool arguments and errors",
    async () => {
      scope.setEnvironment({ DEBUG: "2" });
      const pending = await debugChat.start({
        message: "IMPLEMENT DEBUG",
        principalId: "debug-user",
      });
      expectApproval(pending);
      assert.ok(debugEvents.includes("lead: loading team"));
      assert.ok(debugEvents.includes("lead: delegating"));
      assert.ok(
        debugEvents.includes(
          "backend-engineer: running tool read_workspace_file"
        )
      );
      assert.ok(
        debugEvents.includes(
          'backend-engineer: tool read_workspace_file input {"path":"src/service.ts"}'
        )
      );
      assert.ok(
        debugEvents.includes(
          "backend-engineer: tool write_workspace_file awaits approval"
        )
      );
      assert.ok(
        !debugEvents.some(
          (event) =>
            event.includes("IMPLEMENT DEBUG") ||
            event.includes("enabled = true")
        )
      );

      const eventsBeforeFailure = debugEvents.length;
      const failure = await debugChat.start({
        message: "DEBUG_FAILURE",
        principalId: "debug-user",
      });
      assert.equal(failure.text, "Development-team handoff complete.");
      const failureEvents = debugEvents.slice(eventsBeforeFailure);
      assert.ok(
        failureEvents.includes(
          'backend-engineer: tool read_workspace_file input {"path":"missing.ts"}'
        )
      );
      assert.ok(
        failureEvents.some((event) =>
          event.startsWith("backend-engineer: tool read_workspace_file error ")
        )
      );

      const eventsBeforeSensitiveArguments = debugEvents.length;
      const sensitiveResult = await debugChat.start({
        message: "DEBUG_SENSITIVE_ARGUMENTS",
        principalId: "debug-user",
      });
      assert.equal(sensitiveResult.text, "Debug complete.");
      const sensitiveTrace = debugEvents
        .slice(eventsBeforeSensitiveArguments)
        .join("\n");
      assert.match(
        sensitiveTrace,
        /lead: tool list_workspace_files input \{\}/
      );
      assert.doesNotMatch(
        sensitiveTrace,
        /access-key-sentinel|auth-sentinel|credential-sentinel|jwt-sentinel|key-sentinel|passphrase-sentinel|private-key-sentinel|ssh-key-sentinel|token-sentinel/
      );

      const eventsBeforeInvalidInput = debugEvents.length;
      const invalidInputResult = await debugChat.start({
        message: "DEBUG_INVALID_TOOL_INPUT",
        principalId: "debug-user",
      });
      assert.equal(invalidInputResult.text, "Debug complete.");
      const invalidInputTrace = debugEvents
        .slice(eventsBeforeInvalidInput)
        .join("\n");
      assert.match(
        invalidInputTrace,
        /lead: tool list_workspace_files error Invalid tool input\./
      );
      assert.doesNotMatch(invalidInputTrace, /jwt-raw-sentinel/);

      const eventsBeforeDelegateFailure = debugEvents.length;
      const delegateFailure = await debugChat.start({
        message: "DEBUG_DELEGATE_MODEL_FAILURE",
        principalId: "debug-user",
      });
      assert.equal(delegateFailure.text, "Development-team handoff complete.");
      const delegateFailureTrace = debugEvents
        .slice(eventsBeforeDelegateFailure)
        .join("\n");
      assert.match(
        delegateFailureTrace,
        /lead: delegated agent model returned an error response \(200\)\./
      );
      assert.match(
        delegateFailureTrace,
        /lead: tool delegate error Delegated agent model returned an error response \(200\)\./
      );
      assert.doesNotMatch(delegateFailureTrace, /delegated-model-sentinel/);

      const eventsBeforeDirectModelFailure = debugEvents.length;
      const directModelFailureResponse = await fetch(`${debugApiOrigin}/chat`, {
        body: JSON.stringify({
          message: "DEBUG_DIRECT_MODEL_FAILURE",
          principalId: "debug-user",
          team: "software-development",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(directModelFailureResponse.status, 400);
      const directModelFailureTrace = debugEvents
        .slice(eventsBeforeDirectModelFailure)
        .join("\n");
      assert.match(directModelFailureTrace, /lead: model request failed/);
      assert.match(
        directModelFailureTrace,
        /lead: model error Model returned an error response \(200\)\./
      );
      assert.doesNotMatch(directModelFailureTrace, /direct-model-sentinel/);

      scope.setEnvironment({ MODEL_TIMEOUT_MS: "10" });
      const eventsBeforeTimeout = debugEvents.length;
      const timeoutResponse = await fetch(`${debugApiOrigin}/chat`, {
        body: JSON.stringify({
          message: "DEBUG_MODEL_TIMEOUT",
          principalId: "debug-user",
          team: "software-development",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(timeoutResponse.status, 400);
      const timeoutBody = (await timeoutResponse.json()) as { error: string };
      assert.match(timeoutBody.error, /Model request timed out after 10ms/);
      assert.ok(
        debugEvents
          .slice(eventsBeforeTimeout)
          .includes("lead: model request timed out")
      );
      scope.setEnvironment({ MODEL_TIMEOUT_MS: undefined });

      const eventsBeforeRemoteFailure = debugEvents.length;
      githubFailure = true;
      try {
        const remoteFailure = await debugChat.start({
          message: "REVIEW DEBUG_REMOTE_FAILURE",
          principalId: "debug-user",
        });
        assert.equal(remoteFailure.text, "Development-team handoff complete.");
      } finally {
        githubFailure = false;
      }
      const remoteFailureTrace = debugEvents
        .slice(eventsBeforeRemoteFailure)
        .join("\n");
      assert.match(
        remoteFailureTrace,
        /code-reviewer: tool github_get_pull_request error Remote request failed\./
      );
      assert.doesNotMatch(remoteFailureTrace, /remote-token-sentinel/);
      assert.doesNotMatch(remoteFailureTrace, /DEBUG_REMOTE_FAILURE/);

      const eventsBeforeUnknownTool = debugEvents.length;
      const debugResult = await debugChat.start({
        message: "DEBUG_TOOL_NAME_SENTINEL",
        principalId: "debug-user",
      });
      assert.equal(debugResult.text, "Debug complete.");
      const unknownToolEvents = debugEvents.slice(eventsBeforeUnknownTool);
      assert.ok(unknownToolEvents.includes("lead: running tool unknown tool"));
      assert.ok(
        unknownToolEvents.includes("lead: model requested an unavailable tool")
      );
      assert.ok(
        !unknownToolEvents.some((event) =>
          event.includes("debug-tool-name-sentinel")
        )
      );

      const eventsBeforeUnknownTeam = debugEvents.length;
      const unknownTeam = "debug-team-secret";
      const unknownTeamResponse = await fetch(`${debugApiOrigin}/chat`, {
        body: JSON.stringify({
          message: "Inspect the workspace",
          principalId: "debug-user",
          team: unknownTeam,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(unknownTeamResponse.status, 400);
      assert.ok(
        !debugEvents
          .slice(eventsBeforeUnknownTeam)
          .some((event) => event.includes(unknownTeam))
      );
    }
  );

  await t.test(
    "workspace write tools reject invalid paths before requesting approval",
    async () => {
      await symlink(externalDirectory, join(workspaceDirectory, "external"));
      let approvalRequests = 0;
      const tools = createSoftwareDevelopmentTools({
        agent: "frontend-engineer",
        delegate: async () => ({}),
        loadSkill: async () => "",
        principalId: "frontend-user",
        requestApproval: () => {
          approvalRequests += 1;
          return { approvalId: "approval-id", message: "" };
        },
        specialists: ["frontend-engineer"],
      });
      const createFile = tools.find(
        (tool) => tool.name === "create_workspace_file"
      );
      const replaceFile = tools.find(
        (tool) => tool.name === "write_workspace_file"
      );
      if (!(createFile && replaceFile)) {
        throw new Error("Expected workspace write tools to be available.");
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
      await assert.rejects(
        replaceFile.run({
          content: "<h1>Snake</h1>\n",
          path: "/workspace/snake.html",
        }),
        /Workspace paths must be relative/
      );
      assert.equal(approvalRequests, 0);
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
    const githubCallsBefore = github.calls.length;
    const result = await chat.start({
      message: "REVIEW E2E",
      principalId: "reviewer-user",
    });
    assert.equal(result.text, "Development-team handoff complete.");
    assert.deepEqual(
      github.calls.slice(githubCallsBefore).map((call) => call.path),
      ["/repos/acme/widget/pulls/42"]
    );
  });
});
