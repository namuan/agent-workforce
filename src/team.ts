import type { ToolFactory } from "./tools.ts";

export interface AgentDefinition {
  readonly description: string;
  readonly directory?: string;
}

export interface TeamModule {
  readonly agents: Readonly<Record<string, AgentDefinition>>;
  readonly createTools: ToolFactory;
  readonly id: string;
  readonly leadDelegationGuidance: string;
}
