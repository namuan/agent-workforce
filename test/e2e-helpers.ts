import { strict as assert } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export interface ChatResult {
  readonly approvalId?: string;
  readonly sessionId: string;
  readonly text: string;
}

export interface MockRequest {
  readonly body: unknown;
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly path: string;
}

export interface ModelMessage {
  readonly content: string | null;
  readonly role: string;
  readonly tool_calls?: readonly {
    readonly function: { readonly name: string };
  }[];
}

export interface ToolCall {
  readonly function: { readonly arguments: string; readonly name: string };
  readonly id: string;
}

export const toolCall = (
  name: string,
  input: Record<string, unknown>
): ToolCall => ({
  function: { arguments: JSON.stringify(input), name },
  id: `call-${name}`,
});

export const originalUserMessage = (
  messages: readonly ModelMessage[]
): string =>
  messages.find(
    (message) =>
      message.role === "user" &&
      !message.content?.startsWith("The requested action was approved")
  )?.content ?? "";

const listen = async (server: Server): Promise<string> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine mock-server port."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

const close = async (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

const readJson = async <Value>(request: IncomingMessage): Promise<Value> => {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return JSON.parse(body || "null") as Value;
};

const sendJson = (response: ServerResponse, value: unknown): void => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
};

export const createJsonMock = (
  handler: (
    request: MockRequest,
    response: ServerResponse
  ) => unknown | Promise<unknown>
): { readonly calls: MockRequest[]; readonly server: Server } => {
  const calls: MockRequest[] = [];
  const server = createServer(async (request, response) => {
    const call = {
      body: await readJson(request),
      headers: request.headers,
      method: request.method ?? "",
      path: request.url ?? "",
    };
    calls.push(call);
    sendJson(response, await handler(call, response));
  });
  return { calls, server };
};

export const createModelMock = <Request>(
  responseFor: (request: Request) => unknown | Promise<unknown>
): Server =>
  createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    sendJson(response, await responseFor(await readJson<Request>(request)));
  });

export const createChatClient = (origin: string, team: string) => {
  const request = async (body: Record<string, string>): Promise<ChatResult> => {
    const response = await fetch(`${origin}/chat`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<ChatResult>;
  };

  return {
    approve: async (approval: { approvalId: string; sessionId: string }) =>
      request(approval),
    start: async (input: { message: string; principalId: string }) =>
      request({ ...input, team }),
  };
};

export const expectApproval = (
  result: ChatResult
): { readonly approvalId: string; readonly sessionId: string } => {
  assert.ok(result.approvalId);
  return { approvalId: result.approvalId, sessionId: result.sessionId };
};

export const requestCount = (
  calls: readonly MockRequest[],
  path: string
): number => calls.filter((call) => call.path === path).length;

export const createE2EScope = (test: TestContext) => {
  const directories: string[] = [];
  const environment = new Map<string, string | undefined>();
  const servers: Server[] = [];

  test.after(async () => {
    try {
      const results = await Promise.allSettled([
        ...servers.map(close),
        ...directories.map((directory) =>
          rm(directory, { force: true, recursive: true })
        ),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
    } finally {
      for (const [key, value] of environment) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  return {
    setEnvironment: (values: Record<string, string | undefined>): void => {
      for (const [key, value] of Object.entries(values)) {
        if (!environment.has(key)) {
          environment.set(key, process.env[key]);
        }
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
    start: async (server: Server): Promise<string> => {
      const origin = await listen(server);
      servers.push(server);
      return origin;
    },
    temporaryDirectory: async (prefix: string): Promise<string> => {
      const directory = await mkdtemp(join(tmpdir(), prefix));
      directories.push(directory);
      return directory;
    },
  };
};
