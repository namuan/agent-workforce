export interface Tool {
  readonly description: string;
  readonly name: string;
  readonly parameters: Record<string, unknown>;
  readonly run: (input: unknown) => Promise<unknown>;
}

export interface ToolFactoryContext {
  readonly agent: string;
  readonly delegate: (specialist: string, brief: string) => Promise<unknown>;
  readonly loadSkill: (name: string, reference?: string) => Promise<string>;
  readonly principalId: string;
  readonly requestApproval: (
    description: string,
    action: () => Promise<unknown>
  ) => { readonly approvalId: string; readonly message: string };
  readonly specialists: readonly string[];
}

export type ToolFactory = (context: ToolFactoryContext) => Tool[];
