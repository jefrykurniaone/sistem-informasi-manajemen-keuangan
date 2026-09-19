import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah } from '$lib/money';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import { CASH_CATEGORY_TYPE, type CashCategoryType } from '$lib/server/db/schema/cash-category';
import type { CashTransaction } from '$lib/server/db/schema/cash-transaction';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import { cashBook } from '$lib/server/services/cash/balance';
import { createCashCategory } from '$lib/server/services/cash/category';
import { recordCashCorrection } from '$lib/server/services/cash/correction';
import { recordCashTransaction } from '$lib/server/services/cash/transaction';

/**
 * The running balance: computed on every read, never stored, and checked here against sums worked
 * out two other ways over a long sequence that includes corrections.
 *
 * ## Why three different computations
 *
 * `cashBook` folds the balance forward in TypeScript, one line at a time. A test that folded the
 * same way would prove the fold agrees with itself. So this file checks it against:
 *
 * 1. **A nested prefix sum** — for each position, add every signed amount from the start again,
 *    from scratch. It is O(n²) and carries no accumulator between positions, so an off-by-one, a
 *    stale running total or a mis-sorted row shows up as a mismatch rather than being folded in.
 *    It is built from this file's own plan of what was recorded, not from what the service returned.
 * 2. **A `sum` aggregate in PostgreSQL** — a different engine entirely, issued by the test against
 *    the same rows.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** One minute between rows, so that `createdAt` orders them exactly as they were recorded. */
const STEP_MILLISECONDS = 60_000;

/** The four months the plan spreads its transactions over. */
const MONTHS: readonly string[] = ['2026-01', '2026-02', '2026-03', '2026-04'];

/** The categories the plan files its transactions under: two income, two expense. */
const CATEGORY_PLAN: readonly { readonly name: string; readonly type: CashCategoryType }[] = [
	{ name: 'Sumbangan kegiatan warga', type: CASH_CATEGORY_TYPE.income },
	{ name: 'Sewa aula komplek', type: CASH_CATEGORY_TYPE.income },
	{ name: 'Gaji petugas kebersihan', type: CASH_CATEGORY_TYPE.expense },
	{ name: 'Perbaikan fasilitas umum', type: CASH_CATEGORY_TYPE.expense }
];

/** How many transactions the plan records before any of them is corrected. */
const PLANNED_COUNT = 48;

/** Every seventh recorded transaction is corrected, which puts a Koreksi in three of four months. */
const CORRECTION_EVERY = 7;

/** One transaction the plan will record: worked out from its index, never from a random number. */
interface PlannedTransaction {
	readonly occurredOn: string;
	readonly categoryIndex: number;
	readonly amount: number;
}

/**
 * The plan, derived from the index alone so that the sequence is the same on every run and on every
 * machine. Days repeat inside a month on purpose: two transactions on one day are what the
 * `createdAt` tiebreak in `cashBook`'s ordering exists for.
 *
 * The two extra rows pin the inclusive ends of a month filter — the first and the last day of
 * February, which is also the month whose length a range built by hand would get wrong.
 */
const PLAN: readonly PlannedTransaction[] = [
	...Array.from({ length: PLANNED_COUNT }, (_, index) => ({
		occurredOn: `${MONTHS[index % MONTHS.length]}-${String(((index * 5) % 28) + 1).padStart(2, '0')}`,
		categoryIndex: index % CATEGORY_PLAN.length,
		amount: 10_000 * (((index * 37) % 23) + 1)
	})),
	{ occurredOn: '2026-02-01', categoryIndex: 0, amount: 111_000 },
	{ occurredOn: '2026-02-28', categoryIndex: 2, amount: 222_000 }
];

/** One line of the model this file compares the service against. */
interface ModelLine {
	readonly occurredOn: string;
	readonly categoryIndex: number;
	/** Positive for money in, negative for money out. */
	readonly signed: number;
	/** The order this line was written in, which is the order its `createdAt` carries. */
	readonly writtenAt: number;
}

let adminId: string;
let categoryIds: string[];
let recorded: CashTransaction[];
let corrections: CashTransaction[];
/** Every line the plan produced, in the order `cashBook` is expected to return them. */
let model: readonly ModelLine[];

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any sign-up. */
async function insertUser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: `${id}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

/** A user holding `role` on top of the default `resident` one. */
async function insertUserWithRole(name: string, role: Role): Promise<string> {
	const id = await insertUser(name);
	await testDb.db.insert(userRoles).values({ userId: id, role, createdAt: new Date(START) });
	return id;
}

/** The signed effect of one planned line: money in adds, money out takes away. */
function signedOf(plan: PlannedTransaction): number {
	return CATEGORY_PLAN[plan.categoryIndex].type === CASH_CATEGORY_TYPE.income
		? plan.amount
		: -plan.amount;
}

/**
 * Every running total, each one added up again from the beginning.
 *
 * Deliberately quadratic and deliberately without an accumulator: it is the independent answer the
 * acceptance criteria asks for, and it is only independent if it shares no state between positions
 * with the fold it is checking.
 */
function prefixTotals(signed: readonly number[]): readonly number[] {
	const totals: number[] = [];
	for (let end = 0; end < signed.length; end += 1) {
		let total = 0;
		for (let index = 0; index <= end; index += 1) {
			total += signed[index];
		}
		totals.push(total);
	}
	return totals;
}

/** The model lines this filter should produce, in the order `cashBook` returns them. */
function modelFor(filter: { month?: string; categoryIndex?: number }): readonly ModelLine[] {
	return model.filter(
		(line) =>
			(filter.month === undefined || line.occurredOn.startsWith(filter.month)) &&
			(filter.categoryIndex === undefined || line.categoryIndex === filter.categoryIndex)
	);
}

/** The signed total of every model line strictly before `month`, under the same category filter. */
function carriedInto(month: string, categoryIndex?: number): number {
	let total = 0;
	for (const line of model) {
		const earlier = line.occurredOn.slice(0, month.length) < month;
		const matches = categoryIndex === undefined || line.categoryIndex === categoryIndex;
		if (earlier && matches) {
			total += line.signed;
		}
	}
	return total;
}

/** The whole book's signed total, added up by PostgreSQL rather than by TypeScript. */
async function totalAccordingToPostgres(): Promise<number> {
	const result = await testDb.db.execute<{ total: string }>(
		sql`select coalesce(sum(case when type = 'income' then amount else -amount end), 0)::text as total from cash_transactions`
	);
	return Number(result.rows[0].total);
}

beforeAll(async () => {
	adminId = await insertUserWithRole('Pengurus Buku Kas Panjang', ROLE.admin);
	const superuserId = await insertUserWithRole('Pengurus Kategori Buku Kas', ROLE.superuser);
	const clock = new FakeClock(START);
	const fileStore = new FakeFileStore(clock);

	categoryIds = [];
	for (const category of CATEGORY_PLAN) {
		const created = await createCashCategory(testDb.db, clock, {
			actorId: superuserId,
			name: category.name,
			type: category.type
		});
		categoryIds.push(created.id);
	}

	recorded = [];
	for (const plan of PLAN) {
		clock.advance(STEP_MILLISECONDS);
		recorded.push(
			await recordCashTransaction(testDb.db, clock, fileStore, {
				actorId: adminId,
				occurredOn: plan.occurredOn,
				categoryId: categoryIds[plan.categoryIndex],
				amount: rupiah(plan.amount),
				description: `Baris rencana ${recorded.length + 1}`
			})
		);
	}

	corrections = [];
	const correctedIndexes: number[] = [];
	for (let index = 0; index < PLAN.length; index += CORRECTION_EVERY) {
		clock.advance(STEP_MILLISECONDS);
		corrections.push(
			await recordCashCorrection(testDb.db, clock, {
				actorId: adminId,
				transactionId: recorded[index].id,
				reason: `Koreksi baris rencana ${index + 1}.`
			})
		);
		correctedIndexes.push(index);
	}

	// The model, built from the plan rather than from anything the service returned, then sorted the
	// way `cashBook` documents its order: by the day money moved, then by when the line was written.
	const lines: ModelLine[] = PLAN.map((plan, index) => ({
		occurredOn: plan.occurredOn,
		categoryIndex: plan.categoryIndex,
		signed: signedOf(plan),
		writtenAt: index
	}));
	correctedIndexes.forEach((index, order) => {
		lines.push({
			occurredOn: PLAN[index].occurredOn,
			categoryIndex: PLAN[index].categoryIndex,
			signed: -signedOf(PLAN[index]),
			writtenAt: PLAN.length + order
		});
	});
	model = [...lines].sort(
		(left, right) =>
			left.occurredOn.localeCompare(right.occurredOn) || left.writtenAt - right.writtenAt
	);
});

describe('the cash book in date order', () => {
	it('returns every line, oldest first, with each one written after the day it belongs to', async () => {
		const book = await cashBook(testDb.db, adminId);

		expect(book.entries).toHaveLength(PLAN.length + corrections.length);
		expect(book.entries.map((entry) => entry.occurredOn)).toEqual(
			model.map((line) => line.occurredOn)
		);
		const days = book.entries.map((entry) => entry.occurredOn);
		expect([...days].sort((left, right) => left.localeCompare(right))).toEqual(days);
	});

	it('marks a Koreksi and the line it corrects, and offers a second correction of neither', async () => {
		const book = await cashBook(testDb.db, adminId);
		const byId = new Map(book.entries.map((entry) => [entry.id, entry]));

		for (const correction of corrections) {
			expect(byId.get(correction.id)?.correctionOf).toBe(correction.correctionOf);
			expect(byId.get(correction.correctionOf ?? '')?.correctedBy).toBe(correction.id);
		}
		const corrected = new Set(corrections.map((correction) => correction.correctionOf));
		for (const entry of book.entries) {
			if (!corrected.has(entry.id)) {
				expect(entry.correctedBy).toBeNull();
			}
		}
	});
});

describe('the running balance over a long sequence including corrections', () => {
	it('matches a prefix sum worked out from scratch at every single line', async () => {
		const book = await cashBook(testDb.db, adminId);

		expect(book.entries.map((entry) => entry.balance)).toEqual(
			prefixTotals(model.map((line) => line.signed))
		);
	});

	it('closes on a figure PostgreSQL agrees with, added up by the database instead', async () => {
		const book = await cashBook(testDb.db, adminId);

		expect(book.closingBalance).toBe(await totalAccordingToPostgres());
		expect(book.openingBalance).toBe(0);
	});

	it('nets a corrected line back to nothing, which is what a reversing row is for', async () => {
		const book = await cashBook(testDb.db, adminId);
		const byId = new Map(book.entries.map((entry) => [entry.id, entry]));

		for (const correction of corrections) {
			const original = byId.get(correction.correctionOf ?? '');
			expect(correction.amount).toBe(original?.amount);
			expect(correction.type).not.toBe(original?.type);
		}
	});
});

describe('the cash book filtered by period', () => {
	it('shows only that month, carried forward from the balance the month before it ended on', async () => {
		for (const month of MONTHS) {
			const book = await cashBook(testDb.db, adminId, { month });
			const expectedLines = modelFor({ month });

			expect(book.entries.map((entry) => entry.occurredOn)).toEqual(
				expectedLines.map((line) => line.occurredOn)
			);
			expect(book.openingBalance).toBe(carriedInto(month));
			expect(book.entries.map((entry) => entry.balance)).toEqual(
				prefixTotals(expectedLines.map((line) => line.signed)).map(
					(total) => total + carriedInto(month)
				)
			);
		}
	});

	it('is a window onto the same running total, not a separate one', async () => {
		// The last line of February has the same balance whether it is read in the whole book or in
		// February alone. That is the property that makes a month's view honest: the carry-forward is
		// exactly the balance the book had reached when the month opened.
		const whole = await cashBook(testDb.db, adminId);
		const february = await cashBook(testDb.db, adminId, { month: '2026-02' });

		const lastOfFebruary = february.entries.at(-1);
		expect(lastOfFebruary).toBeDefined();
		expect(whole.entries.find((entry) => entry.id === lastOfFebruary?.id)?.balance).toBe(
			lastOfFebruary?.balance
		);
	});

	it('includes the first and the last day of the month, February included', async () => {
		const february = await cashBook(testDb.db, adminId, { month: '2026-02' });

		const days = february.entries.map((entry) => entry.occurredOn);
		expect(days).toContain('2026-02-01');
		expect(days).toContain('2026-02-28');
		expect(days.every((day) => day.startsWith('2026-02'))).toBe(true);
	});

	it('answers a month with nothing in it with an empty book that still carries its balance', async () => {
		const book = await cashBook(testDb.db, adminId, { month: '2026-09' });

		expect(book.entries).toEqual([]);
		expect(book.openingBalance).toBe(carriedInto('2026-09'));
		expect(book.closingBalance).toBe(book.openingBalance);
	});

	it('refuses a month that is not one', async () => {
		await expect(cashBook(testDb.db, adminId, { month: '2026-13' })).rejects.toThrow(TypeError);
	});
});

describe('the cash book filtered by category', () => {
	it('adds up that category alone, corrections included', async () => {
		for (const [categoryIndex, categoryId] of categoryIds.entries()) {
			const book = await cashBook(testDb.db, adminId, { categoryId });
			const expectedLines = modelFor({ categoryIndex });

			expect(book.entries.map((entry) => entry.categoryId)).toEqual(
				expectedLines.map(() => categoryId)
			);
			expect(book.entries.map((entry) => entry.balance)).toEqual(
				prefixTotals(expectedLines.map((line) => line.signed))
			);
		}
	});

	it('combines with a period, and carries only that category into it', async () => {
		const categoryIndex = 2;
		const month = '2026-03';
		const book = await cashBook(testDb.db, adminId, {
			month,
			categoryId: categoryIds[categoryIndex]
		});
		const expectedLines = modelFor({ month, categoryIndex });

		expect(book.openingBalance).toBe(carriedInto(month, categoryIndex));
		expect(book.entries.map((entry) => entry.balance)).toEqual(
			prefixTotals(expectedLines.map((line) => line.signed)).map(
				(total) => total + carriedInto(month, categoryIndex)
			)
		);
		expect(book.closingBalance).toBe(
			carriedInto(month, categoryIndex) +
				expectedLines.reduce((total, line) => total + line.signed, 0)
		);
	});
});

describe('the filter option lists', () => {
	it('offer every month and every category the book really contains, whatever the filter', async () => {
		const filtered = await cashBook(testDb.db, adminId, { month: '2026-01' });

		expect(filtered.months).toEqual([...MONTHS].reverse());
		expect(filtered.categories.map((category) => category.name)).toEqual(
			[...CATEGORY_PLAN]
				.map((category) => category.name)
				.sort((left, right) => left.localeCompare(right))
		);
	});
});

describe('reading the cash book', () => {
	it('refuses a superuser who is not also an admin, and a resident', async () => {
		const superuserId = await insertUserWithRole('Pengurus Baca Kas Tanpa Peran', ROLE.superuser);
		const residentId = await insertUser('Warga Baca Kas');

		for (const actorId of [superuserId, residentId]) {
			await expect(cashBook(testDb.db, actorId)).rejects.toThrow(PermissionDeniedError);
		}
	});
});
