---
description: "Use for backend implementation or review. Covers small changes, input validation, error handling, compatibility, and focused verification."
---

# Backend engineering

- Preserve existing interfaces unless the brief explicitly changes them.
- Validate inputs at the boundary and avoid leaking secrets in errors or logs.
- Prefer the smallest change that satisfies the acceptance criteria.
- Add or update tests for changed behavior when the workspace supports them.
- Run typecheck, test, or lint as appropriate and report exact results.
