import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseCliCommand } from "./cli-command.ts";
import { approve, chat, createSession, debugEnabled } from "./runtime.ts";

const team = process.env.TEAM;
if (!team) {
  throw new Error("Set TEAM to a team directory name before starting the CLI.");
}
const terminal = createInterface({ input, output });
const session = createSession(
  process.env.PRINCIPAL_ID ?? "local-user",
  team,
  debugEnabled() ? (message) => output.write(`[debug] ${message}\n`) : undefined
);

output.write(
  `${team} team ready. Type /exit to quit. Approvals use /approve <id>.\n\n`
);
for (;;) {
  const message = await terminal.question("You: ");
  const command = parseCliCommand(message);
  if (command.type === "exit") {
    break;
  }
  try {
    if (command.type === "unknown") {
      output.write("\nError: Unknown command. Use /approve <id> or /exit.\n\n");
      continue;
    }
    const result =
      command.type === "approve"
        ? await approve(session, command.approvalId)
        : await chat(session, command.message);
    output.write(`\nTeam: ${result.text}\n\n`);
  } catch (error) {
    output.write(
      `\nError: ${error instanceof Error ? error.message : "Unexpected failure."}\n\n`
    );
  }
}
terminal.close();
