---
description: "Use for a software change or pull-request review. Provides a priority order for correctness, security, regressions, tests, and maintainability findings."
---

# Code review

1. Confirm the change meets the stated behavior.
2. Check trust boundaries, authorization, validation, and secret handling.
3. Look for regressions, error handling gaps, and data-loss paths.
4. Confirm changed behavior has proportionate tests.
5. Report findings by severity with a concrete fix direction. Say when no finding is supported by evidence.
