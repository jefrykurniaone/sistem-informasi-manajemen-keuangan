import { expect, test, type Page } from '@playwright/test';

/**
 * The five `(auth)` pages in English, once the interface locale is switched by cookie.
 *
 * `tests/e2e/auth.spec.ts`, `tests/e2e/registration.spec.ts` and `tests/e2e/invitation.spec.ts`
 * cover these same pages at the default `id` locale and match on the Indonesian text directly,
 * because none of them sets `PARAGLIDE_LOCALE`: `vite.config.ts`'s `strategy: ['cookie',
 * 'baseLocale']` falls back to `baseLocale` (`id`, `project.inlang/settings.json`) when no cookie
 * is present. #212 moved every visible string on these pages and every message their server
 * actions return into `messages/id.json` and `messages/en.json`, and this file is the one place
 * that proves the `en` half of that catalogue actually renders, rather than only existing in the
 * JSON. It does not repeat what the specs above already prove about the flows themselves.
 *
 * `messages/id.json`'s values are unchanged, character for character equal to what used to be
 * hardcoded, which is what keeps the specs above passing without an edit.
 *
 * Like every file in this directory, it stands alone and copies its own `open` helper rather than
 * importing one from `auth.spec.ts`.
 */

/** The cookie `paraglideVitePlugin`'s `strategy: ['cookie', 'baseLocale']` reads a locale from. */
const LOCALE_COOKIE = 'PARAGLIDE_LOCALE';

/**
 * Opens `path` and waits until the page can be typed into.
 *
 * See the long comment on the same helper in `tests/e2e/auth.spec.ts`: `goto` alone races Svelte's
 * hydration, which overwrites anything filled into the form before it finishes.
 */
async function open(page: Page, path: string): Promise<void> {
	await page.goto(path);
	await page.waitForLoadState('networkidle');
}

/** An address no other run of this spec will have used. */
function anAddress(label: string): string {
	return `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@komplek.local`;
}

test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([{ name: LOCALE_COOKIE, value: 'en', url: baseURL }]);
});

test('the sign-in page renders in English', async ({ page }) => {
	await open(page, '/login');
	await expect(page).toHaveTitle(/^Log in/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Log in');
	await expect(page.getByLabel('Email address')).toBeVisible();
	await expect(page.getByLabel('Password')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Forgot your password?' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Register a new account' })).toBeVisible();
});

test('the registration page renders in English', async ({ page }) => {
	await open(page, '/register');
	await expect(page).toHaveTitle(/^Register/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Register');
	await expect(page.getByLabel('Name')).toBeVisible();
	await expect(page.getByLabel('Email address')).toBeVisible();
	await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Repeat password')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Register' })).toBeVisible();
});

test('the forgot-password page renders in English', async ({ page }) => {
	await open(page, '/forgot-password');
	await expect(page).toHaveTitle(/^Forgot password/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Forgot password');
	await expect(page.getByLabel('Email address')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send link' })).toBeVisible();
});

test('the verify page renders in English', async ({ page }) => {
	await open(page, '/verify');
	await expect(page).toHaveTitle(/^Verify email/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Verify email');
	await expect(page.getByText('A new account has to be verified first')).toBeVisible();
});

test('the set-password page renders in English without a token', async ({ page }) => {
	await open(page, '/set-password');
	await expect(page).toHaveTitle(/^Set a new password/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Set a new password');
	await expect(page.getByText('This page can only be opened through the link')).toBeVisible();
});

test('signing in with the wrong password shows the English server message', async ({ page }) => {
	await open(page, '/login');
	await page.getByLabel('Email address').fill(anAddress('locale'));
	await page.getByLabel('Password').fill('a wrong password entirely');
	await page.getByRole('button', { name: 'Log in' }).click();
	await expect(page.getByRole('alert')).toContainText('Wrong email address or password.');
});
