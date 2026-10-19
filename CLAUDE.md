# Sistem Informasi dan Manajemen Keuangan Komplek

SvelteKit monolith on Bun for one housing complex, Bumi Cikoneng Indah Regency (BCIR). The parent
folder `simk-bcir` also holds `data-warga/`, the complex's manual dues records: residents' personal
data that stays outside this repository.

## Where things are

- `CONTEXT.md` — the glossary and the contract for every name. Look a term up before naming a type,
  table, column, route, message key or screen text. A concept it lacks goes into `CONTEXT.md` first,
  agreed with the owner, before any code uses it.
- `README.md` — stack, directory layout, the four gate commands, seed data, the first superuser.
- `docs/agents/issue-tracker.md` — specs, tickets, labels and delivery on GitHub Issues.
- `docs/agents/local-environment.md` — this machine: Docker inside WSL, database ports, Playwright
  install, worktree stacks, PowerShell traps. Read it before starting a database, a dev server, an
  e2e run or a worktree.
- `docs/deploy.md` — the production runbook.
- `docs/spec-*.md` are point-in-time copies; the GitHub issue is the source of truth.
- `src/lib/money.ts` and `src/lib/time.ts` open with the decisions every money or date change
  follows.

## Domain invariants

- The cash book is single-entry, cash-basis and append-only. Dues income enters only through Payment
  verification (`recordDuesIncome`), a dues refund leaves only through `recordDuesRefund`, and a
  recording mistake is fixed by a Koreksi. Every write path checks its Period with
  `requireOpenPeriodFor`.
- Invoice status and Credit Balance are computed, never stored. Tarif rows are versioned, and an
  Invoice freezes its amount when it is issued.
- Invoices and Credit Balance belong to the Unit. A Resident sees only what falls inside their own
  Masa Huni; the overdue list, with its household names, is an Admin screen.
- Money is the branded integer `Rupiah`: whole rupiah, with fractional input rejected.
- The complex runs on WIB (`Asia/Jakarta`) while this machine's clock is UTC+8. Day and month
  boundaries come from `src/lib/time.ts` and `Date.UTC`.
- Authorisation goes through `requirePermission` and the `PERMISSIONS` map in
  `src/lib/server/authz.ts`: a denial becomes `error(403)`, a broken rule `fail(400)`.
- A scheduled job is registered by its owning module's idempotent `register…Jobs` and composed in
  `hooks.server.ts`. A job name is permanent.

## Language

Code, filenames and route segments are English. Screen, validation and email text is Indonesian
through Paraglide, with `messages/id.json` and `messages/en.json` kept key-for-key symmetric. Screen
text carries no em dash (`tests/unit/no-em-dash.test.ts`). Commit subjects are Conventional Commits
with an Indonesian description.

## Changing the database

- `bun run db:generate` writes `"public".` before every foreign key. Strip it from the generated SQL:
  tests run each file in its own schema.
- A new table is re-exported from `src/lib/server/db/schema/index.ts`.
- Versions pinned exactly in `package.json` (drizzle, pg, better-auth, paraglide) stay exact.
- Data enters through the services or `bun run db:seed-dev -- --yes`. A row written straight into
  `dues_rates` wakes the live `issue-invoices` job.

## Tests and the gate

The gate has passed over real defects at least six times, so a change a person can see is also
checked in a running browser.

- `bun run test` needs a running PostgreSQL and a `TEST_DATABASE_URL` that differs from
  `DATABASE_URL`. One test run per database at a time; a lone `ETIMEDOUT` from
  `ensureDatabaseExists` gets one retry.
- CI has no `.env`: a variable a test reads also goes into `.github/workflows/ci.yml`.
- A rule such as "the last X cannot be removed" holds only with `.for('update')` on every row it
  depends on, at every writer. Prove it with a second connection holding the lock (a hand-written
  lock test takes `for no key update`); `Promise.allSettled` never reproduces the race.
- A new email kind is also listed in `tests/unit/scheduler-jobs.test.ts`. A new required form field
  breaks the e2e specs that fill that form: grep `tests/e2e` first.
- A form posting to a named action needs `action="?/<name>"`; no gate command notices it missing.
- `bun run test:e2e` leaves rows behind and publishes a report. Reseed afterwards.
- `.playwright-mcp/` snapshots and loose screenshots turn `prettier --check .` red. Delete them
  before the gate and leave them out of commits.

## Delivery

- Work reaches `main` through a pull request, and the owner merges it. An agent pushes its own
  branches only.
- A commit names its issue as `fix: <description> (#N)`. The form `fix: #N` closes the issue the
  moment it reaches `main`.
- A defect outside a ticket's write surface becomes its own issue.
- Deploy and every production change are the owner's steps (`docs/deploy.md`). A data fix on
  production runs only after its dry run is posted to the tracker and the owner approves it. The
  running `app` container's environment holds production secrets: read single variables, never the
  whole environment.
