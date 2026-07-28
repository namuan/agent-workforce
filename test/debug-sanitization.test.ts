import { doesNotMatch, match, rejects } from "node:assert/strict";
import test from "node:test";
import {
  approve,
  createSession,
  formatDebugToolArguments,
  sanitizeDebugError,
} from "../src/runtime.ts";
import type { Tool } from "../src/tools.ts";

test("DEBUG=2 omits structured error payloads", () => {
  const detail = sanitizeDebugError(
    JSON.stringify({
      auth: "auth-sentinel",
      jwt: "jwt-sentinel",
      key: "key-sentinel",
      privateKey: "private-key-sentinel",
      sshKey: "ssh-key-sentinel",
      token: "token-sentinel",
    })
  );

  match(detail, /structured detail omitted/);
  doesNotMatch(
    detail,
    /auth-sentinel|jwt-sentinel|key-sentinel|private-key-sentinel|ssh-key-sentinel|token-sentinel/
  );

  const arrayDetail = sanitizeDebugError(
    JSON.stringify(["jwt-array-sentinel"])
  );
  const scalarDetail = sanitizeDebugError(
    JSON.stringify("jwt-scalar-sentinel")
  );
  match(arrayDetail, /structured detail omitted/);
  match(scalarDetail, /structured detail omitted/);
  doesNotMatch(arrayDetail, /jwt-array-sentinel/);
  doesNotMatch(scalarDetail, /jwt-scalar-sentinel/);
});

test("DEBUG=2 sanitizes failed approved actions", async () => {
  const events: string[] = [];
  const session = createSession(
    "debug-user",
    "marketing",
    (message) => events.push(message),
    2,
    ""
  );
  session.pendingApprovals.set("approval-id", {
    action: async () => {
      throw new Error(JSON.stringify({ token: "approval-token-sentinel" }));
    },
    description: "Send email.",
    expiresAt: Date.now() + 60_000,
  });

  await rejects(approve(session, "approval-id"));
  const trace = events.join("\n");
  match(trace, /approval: action failed/);
  match(trace, /approval: action error Error: \[structured detail omitted\]/);
  doesNotMatch(trace, /approval-token-sentinel/);
});

test("DEBUG=2 omits non-object and nested tool arguments", () => {
  const tool = {
    description: "Test tool.",
    name: "test_tool",
    parameters: {
      properties: {
        body: { type: "object" },
        sharedKey: { type: "string" },
        url: { type: "string" },
      },
      type: "object",
    },
    run: async () => ({}),
  } satisfies Tool;

  const detail = formatDebugToolArguments(
    {
      body: { token: "nested-token-sentinel" },
      sharedKey: "shared-key-sentinel",
      url: "https://url-user:url-password@example.test/download?sig=signed-url-sentinel",
    },
    tool
  );
  const scalarDetail = formatDebugToolArguments("jwt-scalar-sentinel", tool);
  const objectFieldScalarDetail = formatDebugToolArguments(
    { body: "body-scalar-sentinel" },
    tool
  );
  const objectFieldNullDetail = formatDebugToolArguments({ body: null }, tool);
  const malformedScalarDetail = formatDebugToolArguments(
    {
      sharedKey: { value: "nested-shared-key-sentinel" },
      url: ["https://example.test?sig=array-sentinel"],
    },
    tool
  );
  const nullScalarDetail = formatDebugToolArguments({ sharedKey: null }, tool);

  doesNotMatch(detail, /"body"/);
  match(detail, /"sharedKey":"\[redacted\]"/);
  match(detail, /https:\/\/\[redacted\]@example\.test/);
  match(detail, /sig=\[redacted\]/);
  match(scalarDetail, /input omitted/);
  doesNotMatch(objectFieldScalarDetail, /body|body-scalar-sentinel/);
  doesNotMatch(objectFieldNullDetail, /body/);
  doesNotMatch(
    malformedScalarDetail,
    /sharedKey|url|nested-shared-key-sentinel|array-sentinel/
  );
  doesNotMatch(nullScalarDetail, /sharedKey/);
  doesNotMatch(
    detail,
    /nested-token-sentinel|shared-key-sentinel|signed-url-sentinel|url-user|url-password/
  );
  doesNotMatch(scalarDetail, /jwt-scalar-sentinel/);
});

test("DEBUG=2 redacts URL userinfo and Basic authorization errors", () => {
  const detail = sanitizeDebugError(
    "Authorization: Basic basic-credential-sentinel"
  );
  const urlDetail = sanitizeDebugError(
    "Request failed for https://url-user:url-password@example.test"
  );

  match(detail, /Authorization: \[redacted\]/);
  match(urlDetail, /https:\/\/\[redacted\]@example\.test/);
  doesNotMatch(detail, /basic-credential-sentinel/);
  doesNotMatch(urlDetail, /url-user|url-password/);
});
