import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { approve, chat, createSession } from "./runtime.ts";

const team = process.env.TEAM;
if (!team) {
  throw new Error("Set TEAM to a team directory name before starting the CLI.");
}
const session = createSession(process.env.PRINCIPAL_ID ?? "local-user", team);
const terminal = createInterface({ input, output });

output.write(
  `${team} team ready. Type /exit to quit. Approvals use /approve <id>.\n\n`
);
for (;;) {
  const message = await terminal.question("You: ");
  if (message.trim() === "/exit") {
    break;
  }
  try {
    const approval = message.match(/^\/approve\s+(.+)$/);
    const result = approval
      ? await approve(session, approval[1].trim())
      : await chat(session, message);
    output.write(`\nTeam: ${result.text}\n\n`);
  } catch (error) {
    output.write(
      `\nError: ${error instanceof Error ? error.message : "Unexpected failure."}\n\n`
    );
  }
}
terminal.close();
