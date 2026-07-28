import { strict as assert } from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDirectory = await mkdtemp(join(tmpdir(), "marketing-team-e2e-"));
process.env.DATA_DIR = dataDirectory;

interface ToolCall {
  readonly function: { readonly arguments: string; readonly name: string };
  readonly id: string;
}

interface ModelRequest {
  readonly messages: Array<{
    readonly content: string | null;
    readonly role: string;
    readonly tool_calls?: ToolCall[];
  }>;
}

interface ServiceCall {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
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

const json = (
  response: import("node:http").ServerResponse,
  value: unknown
): void => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
};

const toolCall = (name: string, input: Record<string, unknown>): ToolCall => ({
  function: { arguments: JSON.stringify(input), name },
  id: `call-${name}`,
});

const userIntent = (messages: ModelRequest["messages"]): string =>
  messages.find(
    (message) =>
      message.role === "user" &&
      !message.content?.startsWith("The requested action was approved")
  )?.content ?? "";

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
  const intent = userIntent(messages);

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

const readJson = async (
  request: import("node:http").IncomingMessage
): Promise<unknown> => {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body ? JSON.parse(body) : undefined;
};

test("marketing specialists complete mocked end-to-end flows", async (t) => {
  const model = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    json(response, modelResponse((await readJson(request)) as ModelRequest));
  });
  const services: ServiceCall[] = [];
  const externalServices = createServer(async (request, response) => {
    services.push({
      body: await readJson(request),
      method: request.method ?? "",
      path: request.url ?? "",
    });
    if (request.url === "/notion/v1/pages") {
      return json(response, { id: "notion-page" });
    }
    if (request.url === "/typefully/drafts") {
      return json(response, { id: "typefully-draft" });
    }
    if (request.url === "/resend/domains") {
      return json(response, { data: [{ id: "domain-1", status: "verified" }] });
    }
    if (request.url === "/resend/broadcasts") {
      return json(response, { id: "resend-broadcast" });
    }
    if (request.url === "/resend/emails") {
      return json(response, { id: "resend-email" });
    }
    response.statusCode = 404;
    return json(response, { error: "Unexpected mock request" });
  });

  const modelPort = await listen(model);
  const servicePort = await listen(externalServices);
  process.env.MODEL_NAME = "e2e-model";
  process.env.MODEL_URL = `http://127.0.0.1:${modelPort}/v1`;
  process.env.NOTION_API_BASE_URL = `http://127.0.0.1:${servicePort}/notion`;
  process.env.NOTION_API_KEY = "notion-test-key";
  process.env.RESEND_API_BASE_URL = `http://127.0.0.1:${servicePort}/resend`;
  process.env.RESEND_API_KEY = "resend-test-key";
  process.env.TYPEFULLY_API_BASE_URL = `http://127.0.0.1:${servicePort}/typefully`;
  process.env.TYPEFULLY_API_KEY = "typefully-test-key";

  const { createAppServer } = await import("../src/server.ts");
  const api = createAppServer();
  const apiPort = await listen(api);
  t.after(async () => {
    await Promise.all([close(api), close(model), close(externalServices)]);
    await rm(dataDirectory, { force: true, recursive: true });
  });

  const chat = async (
    body: Record<string, unknown>
  ): Promise<Record<string, string>> => {
    const payload = body.approvalId ? body : { ...body, team: "marketing" };
    const response = await fetch(`http://127.0.0.1:${apiPort}/chat`, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<Record<string, string>>;
  };

  await t.test("product marketer saves shared context", async () => {
    const result = await chat({
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
      const pending = await chat({
        message: "E2E CONTENT",
        principalId: "content-user",
      });
      assert.ok(pending.approvalId);
      assert.equal(
        services.filter((call) => call.path === "/notion/v1/pages").length,
        0
      );
      const result = await chat({
        approvalId: pending.approvalId,
        sessionId: pending.sessionId,
      });
      assert.equal(result.text, "Lead completed content-marketer work.");
      assert.equal(
        services.filter((call) => call.path === "/notion/v1/pages").length,
        1
      );
    }
  );

  await t.test(
    "social coordinator creates a Typefully draft only after approval",
    async () => {
      const pending = await chat({
        message: "E2E SOCIAL",
        principalId: "social-user",
      });
      assert.ok(pending.approvalId);
      assert.equal(
        services.filter((call) => call.path === "/typefully/drafts").length,
        0
      );
      const result = await chat({
        approvalId: pending.approvalId,
        sessionId: pending.sessionId,
      });
      assert.equal(
        result.text,
        "Lead completed social-media-coordinator work."
      );
      assert.equal(
        services.filter((call) => call.path === "/typefully/drafts").length,
        1
      );
    }
  );

  await t.test(
    "SEO specialist validates JSON-LD without external side effects",
    async () => {
      const result = await chat({
        message: "E2E SEO",
        principalId: "seo-user",
      });
      assert.equal(result.text, "Lead completed seo work.");
    }
  );

  await t.test(
    "email specialist sends through Resend only after approval",
    async () => {
      const pending = await chat({
        message: "E2E EMAIL",
        principalId: "email-user",
      });
      assert.ok(pending.approvalId);
      assert.equal(
        services.filter((call) => call.path === "/resend/broadcasts").length,
        1
      );
      assert.equal(
        services.filter((call) => call.path === "/resend/emails").length,
        0
      );
      const result = await chat({
        approvalId: pending.approvalId,
        sessionId: pending.sessionId,
      });
      assert.equal(result.text, "Lead completed email work.");
      const sent = services.find((call) => call.path === "/resend/emails");
      assert.deepEqual(sent?.body, {
        from: "team@example.test",
        html: "<p>E2E</p>",
        subject: "E2E campaign",
        to: "reader@example.test",
      });
    }
  );
});
