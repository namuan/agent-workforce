import { strict as assert } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createChatClient,
  createE2EScope,
  createJsonMock,
  createModelMock,
  expectApproval,
  originalUserMessage,
  requestCount,
  type ToolCall,
  toolCall,
} from "./e2e-helpers.ts";

interface ModelRequest {
  readonly messages: Array<{
    readonly content: string | null;
    readonly role: string;
    readonly tool_calls?: ToolCall[];
  }>;
}

const specialistFor = (intent: string): string => {
  if (intent.includes("PRODUCT")) {
    return "product-marketer";
  }
  if (intent.includes("CONTENT")) {
    return "content-marketer";
  }
  if (intent.includes("SOCIAL")) {
    return "social-media-coordinator";
  }
  if (intent.includes("SEO")) {
    return "seo";
  }
  return "email";
};

const modelResponse = (request: ModelRequest): unknown => {
  const { messages } = request;
  const system = messages[0]?.content ?? "";
  const hasToolResult = messages.some((message) => message.role === "tool");
  const hasDelegated = messages.some((message) =>
    message.tool_calls?.some((call) => call.function.name === "delegate")
  );
  const calledTools = messages.flatMap(
    (message) => message.tool_calls?.map((call) => call.function.name) ?? []
  );
  const intent = originalUserMessage(messages);

  if (system.includes("You lead a marketing team.")) {
    if (hasDelegated) {
      return {
        choices: [
          {
            message: {
              content: `Lead completed ${specialistFor(intent)} work.`,
            },
          },
        ],
      };
    }
    if (!hasToolResult) {
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                toolCall("get_brand_context", {}),
                toolCall("get_user_preferences", {}),
              ],
            },
          },
        ],
      };
    }
    const specialist = specialistFor(intent);
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              toolCall("delegate", {
                brief: `E2E brief for ${specialist}`,
                specialist,
              }),
            ],
          },
        },
      ],
    };
  }

  if (system.includes("You are the product marketer")) {
    if (hasToolResult) {
      return { choices: [{ message: { content: "Product context saved." } }] };
    }
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              toolCall("save_brand_context", {
                content: "# E2E Product\nA clear positioning statement.",
              }),
            ],
          },
        },
      ],
    };
  }

  if (system.includes("You are a content marketer")) {
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              toolCall("notion_request", {
                body: { parent: {}, properties: {} },
                method: "POST",
                path: "/v1/pages",
              }),
            ],
          },
        },
      ],
    };
  }

  if (system.includes("You are a social media coordinator")) {
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              toolCall("typefully_request", {
                body: { content: "E2E social post" },
                method: "POST",
                path: "/drafts",
              }),
            ],
          },
        },
      ],
    };
  }

  if (system.includes("You do the organic search work")) {
    if (hasToolResult) {
      return { choices: [{ message: { content: "SEO schema checked." } }] };
    }
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              toolCall("validate_schema", {
                jsonld:
                  '{"@context":"https://schema.org","@type":"Article","headline":"E2E"}',
              }),
            ],
          },
        },
      ],
    };
  }

  if (hasToolResult && !calledTools.includes("resend_create_broadcast")) {
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              toolCall("resend_create_broadcast", {
                body: { name: "E2E broadcast" },
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
            content: null,
            tool_calls: [
              toolCall("resend_send_email", {
                body: {
                  from: "team@example.test",
                  html: "<p>E2E</p>",
                  subject: "E2E campaign",
                  to: "reader@example.test",
                },
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
          tool_calls: [toolCall("resend_list_domains", {})],
        },
      },
    ],
  };
};

test("marketing specialists complete mocked end-to-end flows", async (t) => {
  const scope = createE2EScope(t);
  const dataDirectory = await scope.temporaryDirectory("marketing-team-e2e-");
  const model = createModelMock<ModelRequest>(modelResponse);
  const externalServices = createJsonMock((request, response) => {
    if (request.path === "/notion/v1/pages") {
      return { id: "notion-page" };
    }
    if (request.path === "/typefully/drafts") {
      return { id: "typefully-draft" };
    }
    if (request.path === "/resend/domains") {
      return { data: [{ id: "domain-1", status: "verified" }] };
    }
    if (request.path === "/resend/broadcasts") {
      return { id: "resend-broadcast" };
    }
    if (request.path === "/resend/emails") {
      return { id: "resend-email" };
    }
    response.statusCode = 404;
    return { error: "Unexpected mock request" };
  });

  const modelOrigin = await scope.start(model);
  const servicesOrigin = await scope.start(externalServices.server);
  scope.setEnvironment({
    DATA_DIR: dataDirectory,
    MODEL_NAME: "e2e-model",
    MODEL_URL: `${modelOrigin}/v1`,
    NOTION_API_BASE_URL: `${servicesOrigin}/notion`,
    NOTION_API_KEY: "notion-test-key",
    RESEND_API_BASE_URL: `${servicesOrigin}/resend`,
    RESEND_API_KEY: "resend-test-key",
    TYPEFULLY_API_BASE_URL: `${servicesOrigin}/typefully`,
    TYPEFULLY_API_KEY: "typefully-test-key",
  });

  const { createAppServer } = await import("../src/server.ts");
  const chat = createChatClient(
    await scope.start(createAppServer()),
    "marketing"
  );

  await t.test("product marketer saves shared context", async () => {
    const result = await chat.start({
      message: "E2E PRODUCT",
      principalId: "product-user",
    });
    assert.equal(result.text, "Lead completed product-marketer work.");
    assert.match(
      await readFile(join(dataDirectory, "brand-context", "brand.md"), "utf8"),
      /E2E Product/
    );
  });

  await t.test(
    "content marketer creates a Notion page only after approval",
    async () => {
      const pending = await chat.start({
        message: "E2E CONTENT",
        principalId: "content-user",
      });
      assert.equal(requestCount(externalServices.calls, "/notion/v1/pages"), 0);
      const result = await chat.approve(expectApproval(pending));
      assert.equal(result.text, "Lead completed content-marketer work.");
      assert.equal(requestCount(externalServices.calls, "/notion/v1/pages"), 1);
    }
  );

  await t.test(
    "social coordinator creates a Typefully draft only after approval",
    async () => {
      const pending = await chat.start({
        message: "E2E SOCIAL",
        principalId: "social-user",
      });
      assert.equal(
        requestCount(externalServices.calls, "/typefully/drafts"),
        0
      );
      const result = await chat.approve(expectApproval(pending));
      assert.equal(
        result.text,
        "Lead completed social-media-coordinator work."
      );
      assert.equal(
        requestCount(externalServices.calls, "/typefully/drafts"),
        1
      );
    }
  );

  await t.test(
    "SEO specialist validates JSON-LD without external side effects",
    async () => {
      const result = await chat.start({
        message: "E2E SEO",
        principalId: "seo-user",
      });
      assert.equal(result.text, "Lead completed seo work.");
    }
  );

  await t.test(
    "email specialist sends through Resend only after approval",
    async () => {
      const pending = await chat.start({
        message: "E2E EMAIL",
        principalId: "email-user",
      });
      assert.equal(
        requestCount(externalServices.calls, "/resend/broadcasts"),
        1
      );
      assert.equal(requestCount(externalServices.calls, "/resend/emails"), 0);
      const result = await chat.approve(expectApproval(pending));
      assert.equal(result.text, "Lead completed email work.");
      const sent = externalServices.calls.find(
        (call) => call.path === "/resend/emails"
      );
      assert.deepEqual(sent?.body, {
        from: "team@example.test",
        html: "<p>E2E</p>",
        subject: "E2E campaign",
        to: "reader@example.test",
      });
    }
  );
});
