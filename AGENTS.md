# AGENTS.md instructions for /Users/tribe/IdeaProjects/tashkent-voxel-vision

You are operating in a multi-terminal, multi-worktree environment with parallel PRs.

## Non-negotiables (do these BEFORE editing anything)
1) `git fetch origin --prune`
2) `git status -sb`
3) Compute behind/ahead vs `origin/main`:
   - `git rev-list --left-right --count origin/main...HEAD`
4) If behind > 0: run `git rebase origin/main` immediately.
   - If conflicts occur: STOP and ask the user for conflict-resolution intent per chunk. Do not guess.

## Cross-session conflict prevention (file claiming)
Before touching any file:
1) Determine CODEX_HOME: `$CODEX_HOME` else `~/.codex`
2) Ensure directory exists: `$CODEX_HOME/locks/`
3) Create/refresh a lock file named after the current branch:
   - `$CODEX_HOME/locks/<branch>.lock`
4) Lock file must contain:
   - Timestamp
   - Current working directory
   - A newline list of planned files/dirs to modify (exact repo-relative paths)
5) Check ALL other lock files in `$CODEX_HOME/locks/`:
   - If any planned path overlaps (same file, or one path is a parent dir of another), pause and request approval to clear the conflicting lock.
   - With explicit approval from the user/orchestrator, delete the conflicting lock file(s), refresh your lock, then proceed.
   - If approval is not granted, do not edit; propose alternatives: split scope, choose different files, or stack PRs (base branch on the other branch).

## During work
- Keep diffs small and local to the issue.
- Avoid broad refactors/formatting/reordering, especially in shared hotspots (dashboards, configs).
- If a hotspot must be changed, do it in one dedicated PR or stacked PR series.

## Before every commit/push
1) Repeat preflight: fetch + status + behind/ahead + rebase if behind.
2) Run the fastest relevant checks for touched areas (at least syntax/lint/unit tests for the changed module).
3) Push policy:
   - If a rebase was performed: `git push --force-with-lease`
   - Otherwise: normal `git push`

## Safety (because approvals are never + danger-full-access)
- Never run destructive commands (rm -rf, mass deletes) without explicit user request.
- Never rotate/change secrets/tokens unless explicitly asked.
- Never use `--force` without `--force-with-lease`.

## Skills
A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.

### Available skills
- adr-execspec-writer: Create or update ADR and ExecSpec docs for this repo. Use when the user asks for an ADR (architecture decision record, decision record, ADR for change), an ExecSpec/spec/tech spec, says "тех. план/технический план", or to document a significant behavior or architecture change. Handle file naming, numbering, and ADR index updates in docs/ADR/README.md and drafts/README.md. (file: /Users/tribe/.codex/skills/adr-execspec-writer/SKILL.md)
- gh-issue-ops: Create or update GitHub issues and epics for Username960528/polymarket_event_sniping_arb, apply taxonomy labels, link ADR/ExecSpec artifacts, add items to Project 1, and post Worklog updates. Use when asked to create issues, fix issue formatting, connect issues to epics, or manage Project board updates. (file: /Users/tribe/.codex/skills/gh-issue-ops/SKILL.md)
- mermaid: Create, edit, or explain Mermaid diagrams in Markdown docs. Use when asked to visualize workflows, pipelines, architecture, decision flows, or to add Mermaid blocks to README/docs. (file: /Users/tribe/.codex/skills/mermaid/SKILL.md)
- skill-creator: Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Codex's capabilities with specialized knowledge, workflows, or tool integrations. (file: /Users/tribe/.codex/skills/.system/skill-creator/SKILL.md)
- skill-installer: Install Codex skills into $CODEX_HOME/skills from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo (including private repos). (file: /Users/tribe/.codex/skills/.system/skill-installer/SKILL.md)

### How to use skills
- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.
  2) When `SKILL.md` references relative paths (e.g., `scripts/foo.py`), resolve them relative to the skill directory listed above first, and only consider other paths if needed.
  3) If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request; don't bulk-load everything.
  4) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.
  5) If `assets/` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.
