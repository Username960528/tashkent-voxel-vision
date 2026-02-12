# ADR 0035: AI-gate batched autofix dispatch, no-change guardrail, and stuck-run watchdog

## Context

Autofix dispatch came from multiple workflows and could fan out duplicate runs for the same PR head SHA.  
In failure paths, runs could remain queued/in-progress too long without automatic recovery.  
`Autofix finished: no changes` also needed an automatic escalation path when high-priority feedback (P1/P2) remained unresolved.

## Decision

1. Introduce `codex-autofix-dispatch-batched.yml` as the primary dispatch gate:
   - keyed by `pr+sha`,
   - 90-second debounce (`attempt=1`),
   - single marker creation and downstream self-hosted dispatch.
2. Route all existing autofix-dispatch sources through the batcher, with direct-dispatch fallback when batcher dispatch fails.
3. Extend `codex-autofix-selfhosted.yml` with:
   - `target_sha`, `attempt`, `source` inputs,
   - parseable run-name (`pr=... sha=... attempt=... source=...`),
   - stale-trigger skip (`target_sha != current head`),
   - no-change guardrail: unresolved P1/P2 on current head triggers idempotent `attempt=2` retry.
4. Add `codex-autofix-watchdog.yml`:
   - polls every 2 minutes,
   - cancels stale queued/in-progress runs,
   - retries once (`attempt=2`) with marker-based idempotency.

## Consequences

### Positive
- Fewer duplicate autofix runs and marker noise for clustered review comments.
- Automatic recovery from stuck runs without manual intervention.
- Better chance to resolve critical feedback when first attempt returns no diff.

### Trade-offs
- More workflow logic and marker/state handling complexity.
- Additional scheduled workflow activity (watchdog).
- Requires careful marker parsing to maintain idempotency.

## Related Code

- `.github/workflows/codex-autofix-dispatch-batched.yml`
- `.github/workflows/codex-autofix-watchdog.yml`
- `.github/workflows/codex-autofix-selfhosted.yml`
- `.github/workflows/codex-review-automation.yml`
- `.github/workflows/codex-review-fallback.yml`
- `.github/workflows/codex-review-selfhosted.yml`
- `.github/workflows/codex-autofix-on-command.yml`
- `.github/workflows/codex-session-dispatch.yml`
- `docs/WORKFLOW.md`

