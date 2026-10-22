# Housing Complex Financial Management System

A single application for one housing complex (komplek), about 100 houses and 300–400 Residents
(Warga), covering four things:

1. **Dues and cash (Iuran dan kas)** — monthly dues Invoices (Tagihan) per house, Payments
   (Pembayaran) recorded with their proof, and the complex's cash book.
2. **Monthly financial reports** — Monthly Reports (Laporan Bulanan) published straight from the
   cash book, not retyped from a spreadsheet.
3. **Activities and announcements** — Posts covering neighborhood clean-up days, community health
   post sessions, 17 August celebrations, and resident meetings.
4. **Resident reports** — Complaints (Keluhan) that can be tracked to resolution.

Residents who subscribe receive the Monthly Report by email.

## Status

The application scaffold is up, and every domain feature now sits on top of it: the Unit and
Occupancy (Masa Huni) register, Invitations (Undangan) and Registrations (Pendaftaran) with
approval, dues with Invoices, their issuance job, and Exemptions (Pembebasan), Payments with
verification and the overdue list, the cash book with accounting Periods (Periode), the Opening
Balance (Saldo Awal), and Monthly Reports, Posts, Complaints, an XLSX import of Residents,
notification Subscriptions (Langganan), role management, scheduled jobs, and a staging deploy.
SvelteKit runs, Tailwind CSS v4 and shadcn-svelte are installed, the four quality-gate commands
exist and pass, and `docker compose up` starts the application, PostgreSQL, and Mailpit.

## Stack

| Layer             | Choice                                                      |
| ----------------- | ----------------------------------------------------------- |
| Runtime           | Bun                                                         |
| Application       | SvelteKit (Svelte 5), monolith                              |
| HTTP surface      | ElysiaJS, mounted at `src/routes/api/[...slugs]/+server.ts` |
| Domain logic      | Service layer at `src/lib/server/services/`                 |
| Database          | PostgreSQL + Drizzle ORM                                    |
| Authentication    | better-auth, mounted in `hooks.server.ts`                   |
| Interface         | Tailwind CSS v4 + shadcn-svelte, mobile-first               |
| i18n              | Paraglide JS, Indonesian base locale                        |
| Local development | Docker Compose — application, PostgreSQL, Mailpit           |

All four of ElysiaJS, Drizzle ORM, better-auth, and Paraglide JS are installed dependencies today,
listed in `package.json` alongside everything else above.

## Running on a local machine

```bash
cp .env.example .env     # adjust ports if any conflict
docker compose up
```

| Service        | Address                 |
| -------------- | ----------------------- |
| Application    | <http://localhost:5173> |
| Mailpit (web)  | <http://localhost:8025> |
| Mailpit (SMTP) | `localhost:1025`        |
| PostgreSQL     | `localhost:5432`        |

All ports above come from `.env`; `.env.example` carries their defaults. The `app` service uses
the `dev` target from `Dockerfile`, bind-mounts the working directory, and runs the Vite
development server, so file changes show up immediately without rebuilding the image. If file
changes are not detected inside the container, set `VITE_USE_POLLING=true` in `.env`.

To work without Docker, run `bun install` then `bun run dev`; PostgreSQL and Mailpit can still be
started on their own with `docker compose up db mailpit`. That command runs `vite dev` under
Node, which does not inherit the `.env` content the Bun process loads, so `vite.config.ts` copies
`.env` into `process.env` — a variable that already exists in the real environment still wins
over the value in that file.

### Initial setup: migrate, then the first superuser

A freshly migrated database has no superuser at all. The database trigger gives every new account
only the `resident` role, while granting a role inside the application requires the `superuser`
role, so without this step the `/admin/roles` page answers 403 to everyone. That is why the first
superuser is created from the command line, not from any page: there is no route, no form action,
and no endpoint that can grant this role.

```bash
bun run db:migrate                                # run the migration
# register that account through the app, then grant it the role:
bun run superuser:grant pengurus@komplek.local
```

The command only grants a role to an account that is **already registered**. If the address does
not exist, it stops with a message naming that address and exits with code 1. Running it twice
changes nothing on the second run — no second role row and no second `audit_log` row. Every
successful grant leaves one `audit_log` row with `actor_id` set to `system:bootstrap`, marking
that the change came from a machine operator rather than someone signed in.

This command still works on a system that already has a superuser, and deliberately does not
refuse that: it is the only way back if the last superuser account is lost. Note that holding the
`superuser` role alone is not enough for every screen — some actions, such as granting an
Exemption, are attributed to the `residents` row of whoever performs them, so that account still
needs to be registered as a Resident of a Unit.

### Seed data (Data Contoh)

Instead of filling in twenty Units and twenty-seven accounts one by one, one command fills the
local database with the Seed data of one housing complex for the current WIB month, so every main
screen has something on it:

```bash
bun run db:seed-dev -- --yes
```

> **This command deletes every row in the database `DATABASE_URL` points at, then empties the
> `FILE_STORE_ROOT` directory.** Every Unit, Resident, Invoice, Payment, Cash Transaction, Post,
> Complaint, and account there is will be gone, with no way back. Only run it against a
> development database on your own machine.

Three guards stand before a single row is touched, and each stops with exit code 1 and its own
message: `NODE_ENV` set to `production`, a `DATABASE_URL` host that is not `localhost`,
`127.0.0.1`, or `db`, and `--yes` not given. The `--yes` flag is what makes the deletion a
deliberate act rather than a typo.

Once it finishes, the following accounts can sign in:

| Account                                           | Role                 | Unit        |
| ------------------------------------------------- | -------------------- | ----------- |
| `superuser@komplek.local`                         | `superuser`, `admin` | A-01        |
| `admin@komplek.local`                             | `admin`              | A-02        |
| `warga01@komplek.local` … `warga25@komplek.local` | `resident`           | A-01 … B-10 |

Every account's password is `kata-sandi-dummy-123`.

The `superuser` account deliberately holds both roles: `/admin/overdue` and `/admin/payments` are
guarded by actions that `src/lib/server/authz.ts` grants to `admin` alone, so without that role
the superuser would be answered 403 on those two screens.

Contents: 20 Units, 27 Residents with one Primary Occupant (Penanggung Jawab) per Unit, a Dues
Rate (Tarif) of 150,000 effective since last month, an Opening Balance of 12,500,000, 20 Invoices
for this month, 30 Payments (five of them still `pending` with proof, three rejected,
two overpayments that become Credit Balance (Saldo Titipan)), 26 outgoing Cash Transactions
(Transaksi Kas) with one Correction (Koreksi), 6 Posts, 10 Complaints covering every status, and
additional Subscriptions for some Residents. This command prints a summary of the count per
entity when it finishes.

The cash book is built to make sense: income of 15,170,000 (Opening Balance, verified dues, and
one Correction) against expenses of 10,170,000, so the running balance never drops below zero and
the month closes with a cash balance of 5,000,000.

Four of the five still-`pending` Payments are the remainder of a house that has only partly paid,
so the verification screen has a real Invoice to settle; the fifth is for a house that is already
paid in full, an example of the case where the whole amount becomes Credit Balance. As a result
`/admin/overdue` lists seven houses: three that have not paid at all, plus four that are still
short by 60,000 until their Payment is verified.

One thing that reasonably confuses: an Invoice falls due on the 5th, and the overdue list only
includes houses whose due date has **already passed**. Running this command from the 1st through
the 5th therefore leaves `/admin/overdue` empty — not because the seven houses that still owe
money vanished, but because nothing is late yet. The printed summary states how many houses are
overdue, so the situation can be read without guessing.

This command uses `--tsconfig-override scripts/tsconfig.seed.json` because the script imports
`src/lib/server/auth.ts` — accounts are created through better-auth's `signUpEmail` so passwords
are seeded exactly as a real sign-up would — and that module imports `$app/server`, SvelteKit's
virtual module, which plain `bun run` cannot resolve. `scripts/app-server-shim.ts` explains the
whole reason. On Bun 1.4, this flag makes Bun print one `Internal error: directory mismatch …`
line to stderr after the script finishes, on Windows and on Linux alike; the line is harmless and
the exit code stays 0.

## Quality gate

These four commands are the gate. All must pass before a pull request is merged, and GitHub
Actions runs all four on every pull request through `.github/workflows/ci.yml`.

| Command         | Contents                              |
| --------------- | ------------------------------------- |
| `bun run check` | `svelte-kit sync` then `svelte-check` |
| `bun run lint`  | `prettier --check .` then `eslint .`  |
| `bun run test`  | Vitest, single run                    |
| `bun run build` | SvelteKit production build            |

End-to-end tests run separately with `bun run test:e2e` and are **not** part of the per-merge
gate: it builds the application, starts `vite preview`, and runs Playwright. `bun run format`
tidies files with Prettier.

## Security checks

`bun run audit` runs `bun audit` over every dependency, not only the production ones (`--prod`):
SvelteKit, Svelte and Vite sit in `devDependencies` but are bundled into the build. The threshold
is `low`, so any advisory not on the ignore list fails the check. The command is **not** part of the
four-command gate above, because an advisory published in the middle of a run must not fail
unrelated work. GitHub Actions runs it through its own workflow, `.github/workflows/security.yml`
(job `audit`), on every pull request, on every push to `main` and on demand.

**The ignore list** is data in `scripts/audit.ts`, one entry per advisory, keyed by its GHSA id (a
CVE id does not match the registry data `bun audit` reads). Every entry must state:

- the GHSA id;
- the package and version, and the parent that brings it in;
- why the advisory does not apply to this repository;
- the condition that removes the entry.

To add an entry, prove the advisory is not reachable here and fill in all four. To remove one,
delete it once its condition holds, then run `bun run audit` and confirm it still exits 0.

**The image scan.** The same workflow has a second job, `image-scan`, which builds the `production`
target of `Dockerfile` and scans it with Trivy for vulnerabilities in **OS packages only** (the
Alpine layer under `oven/bun`). JavaScript packages are left out because `bun run audit` already
covers them: scanning them here would report again the advisories the ignore list sets aside, without
their reasons. The job prints a report of every severity, which never blocks, then fails only on a
HIGH or CRITICAL finding that already has a fixed version (`--ignore-unfixed`): that is a finding a
rebuild removes, because the `base` stage runs `apk upgrade`; a base-image bump is needed only when
the Alpine branch under the pinned tag no longer receives the fix. An unfixed finding would block
every pull request until an upstream ships a fix. To run it locally, use Trivy 0.76.1, the version the job pins, inside WSL
where Docker runs, from the repository root:

```sh
docker build --target production --build-arg PUBLIC_COMPLEX_NAME=Komplek --tag komplek:image-scan .
trivy image --image-src docker --scanners vuln --pkg-types os --exit-code 0 komplek:image-scan
trivy image --image-src docker --scanners vuln --pkg-types os --severity HIGH,CRITICAL \
  --ignore-unfixed --exit-code 1 komplek:image-scan
```

Install that Trivy from the `trivy_0.76.1_Linux-64bit.tar.gz` release archive and check it against
the `ARCHIVE_SHA256` in the workflow, the same way the job's `Install Trivy` step does. The version
and its hash are bumped together in that step's `env` in `.github/workflows/security.yml`, and only
to a release whose `immutable` flag is true (`gh api repos/aquasecurity/trivy/releases/tags/v<x>`).
Take the hash from the release's `trivy_<x>_checksums.txt` and confirm it matches the archive's
`digest` in that same response. Trivy is deliberately not installed through `aquasecurity/trivy-action`: the reason is
in the comment above that step.

**Settings on GitHub, on since 2026-10-23:**

- Dependabot alerts, for direct dependencies only: the dependency graph does not read `bun.lock`.
- Secret scanning, with push protection.
- CodeQL, default setup.

Dependabot security updates are off, because they do not support Bun.

**What this cannot see.** There is no schedule, so a new advisory on a transitive package, or a new
CVE in an Alpine package of the image, shows only when a pull request or a push to `main` runs the
workflow.

## Conventions

The decisions below were set by the scaffolding ticket and are followed by all later work.

**Directory layout.**

| Directory                  | Contents                                                              |
| -------------------------- | --------------------------------------------------------------------- |
| `src/routes/`              | SvelteKit pages and endpoints. Holds no domain rules.                 |
| `src/lib/server/services/` | The only place domain rules live. Tested directly, without HTTP.      |
| `src/lib/components/ui/`   | shadcn-svelte components copied into the repository and free to edit. |
| `src/lib/components/`      | This application's own interface components.                          |
| `src/lib/utils.ts`         | Cross-layer helpers, including `cn` for combining classes.            |
| `tests/unit/`              | Vitest. `*.test.ts` files.                                            |
| `tests/e2e/`               | Playwright. `*.spec.ts` files.                                        |

The outbound ports `EmailSender`, `FileStore`, and `Clock` live under `src/lib/server/ports/`,
next to the service layer, and are faked in tests.

**Tooling configuration.** From SvelteKit 2.63 with `@sveltejs/vite-plugin-svelte` 7, SvelteKit's
configuration no longer lives in `svelte.config.js` but inside the `sveltekit()` plugin's options
in `vite.config.ts`. That file also holds the Tailwind CSS v4 plugin and the Vitest configuration,
so it is the one place to add the next Vite plugin. Tailwind v4 uses the `@tailwindcss/vite`
plugin with its configuration inside CSS (`src/app.css`), not `tailwind.config.js`.

**Language.** The interface's base language is Indonesian. Names in code and in the interface use
the vocabulary in `CONTEXT.md`; new vocabulary is added there first, rather than invented in code.
This README is written in English. `CONTEXT.md`, the specs, and the deploy runbook stay in
Indonesian.

**Mobile-first.** Pages must be readable and usable at 390px width before any wider layout is
considered.

## Documents

- [Specs](./docs) — copies of every spec for the run in progress (in Indonesian).
- [Tracker](./docs/agents/issue-tracker.md) — where specs and tickets live.
- [Glossary](./CONTEXT.md) — canonical language used in code, the interface, and conversation (in
  Indonesian).
- [Deploy runbook](./docs/deploy.md): how to set up and redeploy the staging environment (in
  Indonesian).
