# Subagents EX

A pi extension based on the [official subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent). It adds background task management, shared agent-tree budgets, worktree patch handoffs, validated output contracts, steering, resumable sessions, and durable run history.

Requires **Node.js 22.19+ and pi 0.86.0 or later** (verified through pi **0.99.1**). Each worker runs in a separate pi RPC process. Worktrees separate checkouts; they are not an operating-system sandbox.

## Install

Use the release archive `pi-subagents-ex-1.0.0.tgz` on any machine with the Node.js and pi versions above. Extract it into pi's extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions/subagents-ex
tar -xzf pi-subagents-ex-1.0.0.tgz -C ~/.pi/agent/extensions/subagents-ex --strip-components=1
```

For a new installation, use an empty destination directory. Run `/reload` in pi after installation. This is a normal auto-discovered extension, displayed as `subagents-ex`.

The archive contains the extension's TypeScript modules, bundled agents and prompts, and its runtime dependencies. It excludes development tools, tests, benchmarks, and repository metadata. Pi supplies its own SDK packages, so no separate `npm install` is needed on the destination machine.

The two directories serve different purposes:

- `~/.pi/agent/extensions/subagents-ex/` contains the installed extension.
- `~/.pi/agent/subagents-ex/` contains saved runs, child sessions, task records, and artifacts. It is created during use and does not need to be copied to install the extension elsewhere.

Bundled agents (`scout`, `planner`, `reviewer`, `worker`, `tester`) and prompts (`/implement`, `/scout-and-plan`, `/implement-and-review`, `/fan-out`, `/delegate`) are discovered automatically.

## Package for another machine

From the development checkout:

```bash
npm ci
npm pack
```

Transfer the resulting `pi-subagents-ex-1.0.0.tgz` and extract it as shown above. `npm pack` uses the manifest's `files` allowlist and includes `ajv`, `proper-lockfile`, and their dependencies. Keep the pi SDK peers optional so npm does not install a second copy of pi for consumers.

The same archive can be published to an npm registry. Once published under an available package name, consumers can use `pi install npm:<package-name>`. This repository does not publish packages automatically.

## Develop

```bash
npm ci
pi install /absolute/path/to/pi-subagents-ex
```

For a development checkout, a symlink also works:

```bash
ln -s /absolute/path/to/pi-subagents-ex ~/.pi/agent/extensions/subagents-ex
```

Use `/reload` after changes. These development installs refer to the checkout, which must remain available. Use the archive installation above for a standalone copy.

```bash
npm run check
npm test
npm run eval -- --check-fixtures
```

Tests use temporary repositories and deterministic subprocesses, including a local provider running through the real pi CLI. They make no paid provider requests. CI runs on Node 22.19 and 24.

## Execution

The model can call `subagent` with one of these shapes:

```javascript
// One worker
{ agent: "worker", task: "Implement X and run its tests" }

// Independent workers; top-level defaults apply to each task
{
  isolation: "worktree",
  tasks: [
    { agent: "worker", task: "Implement A" },
    { agent: "worker", task: "Implement B", maxTurns: 15 }
  ]
}

// A sequence sharing one checkout
{
  isolation: "worktree",
  chain: [
    { agent: "worker", task: "Implement X and verify it" },
    { agent: "reviewer", task: "Review these edits: {previous}" }
  ]
}
```

Parallel calls accept 1–32 tasks and use the shared worker pool; chains accept 1–32 steps and stop at the first failing step. Chain placeholders are literal substitutions: `{previous}` is the prior final response and `{steps.N}` is a prior step's response, indexed from zero. Inserted text is not interpreted as another template. Prompts travel over stdin, with a 4 MB limit after expansion.

| Option | Behavior |
|---|---|
| `model` | Per-task override, then top-level default, then saved model on resume, then agent definition, then parent session. |
| `thinking` | Per-task override, then top-level default, then agent definition, then parent session. Inherited independently of model selection. |
| `cwd` | Top-level path is relative to the dispatcher; per-item paths are relative to that base. A single call resolves its path once. |
| `timeout` | Optional positive seconds for each run, including queueing and retries; no total deadline by default. Cancellation uses SIGTERM, then SIGKILL after a 5-second grace period. Artifact export and cleanup can add time after the deadline. |
| `maxTurns` | Optional positive integer; total assistant turns allowed across attempts, unlimited by default. The child guard checks before starting another turn. |
| `retries` | Integer 0–3; retries errors, including invalid final JSON. Does not retry cancellation, timeouts, or exhausted budgets. Earlier attempts and usage are retained. |
| `maxCost` | Positive USD ceiling for observed run cost across attempts, including reported nested usage. Requests already in flight can overshoot. |
| `isolation` | `none` or `worktree`. Single: one checkout. Parallel: one per task, with per-task overrides. Chain: one shared checkout, specified only at the top level. |
| `outputFormat` | `text` or `json`. JSON must be one complete value, without prose or fences. Applies to the final chain step. |
| `outputSchema` | JSON Schema draft-07; implies JSON output and validates its shape. Maximum schema size 64 KB. Uses strict Ajv schema checks; `format` annotations are not enforced. |
| `agentScope` | `user` (default), `project`, or `both`. Bundled agents are always available. |
| `runInBackground`, `notify` | Start a managed background task; completion notifications default to true. |
| `resume` | Saved run ID to continue; `task` is the follow-up instruction. Preserves its checkout and copies its last child session into a new run. |

All bundled agents inherit the parent session's model and thinking level by default. Selecting a different subagent model keeps the inherited thinking level unless you explicitly override it. Supported thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; pi adjusts unsupported levels to those available on the target model and disables thinking for models without reasoning support. A resumed run uses the current parent's thinking level unless the call or agent definition overrides it.

```javascript
// Use another model with the parent's thinking level
{ agent: "worker", task: "Implement X", model: "provider/model-id" }

// Explicit thinking override (also accepted on individual tasks or chain steps)
{ agent: "worker", task: "Implement X", model: "provider/model-id", thinking: "max" }
```

Top-level timeout, turn, cost, and retry options are defaults **per run**, not one aggregate limit for the whole parallel call or chain. The shared tree limits below bound aggregate work. Retries start a fresh child context with failure feedback in the same checkout; they are not a rollback and may repeat side effects. Use `resume` to deliberately continue an existing conversation.

Bundled agents have no turn cap or total runtime deadline. A progress watchdog stops a child after **10 minutes without model or tool progress**, returning `timeout` with a stall reason. It starts when the child is prompted, so time in the admission queue does not count. Model streaming (including thinking), message boundaries, and tool execution updates reset it; stderr and unrelated RPC responses do not. Parents waiting in `subagent` or `subagent_task_output` rely on their descendants' watchdogs and restart their own watchdog after the tool returns. An explicit `timeout` still bounds the entire run, including those waits. Set `PI_SUBAGENTS_EX_STALL_TIMEOUT_MS` to adjust the idle window, including for tools that legitimately run silently for longer than ten minutes.

Every result includes model-visible run IDs, statuses, working directories, child session paths, usage, errors, and artifact references. Parallel results distinguish partial success. Failed orchestration and failed runs are flagged through pi's `tool_result` error hook while retaining structured details.

## Background work, steering, and resume

```javascript
subagent({ agent: "worker", task: "Implement X", isolation: "worktree", runInBackground: true })
// Returns task-<uuid>

subagent_task_list({})
subagent_task_send({ id: "task-<uuid>", message: "Also cover the empty-input case" })
subagent_task_output({ id: "task-<uuid>", wait: true, timeoutSeconds: 600 })
subagent_task_kill({ id: "task-<uuid>" })

subagent({ resume: "run-<uuid>", task: "Address the review feedback" })
```

Use `runId` with `subagent_task_send` when a parallel task has multiple active workers. Steering is queued at pi's next steering boundary; it does not interrupt a running tool. Workers must have reached RPC prompt acceptance before they accept steering. A settled worker can be resumed instead.

Progress includes live statuses, turns, and usage. Reading output repeatedly does not charge it again. Completion usage is attached once to the next persisted assistant or tool message, regardless of collection. The task dashboard updates immediately; an idle parent session's token/cost footer catches up when that next message is persisted. Notifications are queued into the current loop or the next user turn, and do not start an unsolicited new turn while idle.

Cancelling a collection wait leaves the background task running. Task cancellation stops its current workers. Session shutdown cancels all tasks and waits for cleanup. Workers also monitor their dispatcher and terminate if it disappears.

Task snapshots survive reload/resume of the parent session. Work interrupted by a crash is marked interrupted and is **not automatically relaunched**. Inspect the saved runs, then explicitly resume an available session. Resume charges only new work and uses the current agent definition, with project trust checked again. Deleted worktrees/sessions cannot be resumed. Concurrent use of the same worktree is rejected. These are session continuations, not exactly-once execution guarantees after a crash; usage available only in a killed provider request may be absent from the last durable snapshot.

## Shared scheduling and budgets

Foreground calls, background tasks, and nested workers share a process-safe queue and ledger for one parent pi session. Waiting parents yield their slots while descendants execute, then reacquire them before continuing. This avoids a deadlock when all available parents delegate. The limit controls active workers; parked parents remain live processes waiting for results.

Set these variables before starting the parent session:

| Variable | Default | Range / meaning |
|---|---:|---|
| `PI_SUBAGENTS_EX_CONCURRENCY` | 20 | 1–32 active workers |
| `PI_SUBAGENTS_EX_MAX_RUNS` | unset | Optional 1–10,000 admitted runs, including resumed runs; queued requests consume an admission |
| `PI_SUBAGENTS_EX_MAX_TOTAL_TURNS` | unset | Optional 1–100,000 child assistant turns |
| `PI_SUBAGENTS_EX_MAX_COST` | unset | Positive observed USD ceiling for the tree |
| `PI_SUBAGENTS_EX_STALL_TIMEOUT_MS` | 600000 | 1–2,147,483,000 milliseconds without model or tool progress per child; read from the environment, not stored in the tree ledger |

With no overrides, run and turn totals are tracked without a cumulative ceiling. These defaults follow Claude Code's documented [20-subagent concurrency and unlimited session spawn count](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit) and [10-minute progress watchdog](https://code.claude.com/docs/en/env-vars). This extension queues work above its active-worker limit and accepts up to 32 tasks per parallel call.

The first use fixes shared tree limits in the session's durable ledger; resuming that session retains its consumption and limits. **Existing sessions keep their saved limits**, including the former defaults of 4 workers, 128 runs, and 1000 turns. Start a new parent pi session to adopt the new defaults; reloading the extension or changing environment variables does not rewrite an existing ledger. `/agents-budget` displays the current totals and labels absent run/turn ceilings `unlimited`. These budgets cover delegated work, not the top-level interactive model's own requests. A mandatory child extension checks explicit turn limits even when ordinary extensions are disabled. Nested managed usage is counted once; retries and other usage-bearing tool results remain billable. In-flight requests and usage reported late can overshoot cost ceilings. Accounting depends on provider-reported usage and is not a billing-system hard cap.

Delegation is available at depths 0–2; workers at depth 3 cannot delegate further. `extensions: false` also disables further delegation. Custom extensions that make their own model requests outside pi's normal turn/usage events are outside the turn guard's scope.

## Worktree and artifact handoff

Worktrees start from **committed HEAD**; the parent's uncommitted changes are not copied. Git's common directory is resolved correctly for linked checkouts. A committed working subdirectory is preserved within the new checkout. Chain steps must remain inside the isolated repository.

At completion, the extension exports a binary-capable patch against the starting commit using a temporary index. It includes worker commits, tracked modifications/deletions, and new non-ignored files without staging changes in the worker's real index. Ignored files and uncommitted changes inside submodule working directories are not copied into the patch. The worktree and branch are retained.

Model-visible metadata points to:

- `patch`: the integration artifact, when changes exist;
- `baseCommit` and `changedFiles`: the change scope;
- `manifest`: full artifact metadata and recorded bash command evidence;
- `verification`: recent command names, error flags, and exit codes when available.

Recorded command output is evidence of what ran; it is not an independent certification that all acceptance criteria were tested. Each recorded output excerpt is capped at 8 KB; full tool-result messages remain in the run/session records. Long changed-file and command lists are summarized in the model response, with the full lists in the manifest.

Review the patch and verification output before integrating it in the target repository:

```bash
git apply --check /absolute/path/to/run-uuid.patch
git apply /absolute/path/to/run-uuid.patch
```

Resolve conflicts explicitly. Worker edits need not be committed, so merging its branch alone may omit the work. `/agents-clean-worktrees` asks before deleting inactive checkouts and branches, skips active ownership, and preserves exported patches.

## Agent definitions and trust

Definitions are Markdown files with YAML frontmatter. Later sources override earlier ones: bundled definitions, `~/.pi/agent/agents/*.md`, then the nearest project `.pi/agents/*.md` when its scope is enabled.

```markdown
---
name: specialist
description: Implement and verify a scoped change
# model: provider/model-id        # omitted: inherit dispatcher model
# thinking: high                 # omitted: inherit dispatcher thinking level
tools: read, bash, edit, write     # optional allowlist
# excludeTools: write, edit       # optional; ignored when tools is set
skills: false                    # defaults to true
contextFiles: false              # defaults to true
extensions: true                 # defaults to true
maxTurns: 25
timeout: 600
retries: 1
---
Complete the assigned task and report the verification performed.
```

Invalid numeric frontmatter is rejected and reported in discovery diagnostics. Project agents require either pi project trust or explicit user confirmation for the selected definitions. Untrusted headless use is rejected. A model cannot disable that gate with `confirmProjectAgents: false`. Approval is cached only for the exact definition during the current extension session.

Custom provider models require their provider extension to load in children. Keep `extensions: true` for those agents. Since pi 0.99.0, `--no-extensions` also disables pi's built-in extensions, so `extensions: false` children lose the llama.cpp provider and MCP-supplied tools as well. Tool allowlists, project trust, and worktrees do not restrict filesystem access as an OS sandbox would.

## Policy, dashboard, and history

`/agents-policy off|balanced|aggressive` controls delegation guidance. `balanced` suggests bounded tasks where separate context helps; `aggressive` asks for more specialist delegation. `off` removes proactive guidance from the system prompt while leaving tools callable. Policy is guidance, not a deterministic planner or a demonstrated quality improvement. Set `PI_SUBAGENTS_EX_POLICY` for the initial default.

`/agents` shows live tasks and the latest run history. Arrow keys select, Enter opens details, `k` cancels a task, `r` refreshes, and Escape returns/closes. Selection scrolls into view; lines respect terminal display width. Non-TUI modes show a text summary.

State lives under `~/.pi/agent/subagents-ex/` (or the configured `PI_CODING_AGENT_DIR`):

| Directory | Contents |
|---|---|
| `runs/` | Atomic snapshots: final outcome, all attempt messages and usage, diagnostics, metadata, bounded stderr |
| `sessions/` | Native pi child sessions, one per attempt; used for resume |
| `tasks/` | Background task snapshots, keyed by parent session |
| `trees/` | Shared admission and budget ledgers |
| `worktrees/` | Individual worktree records and live ownership |
| `artifacts/` | Patches and command-evidence manifests |

Run snapshots retain the newest 200 settled records. Active records are not pruned. Sessions, artifacts, task snapshots, and budget ledgers are retained until manually removed; they can contain source and tool output, so plan disk retention accordingly. Stderr is capped at 32 KB per attempt and final model-visible prose at 50 KB per run. No promise is made to recover bytes a child never flushed before forced termination.

## Design and evaluation

`plan.ts` normalizes and validates modes/options. `orchestrator.ts` executes all modes through the same `runner.ts` RPC engine. `scheduler.ts` coordinates processes; `child-guard.ts` enforces budgets inside pi. `tasks.ts`, `accounting.ts`, and `store.ts` handle background ownership, usage attribution, and persistence. `worktree.ts` exports patch handoffs. Presentation consumes these records through `render.ts` and `dashboard.ts`.

The [evaluation harness](benchmarks/README.md) compares direct work, the stock example, and this extension on repeatable fixtures, measuring task success, patch correctness, latency, tokens, and cost. Offline fixture checks and mocked integration tests establish mechanics. Live model comparisons are opt-in; no task-quality or cost advantage is claimed without those measurements.
