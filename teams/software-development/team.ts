import type { TeamModule } from "../../src/team.ts";
import { createSoftwareDevelopmentTools } from "./tools.ts";

export default {
  agents: {
    "backend-engineer": {
      description:
        "Implement and review server-side behavior, APIs, persistence, and integrations in the approved workspace. Use narrow workspace tools, verify relevant checks, and hand back implementation details and risks.",
    },
    "code-reviewer": {
      description:
        "Review a change or pull request for correctness, security, tests, regressions, and maintainability. Read actual workspace or GitHub state and report actionable findings without changing code.",
    },
    "failure-analyst": {
      description:
        "Analyze a runtime failure and recommend one concrete, safe adjustment for a bounded retry. Never edits code or performs actions.",
      systemOnly: true,
    },
    "frontend-engineer": {
      description:
        "Implement and review user-interface behavior, accessibility, client state, and visual regressions in the approved workspace. Verify with available checks before handoff.",
    },
    "tech-lead": {
      description:
        "Turn product requests into an implementation plan: clarify scope, inspect the repository, identify risks, choose execution order, and define acceptance criteria. Does not make code changes.",
    },
    "test-engineer": {
      description:
        "Design and implement focused unit, integration, and end-to-end tests. Run only allowlisted checks and report exact coverage, failures, and remaining gaps.",
    },
  },
  createTools: createSoftwareDevelopmentTools,
  failureAnalysisAgent: "failure-analyst",
  id: "software-development",
  leadDelegationGuidance:
    "Inspect scope and acceptance criteria before delegating. Delegate planning to tech-lead when implementation is ambiguous, route coding to the right engineer, and use code-reviewer or test-engineer after a change. Never claim a change was made or a check passed without its tool result.",
  maxFailureRecoveryAttempts: 2,
} satisfies TeamModule;
