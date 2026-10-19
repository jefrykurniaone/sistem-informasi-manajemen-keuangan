# Local environment

How this repository runs on the owner's Windows machine. `README.md` describes the portable setup;
this file holds what differs here.

## Docker and PostgreSQL

- Docker Engine runs inside WSL Ubuntu, not Docker Desktop, and Windows has no `docker` CLI. Call it
  as `wsl -d Ubuntu -e docker …` after `$env:WSL_UTF8 = '1'`. The compose project is `komplek`
  (`komplek-app-1`, `komplek-db-1`, `komplek-mailpit-1`).
- A native Windows PostgreSQL owns port 5432 and answers in place of the container, failing with
  `28P01`. The local `.env` sets `POSTGRES_PORT=5433`, with `DATABASE_URL` and `TEST_DATABASE_URL` on
  the same port; `.env.example` keeps 5432.
- `docker compose build` hangs on the bridge network. Build with
  `docker build --network host --target dev -t komplek-app .`, then `docker compose up -d --no-build`;
  after a dependency change, `docker compose up -d --no-build -V app`.
- The working tree is bind-mounted from `/mnt/d`, so `.env` keeps `VITE_USE_POLLING=true`.
- `komplek-app-1` serves whatever branch the main tree has checked out, at `localhost:5173`.
- The WSL VM shuts down when idle and takes the database with it. A long run keeps it awake with a
  background `wsl -d Ubuntu -e sleep 7200`.

## Playwright

The browser download fails here with a misleading "timed out 30000ms". Download the archives with
`curl.exe`, serve them from a local folder, and install with
`$env:PLAYWRIGHT_DOWNLOAD_HOST = 'http://127.0.0.1:<port>'; bunx playwright install chromium`. Repeat
whenever Playwright's browser revision changes. `bun run preview` binds `127.0.0.1`; `localhost` is
refused.

## Worktrees

One worktree per ticket, under `.claude/worktrees/solo/<ticket>`, each with:

- its own ASCII `.env`, written with the Write tool;
- its own compose stack when it runs tests or a server: `docker compose -p komplek<n>` on a port from
  55433–55463. A bare `docker compose` acts on the main tree's `komplek` stack;
- `node_modules` as a junction or a `robocopy` copy (`robocopy` exit code 1 means success).

Teardown runs in this order: unlink every reparse point deepest-first, `git worktree remove`, then
`docker compose -p <name> down -v`. The junction trap behind the first step is in
`~/.claude/docs/worktree-junction-removal.md`.

## PowerShell

- `gh api --jq` filters containing inner double quotes, `join`, `index()` or `{owner}` arrive
  mangled. Fetch the JSON and parse it with `ConvertFrom-Json`.
- `psql -c` breaks on a quoted `"user"` identifier; pipe the SQL in on stdin.
- `git merge` runs to completion before its output is trimmed: `Select-Object -First N` cuts it off
  and leaves a dangling `MERGE_HEAD`.
- `2>&1` on a native executable corrupts `$?`; read `$LASTEXITCODE`.
