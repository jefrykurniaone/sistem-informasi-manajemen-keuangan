import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { auditEntriesFor } from '$lib/server/audit';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	SYSTEM_CATEGORY_KEY
} from '$lib/server/db/schema/cash-category';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import * as categoryModule from '$lib/server/services/cash/category';
import {
	CASH_CATEGORY_CREATED_ACTION,
	CASH_CATEGORY_DEACTIVATED_ACTION,
	CASH_CATEGORY_REACTIVATED_ACTION,
	CASH_CATEGORY_UPDATED_ACTION,
	CashCategoryNameTakenError,
	CashCategoryNotFoundError,
	createCashCategory,
	deactivateCashCategory,
	duesCategory,
	findCashCategoryById,
	listActiveCashCategories,
	listCashCategories,
	reactivateCashCategory,
	SYSTEM_CATEGORY_ATTEMPT,
	SystemCashCategoryError,
	updateCashCategory
} from '$lib/server/services/cash/category';

/**
 * Managing the Kategori Kas: adding one, renaming it, retiring it, the three things a system
 * category refuses, and the two reads #34's recording form is built on — against a real
 * PostgreSQL, whose migration has already seeded "Iuran warga" and "Saldo awal".
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

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

/** A superuser, ready to act as `actorId` wherever a test needs one who is allowed. */
async function insertSuperuser(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.superuser);
}

/** Adds an ordinary category through the service, for a test that needs one to act on. */
async function addCategory(
	actorId: string,
	name: string,
	type: string = CASH_CATEGORY_TYPE.expense
) {
	return createCashCategory(testDb.db, new FakeClock(START), { actorId, name, type });
}

/** The system category "Saldo awal", read straight from the table the migration seeded. */
async function openingBalanceRow() {
	const [row] = await testDb.db
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, SYSTEM_CATEGORY_KEY.openingBalance));
	return row;
}

describe('the cash category module', () => {
	it('exports no way to delete a category, and never will', () => {
		// Deactivation is the only way a category leaves the recording form — user story 2 of
		// `docs/spec-kas-laporan-v1.md`. A future `deleteCashCategory` shows up here as a failing
		// assertion rather than as something a reviewer has to notice by eye, exactly as
		// `tests/unit/audit.test.ts` pins the audit log's surface.
		expect(Object.keys(categoryModule).sort()).toEqual([
			'CASH_CATEGORY_CREATED_ACTION',
			'CASH_CATEGORY_DEACTIVATED_ACTION',
			'CASH_CATEGORY_REACTIVATED_ACTION',
			'CASH_CATEGORY_UPDATED_ACTION',
			'CashCategoryNameTakenError',
			'CashCategoryNotFoundError',
			'SYSTEM_CATEGORY_ATTEMPT',
			'SystemCashCategoryError',
			'SystemCategoryMissingError',
			'createCashCategory',
			'deactivateCashCategory',
			'duesCategory',
			'findCashCategoryById',
			'listActiveCashCategories',
			'listCashCategories',
			'reactivateCashCategory',
			'updateCashCategory'
		]);
	});
});

describe('createCashCategory', () => {
	it('adds an ordinary, active category and records who added it', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Tambah');

		const created = await addCategory(superuserId, 'Perbaikan gerbang', CASH_CATEGORY_TYPE.expense);

		expect(created).toMatchObject({
			name: 'Perbaikan gerbang',
			type: CASH_CATEGORY_TYPE.expense,
			isActive: true,
			systemKey: null
		});
		expect(created.createdAt.getTime()).toBe(Date.parse(START));
		const entries = await auditEntriesFor(testDb.db, created.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: CASH_CATEGORY_CREATED_ACTION,
			targetId: created.id,
			after: { name: 'Perbaikan gerbang', type: CASH_CATEGORY_TYPE.expense }
		});
	});

	it('trims the name it is given', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Rapi');

		const created = await addCategory(superuserId, '  Sewa tenda  ');

		expect(created.name).toBe('Sewa tenda');
	});

	it('refuses a name another category already carries, whatever its type', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Kembar');
		await addCategory(superuserId, 'Donasi warga', CASH_CATEGORY_TYPE.income);

		await expect(
			addCategory(superuserId, 'Donasi warga', CASH_CATEGORY_TYPE.expense)
		).rejects.toThrow(CashCategoryNameTakenError);
	});

	it('refuses a name a system category already carries', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Bentrok Sistem');

		await expect(
			addCategory(superuserId, 'Iuran warga', CASH_CATEGORY_TYPE.income)
		).rejects.toThrow(CashCategoryNameTakenError);
	});

	it('refuses an empty name and an unknown type', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Kosong');

		await expect(addCategory(superuserId, '   ')).rejects.toThrow(TypeError);
		await expect(addCategory(superuserId, 'Sumbangan lebaran', 'transfer')).rejects.toThrow(
			TypeError
		);
	});

	it('refuses an admin who is not also a superuser, and changes nothing', async () => {
		const adminId = await insertUserWithRole('Pengurus Harian Tanpa Hak', ROLE.admin);

		await expect(addCategory(adminId, 'Kebersihan harian')).rejects.toThrow(PermissionDeniedError);

		const stored = await testDb.db
			.select()
			.from(cashCategories)
			.where(eq(cashCategories.name, 'Kebersihan harian'));
		expect(stored).toHaveLength(0);
	});
});

describe('listCashCategories', () => {
	it('returns every category, the inactive and the system ones included, for a superuser', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Daftar');
		const retired = await addCategory(superuserId, 'Kategori pensiun');
		await deactivateCashCategory(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			categoryId: retired.id
		});

		const listed = await listCashCategories(testDb.db, superuserId);

		const names = listed.map((category) => category.name);
		expect(names).toContain('Iuran warga');
		expect(names).toContain('Saldo awal');
		expect(names).toContain('Kategori pensiun');
	});

	it('refuses an admin who is not also a superuser', async () => {
		const adminId = await insertUserWithRole('Pengurus Harian Daftar', ROLE.admin);

		await expect(listCashCategories(testDb.db, adminId)).rejects.toThrow(PermissionDeniedError);
	});
});

describe('the reads a recording form is built on', () => {
	it('leaves a deactivated category out of the active list while read-by-id still returns it', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Sembunyi');
		const category = await addCategory(superuserId, 'Perbaikan pompa air');

		expect((await listActiveCashCategories(testDb.db)).map((row) => row.id)).toContain(category.id);

		await deactivateCashCategory(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			categoryId: category.id
		});

		expect((await listActiveCashCategories(testDb.db)).map((row) => row.id)).not.toContain(
			category.id
		);
		const stillThere = await findCashCategoryById(testDb.db, category.id);
		expect(stillThere).toMatchObject({ id: category.id, name: 'Perbaikan pompa air' });
		expect(stillThere?.isActive).toBe(false);
	});

	it('answers with nothing for an id no category carries', async () => {
		expect(await findCashCategoryById(testDb.db, randomUUID())).toBeUndefined();
	});
});

describe('duesCategory', () => {
	it('returns the seeded system category "Iuran warga", found by its key', async () => {
		// The contract #29's payment verification builds on: it asks for the category by this
		// function, never by the display name, which a superuser is free to change.
		const category = await duesCategory(testDb.db);

		expect(category).toMatchObject({
			name: 'Iuran warga',
			type: CASH_CATEGORY_TYPE.income,
			systemKey: SYSTEM_CATEGORY_KEY.dues,
			isActive: true
		});
	});
});

describe('updateCashCategory', () => {
	it('renames a category, changes its type, and records both sides of the change', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Ubah');
		const category = await addCategory(superuserId, 'Sewa aula', CASH_CATEGORY_TYPE.expense);
		const clock = new FakeClock(START);
		clock.advance(60_000);

		const updated = await updateCashCategory(testDb.db, clock, {
			actorId: superuserId,
			categoryId: category.id,
			name: 'Sewa aula serbaguna',
			type: CASH_CATEGORY_TYPE.income
		});

		expect(updated).toMatchObject({
			name: 'Sewa aula serbaguna',
			type: CASH_CATEGORY_TYPE.income
		});
		const entries = await auditEntriesFor(testDb.db, category.id);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: CASH_CATEGORY_UPDATED_ACTION,
			before: { name: 'Sewa aula', type: CASH_CATEGORY_TYPE.expense },
			after: { name: 'Sewa aula serbaguna', type: CASH_CATEGORY_TYPE.income }
		});
	});

	it('is a no-op, with no extra audit row, when nothing would change', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Sama');
		const category = await addCategory(superuserId, 'Listrik pos jaga');

		await updateCashCategory(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			categoryId: category.id,
			name: 'Listrik pos jaga',
			type: CASH_CATEGORY_TYPE.expense
		});

		expect(await auditEntriesFor(testDb.db, category.id)).toHaveLength(1);
	});

	it('refuses a rename onto a name another category already carries', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Tabrakan');
		await addCategory(superuserId, 'Air bersih');
		const other = await addCategory(superuserId, 'Air minum');

		await expect(
			updateCashCategory(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				categoryId: other.id,
				name: 'Air bersih',
				type: CASH_CATEGORY_TYPE.expense
			})
		).rejects.toThrow(CashCategoryNameTakenError);
	});

	it('refuses an id no category carries', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Hantu');

		await expect(
			updateCashCategory(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				categoryId: randomUUID(),
				name: 'Kategori tak ada',
				type: CASH_CATEGORY_TYPE.expense
			})
		).rejects.toThrow(CashCategoryNotFoundError);
	});
});

describe('deactivateCashCategory and reactivateCashCategory', () => {
	it('retires a category and records it, then is a no-op the second time', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Pensiun');
		const category = await addCategory(superuserId, 'Iuran keamanan tambahan');
		// Later than the creation above, so that `auditEntriesFor`'s newest-first order is decided by
		// the clock rather than by a tie between two rows stamped with the same instant.
		const clock = new FakeClock(START);
		clock.advance(60_000);

		const retired = await deactivateCashCategory(testDb.db, clock, {
			actorId: superuserId,
			categoryId: category.id
		});
		expect(retired.isActive).toBe(false);
		const entries = await auditEntriesFor(testDb.db, category.id);
		expect(entries[0]).toMatchObject({
			actorId: superuserId,
			action: CASH_CATEGORY_DEACTIVATED_ACTION,
			before: { isActive: true },
			after: { isActive: false }
		});

		await deactivateCashCategory(testDb.db, clock, {
			actorId: superuserId,
			categoryId: category.id
		});
		expect(await auditEntriesFor(testDb.db, category.id)).toHaveLength(2);
	});

	it('brings a retired category back, so a mis-click is not permanent', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Kembali');
		const category = await addCategory(superuserId, 'Perbaikan saluran');
		// Each step later than the one before it, so newest-first is decided by the clock — see the
		// note on the deactivation test above.
		const clock = new FakeClock(START);
		clock.advance(60_000);
		await deactivateCashCategory(testDb.db, clock, {
			actorId: superuserId,
			categoryId: category.id
		});
		clock.advance(60_000);

		const back = await reactivateCashCategory(testDb.db, clock, {
			actorId: superuserId,
			categoryId: category.id
		});

		expect(back.isActive).toBe(true);
		const entries = await auditEntriesFor(testDb.db, category.id);
		expect(entries[0]).toMatchObject({ action: CASH_CATEGORY_REACTIVATED_ACTION });
		expect((await listActiveCashCategories(testDb.db)).map((row) => row.id)).toContain(category.id);
	});

	it('refuses an admin who is not also a superuser', async () => {
		const superuserId = await insertSuperuser('Pengurus Kategori Terjaga');
		const adminId = await insertUserWithRole('Pengurus Harian Nonaktifkan', ROLE.admin);
		const category = await addCategory(superuserId, 'Konsumsi rapat');

		await expect(
			deactivateCashCategory(testDb.db, new FakeClock(START), {
				actorId: adminId,
				categoryId: category.id
			})
		).rejects.toThrow(PermissionDeniedError);

		expect((await findCashCategoryById(testDb.db, category.id))?.isActive).toBe(true);
	});
});

describe('a system category', () => {
	it('refuses to be renamed, and keeps its name', async () => {
		const superuserId = await insertSuperuser('Pengurus Sistem Ganti Nama');
		const category = await duesCategory(testDb.db);

		const refusal: unknown = await updateCashCategory(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			categoryId: category.id,
			name: 'Iuran bulanan',
			type: CASH_CATEGORY_TYPE.income
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(SystemCashCategoryError);
		expect(refusal).toMatchObject({
			categoryId: category.id,
			systemKey: SYSTEM_CATEGORY_KEY.dues,
			attempted: SYSTEM_CATEGORY_ATTEMPT.update
		});
		expect((await duesCategory(testDb.db)).name).toBe('Iuran warga');
	});

	it('refuses to change its type, and keeps it', async () => {
		const superuserId = await insertSuperuser('Pengurus Sistem Ganti Tipe');
		const category = await duesCategory(testDb.db);

		await expect(
			updateCashCategory(testDb.db, new FakeClock(START), {
				actorId: superuserId,
				categoryId: category.id,
				name: category.name,
				type: CASH_CATEGORY_TYPE.expense
			})
		).rejects.toThrow(SystemCashCategoryError);

		expect((await duesCategory(testDb.db)).type).toBe(CASH_CATEGORY_TYPE.income);
	});

	it('refuses to be deactivated, and stays active', async () => {
		const superuserId = await insertSuperuser('Pengurus Sistem Nonaktifkan');
		const openingBalance = await openingBalanceRow();

		const refusal: unknown = await deactivateCashCategory(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			categoryId: openingBalance.id
		}).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(SystemCashCategoryError);
		expect(refusal).toMatchObject({
			systemKey: SYSTEM_CATEGORY_KEY.openingBalance,
			attempted: SYSTEM_CATEGORY_ATTEMPT.deactivate
		});
		expect((await findCashCategoryById(testDb.db, openingBalance.id))?.isActive).toBe(true);
		expect(await auditEntriesFor(testDb.db, openingBalance.id)).toHaveLength(0);
	});

	it('is still offered to a recording form, because refusing a manual entry is not a read', async () => {
		// "Iuran warga" accepts no manual entry, which is a rule about the recording operation and
		// belongs to the ticket that builds it. Filtering it out here would hide that rule in a read.
		const active = await listActiveCashCategories(testDb.db);

		expect(active.map((row) => row.systemKey)).toContain(SYSTEM_CATEGORY_KEY.dues);
	});
});
