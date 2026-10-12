# Delegation evaluation

This small, deterministic coding corpus compares direct work, pi's stock subagent example, and this extension. It measures acceptance-test success, patch scope/whitespace correctness, latency, reported tokens, and reported cost. It is a starting point for evaluation, not evidence of a quality advantage on larger projects.

Offline checks make no model requests:

```bash
npm run eval -- --list
npm run eval -- --check-fixtures
```

Live comparisons make paid provider requests using your configured credentials. Pin the pi version, stock example revision, model, and provider settings when comparing results:

```bash
npm run eval -- --model provider/model-id \
  --stock /absolute/path/to/pi/packages/coding-agent/examples/extensions/subagent/index.ts \
  --repeats 3 --timeout 120 --max-cost 1 --out /tmp/pi-comparison
```

Use `--variants single,extended` without a stock checkout. Extension-provided models require `--provider-extension /absolute/path/to/provider.ts` (repeatable). All trials start from fresh committed fixtures, use the same model, and allow only `lib.mjs` to change. Acceptance tests run outside each worker checkout with a 15-second deadline. Initial implementations must fail the acceptance tests and reference solutions must pass them; CI verifies this.

Results include `summary.json`, individual run transcripts and checks, edited repositories, and a copy of private orchestration state. Session/artifact paths embedded in copied state refer to the temporary configuration directory and should be located under the output's `state/` directory for inspection; benchmark sessions are not intended for resume. Credential files are removed in `finally` and are never copied into results. A hard process crash may leave the private `subagents-eval-config-*` temporary directory; remove it when finished.

The cost limit is an observed ceiling, so in-flight requests can overshoot. The stock example does not implement this extension's shared descendant admission/turn controls; its root still has the harness deadline and cost guard, but descendant enforcement is part of the capability being compared. Report that difference alongside results. Models can vary between repetitions and providers may report usage differently. Inspect failures, repeat trials, and add realistic repository tasks before drawing broader conclusions.
