# SonarQube Cloud analysis

How static analysis runs on this repository, and the things about it that are not obvious.

Configuration lives in [`sonar-project.properties`](../sonar-project.properties) and in the `sonar`
job of [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

| | |
|---|---|
| Organization | `jefry-kurniawan` |
| Project key | `jefrykurniaone_sistem-informasi-manajemen-keuangan` |
| Dashboard | <https://sonarcloud.io/dashboard?id=jefrykurniaone_sistem-informasi-manajemen-keuangan> |
| Action | `SonarSource/sonarqube-scan-action`, pinned to the commit for `v8.3.0` |
| Secret | `SONAR_TOKEN`, in the repository's Actions secrets |
| Quality gate | `Sonar way`, measured on new code; `sonar.qualitygate.wait=true` turns a failed gate into a red job |

## `SONAR_TOKEN` does not go in `.env`

**GitHub, repository, Settings, Secrets and variables, Actions, New repository secret**, named
exactly `SONAR_TOKEN`. Nowhere else. Generate the value at SonarQube Cloud under My Account, Security,
or from the project's own Analysis Method page.

Everything in `.env` is read by the application, by Docker Compose or by a script run on a developer
machine or the VM. `SONAR_TOKEN` is read by a GitHub Actions runner, which never sees either, and
`.env` is git-ignored so it could not reach one anyway. It is never committed, never in an
`.env.*.example`, and never pasted into an issue, a pull request or a chat transcript. If it leaks,
revoke it in SonarQube Cloud and generate a new one: it grants analysis access to every project in
the organization.

## Automatic Analysis must stay off

SonarQube Cloud turns Automatic Analysis on for a newly imported project, and it **cannot coexist
with CI-based analysis**: with both on, the `analyse` step fails with a message about the project
already being analysed automatically, which does not name the setting to change. It is a project
setting in the web interface (Administration, Analysis Method), so nothing in this repository can
express or enforce it.

If `analyse` starts failing with nothing in the diff to explain it, check that setting first. CI was
chosen over Automatic Analysis because Automatic Analysis cannot read a coverage report.

## Coverage exclusions mirror `vite.config.ts` and must stay in step

`test.coverage` in `vite.config.ts` instruments `src/lib/**/*.ts` only, and only when Vitest is
given `--coverage`, which the CI `test` step does and `bun run test` on its own does not. Routes,
Svelte components, scripts and the root configuration files produce no coverage data.

Sonar cannot distinguish "not instrumented" from "not covered". Left alone, the gate, which wants
80% coverage on new code, would count every new route and component in every pull request as
uncovered and fail on work that is behaving exactly as designed. `sonar.coverage.exclusions`
therefore lists what Vitest does not instrument.

**If you change `test.coverage` in `vite.config.ts`, change `sonar.coverage.exclusions` in the same
pull request.** Deleting the line to "fix" a coverage number breaks the gate for everyone else
instead.

`vitest` and `@vitest/coverage-v8` must resolve to the same version: each declares the other as an
exact peer.

## The editor and the server do not report the same things

Neither SonarLint in the editor nor SonarQube Cloud is a superset of the other. Every
`githubactions:*` rule is server-only, because SonarLint does not analyse workflow files; that is why
`sonar.sources` is `.` rather than a list of source directories. The server also analyses the
Dockerfile, the shell scripts and the SQL migrations.

**CI is the authority.** The editor extension is a convenience. An empty diagnostics result from the
editor proves nothing either way: it is the same for a clean file and for a file the editor has never
opened.

## The scan is skipped, not failed, without a token

`HAS_SONAR_TOKEN` is derived from the secret in a job-level `env` expression, which may read
`secrets` where a step-level `if` may not. Without the secret the workflow stays green and emits a
warning that the commit was not analysed. A pull request from a fork always takes this path, because
secrets are not exposed to it.

Two consequences: a green CI run is **not** proof that analysis happened, so check the `analyse`
step; and the token never enters the environment of the `gate` job. That separation is why the
`sonar` job downloads `coverage/lcov.info` as an artifact instead of running the tests again: `gate`
installs dependencies, and a token in its environment would be readable by their install scripts.

## Setting it up again from scratch

1. Create the project on SonarQube Cloud and bind it to the GitHub repository.
2. **Turn Automatic Analysis off.**
3. Generate a token and add it as the `SONAR_TOKEN` Actions secret.
4. Confirm `sonar.organization` and `sonar.projectKey` in `sonar-project.properties` match the new
   project. The project key is visible in the dashboard URL.
