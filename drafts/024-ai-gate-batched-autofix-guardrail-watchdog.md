# ExecSpec: AI-gate batched autofix, no-change guardrail, and stuck-run watchdog

## Task
- Implement a single PR that introduces batched autofix dispatch (90s window per `pr+sha`), no-change guardrail retry (`attempt=2` only when unresolved P1/P2 remain), and watchdog recovery for stuck autofix runs (`queued > 3m`, `in_progress > 10m`).

## Steps
1. Add `codex-autofix-dispatch-batched.yml` as the primary dispatch entrypoint:
   - validate `workflow_dispatch` inputs (`pr_number`, `sha`, `attempt`, `source`, etc.),
   - debounce 90s on `attempt=1`,
   - re-check head SHA,
   - ensure `needs-codex-fix` + `autofix/codex`,
   - write one marker comment and dispatch `codex-autofix-selfhosted`.
2. Update all existing dispatch sources to call batcher first, with direct-dispatch fallback:
   - `codex-review-automation.yml`
   - `codex-review-fallback.yml`
   - `codex-review-selfhosted.yml`
   - `codex-autofix-on-command.yml`
   - `codex-session-dispatch.yml`
3. Extend `codex-autofix-selfhosted.yml`:
   - new inputs `target_sha`, `attempt`, `source`,
   - parseable run-name `pr=... sha=... attempt=... source=...`,
   - skip stale triggers when head changed,
   - stricter prompt for `attempt=2`,
   - unresolved P1/P2 evaluator from review threads,
   - guardrail retry marker + batched redispatch for `no changes` on `attempt=1`.
4. Add `codex-autofix-watchdog.yml`:
   - poll active `codex-autofix-selfhosted` runs every 2 minutes,
   - cancel stale runs,
   - retry once via batcher (`attempt=2`) with marker-based idempotency.
5. Update docs in `docs/WORKFLOW.md` and add ADR entry.

## Notes
- Assumptions:
  - Batched window is fixed at 90s for `attempt=1`.
  - Auto-retry scope is unresolved P1/P2 only.
  - Retry ceiling is one extra attempt (`attempt<=2`).
- Risks:
  - New workflows add control-plane complexity.
  - Marker parsing bugs could suppress valid retries or trigger duplicates.

