# Issue tracker

This repository's specs, tickets and execution maps live in **GitHub Issues** on this repository.
Use the `gh` CLI for every operation. This file is read first by `/grill-to-waves` and
`/orchestrate`, so it is the authority on tracker mechanics here.

## Operations

**Publish an item**

```
gh issue create --title "<title>" --body-file <file>
```

Author bodies to a scratch file. An inline `--body` with multi-line text is mangled by PowerShell
on this machine.

**Label**

```
gh label list
gh label create <name> --description '<description>'
gh issue edit <n> --add-label <name>
```

Single-quote any description containing a backtick or `$`.

**Link a ticket as a child of its spec** — native sub-issues. The API takes the child's database
id, not its issue number:

```
gh api repos/{owner}/{repo}/issues/<n> -q .id
gh api -X POST repos/{owner}/{repo}/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>
```

**Record a blocking edge** — same database-id rule:

```
gh api -X POST repos/{owner}/{repo}/issues/<blocked>/dependencies/blocked_by -F issue_id=<blocker-db-id>
```

**Read the frontier** — one listing returns state, labels, bodies and the count of open blockers:

```powershell
gh api -X GET 'repos/{owner}/{repo}/issues' -f 'labels=run:<slug>' -f state=open -f per_page=100 --paginate `
  --jq '.[] | {n: .number, title, blocked: .issue_dependencies_summary.blocked_by, labels: [.labels[].name], body}'
```

`blocked_by` counts open blockers; `total_blocked_by` counts every blocker.

**Comment**

```
gh issue comment <n> --body-file <file>
```

**Deliver** — a pull request, `gh pr create --body-file <file>`. The orchestrator merges locally,
never with `gh pr merge`.

## Label vocabulary

| Label | Meaning |
|---|---|
| `meta:orchestration` | Execution maps and other pipeline bookkeeping items |
| `ready-for-agent` | Dispatchable by an executor |
| `ready-for-human` | Blocked on a human decision; never dispatched |
| `run:<slug>` | Belongs to one delivery run |
| `spec:<slug>` | Belongs to one spec within a run |
| `executor:fable-five-one`, `executor:fable`, `executor:opus`, `executor:sonnet` | Executor tier |
| `effort:medium`, `effort:high`, `effort:xhigh` | Reasoning effort |

A ticket carries both an `executor:` and an `effort:` label. Specs and maps carry neither.

## Conventions

- Commit messages and pull request bodies follow Conventional Commits.
- Issue bodies, specs and documentation are written in normal prose.
- Branch protection on `main` is required before any team-shaped run: required status checks, and
  *require branches to be up to date before merging*.
