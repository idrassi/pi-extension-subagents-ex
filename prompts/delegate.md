---
description: Delegate a well-scoped task to a background worker while you continue in the main session
---
Use the subagent tool with runInBackground: true to delegate this task to a "worker" agent: $@

Rules for background delegation:
1. Phrase the task so the worker is fully autonomous: exact files if known, acceptance criteria, and what NOT to touch.
2. If the task involves writing code in a git repo, set isolation: "worktree" so the worker cannot collide with the main checkout.
3. After starting the background task, continue with related work in this session (do NOT idle-wait). The completion will be reported automatically; you can also collect it with subagent_task_output.
4. Collect the completed result. Review its patch artifact, changed files, and recorded verification commands. In the target repository, run `git apply --check <patch-path>` before applying the reviewed patch with `git apply <patch-path>`. Resolve conflicts explicitly. Worker changes may be uncommitted, so a branch name alone is not a complete handoff.
