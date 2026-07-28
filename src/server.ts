import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  approve,
  chat,
  createSession,
  type DebugLogger,
  debugEnabled,
  type Session,
} from "./runtime.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(host);
const apiToken = process.env.API_TOKEN;
const environmentDebug: DebugLogger | undefined = debugEnabled()
  ? (message) => process.stderr.write(`[debug] ${message}\n`)
  : undefined;

const teamFrom = (value: unknown): string => {
  if (typeof value === "string" && /^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    return value;
  }
  throw new Error("A valid team is required when creating a session.");
};

if (!(isLoopback || apiToken)) {
  throw new Error("Set API_TOKEN before binding the HTTP API beyond loopback.");
}

const authorized = (request: import("node:http").IncomingMessage): boolean => {
  if (isLoopback && !apiToken) {
    return true;
  }
  const supplied = request.headers.authorization?.replace(/^Bearer /, "");
  if (!(apiToken && supplied) || supplied.length !== apiToken.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(apiToken));
};

const readBody = async (
  request: import("node:http").IncomingMessage
): Promise<unknown> => {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1_000_000) {
      throw new Error("Request body is too large.");
    }
  }
  return JSON.parse(body || "{}");
};

export const createAppServer = (
  options: { readonly debug?: DebugLogger } = {}
) => {
  const sessions = new Map<string, Session>();
  return createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/health") {
      return response.end(JSON.stringify({ ok: true }));
    }
    if (request.method !== "POST" || request.url !== "/chat") {
      response.statusCode = 404;
      return response.end(JSON.stringify({ error: "Not found" }));
    }
    if (!authorized(request)) {
      response.statusCode = 401;
      return response.end(JSON.stringify({ error: "Unauthorized" }));
    }
    try {
      const body = (await readBody(request)) as {
        approvalId?: string;
        message?: string;
        principalId?: string;
        sessionId?: string;
        team?: string;
      };
      const sessionId = body.sessionId ?? randomUUID();
      const existing = sessions.get(sessionId);
      const session =
        existing ??
        createSession(
          isLoopback
            ? (body.principalId ?? "local-user")
            : (process.env.PRINCIPAL_ID ?? "api-user"),
          teamFrom(body.team),
          options.debug ?? environmentDebug
        );
      if (existing && body.team !== undefined && session.team !== body.team) {
        throw new Error("A session cannot switch teams.");
      }
      sessions.set(sessionId, session);
      const result = body.approvalId
        ? await approve(session, body.approvalId)
        : await chat(session, body.message ?? "");
      response.end(JSON.stringify({ ...result, sessionId }));
    } catch (error) {
      response.statusCode = 400;
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Bad request",
        })
      );
    }
  });
};

if (import.meta.main) {
  createAppServer().listen(port, host, () =>
    process.stdout.write(
      `Native agent API listening on http://${host}:${port}\n`
    )
  );
}
