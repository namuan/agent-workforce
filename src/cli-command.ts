const approvalIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CliCommand =
  | { readonly approvalId: string; readonly type: "approve" }
  | { readonly type: "exit" }
  | { readonly message: string; readonly type: "message" }
  | { readonly type: "unknown" };

export const parseCliCommand = (message: string): CliCommand => {
  const command = message.trim();
  if (command === "/exit") {
    return { type: "exit" };
  }
  const approvalId = command.match(/^\/approve\s+(\S+)$/)?.[1];
  if (approvalId && approvalIdPattern.test(approvalId)) {
    return { approvalId, type: "approve" };
  }
  if (command.startsWith("/")) {
    return { type: "unknown" };
  }
  return { message, type: "message" };
};
