# Development Workflow

This document describes the branch, review, and automation workflow for this repo.

## Branch + Worktree Flow

- Create a branch per issue: `issue-XX-short-title` from `main`.
- Use worktrees for parallel work:

```bash
git worktree add ../pmea-issue-XX issue-XX-short-title main
cd ../pmea-issue-XX || exit 1
git rev-parse --abbrev-ref HEAD
```

- Start Codex with the default profile:

```bash
CODEX_PROFILE=local_auto codex "Issue #XX: ..."
```

## PR Flow

1. Post an ExecSpec/Risks comment on the issue before code changes.
2. Open a PR with `Fixes #XX` and links to ADR/ExecSpec.
3. Move the issue to In review after opening the PR.
4. Add a Worklog comment after completion.

## Workflow Diagram

```mermaid
flowchart LR
  subgraph Work[Work setup]
    A[Issue + ExecSpec/Risks] --> B[Branch issue-XX + worktree]
    B --> C[PR opened (Fixes #XX)]
  end

  subgraph Review[Review + automation]
    C --> D[@codex review]
    D -->|inline feedback| E[needs-codex-fix]
    E --> F{autofix/codex?}
    F -->|yes| G[Autofix workflow (comment or self-hosted)]
    G --> H[Push fixes]
    H --> D
    D -->|no blocking feedback| I[Approval + CI]
  end

  subgraph Merge[Merge]
    I --> J[automerge label]
    J --> K[Auto-merge (squash)]
  end
```

## Review Automation

### Setup Checklist (required)

Before expecting fully automatic review+autofix, verify:

- **Codex connector**: connect this GitHub repo in Codex settings, otherwise bot replies with "create a Codex account and connect to github".
- **Self-hosted runner**: at least one online runner with labels `self-hosted` and `codex`.
- **Secrets**:
  - `CODEX_REVIEW_TOKEN` (recommended) for comment/dispatch operations as connected user.
  - `CODEX_API_KEY` only if you use API auth mode instead of ChatGPT login.
  - `CODEX_SESSION_DISPATCH_URL` (+ optional `CODEX_SESSION_DISPATCH_TOKEN`) only if you use webhook relay.
- **Labels**: ensure `needs-codex-fix` and `autofix/codex` exist in the repo.

Notes:
- If `CODEX_REVIEW_TOKEN` is absent or under-scoped, workflows may fall back to `GITHUB_TOKEN` for labeling/dispatch, but will not post `@codex …` commands (Codex ignores `github-actions[bot]`).
- `codex-autofix-watchdog` is fail-open for PR-comment write errors: it still cancels stale runs and continues retry flow.

### Codex Review

- On PR open/reopened/ready_for_review/synchronize (non-draft, non-fork), a workflow posts `@codex review` automatically (requires `CODEX_REVIEW_TOKEN`).
- Skip automation if `automation/off` or `no-bot` is present.
- If Codex leaves inline feedback, a workflow adds the label `needs-codex-fix`.
- Before manual fixes, check PR comments and commit history for autofix signals (e.g., comment "Dispatching autofix" and commits like "fix: address codex review feedback"); also look for the autofix result comment (`codex-autofix:result`) with a run link; verify if feedback is already resolved before rework.
- When `needs-codex-fix` is added (including inline feedback), a workflow can also ensure `autofix/codex` (non-draft, non-fork, no opt-out) and dispatch via `codex-autofix-dispatch-batched` (window 90s per `pr+sha`) before invoking self-hosted autofix.
- For automation that must comment as a user (instead of `github-actions[bot]`), set secret `CODEX_REVIEW_TOKEN` to a PAT from the GitHub account connected to Codex.
- Some label-chaining flows require `CODEX_REVIEW_TOKEN` (GitHub blocks workflow triggers from `GITHUB_TOKEN`-authored events). Autofix dispatch avoids this by dispatching in the same run.
- A scheduled fallback job (every ~5 minutes) scans open PRs and backfills `needs-codex-fix` (and `autofix/codex` unless `autofix/off`) when inline Codex comments exist, then uses the same batched dispatcher path.

### Label Semantics

- `needs-codex-fix`: Codex left inline review feedback that should be addressed.
- `autofix/codex`: opt-in to allow the self-hosted Codex runner to apply fixes automatically.
- `autofix/remote`: opt-in to post `@codex address that feedback` (remote Codex); not auto-added.
- `autofix/off`: blocks auto-apply (self-hosted) while leaving `@codex review` on.
- `needs-codex-fix` is removed automatically after Codex re-review completes on the current head SHA with no inline feedback and no blocking result (PR review or Codex issue comment "Didn't find any major issues"); self-hosted autofix keeps the label until that clean verdict is observed.

### Re-review on Push (debounced)

- When `needs-codex-fix` is present, a push triggers a single `@codex review` after a short quiet period.
- The workflow skips drafts, forks, and PRs labeled `automation/off` or `no-bot`.
- A per-SHA marker prevents repeated requests for the same commit.

### Autofix (opt-in)

- Add label `autofix/remote` to a PR to request Codex to address feedback.
- A workflow posts `@codex address that feedback`.
- Requires `CODEX_REVIEW_TOKEN` to post as the connected user.

### Self-hosted Autofix (optional, fully automatic)

- A self-hosted runner labeled `codex` can apply fixes directly via `workflow_dispatch` when `autofix/codex` + `needs-codex-fix` are present.
- `CODEX_REVIEW_TOKEN` is optional for dispatch/labels, but required for workflow-generated `@codex …` comments (review/rereview/address) to be acted on by Codex.
- Codex auth can be either ChatGPT device auth (preferred for subscription accounts) or API key (`CODEX_API_KEY`). This is controlled by `vars.CODEX_AUTOFIX_LOGIN_METHOD` (or workflow input `login_method`).
- Default autofix model is `gpt-5.3-codex`; reasoning effort defaults to `xhigh` (`vars.CODEX_AUTOFIX_MODEL` / `vars.CODEX_AUTOFIX_REASONING_EFFORT` override).
- The workflow uses Codex CLI and pushes changes back to the PR branch.
- Manual runs require `workflow_dispatch` inputs: `pr_number` (required) and `repo` (optional).
- To retry/force a run via PR comment, post `@codex respond that feedback` or `@codex address that feedback` (trusted collaborators only). This dispatches the self-hosted autofix and pushes a commit when fixes exist.

- Optional PR body markers (must be on their own line; leading `-`/backticks won't match):
  - `<!-- codex-runner: <label> -->` routes the run to a specific self-hosted runner label (appended to `[self-hosted, codex]`).
  - `<!-- codex-autofix:dry-run -->` computes changes but does not push them (useful to validate dispatch without mutating the PR).
- Example:

```text
<!-- codex-runner: Linux -->
<!-- codex-autofix:dry-run -->
```
- The self-hosted workflow posts a result comment with the run URL and whether fixes were pushed.
- `codex-autofix-selfhosted` accepts internal control inputs `target_sha`, `attempt`, `source`; stale triggers (`target_sha != current head`) are skipped gracefully.

### Batched Dispatch + Guardrail + Watchdog

- `codex-autofix-dispatch-batched.yml` is the primary dispatch entrypoint for autofix.
  - Concurrency key: `pr+sha`.
  - Default debounce window: 90s (`attempt=1`) to collapse clustered feedback into one run.
  - Creates a single `codex-autofix:sha` marker and then dispatches `codex-autofix-selfhosted`.
  - If batched dispatch is unavailable from a source workflow, source workflow falls back to direct dispatch.
- Guardrail for `Autofix finished: no changes`:
  - On `attempt=1`, if unresolved `P1/P2` review threads remain on current head SHA, workflow emits marker
    `codex-autofix:retry ... reason=no-changes-unresolved-p1p2` and triggers `attempt=2` with stricter prompt.
  - Retry is idempotent per `sha+attempt=2`.
- `codex-autofix-watchdog.yml` (every 2 minutes):
  - Cancels stale `codex-autofix-selfhosted` runs (`queued > 3m`, `in_progress > 10m`).
  - Retries once via `attempt=2` (`source=watchdog-stale-run`) with marker `codex-autofix:watchdog-retry`.
  - Runs already at `attempt>=2` are cancelled without further retry.

### Session Dispatch (fallback when autofix can't run)

When Codex leaves inline feedback but the self-hosted autofix cannot run (quota, runner busy, etc.),
we still want the right human/agent session to see the comment quickly.

- Bind a PR to a session/agent (one of):
  - PR body: `<!-- codex-session: <id> -->`
  - PR body: `<!-- codex-agent: <name> -->`
  - Label: `codex/session:<id>` or `codex/agent:<name>`
- `codex-session-dispatch` workflow listens to new PR comments and appends a JSONL event to
  `~/.codex/inbox/github_pr_comments.jsonl` on the self-hosted runner (`[self-hosted, codex]`).
- By default it routes only Codex bot comments; other bot comments are skipped.
  Add label `codex/dispatch-all` (or PR marker `<!-- codex-dispatch-all -->`) to route all PR comments.
- Clean Codex verdict comments (e.g., "Didn't find any major issues") are used to clear `needs-codex-fix` and are not routed to the session inbox.
- If Codex posts a quota-limit issue comment for `@codex review`, `codex-session-dispatch` auto-dispatches
  `codex-review-selfhosted.yml` (once per head SHA) to run a local review on the self-hosted runner.
  The self-hosted review uses `gpt-5.3-codex` with default reasoning effort `xhigh`
  (`vars.CODEX_REVIEW_MODEL` / `vars.CODEX_REVIEW_REASONING_EFFORT` override).
  If that review finds issues, it dispatches `codex-autofix-dispatch-batched.yml`
  (same runner/model/effort), which then dispatches `codex-autofix-selfhosted.yml`.
  The fallback path passes the review comment as the autofix trigger.
  It also honors PR marker `<!-- codex-autofix:dry-run -->` and forwards `dry_run=true`.
  Dispatch is deduped per head SHA (`source=quota-fallback-review`) with cooldown, so mixed triggers
  (manual `workflow_dispatch` + automatic quota-fallback) do not fan out multiple autofix runs for the same SHA.
  It writes request marker `<!-- codex-selfhosted-review:request sha=... source=quota-fallback -->`
  and suppresses duplicate dispatch while that request is fresh.
  The fallback posts `<!-- codex-selfhosted-review:sha=... source=quota-fallback -->` into the PR thread.
- `codex-selfhosted-review:*` marker comments are treated as internal control comments and are not routed to session inbox/webhook.
- Optional webhook routing: set secret `CODEX_SESSION_DISPATCH_URL` (and optionally `CODEX_SESSION_DISPATCH_TOKEN`).

Example JSONL payload (one JSON object per line):

```json
{
  "correlation_id": "2b0c4f69-0ef5-4e4c-b6a3-1c3f7e80e2d3",
  "event": "pull_request_review_comment",
  "repo": "Username960528/polymarket_event_sniping_arb",
  "pr_number": 252,
  "pr_url": "https://github.com/Username960528/polymarket_event_sniping_arb/pull/252",
  "codex_session": "019c3a84-48a8-7ab0-81c3-75f6c4f4d1c4",
  "codex_agent": null,
  "comment": {
    "kind": "review_comment",
    "id": 123456789,
    "url": "https://github.com/Username960528/polymarket_event_sniping_arb/pull/252#discussion_r123",
    "author": "chatgpt-codex-connector[bot]",
    "created_at": "2026-02-08T00:00:00Z",
    "body": "P1: ...",
    "path": "crates/poly-sniper/src/pipeline.rs",
    "line": 480,
    "side": "RIGHT",
    "commit_id": "3ae0d036ad..."
  }
}
```

Notes:
- The queue file is `~/.codex/inbox/github_pr_comments.jsonl`.
- For `event=issue_comment`, `comment.kind=issue_comment` and file/line metadata is typically absent.

#### Webhook/chat relay consumer (optional)

If you want queued events to show up in a chat tool (Slack/Discord/Telegram via your own gateway),
run the consumer that tails the JSONL queue and POSTs to a webhook:

```bash
CODEX_COMMENT_RELAY_WEBHOOK_URL='https://example.com/webhook' \
CODEX_COMMENT_RELAY_WEBHOOK_TOKEN='...' \
CODEX_COMMENT_RELAY_FORMAT='generic' \
python3 scripts/codex_comment_relay.py
```

Environment:
- `CODEX_COMMENT_RELAY_WEBHOOK_URL` (required unless `--dry-run`)
- `CODEX_COMMENT_RELAY_WEBHOOK_TOKEN` (optional bearer token)
- `CODEX_COMMENT_RELAY_FORMAT` = `generic|slack|discord|raw` (default `generic`)
- `CODEX_HOME` (optional; defaults to `~/.codex`)

Cursor/state:
- Cursor is stored in `~/.codex/state/github_pr_comments.cursor.json`.

Systemd template (optional):
- `deploy/polymarket-codex-comment-relay.service`
- Expects env file: `/etc/codex-comment-relay/env`
- Set `CODEX_HOME` in that env file to the same path the GitHub runner writes to (often `/home/<runner-user>/.codex`).

### Auto-merge (opt-in)

- Add label `automerge` to a PR to enable auto-merge.
- Auto-merge is allowed only when:
  - Branch protection is enabled on `main`.
  - Required check `ci-signal-processing / test_signal_processing` is configured (GitHub waits for it to pass).
  - At least one approval is present.
- Merge method uses squash.

### Auto-update from main (opt-in)

- Add label `autoupdate/main` to request a GitHub "update branch" from the base branch.
- Works only for non-draft, same-repo PRs; skips when `automation/off` or `no-bot` is present.
- On success the label is removed; on conflicts the workflow comments and stops.
 - If the label is added while the PR is a draft, the update runs once it is marked ready for review.

## CI Check

- `ci-signal-processing` runs `cargo test -p signal-processing` on PRs to `main`.

## Labeling Rules

- Only add missing taxonomy labels to issues (`type/*`, `area/*`, `priority/*`).
- Mirror taxonomy labels from the issue onto the PR.
- Add `agent/codex` only when explicitly asked to start work.
- Never apply `status/*` labels.
- Skip automation if `automation/off` or `no-bot` is present.

## Deployment Notes

- Prod checkout: `/opt/polymarket-sniper-prod` (keep `/opt/polymarket-sniper` for lab use).
- Secrets: `/etc/polymarket-sniper/env`.
- State: `/var/lib/polymarket-sniper`.
- Logs: `/var/log/polymarket-sniper`.
- Dashboard venv: `/opt/polymarket-sniper-venv`.
