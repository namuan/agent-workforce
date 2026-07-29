import type { ToolFactory } from "./tools.ts";

export interface AgentDefinition {
  readonly description: string;
  readonly directory?: string;
  readonly systemOnly?: boolean;
}

export interface TeamModule {
  readonly agents: Readonly<Record<string, AgentDefinition>>;
  readonly createTools: ToolFactory;
  readonly failureAnalysisAgent?: string;
  readonly id: string;
  readonly leadDelegationGuidance: string;
  readonly maxFailureRecoveryAttempts?: number;
}
