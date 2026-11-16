import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * The nominal field never turns typed text into a different amount (#340, spec #344).
 *
 * It used to keep the digits of whatever was typed, so `12,5` on `/admin/payments/cash` recorded a
 * cash Pembayaran of Rp 125 without a word. The rule itself is `src/lib/rupiah-field.ts`, held by
 * `tests/unit/rupiah-field.test.ts`; this file proves the shared component carries it into a real
 * form: refused text stays on screen, the shared sentence shows under the field, and the browser
 * does not post the form, while an ordinary amount typed the way a person types it still records.
 *
 * The page is the Data Contoh superuser's (`README.md`, "Data Contoh"), already signed in through
 * the `superuserPage` fixture of `./fixtures.ts`, and the house is `A-10`: paid in full in Data
 * Contoh and touched by no other spec, so the Pembayaran recorded here becomes Saldo Titipan on a
 * house nothing else looks at. The run leaves that row behind like every other spec; reseed after.
 */

/** The screen under test. */
const CASH_PAYMENT_PATH = '/admin/payments/cash';

/** The label on the nominal field, `adminPayments_cash_amountLabel`. */
const AMOUNT_LABEL = 'Nominal yang diterima';

/** The label on the house picker, `adminPayments_cash_unitLabel`. */
const UNIT_LABEL = 'Unit';

/** The label on the date field, `adminPayments_cash_receivedOnLabel`. */
const RECEIVED_ON_LABEL = 'Tanggal uang diterima';

/** The submit button, `adminPayments_cash_submit`. */
const SUBMIT_LABEL = 'Catat dan verifikasi';

/** The Data Contoh house this file records on, as the picker names it. */
const UNIT_OPTION = 'Blok A No 10';

/** The shared sentence under a refused nominal field, `rupiahInput_invalid`. */
const REFUSAL =
	'Nominal harus rupiah utuh, misalnya 150.000, tanpa koma, huruf, atau tanda minus. Hapus ,00 kalau ada.';

/** The complex's own time zone: "today" for a cash payment is the day in Jakarta. */
const COMPLEX_TIME_ZONE = 'Asia/Jakarta';

/**
 * Opens `path` and waits until the page can be typed into. Copied from `tests/e2e/dialogs.spec.ts`:
 * hydration overwrites anything typed before it runs, and `networkidle` is the signal that it has
 * already happened.
 */
async function open(page: Page, path: string): Promise<void> {
	await page.goto(path);
	await page.waitForLoadState('networkidle');
}

/**
 * Today in Jakarta as `YYYY-MM-DD`. Never a day ahead of the server's own "today", which the
 * service refuses as `receivedInTheFuture`, and never the day before, which on the first of a month
 * would fall in last month's Periode.
 */
function todayInJakarta(): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: COMPLEX_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(new Date());
	const part = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((candidate) => candidate.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Fills in everything on the form except the nominal, so that the nominal is the only thing that
 * can stop the browser from submitting it.
 */
async function fillEverythingButTheAmount(page: Page): Promise<void> {
	await page.getByLabel(UNIT_LABEL, { exact: true }).selectOption({ label: UNIT_OPTION });
	await page.getByLabel(RECEIVED_ON_LABEL).fill(todayInJakarta());
}

test('a nominal typed with a decimal comma stays on screen, is refused, and is never posted', async ({
	superuserPage: page
}) => {
	await open(page, CASH_PAYMENT_PATH);
	await fillEverythingButTheAmount(page);

	// Every POST the page makes from here on. A refused form is one the browser never sends, so a
	// Pembayaran cannot have been created if this stays empty.
	const posts: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'POST') {
			posts.push(request.url());
		}
	});

	const amount = page.getByLabel(AMOUNT_LABEL, { exact: true });
	// Key by key, as a person types it, not `fill`: every keystroke is an `input` event of its own,
	// which is where the old field dropped the comma.
	await amount.pressSequentially('12,5');
	await expect(amount).toHaveValue('12,5');
	// The posted half carries the text untouched, never its digits.
	await expect(page.locator('input[name="amount"]')).toHaveValue('12,5');

	await page.getByRole('button', { name: SUBMIT_LABEL }).click();

	await expect(page.getByText(REFUSAL)).toBeVisible();
	await expect(amount).toHaveValue('12,5');
	await expect(amount).toHaveAttribute('aria-invalid', 'true');
	await expect(amount).toHaveAccessibleDescription(REFUSAL);
	await expect(page).toHaveURL(new RegExp(`${CASH_PAYMENT_PATH}$`));
	// No success sentence, and no request the server could have recorded anything from.
	await expect(page.getByRole('status')).toHaveCount(0);
	expect(posts).toEqual([]);
});

test('a nominal typed as 150.000 records the Pembayaran', async ({ superuserPage: page }) => {
	await open(page, CASH_PAYMENT_PATH);
	await fillEverythingButTheAmount(page);

	const amount = page.getByLabel(AMOUNT_LABEL, { exact: true });
	// Typing the separator by hand passes through `150.` and `150.00`, which are not amounts yet; the
	// sentence must not show for any of them.
	await amount.pressSequentially('150.000');
	await expect(amount).toHaveValue('150.000');
	await expect(page.locator('input[name="amount"]')).toHaveValue('150000');
	await expect(page.getByText(REFUSAL)).toHaveCount(0);
	await expect(amount).not.toHaveAttribute('aria-invalid', 'true');

	await page.getByRole('button', { name: SUBMIT_LABEL }).click();

	await expect(page.getByRole('status')).toContainText(
		'Pembayaran tunai Rp 150.000 tercatat dan langsung terverifikasi.'
	);
});
