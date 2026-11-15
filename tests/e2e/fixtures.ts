import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';

/**
 * The one sign-in of the Data Contoh superuser that every spec shares, once per Playwright worker.
 *
 * ## Why this file exists: the login limit is one budget for the whole suite
 *
 * `POST /login` allows 30 attempts per client address per minute (`RATE_LIMIT_POLICY.login` in
 * `src/lib/server/rate-limit.ts`), and the whole suite signs in from one address (`::1`), fully
 * parallel, in about forty seconds. Before this file, every test that only needed "a superuser" ran
 * the sign-in form itself: thirteen of the thirty attempts of one run, which left the suite exactly
 * at the limit. A test added later then failed the last test of the minute to sign in, with "Terlalu
 * banyak percobaan masuk", in a spec file nobody had touched (#336).
 *
 * `superuserPage` is a page that is already signed in as the Data Contoh superuser, and the sign-in
 * behind it happens once per worker, not once per test. A spec that wants a superuser asks for it by
 * name (`{ superuserPage: page }`); it does not write a sign-in helper of its own.
 *
 * ## What still signs in by itself, and must keep doing so
 *
 * - A test whose subject is signing in or out, or the session itself (`auth.spec.ts`,
 *   `auth-locale.spec.ts`): a shared session would not prove the flow, and signing out would revoke
 *   the session every other test is standing on.
 * - A test that registers an account of its own and then signs it in (every `signUp…` helper in the
 *   other specs, and each registrant in `registration.spec.ts`): the account is new, so there is no
 *   shared session to borrow, and a role granted to it is the thing the test is about.
 *
 * Those are 17 attempts a run. The workers add at most `workers` more (`playwright.config.ts`), one
 * each and only for a worker that runs a test asking for `superuserPage`, so the cap there and the
 * count here are one decision: 17 + 3 stays at 20, which leaves the headroom of 10 the limit is
 * meant to keep. A new test that signs in raises the first number; check it against the cap.
 *
 * ## What a shared session must survive
 *
 * Nothing in the suite signs this account out, changes its roles or its password, or resets its
 * password (which would revoke every session it has). A test that did would have to sign in on its
 * own instead. A page made here has its own browser context, so its cookies and its locale cookie
 * (the language switcher in `layout.spec.ts` writes one) never reach another test.
 */

/** The Data Contoh superuser account (`README.md`, "Data Contoh"), on unit `A-01`. */
const SUPERUSER_EMAIL = 'superuser@komplek.local';
const SUPERUSER_PASSWORD = 'kata-sandi-dummy-123';

/** The label on the address field in the sign-in form. */
const EMAIL_FIELD = 'Alamat email';

/** What `BrowserContext.storageState()` answers: the cookies and local storage of a signed-in browser. */
type SignedInState = Awaited<ReturnType<BrowserContext['storageState']>>;

interface TestFixtures {
	/** A page in a browser context of its own, signed in as the Data Contoh superuser. */
	superuserPage: Page;
}

interface WorkerFixtures {
	/** The superuser's cookies, taken from the one sign-in this worker makes. */
	superuserState: SignedInState;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
	superuserState: [
		async ({ browser }, use, workerInfo) => {
			const baseURL = workerInfo.project.use.baseURL;
			if (baseURL === undefined) {
				throw new Error('playwright.config.ts names no baseURL, so the sign-in has nowhere to go.');
			}

			const context = await browser.newContext({ baseURL });
			let state: SignedInState;
			try {
				const page = await context.newPage();
				// `networkidle` before typing, for the reason `tests/e2e/auth.spec.ts` measures: hydration
				// writes every `value={…}` binding back over what was typed before it ran, which leaves a
				// `required` field empty and a form the browser will not submit.
				await page.goto('/login');
				await page.waitForLoadState('networkidle');
				await page.getByLabel(EMAIL_FIELD).fill(SUPERUSER_EMAIL);
				await page.getByLabel('Kata sandi').fill(SUPERUSER_PASSWORD);
				await page.getByRole('button', { name: 'Masuk' }).click();
				// The response that carries the session cookie is still in flight when `click` resolves.
				await expect(page).toHaveURL(/\/$/);
				state = await context.storageState();
			} finally {
				await context.close();
			}
			await use(state);
		},
		{ scope: 'worker', timeout: 60_000 }
	],

	superuserPage: async ({ browser, superuserState }, use) => {
		// `browser.newContext` still applies the project's and the file's `use` options (the base URL,
		// the viewport a spec asked for), and only the stored session is added to them.
		const context = await browser.newContext({ storageState: superuserState });
		try {
			await use(await context.newPage());
		} finally {
			await context.close();
		}
	}
});

export { expect };
