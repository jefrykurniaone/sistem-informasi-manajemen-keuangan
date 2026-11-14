import { spawnSync } from 'node:child_process';

/**
 * Runs `bun audit` over the whole lockfile and fails for every advisory that is not in
 * `IGNORED_ADVISORIES`. `bun run audit` runs it locally, and the Security workflow
 * (`.github/workflows/security.yml`) runs the same command on every pull request and push to `main`.
 *
 * ## Why it is not part of the gate
 *
 * An advisory published in the middle of a run must not fail a wave of unrelated tickets, so the
 * four gate commands stay as they are and this check has a workflow of its own.
 *
 * ## Why it checks every dependency
 *
 * No `--prod` flag: SvelteKit, Svelte and Vite sit in `devDependencies` but are bundled into the
 * build, so a flaw in them reaches production all the same.
 *
 * ## The threshold
 *
 * `--audit-level=low` is Bun's default, written out so the threshold can be read here. Anything at
 * or above it fails the check.
 *
 * ## The ignore list
 *
 * An entry is a decision that an advisory does not apply to this repository, so it carries the
 * reason and the condition that retires it. Entries are keyed by GHSA id: a CVE id does not match
 * the registry data `bun audit` reads.
 *
 * - To add one, prove that the advisory is not reachable here, then add an entry with all five
 *   fields. A missing field is a defect in the entry, not a formality.
 * - To remove one, delete the entry once its `removeWhen` condition holds, and run
 *   `bun run audit`: it must still exit 0.
 *
 * The output of `bun audit` is passed through as it is, and this script exits with its exit code.
 */

const AUDIT_LEVEL = 'low';

interface IgnoredAdvisory {
	/** The GHSA id, as `bun audit` prints it. */
	readonly id: string;
	/** The vulnerable package and version, and the parent that brings it in. */
	readonly package: string;
	readonly parent: string;
	/** Why the advisory does not apply to this repository. */
	readonly reason: string;
	/** The condition that retires the entry. */
	readonly removeWhen: string;
}

const IGNORED_ADVISORIES: readonly IgnoredAdvisory[] = [
	{
		id: 'GHSA-67mh-4wv8-2f99',
		package: 'esbuild 0.18.20',
		parent: 'drizzle-kit > @esbuild-kit/core-utils > esbuild',
		reason:
			"The flaw is in esbuild's serve mode, which drizzle-kit never starts: it only transforms its own config and schema files.",
		removeWhen: 'drizzle-kit no longer brings in an esbuild below 0.25.0.'
	},
	{
		id: 'GHSA-rj75-hqrm-r3gf',
		package: 'postcss-selector-parser 6.0.10',
		parent: '@tailwindcss/typography 0.5.20',
		reason:
			"The package runs only at build time and reads this repository's own CSS, never input from a visitor.",
		removeWhen: '@tailwindcss/typography brings in postcss-selector-parser 7.1.6 or newer.'
	},
	{
		id: 'GHSA-pfhg-q3qv-9q6r',
		package: '@sveltejs/kit 2.70.4',
		parent: 'direct dependency',
		reason:
			'The open redirect needs a use:enhance form on a page route that can match a path starting with //. The only catch-all routes, api/[...slugs] and files/[...key], hold a +server.ts and no page, no form action and no use:enhance, and none sits at the root. No reroute hook exists.',
		removeWhen: 'The repository upgrades to SvelteKit 3.'
	},
	{
		id: 'GHSA-27mw-82g8-phjj',
		package: '@sveltejs/kit 2.70.4',
		parent: 'direct dependency',
		reason:
			'The XSS needs a prerendered page whose cache-control header comes from setHeaders. No +page or +layout exports prerender, and the SvelteKit options in vite.config.ts set no kit.prerender, so the build prerenders no page.',
		removeWhen: 'The repository upgrades to SvelteKit 3.'
	},
	{
		id: 'GHSA-gcqx-w48m-w2h4',
		package: 'deepmerge 4.3.1',
		parent:
			'@sveltejs/vite-plugin-svelte > deepmerge, and @sveltejs/adapter-node > @rollup/plugin-node-resolve > deepmerge',
		reason:
			"Both parents are build tools that merge this repository's own configuration. The deepmerge package code is not in the production build output.",
		removeWhen:
			'A fixed deepmerge is published and @sveltejs/vite-plugin-svelte and @rollup/plugin-node-resolve depend on it.'
	},
	{
		id: 'GHSA-g3hv-75wg-m249',
		package: 'minimatch 10.2.6',
		parent:
			'eslint > @eslint/config-array > minimatch, and typescript-eslint > @typescript-eslint/utils > @typescript-eslint/typescript-estree > minimatch',
		reason:
			"It is the only copy in the affected range (>=7.0.0 <11.0.1), and ESLint and typescript-eslint run it at lint time on glob patterns from this repository's own configuration. The other copies, 3.1.5 and 5.1.9 under exceljs > archiver, are outside the range.",
		removeWhen: 'ESLint and typescript-eslint accept minimatch 11.0.1 or newer.'
	}
];

const args = [
	'audit',
	`--audit-level=${AUDIT_LEVEL}`,
	...IGNORED_ADVISORIES.map((advisory) => `--ignore=${advisory.id}`)
];

// `bun audit` only reports a count of ignored advisories, so the log would not say which ones. These
// lines make a reader of the CI log see exactly what was ignored.
for (const advisory of IGNORED_ADVISORIES) {
	console.log(`audit: ignoring ${advisory.id} (${advisory.package}, via ${advisory.parent})`);
}

// `process.execPath` is the Bun that runs this script, so the audit uses the same version.
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });

if (result.error) {
	console.error(`audit: could not run bun audit (${result.error.message}).`);
	process.exit(1);
}

// A process ended by a signal has no status; that is a failure too.
process.exit(result.status ?? 1);
