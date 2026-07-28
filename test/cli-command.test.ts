import { deepEqual, equal } from "node:assert/strict";
import test from "node:test";
import { parseCliCommand } from "../src/cli-command.ts";

const approvalId = "866103c9-6a6d-4973-9846-c20a167f6fc5";

test("CLI parser recognises exit, approval, and chat messages", () => {
  deepEqual(parseCliCommand(" /exit "), { type: "exit" });
  deepEqual(parseCliCommand(`/approve ${approvalId}`), {
    approvalId,
    type: "approve",
  });
  deepEqual(parseCliCommand("Build a snake game"), {
    message: "Build a snake game",
    type: "message",
  });
});

test("CLI parser rejects malformed slash commands", () => {
  for (const command of [
    "/approval",
    "/approved",
    "/approve",
    "/approve not-a-token",
    "/approve  ",
  ]) {
    equal(parseCliCommand(command).type, "unknown");
  }
});
