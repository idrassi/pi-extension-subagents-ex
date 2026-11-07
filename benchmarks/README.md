# Evaluation and offline measurements

Two separate harnesses answer different questions:

- **`npm run eval`** checks coding-task acceptance, immutable patch scope/whitespace, latency, reported tokens, and reported cost. Real-model comparisons are explicitly opt-in.
- **`npm run measure`** exercises real pi processes with a local synthetic provider to measure control-plane behavior. It never uses a real model or user credentials.

Neither deterministic acceptance checks nor synthetic resource measurements demonstrate a model-quality, cost, or production-performance advantage.

## Offline coding-corpus checks

```bash
npm run eval -- --list
npm run eval -- --check-fixtures
```

All four initial implementations must fail and their references must pass. Checks live outside worker repositories and have a 15-second deadline.

| Case | Scope | Acceptance emphasis |
|---|---|---|
| `map-limit` | `lib.mjs` | Bounded concurrency, order, empty inputs, first callback, failures |
| `memoize-async` | `lib.mjs` | Concurrent deduplication, argument identity, rejected-promise eviction/retry |
| `merge-intervals` | `lib.mjs` | Sorting, overlap, boundaries, input preservation |
| `scoreboard-report` | `src/config.mjs`, `src/report.mjs` | Multi-file configuration precedence, validation, report filtering/sorting, existing CLI integration |

The repository case starts from an `initial/` tree, has a separate `reference/` tree, and protects its CLI/config/data fixtures. Every task declares an exact path allowlist. Known first-item and permanent-rejection-cache mutants are regression-tested, not merely the supplied initial implementations.

### Integrity and reproducibility

Each trial captures its initial commit/tree and a filesystem fingerprint **before** starting the worker. Checks use that immutable baseline, not mutable `HEAD`: worker commits, committed-then-reverted violations, history rewrites, staged/unstaged changes, deletions, untracked/ignored files, index-hidden changes, and unusual filenames are covered. Whitespace policy is independent of worker index flags/configuration. This is integrity checking, **not a sandbox**: an agent with the same OS account can reach files outside its checkout; “external acceptance” does not promise secrecy against that account.

Pre-run manifests record the evaluator revision/dirty flag/source hashes, complete corpus hash, SDK/Node/platform, model, selected provider adapters/stock implementation hashes, settings, prompt, initial baseline, allowlist, and budgets. Keep these manifests with results; pin the provider/model and stock revision for comparisons. Provider/server-side changes can still affect reproducibility.

## Opt-in real-model comparisons

**This command can incur provider charges using your configured credentials. It is not part of offline verification:**

```bash
npm run eval -- --model provider/model-id \
  --stock /absolute/path/to/pi/packages/coding-agent/examples/extensions/subagent/index.ts \
  --repeats 3 --timeout 120 --max-cost 1 --out /tmp/pi-comparison
```

Use `--variants single,extended` without a stock checkout. Extension-provided models require `--provider-extension /absolute/path/to/provider.ts` (repeatable). Repeats range from 1–20. Use a new output directory for each experiment.

All variants receive matched **root** deadlines, turn/cost limits and retry settings. Extended descendants also share admission/turn/cost guards; the stock example does not implement those shared descendant controls. This enforcement difference is recorded separately in manifests and must accompany comparisons. Cost ceilings use observed usage, so requests in flight may overshoot; they are not billing-system hard caps. A single repetition is a smoke check, not a quality estimate.

### Usage accounting

Stock `details.results` descendant usage is reconstructed recursively and deduplicated across aliases/wrappers. SDK usage coverage is reconciled without double-charging already-covered results or dropping unrelated wrapper fees. Extended managed totals remain unchanged. Raw and normalized seven-field usage totals, warnings, and accounting completeness are saved separately.

Missing/ambiguous descendant accounting is **not zero**. Started stock calls without identity-matched results, including partially returned nested call sets, are incomplete even if another child has known usage. Incomplete trials emit warnings and suppress authoritative `meanCost`/`meanTokens`; `meanObservedCost` is only an observed floor. Inspect the individual trial accounting before interpreting averages. Different providers/SDK versions can expose different usage boundaries, and indistinguishable coverage cannot be resolved by guessing.

Results include `summary.json`, pre-run manifests, per-trial full runs/checks, edited repositories, and a copy of orchestration state. Embedded session/artifact paths refer to the removed temporary configuration; find retained copies under `state/` for inspection, not resume. Credentials are copied only to a private temporary configuration and removed in `finally`, never into results. A hard process crash may leave `subagents-eval-config-*` in the OS temp directory; remove it when finished. Transcripts and output repositories may contain source or sensitive tool output.

## Offline real-pi measurements

```bash
npm run measure -- --repeats 3 --fanout 4 --out /tmp/pi-local-measurements
# Optional subset:
npm run measure -- --scenarios single,parked --repeats 5
```

The output directory must be empty. Without `--out`, a unique private OS-temp directory is created. Unknown options, including `--model`, are rejected. `--repeats` is 1–20; `--fanout` is 2–8. Scenarios must be a unique nonempty subset of:

- **`single`**: one streamed synthetic response.
- **`fanout`**: concurrent roots with two executing-worker slots, one request slot, and a worker admission queue.
- **`parked`**: one parent delegates to a child while retaining its process reservation and yielding its execution slot; the parent then continues.

Every scenario uses `maxProcesses: 8`, `maxQueued: 32`, `maxRequests: 1`; non-fanout execution concurrency is one. Streams have eight 40 ms fixture steps. Retry/automatic compaction are disabled, each root has a 30-second wall deadline and four-turn ceiling, and nested workers use the selected local provider. No real provider configuration, credentials, models, or user settings are copied. Each request deliberately reports **synthetic** usage/cost for accounting reconciliation; those values are not prices or actual charges.

### Metric definitions

Lifecycle times use one dispatcher's monotonic clock, not subtraction of wall clocks from different processes. Nearest-rank p50/p95 calculations retain observation counts; missing observations remain `null`, never zero. A successful measurement rejects missing required timing events, non-OK runs, leaked leases/requests, concurrency violations, sampling errors, or mismatched synthetic accounting.

| Metric | Boundary / qualification |
|---|---|
| Worker queue wait | Immediately before worker admission to successful acquisition; model-request waiting is separate |
| Startup | Child spawn to RPC prompt acknowledgment |
| First token | Prompt send to first actual text/thinking delta per attempt; includes model-request queuing |
| Completion delivery | Last observed settlement to final artifact/state persistence and cleanup |
| Active/parked memory | Per-worker peak RSS sampled every 40 ms according to scheduler lease state; Linux `/proc` only |
| Dispatcher delay | Node event-loop delay histogram at 10 ms resolution, including sampler overhead |
| Dispatcher I/O | Scenario delta of `/proc/self/io` logical and disk counters, not exact per-run attribution |
| Worker I/O | Last sampled cumulative `/proc/PID/io` counters since worker birth, plus an outer-worker settlement snapshot; shutdown writes can be missed and descendants are sampled only |
| Retained bytes | Scenario change in saved state size, not a count of bytes physically written |
| Accounting/resources | Synthetic request count versus returned/root/tree cost; request peak and zero final leases/requests |

Logical `wchar` includes pipes and is **not** disk bytes. Linux disk counters depend on caching/filesystem behavior. Sampling can miss short-lived peaks and terminal writes. Unsupported/unavailable RSS/I/O is `null`/absent, not a fabricated cross-platform result. Latency summaries cover top-level runs; nested work contributes to the enclosing run's elapsed time and resource samples, not a second dispatcher's monotonic timestamps.

`summary.json` preserves environment/source hashes, raw lifecycle events, per-attempt timings, observations, and nearest-rank summaries. `requests.jsonl` records local request boundaries for concurrency/accounting checks. Copied `state/` is inspection-only: original temporary paths no longer exist. Failure attempts preserve completed rows/state in `failure.json` when possible before removing temporary configuration. Inspect reports locally; no telemetry is sent anywhere.

[Recorded local observations](LOCAL-MEASUREMENTS.md) include three repetitions per scenario on pi 0.99.1 and 1.5.0, with the exact covered source hash and qualifications.

These are small synthetic workloads on the machine running them, not production latency/RSS/I/O forecasts, capacity guarantees, statistical confidence intervals, or tuning evidence for default limits. Run under representative workloads and report sample counts, host/OS, runtime/SDK, source hash, caps, and background load before generalizing. No paid comparative model trials have been run as part of this verification.
