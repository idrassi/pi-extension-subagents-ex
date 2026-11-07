# Local synthetic resource observations

These are **offline acceptance/resource checks through real pi processes**, not a production benchmark, model-quality comparison, SDK ranking, or recommendation to change default limits. No real model or paid provider was used. The provider deliberately reports synthetic usage so accounting can be checked.

## Reproduction and environment

```bash
npm run measure -- --repeats 3 --fanout 4 --out /empty/private/output-directory
```

Run separately against each SDK installation. The measured source was the same in both runs:

- Covered source SHA-256: `cfc362669c9c127efa35b927e26c8080c32837867be6d8fb927caa626f2d4391` (the flat `src/*.ts` set, measurement scripts, and fixture provider; not a hash of every dependency).
- pi **0.99.1**: working tree based on `4919bbe71a77a2ecd3cb73c7a780ac7c8d2109d1`, **dirty**, including the uncommitted implementation under test.
- pi **1.5.0**: disposable non-Git SDK checkout, so revision/dirty metadata is `null`; its covered source hash matches.
- Node **v24.14.0**, Linux x64 / WSL2 **6.6.87.2-microsoft-standard-WSL2**.
- Intel Core i9-13900HX; 32 reported logical CPUs. These were sequential local harness runs, not an isolated or calibrated performance laboratory; general machine/cache/background-load effects remain.
- Three repetitions of each scenario, no discarded warmup. Fanout starts four roots with two executing-worker slots; the other scenarios use one slot. All use eight process slots, 32 queue slots, and **one model-request slot**.
- Each synthetic stream has eight 40 ms steps. The parked parent first makes a tool call, waits for its child, then produces text, so its first-text latency includes that delegation.

The retained local reports are `/tmp/pi-offline-resources-099-final-wabhmO/summary.json` and `/tmp/pi-offline-resources-15-final-bP6pm4/summary.json`. They contain raw observations, exact counters, source/environment metadata, and inspection-only copied state. These paths are local evidence, not distributed fixtures or resumable installations. The earlier development smoke report with missing timing observations is not used here.

## Latencies

Values are **p50 / p95 in milliseconds**, using nearest ranks. Each scenario has three elapsed-time observations. Root/attempt timing counts are 3 for single/parked and 12 for fanout. At these small counts, p95 is simply the observed maximum, **not a reliable tail-latency estimate**.

| pi | Scenario | Root timing count | Scenario elapsed | Worker queue wait | Spawn → prompt acknowledgment | Prompt → first text/thinking | Settlement → delivery/cleanup |
|---|---|---:|---:|---:|---:|---:|---:|
| 0.99.1 | single | 3 | 716.7 / 848.1 | 1.0 / 2.8 | 257.2 / 374.3 | 50.3 / 52.9 | 44.7 / 68.0 |
| 0.99.1 | fanout | 12 | 1873.6 / 1875.4 | 77.1 / 1060.1 | 288.3 / 322.3 | 65.2 / 365.1 | 48.0 / 59.3 |
| 0.99.1 | parked | 3 | 1763.5 / 1790.9 | 0.6 / 0.9 | 261.2 / 265.2 | 1118.2 / 1122.6 | 47.9 / 58.9 |
| 1.5.0 | single | 3 | 705.0 / 804.0 | 0.6 / 2.3 | 259.6 / 342.6 | 49.2 / 50.1 | 44.6 / 60.3 |
| 1.5.0 | fanout | 12 | 1858.6 / 1861.6 | 79.6 / 1052.2 | 284.6 / 316.3 | 61.4 / 357.4 | 46.5 / 59.9 |
| 1.5.0 | parked | 3 | 1791.7 / 1795.7 | 0.6 / 0.7 | 260.5 / 267.9 | 1123.9 / 1136.0 | 47.2 / 48.0 |

These boundaries use one dispatcher's monotonic clock. First-token time includes request admission wait; worker queue wait does not. Nested work contributes to its enclosing root, rather than supplying cross-process timestamps for subtraction.

## RSS, event-loop delay, and retained bytes

RSS ranges are the minimum/maximum of **observed per-worker peaks**, not a simultaneous process-tree total. Sampling runs every 40 ms and can miss peaks. Parked values describe the retained parent, not the executing child. Delay ranges are the minimum/maximum of the three scenario histograms' p95 values at 10 ms resolution; they include sampler overhead. State growth is scenario aggregate retained file size, not physical bytes written.

| pi | Scenario | Active worker peak RSS range (MiB) | Parked parent peak RSS range (MiB) | Dispatcher delay p95 range (ms) | Retained state growth per trial (bytes) |
|---|---|---:|---:|---:|---:|
| 0.99.1 | single | 117.0–130.3 | — | 15.6–21.8 | 28,856 |
| 0.99.1 | fanout | 116.1–118.8 | — | 22.3–23.8 | 116,587 |
| 0.99.1 | parked | 117.1–119.5 | 118.3–119.5 | 10.7–11.0 | 60,091 |
| 1.5.0 | single | 113.6–146.2 | — | 14.5–22.1 | 28,698 |
| 1.5.0 | fanout | 112.1–115.3 | — | 22.8–23.2 | 115,954–115,956 |
| 1.5.0 | parked | 112.8–115.8 | 114.3–115.6 | 10.7–10.9 | 59,843 |

## I/O

Dispatcher `/proc/self/io` counter deltas, ranges across three trials:

| pi | Scenario | Logical reads `rchar` (MiB) | Logical writes `wchar` (KiB) | Disk writes `write_bytes` (KiB) |
|---|---|---:|---:|---:|
| 0.99.1 | single | 8.6–10.2 | 75.1–79.4 | 132–152 |
| 0.99.1 | fanout | 34.5–34.6 | 349.5–349.5 | 552–560 |
| 0.99.1 | parked | 17.3–17.4 | 189.9–189.9 | 316–316 |
| 1.5.0 | single | 8.8–10.4 | 74.7–79.0 | 132–152 |
| 1.5.0 | fanout | 35.2–35.4 | 348.1–348.8 | 556–560 |
| 1.5.0 | parked | 17.7–17.7 | 189.4–189.5 | 312–316 |

All observed dispatcher disk-read deltas were zero; that reflects the filesystem/cache counters, **not an absence of logical reads**. `wchar` includes pipes and is not disk traffic. These are scenario aggregates including sampling, not exact per-run I/O attribution.

Each SDK report also has 21 last-observed worker counter records, with nonzero logical reads/writes. They are cumulative **since worker process birth**, not complete per-run deltas: root workers are additionally observed at outer settlement, while descendants are sampled only, and shutdown writes may be missed. Do not sum them into a supposedly complete process-tree I/O bill.

## Acceptance invariants and limits

In both reports all nine rows have complete required root timing, OK returned runs, matching synthetic request/root/tree accounting, request peak **1**, **zero** final requests/leases, and no sampling errors. Each SDK run made 24 local synthetic requests and reconciled synthetic cost **0.024**, not an actual charge. Each parked trial recorded a retained parent and its active child.

Separate deterministic storage regressions measured 100 appended 8 KiB evidence records at **942,590 journal bytes** and a **1,637-byte checkpoint** on pi 0.99.1. Mutating the first 8 KiB record while appending another each save used **1,754,384 bytes** (half-growth increments 859,655 / 877,254), rather than repeatedly serializing the accumulated suffix. These are specific byte-growth checks, not latency, arbitrary-complexity, or power-failure guarantees; in-memory comparisons and full hydration still grow with retained data.

No production workload, non-Linux resource instrumentation, real power failure, statistical confidence interval, or comparative model-quality experiment is established by these observations. See [methodology and options](README.md) before interpreting or reproducing them.
