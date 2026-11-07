# Subagents EX

A pi extension based on the [official subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent). It adds background task management, shared agent-tree budgets, worktree patch handoffs, validated output contracts, steering, resumable sessions, and durable run history.

Requires **Node.js 22.19+ and pi 0.86.0 or later**. Production entrypoints are checked against pi 0.86.0; the full development suite targets pi **0.99.1 and 1.5.0** (see compatibility notes below). Each worker runs in a separate pi RPC process. Worktrees separate checkouts; they are not an operating-system sandbox.

## Install

With Git installed, install directly from GitHub, pinned to **v1.0.0**:

```bash
pi install https://github.com/idrassi/pi-extension-subagents-ex@v1.0.0
```

To install the latest code from the repository's default branch, omit the tag:

```bash
pi install https://github.com/idrassi/pi-extension-subagents-ex
```

The default branch may include unreleased changes. Pi installs runtime dependencies automatically. Run `/reload` in an existing pi session after installation.

Alternatively, download the release archive `pi-subagents-ex-1.0.0.tgz` and extract it into pi's extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions/subagents-ex
tar -xzf pi-subagents-ex-1.0.0.tgz -C ~/.pi/agent/extensions/subagents-ex --strip-components=1
```

For a new installation, use an empty destination directory. Run `/reload` in pi after installation. This is a normal auto-discovered extension, displayed as `subagents-ex`.

The archive contains the extension's TypeScript modules, bundled agents and prompts, and its runtime dependencies. It excludes development tools, tests, benchmarks, and repository metadata. Pi supplies its own SDK packages, so no separate `npm install` is needed on the destination machine.

For archive installations, the two directories serve different purposes:

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
npm run measure -- --repeats 3 --fanout 4
```

Tests use temporary repositories and deterministic subprocesses, including a local provider running through the real pi CLI. These commands make no paid provider requests. The measurement command creates a private temporary configuration, never copies credentials, and reports startup/first-token/queue/delivery timings, active/parked RSS, event-loop delay, sampled I/O, and accounting/resource invariants. See [benchmark methodology](benchmarks/README.md) for definitions and limitations; synthetic reported costs are not provider bills.

### Compatibility verification

Local Linux verification covers Node **24.14.0** with pi **0.99.1/1.5.0**, and Node **22.19.0** with pi **0.99.1**. At the advertised pi **0.86.0** floor, production-source typechecking (`npm run check:production`) and a selected runtime smoke suite also pass on Node 22.19.0. The full development suite does **not** pass against that SDK: some fixtures deliberately exercise newer `executeTool`/`agent_before_settle` APIs. This distinction is not a claim of exhaustive minimum-version compatibility.

`.github/workflows/checks.yml` defines a minimum-version smoke job and full-suite jobs for selected Linux/macOS/Windows, Node, and pi combinations. Those workflow definitions are not evidence of completed CI or non-Linux validation. POSIX-only fault/process-group tests remain platform-conditional.

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
| `outputSchema` | Synchronous JSON Schema draft-07; implies JSON output and validates its shape. Maximum serialized schema size is 64 KiB of UTF-8. Async validators are rejected. Each contract has an isolated Ajv registry; `format` annotations are not enforced. |
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

Bundled agents have no turn cap or total runtime deadline. A progress watchdog stops a child after **10 minutes without model or tool progress**, returning `timeout` with a stall reason. It starts when the child is prompted, so time in the admission queue does not count. Model streaming (including thinking), message boundaries, and tool execution updates reset it; stderr and unrelated RPC responses do not. Parents waiting in `subagent` or `subagent_task_output` rely on their descendants' watchdogs and restart their own watchdog after the tool returns. Waiting for a managed model-request permit also pauses stall detection. An explicit `timeout` still bounds the entire run, including those waits. Set `PI_SUBAGENTS_EX_STALL_TIMEOUT_MS` to adjust the idle window, including for tools that legitimately run silently for longer than ten minutes.

Results publish compact run summaries, not transcripts. Exact run/tree/lineage IDs and all seven usage fields are preserved; output, task descriptions, errors, verification lists, and optional metadata can be shortened or omitted. Parallel results distinguish partial success. Failed orchestration and failed runs are flagged through pi's `tool_result` error hook while retaining structured details.

## Bounded results and full output

The serialized `{ content, details, usage }` result is limited to **64 KiB of UTF-8**, including JSON escaping. Model-facing text is at most **32 KiB and 1000 lines**; details have a **30 KiB** budget. A run's output preview is at most **4 KiB/160 lines**, and aggregate limits may shorten it further. Truncation is explicit. SDK usage totals are not clipped or recomputed. Exception results from these tools are bounded too.

**JSON previews are not necessarily complete JSON documents.** Output contracts and chain placeholders still use complete internal run records. Successful settlement saves the full final text or parsed JSON to the run's `.output.txt` artifact; manifests and native sessions retain the larger evidence/transcript. Artifact paths are exact when included, never silently shortened into invalid references.

Use the explicit, uncharged retrieval tools for larger output:

```javascript
subagent_history({ limit: 30 })
// Follow details.nextCursor with { cursor: "...", limit: 30 }.

subagent_run_output({ id: "run-<uuid>", offset: 0, limit: 4096 })
// Follow details.nextOffset until absent. Offsets and limits are UTF-8 BYTES.
```

History defaults to 30 rows (maximum 50); it reads metadata, not v3 transcripts. Output pages contain at most 4096 bytes/900 output lines plus a header. Do not count JavaScript characters to calculate an offset: use `nextOffset`, which also handles Unicode and line-limited pages. Choose a byte limit large enough for the next complete UTF-8 character. Settled materialized output is read directly; live/interrupted/legacy or stale output falls back to explicit transcript reconstruction without locking or rewriting the run. Repeated changes during a live read can require a retry. Live pages are not a frozen transcript snapshot.

Task/history pages can be smaller than the requested limit to fit escaped metadata. Follow the returned cursor rather than assuming a fixed number of rows.

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

`subagent_task_list` returns result-free summaries and run IDs: default 10 tasks, maximum 20, with `cursor`/`nextCursor` pagination. `subagent_task_output` explicitly loads the selected compact result; use its run IDs with `subagent_run_output` for complete output. The dashboard also hydrates selected details only on demand.

Progress includes live statuses, turns, and usage. Progress persistence and presentation are coalesced around 100 ms; lifecycle and final saves flush immediately. Reading output repeatedly does not charge it again. Completion usage is attached once to the next persisted **tool result**, regardless of collection, or recorded in a child shutdown receipt. Assistant provider usage is never inflated with background tokens, so pi's context-size estimates remain unchanged. The task dashboard reflects live usage with coalesced refreshes; an idle parent's token/cost footer can remain behind until the next tool result is persisted. Notifications are queued into the current loop or the next user turn, and do not start an unsolicited new turn while idle.

Cancelling a collection wait leaves the background task running. Task cancellation stops its current workers. Session shutdown cancels all tasks and waits for cleanup. On POSIX, cancellation retains ownership of the process group after the RPC leader exits and escalates to SIGKILL before releasing its scheduler slot. Workers also monitor their dispatcher and retain a hard termination deadline through hanging shutdown hooks. Windows uses bounded `taskkill /T /F` while the leader is available; this is best-effort cleanup, not Job Object containment, and has not been verified on Windows.

Task snapshots survive reload/resume of the parent session. Managed workers use a fresh run/attempt namespace: copying a transcript for a retry or sibling continuation does not transfer ownership of another attempt's background tasks. Work interrupted by a crash is marked interrupted and is **not automatically relaunched**. Inspect the saved runs, then explicitly resume an available session. Resume charges only new work and uses the current agent definition, with per-definition project authorization checked again. Deleted worktrees/sessions cannot be resumed. Concurrent use of the same worktree is rejected. These are session continuations, not exactly-once execution guarantees after a crash; usage available only in a killed provider request may be absent from the last durable snapshot.

## Shared scheduling and budgets

Foreground calls, background tasks, and nested workers share a process-safe queue and ledger for one parent pi session. There are independent limits for **executing workers, retained worker processes, queued admissions, and active model requests**. Waiting parents yield execution slots while descendants execute, then reacquire them before continuing; they retain their process reservations. Newly queued workers reserve no process until admitted. If the process cap leaves no room for a nested child, admission fails explicitly instead of deadlocking behind its parked parent.

Set these variables before starting the parent session:

| Variable | Default | Range / meaning |
|---|---:|---|
| `PI_SUBAGENTS_EX_CONCURRENCY` | 20 | 1–32 executing workers |
| `PI_SUBAGENTS_EX_MAX_PROCESSES` | 64 | 1–256 retained worker-process reservations, including parked parents |
| `PI_SUBAGENTS_EX_MAX_QUEUED` | 256 | 1–10,000 combined waiting worker/model-request admissions |
| `PI_SUBAGENTS_EX_MAX_REQUESTS` | 20 | 1–128 active managed model-request operations |
| `PI_SUBAGENTS_EX_MAX_RUNS` | unset | Optional 1–10,000 admitted runs, including resumed runs; queued requests consume an admission |
| `PI_SUBAGENTS_EX_MAX_TOTAL_TURNS` | unset | Optional 1–100,000 child assistant turns |
| `PI_SUBAGENTS_EX_MAX_COST` | unset | Positive observed USD ceiling for the tree |
| `PI_SUBAGENTS_EX_STALL_TIMEOUT_MS` | 600000 | 1–2,147,483,000 milliseconds without model or tool progress per child; read from the environment, not stored in the tree ledger |

With no overrides, run and turn totals are tracked without a cumulative ceiling. These defaults follow Claude Code's documented [20-subagent concurrency and unlimited session spawn count](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit) and [10-minute progress watchdog](https://code.claude.com/docs/en/env-vars). This extension queues work above its active-worker limit and accepts up to 32 tasks per parallel call.

The first mutation fixes shared tree limits in the session's durable ledger; resuming that session retains its consumption and limits. **Existing sessions keep their saved limits**, including the former defaults of 4 workers, 128 runs, and 1000 turns. Old ledgers missing the three new resource limits receive their defaults without resetting consumption or accounting receipts. Start a new parent pi session to change saved limits; reloading the extension or changing environment variables does not rewrite them. `/agents-budget` displays worker, process, queue, request, run, turn, and cost totals and labels absent run/turn ceilings `unlimited`. These budgets cover delegated work, not the top-level interactive model's own requests. A mandatory child extension checks explicit turn limits even when ordinary extensions are disabled. Nested managed usage is counted once; retries and other usage-bearing tool results remain billable. In-flight requests and usage reported late can overshoot cost ceilings. Accounting depends on provider-reported usage and is not a billing-system hard cap.

The shared ledger deduplicates each reported charge atomically across the child guard, RPC observer, and durable recovery. Every attempt exit reconciles flushed session messages and native `usage`, `compaction`, and `branch_summary` entries before applying any remaining statistics delta. The remainder is frozen at a recovered pre-shutdown checkpoint, so shutdown entries cannot hide a separate statistics-only charge. This relies on pi's supported persistence/shutdown ordering, not an atomic snapshot with arbitrary concurrent session writers. Historical entries in copied continuations are excluded. An incomplete final JSONL write is tolerated; other malformed records fail recovery rather than silently discarding usage. This cannot recover provider usage that was never reported or flushed.

Model-request reservations span stream consumption and provider retries, and are released before ordinary tools execute. Native compaction and branch summaries share the same cap. Child idle-cache warming is disabled because it has no usable assistant-completion boundary for permit release. A request-operation cap may conservatively retain a permit across native maintenance retries or sequential summary calls.

Delegation is available at depths 0–2; workers at depth 3 cannot delegate further. `extensions: false` also disables further delegation. Custom extensions that make their own model requests outside the guarded ordinary/native events are outside these request/turn controls.

## Worktree and artifact handoff

Worktrees start from **committed HEAD**; the parent's uncommitted changes are not copied. Git's common directory is resolved correctly for linked checkouts. A committed working subdirectory is preserved within the new checkout. Chain steps must remain inside the isolated repository.

At completion, the extension exports a binary-capable patch against the starting commit using a temporary index. It includes worker commits, tracked modifications/deletions, and new non-ignored files without staging changes in the worker's real index. Patch replacement uses a private temporary file and rename so a failed write does not replace a complete earlier handoff with partial bytes. Ignored files and uncommitted changes inside submodule working directories are not copied into the patch. The worktree and branch are retained. An export already in progress retains ownership and its process reservation until cleanup finishes, even if the caller cancels during that cleanup.

Model-visible metadata points to:

- `patch`: the integration artifact, when changes exist;
- `baseCommit` and `changedFiles`: the change scope;
- `manifest`: full artifact metadata and recorded bash command evidence;
- `verification`: shell-command evidence with run/attempt/call identity, optional parent-call identity, observed start/end/result flags, outcome, and an exit code only when actually reported.

Verification captures direct and arbitrarily nested bash execution events, not the SDK's bounded `nestedCalls` summary. It reconciles direct transcript results after missing RPC events without merging retries or copied history. Outcomes distinguish `completed`, `error`, `cancelled`, and `incomplete`: a missing end/result never certifies success, and `completed` does not invent exit code zero. Nested evidence depends on the SDK emitting those events; transcript fallback cannot reconstruct nested output that was never persisted.

Recorded output is evidence of what ran, not independent certification that all acceptance criteria were tested. Each excerpt is capped at **8 KiB UTF-8**; larger output has a stable artifact when available. `fullOutputComplete: false` and `outputError` expose partial/unavailable preservation. Evidence capture failures are recorded separately and never suppress message retention or usage recovery. Full evidence is retained in saved attempts/manifests; direct results also remain in native sessions. Long changed-file and command lists are summarized in the model response, with full lists in the manifest.

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

Invalid numeric frontmatter is rejected and reported in discovery diagnostics. **Project agents always require explicit confirmation for the selected definitions**, even when pi reports the project as trusted: pi's trust API does not establish authorization for extension-owned `.pi/agents` resources. Unapproved headless use is rejected. A model cannot disable that gate with `confirmProjectAgents: false`. Approval is memory-only for the exact loaded definition, settings, metadata, and source path in the current session; changes require reapproval. Unapproved project descriptions and parse diagnostics are not injected into the system prompt, and unauthorized project overrides do not hide bundled/user fallbacks.

Custom provider models require their provider extension to load in children. Keep `extensions: true` for those agents. Since pi 0.99.0, `--no-extensions` also disables pi's built-in extensions, so `extensions: false` children lose the llama.cpp provider and MCP-supplied tools as well. Tool allowlists, project trust, and worktrees do not restrict filesystem access as an OS sandbox would.

## Policy, dashboard, and history

`/agents-policy off|balanced|aggressive` controls delegation guidance. `balanced` suggests bounded tasks where separate context helps; `aggressive` asks for more specialist delegation. `off` removes proactive guidance from the system prompt while leaving tools callable. Policy is guidance, not a deterministic planner or a demonstrated quality improvement. Set `PI_SUBAGENTS_EX_POLICY` for the initial default.

`/agents` shows live tasks and the latest run history. Arrow keys select, Enter opens details, `k` cancels a task, `r` refreshes, and Escape returns/closes. Selection scrolls into view; lines respect terminal display width. Non-TUI modes show a text summary.

State lives under `~/.pi/agent/subagents-ex/` (or the configured `PI_CODING_AGENT_DIR`):

| Directory | Contents |
|---|---|
| `runs/` | v3 metadata checkpoints, append-only checksummed journals, task sidecars and settled output files; legacy v2 snapshots/backups |
| `sessions/` | Native pi child sessions, one per attempt; used for resume |
| `tasks/` | Background task snapshots, keyed by parent session and, for managed workers, run/attempt ownership |
| `trees/` | Shared admission and budget ledgers |
| `worktrees/` | Individual worktree records and live ownership |
| `artifacts/` | Patches and command-evidence manifests |

New saves use **v3 append-only journals with small atomic checkpoints**. Existing v2 snapshots remain readable; the first save migrates them after installing and verifying an exact `.v2-backup`. Incomplete final journal writes can recover the preceding committed state; interior corruption/checksum failures fail closed. History listing never replays a v3 journal or reads its task sidecar. Attempt verification uses changed-index journal patches rather than repeatedly embedding full excerpts in checkpoints; concurrent updates, legacy optional evidence, and full hydration remain supported.

Pruning normally retains the newest **200 settled v3 records**, coordinating checkpoint, journal, task, and output deletion. Active/busy records are skipped; legacy snapshots and migration backups are preserved, so 200 is not a hard directory/file-count bound. Sessions, artifacts, task snapshots, budget ledgers, and crash-orphaned files remain until manually removed. They can contain source and tool output; plan retention and back up complete run file sets rather than individual checkpoint JSON files.

Run writes order file fsyncs, dependency publication, and atomic checkpoint rename; Linux directory-fsync failures fail the operation. Platforms without directory-sync support fall back to atomic-rename/process-crash safety, not guaranteed power-loss durability. Actual power-failure recovery has not been tested. Stderr remains capped at 32 KB per attempt. No promise is made to recover bytes a child never flushed before forced termination.

## Design and evaluation

`plan.ts` normalizes and validates modes/options. `orchestrator.ts` executes all modes through the same `runner.ts` RPC engine. `scheduler.ts` coordinates resources; `child-guard.ts` enforces budgets inside pi. `tasks.ts`, `accounting.ts`, and `store.ts` handle background ownership, usage attribution, and persistence. `verification.ts` reconciles shell evidence; `worktree.ts` exports patch handoffs. `results.ts` bounds publication DTOs; `history-tools.ts` exposes paginated reads. Presentation consumes these records through `render.ts` and `dashboard.ts`.

For local instrumentation, `RunnerOptions.onEvent` receives lifecycle-only `RunnerEvent`s (`queued`, `admitted`, `spawned`, `prompt_sent`, `prompt_accepted`, `first_token`, `settled`, `finished`). Events carry exact run/attempt IDs, an optional child PID, and a same-dispatcher `performance.now()` timestamp. First-token events require a real text/thinking delta and occur at most once per attempt. Synchronous observer throws and returned promise rejections do not control execution; callbacks are not awaited and are not a durable event stream. No per-token telemetry is persisted.

The [evaluation harness](benchmarks/README.md) compares direct work, the stock example, and this extension on repeatable fixtures, measuring task success, patch correctness, latency, tokens, and cost. Offline fixture checks and mocked integration tests establish mechanics. Live model comparisons are opt-in; no task-quality or cost advantage is claimed without those measurements.
