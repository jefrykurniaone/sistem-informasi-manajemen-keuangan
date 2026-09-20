import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { rupiah, type Rupiah } from '$lib/money';
import { auditEntriesFor } from '$lib/server/audit';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import {
	CASH_CATEGORY_TYPE,
	cashCategories,
	SYSTEM_CATEGORY_KEY
} from '$lib/server/db/schema/cash-category';
import { cashTransactions, type CashTransaction } from '$lib/server/db/schema/cash-transaction';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import * as balanceModule from '$lib/server/services/cash/balance';
import { cashBook } from '$lib/server/services/cash/balance';
import {
	CashCategoryNotFoundError,
	createCashCategory,
	deactivateCashCategory
} from '$lib/server/services/cash/category';
import * as correctionModule from '$lib/server/services/cash/correction';
import { recordCashCorrection } from '$lib/server/services/cash/correction';
import { lockPeriod, PeriodLockedError, unlockPeriod } from '$lib/server/services/cash/period';
import * as transactionModule from '$lib/server/services/cash/transaction';
import {
	CASH_RULE,
	CASH_TRANSACTION_RECORDED_ACTION,
	CashRuleError,
	MAXIMUM_RECEIPT_BYTES,
	recordCashTransaction,
	recordDuesIncome,
	recordDuesRefund,
	type RecordCashTransactionRequest
} from '$lib/server/services/cash/transaction';

/**
 * Recording a Transaksi Kas by hand, and the property the whole spec rests on: the buku kas is
 * append-only. Against a real PostgreSQL, because "nothing that was committed ever changes" is a
 * statement about committed rows.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** The day the transactions in most of these tests happened. */
const DAY = '2026-03-04';

/** The bytes a real JPEG starts with, followed by filler — enough for the signature check. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

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

/** An admin, who is who records a Transaksi Kas. */
async function insertAdmin(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.admin);
}

/** A superuser, who is who manages the categories those transactions are filed under. */
async function insertSuperuser(name: string): Promise<string> {
	return insertUserWithRole(name, ROLE.superuser);
}

/** An ordinary category to record against, added through the service that owns categories. */
async function addCategory(name: string, type: string = CASH_CATEGORY_TYPE.expense) {
	const superuserId = await insertSuperuser(`Pengurus Kategori ${name}`);
	return createCashCategory(testDb.db, new FakeClock(START), { actorId: superuserId, name, type });
}

/** The id of one seeded system category, read straight from the table the migration seeded. */
async function systemCategoryId(systemKey: string): Promise<string> {
	const [row] = await testDb.db
		.select()
		.from(cashCategories)
		.where(eq(cashCategories.systemKey, systemKey));
	return row.id;
}

/** Records a transaction with this file's defaults, overridden by whatever the test cares about. */
async function record(
	overrides: Partial<RecordCashTransactionRequest> & {
		readonly actorId: string;
		readonly categoryId: string;
	},
	fileStore: FakeFileStore = new FakeFileStore(new FakeClock(START))
): Promise<CashTransaction> {
	return recordCashTransaction(testDb.db, new FakeClock(START), fileStore, {
		occurredOn: DAY,
		amount: rupiah(150_000),
		description: 'Perbaikan gerbang depan',
		...overrides
	});
}

/** Every row of the cash book, in a stable order, for a before-and-after comparison. */
async function allTransactions(): Promise<readonly CashTransaction[]> {
	return testDb.db.select().from(cashTransactions).orderBy(asc(cashTransactions.id));
}

describe('the cash book service layer', () => {
	it('exports no way to change or remove a Transaksi Kas, and never will', () => {
		// The acceptance criterion asks for a test that states the *absence* of an update and of a
		// delete, so that adding one later fails the gate. Asserting the exported surface is what
		// makes that true of the module rather than of its source text: a `deleteCashTransaction`
		// fails here the moment it is exported, whatever it is called and however the file is laid
		// out — which grepping for the word "delete" would not manage. The same move
		// `tests/unit/audit.test.ts` and `tests/unit/cash-category.test.ts` already make.
		//
		// What this cannot catch is an update smuggled *inside* a function that already exists. The
		// append-only witness below is what catches that, and the two together are the guarantee.
		expect(Object.keys(transactionModule).sort()).toEqual([
			'CASH_RULE',
			'CASH_TRANSACTION_RECORDED_ACTION',
			'CashRuleError',
			'MAXIMUM_RECEIPT_BYTES',
			'RECEIPT_CONTENT_TYPES',
			'assertCashDescription',
			'assertMayRecordCashTransactions',
			'recordCashTransaction',
			'recordDuesIncome',
			'recordDuesRefund'
		]);
		expect(Object.keys(correctionModule).sort()).toEqual([
			'CASH_CORRECTION_RECORDED_ACTION',
			'CashTransactionAlreadyCorrectedError',
			'CashTransactionNotFoundError',
			'recordCashCorrection'
		]);
		expect(Object.keys(balanceModule).sort()).toEqual(['CASH_BOOK_MONTH_PATTERN', 'cashBook']);
	});

	it('leaves every row it has already written exactly as it was, whatever it is asked to do next', async () => {
		// The append-only witness. Everything the cash book can be asked to do is driven here — both
		// writers, a refusal from each, and a read — and every row that existed beforehand has to come
		// out of it byte for byte, field for field. An `update` added inside `recordCashCorrection`
		// (stamping the corrected row, say) passes the surface assertion above and fails this one.
		const adminId = await insertAdmin('Pengurus Buku Kas Hanya Tambah');
		const category = await addCategory('Kebersihan lingkungan');
		const first = await record({ actorId: adminId, categoryId: category.id });
		const second = await record({
			actorId: adminId,
			categoryId: category.id,
			amount: rupiah(75_000),
			description: 'Upah menyapu jalan'
		});

		const before = await allTransactions();
		expect(before.map((row) => row.id)).toEqual(expect.arrayContaining([first.id, second.id]));

		await recordCashCorrection(testDb.db, new FakeClock(START), {
			actorId: adminId,
			transactionId: first.id,
			reason: 'Nominalnya salah ketik.'
		});
		await expect(
			recordCashCorrection(testDb.db, new FakeClock(START), {
				actorId: adminId,
				transactionId: first.id,
				reason: 'Sekali lagi.'
			})
		).rejects.toThrow(correctionModule.CashTransactionAlreadyCorrectedError);
		await expect(
			record({ actorId: adminId, categoryId: category.id, amount: rupiah(0) })
		).rejects.toThrow(CashRuleError);
		// The third writer: #29's verification door into "Iuran warga", driven directly here so the
		// witness covers every insert this module owns.
		await testDb.db.transaction(async (transaction) =>
			recordDuesIncome(transaction, new FakeClock(START), {
				occurredOn: DAY,
				amount: rupiah(200_000),
				description: 'Iuran warga Blok W No 1 (pembayaran saksi hanya-tambah)',
				recordedBy: adminId
			})
		);
		await cashBook(testDb.db, adminId);

		const after = await allTransactions();
		for (const row of before) {
			expect(after.find((candidate) => candidate.id === row.id)).toEqual(row);
		}
		// Two rows more: the Koreksi and the dues income. Nothing was replaced, nothing disappeared.
		expect(after).toHaveLength(before.length + 2);
	});
});

describe('recordCashTransaction', () => {
	it('writes one line typed by its category, with a trimmed keterangan and an audit row', async () => {
		const adminId = await insertAdmin('Pengurus Catat Pengeluaran');
		const category = await addCategory('Perbaikan pagar', CASH_CATEGORY_TYPE.expense);

		const recorded = await record({
			actorId: adminId,
			categoryId: category.id,
			description: '  Ganti engsel pagar  '
		});

		expect(recorded).toMatchObject({
			occurredOn: DAY,
			// Never sent by the caller: the category's type is the row's direction.
			type: CASH_CATEGORY_TYPE.expense,
			categoryId: category.id,
			amount: 150_000,
			description: 'Ganti engsel pagar',
			attachmentKey: null,
			recordedBy: adminId,
			correctionOf: null
		});
		expect(recorded.createdAt.getTime()).toBe(Date.parse(START));

		const entries = await auditEntriesFor(testDb.db, recorded.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: adminId,
			action: CASH_TRANSACTION_RECORDED_ACTION,
			targetId: recorded.id,
			after: { occurredOn: DAY, type: CASH_CATEGORY_TYPE.expense, amount: 150_000 }
		});
	});

	it('writes an income line for an income category, which is how non-dues money is recorded', async () => {
		const adminId = await insertAdmin('Pengurus Catat Donasi');
		const category = await addCategory('Donasi kegiatan', CASH_CATEGORY_TYPE.income);

		const recorded = await record({
			actorId: adminId,
			categoryId: category.id,
			amount: rupiah(500_000),
			description: 'Donasi peringatan 17 Agustus'
		});

		expect(recorded.type).toBe(CASH_CATEGORY_TYPE.income);
		expect(recorded.amount).toBe(500_000);
	});

	it('refuses a manual entry into the system category "Iuran warga", and writes nothing', async () => {
		// User story 7, and the reason: kas masuk on this category comes from verifying a Pembayaran
		// and from nowhere else, so that saldo kas and status tagihan cannot contradict each other.
		// "Writes nothing" is asserted as an unchanged row set rather than an empty one, because the
		// append-only witness above legitimately puts a row into this category through
		// `recordDuesIncome` — the flow that IS allowed to — and this file shares one schema.
		const adminId = await insertAdmin('Pengurus Catat Iuran Manual');
		const categoryId = await systemCategoryId(SYSTEM_CATEGORY_KEY.dues);
		const before = await testDb.db
			.select()
			.from(cashTransactions)
			.where(eq(cashTransactions.categoryId, categoryId));

		const refusal: unknown = await record({ actorId: adminId, categoryId }).catch(
			(error: unknown) => error
		);

		expect(refusal).toBeInstanceOf(CashRuleError);
		expect(refusal).toMatchObject({ rule: CASH_RULE.categoryIsSystem });
		expect(
			await testDb.db
				.select()
				.from(cashTransactions)
				.where(eq(cashTransactions.categoryId, categoryId))
		).toEqual(before);
	});

	it('refuses the other system category too, which is what keeps the one opening balance single', async () => {
		// "Saldo awal" is not named by the acceptance criterion, and refusing it anyway is deliberate:
		// #33 holds "hanya boleh ada satu" with a row lock inside `recordOpeningBalance`, and a manual
		// entry into that category would walk straight past that lock.
		const adminId = await insertAdmin('Pengurus Catat Saldo Awal Manual');
		const categoryId = await systemCategoryId(SYSTEM_CATEGORY_KEY.openingBalance);

		await expect(record({ actorId: adminId, categoryId })).rejects.toThrow(CashRuleError);
		expect(
			await testDb.db
				.select()
				.from(cashTransactions)
				.where(eq(cashTransactions.categoryId, categoryId))
		).toHaveLength(0);
	});

	it('refuses a category that has been retired, while the old rows under it stay', async () => {
		const adminId = await insertAdmin('Pengurus Catat Kategori Pensiun');
		const superuserId = await insertSuperuser('Pengurus Pensiunkan Kategori');
		const category = await addCategory('Sewa tenda lama');
		const before = await record({ actorId: adminId, categoryId: category.id });

		await deactivateCashCategory(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			categoryId: category.id
		});

		const refusal: unknown = await record({ actorId: adminId, categoryId: category.id }).catch(
			(error: unknown) => error
		);
		expect(refusal).toBeInstanceOf(CashRuleError);
		expect(refusal).toMatchObject({ rule: CASH_RULE.categoryRetired });

		const stillThere = await testDb.db
			.select()
			.from(cashTransactions)
			.where(eq(cashTransactions.id, before.id));
		expect(stillThere).toHaveLength(1);
	});

	it('refuses an id no category carries', async () => {
		const adminId = await insertAdmin('Pengurus Catat Kategori Hantu');

		await expect(record({ actorId: adminId, categoryId: randomUUID() })).rejects.toThrow(
			CashCategoryNotFoundError
		);
	});

	it('refuses an amount that is not strictly positive', async () => {
		const adminId = await insertAdmin('Pengurus Catat Nominal Nol');
		const category = await addCategory('Konsumsi rapat bulanan');

		for (const amount of [rupiah(0), rupiah(-1)]) {
			const refusal: unknown = await record({
				actorId: adminId,
				categoryId: category.id,
				amount
			}).catch((error: unknown) => error);
			expect(refusal).toMatchObject({ rule: CASH_RULE.amountNotPositive });
		}
	});

	it('refuses a day that is not a real calendar day', async () => {
		const adminId = await insertAdmin('Pengurus Catat Tanggal Palsu');
		const category = await addCategory('Perbaikan lampu jalan');

		for (const occurredOn of ['4 Maret 2026', '2026-02-31']) {
			const refusal: unknown = await record({
				actorId: adminId,
				categoryId: category.id,
				occurredOn
			}).catch((error: unknown) => error);
			expect(refusal).toMatchObject({ rule: CASH_RULE.notACalendarDay });
		}
	});

	it('refuses a keterangan that says nothing', async () => {
		const adminId = await insertAdmin('Pengurus Catat Tanpa Keterangan');
		const category = await addCategory('Perbaikan saluran air');

		const refusal: unknown = await record({
			actorId: adminId,
			categoryId: category.id,
			description: '   '
		}).catch((error: unknown) => error);

		expect(refusal).toMatchObject({ rule: CASH_RULE.descriptionMissing });
	});

	it('refuses a day inside a locked Periode, and takes the same line once the month is reopened', async () => {
		// #35's rule seen from this side. The check sits inside the recording transaction, after the
		// category is known and before the insert, and it reads `occurredOn` — the day money moved —
		// rather than the clock. August is used here rather than this file's `DAY` so that locking a
		// month cannot reach the tests around it.
		const adminId = await insertAdmin('Pengurus Catat Periode Terkunci');
		const superuserId = await insertSuperuser('Pengurus Buka Kunci Catat');
		const category = await addCategory('Perbaikan talang air');
		await testDb.db.transaction((transaction) =>
			lockPeriod(transaction, new FakeClock(START), {
				actorId: adminId,
				year: 2026,
				month: 8,
				reason: 'Laporan Bulanan revisi 1 terbit.'
			})
		);

		await expect(
			record({ actorId: adminId, categoryId: category.id, occurredOn: '2026-08-13' })
		).rejects.toThrow(PeriodLockedError);
		expect(
			await testDb.db
				.select()
				.from(cashTransactions)
				.where(eq(cashTransactions.categoryId, category.id))
		).toHaveLength(0);

		await unlockPeriod(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			year: 2026,
			month: 8,
			reason: 'Nota bulan itu baru ditemukan dan harus masuk.'
		});
		const accepted = await record({
			actorId: adminId,
			categoryId: category.id,
			occurredOn: '2026-08-13'
		});

		expect(accepted.occurredOn).toBe('2026-08-13');
	});

	it('refuses a day inside a locked Periode by name, the way a correction of it does too', async () => {
		// #97: `requireOpenPeriodFor` throws `PeriodLockedError`, which is not a `CashRuleError` and is
		// caught by each route on its own — see this ticket's pull request for the decision not to fold
		// it into `CASH_RULE`. The service-layer contract this test proves is the same for both write
		// paths: `recordCashTransaction` reads the check against its own `occurredOn`, and
		// `recordCashCorrection` reads it against the *corrected row's* `occurredOn` — see
		// `src/lib/server/services/cash/correction.ts`. September, a month no other test in this file
		// locks, so the lock reaches nothing else.
		const adminId = await insertAdmin('Pengurus Catat Dan Koreksi Periode Terkunci');
		const superuserId = await insertSuperuser('Pengurus Buka Kunci Catat Dan Koreksi');
		const category = await addCategory('Perbaikan pagar belakang');

		// An ordinary row dated in September, recorded before the month is locked — the way a
		// transaction would already exist when a Laporan Bulanan later freezes its month.
		const original = await record({
			actorId: adminId,
			categoryId: category.id,
			occurredOn: '2026-09-05'
		});

		await testDb.db.transaction((transaction) =>
			lockPeriod(transaction, new FakeClock(START), {
				actorId: adminId,
				year: 2026,
				month: 9,
				reason: 'Laporan Bulanan September terbit.'
			})
		);

		await expect(
			record({ actorId: adminId, categoryId: category.id, occurredOn: '2026-09-11' })
		).rejects.toThrow(PeriodLockedError);
		await expect(
			recordCashCorrection(testDb.db, new FakeClock(START), {
				actorId: adminId,
				transactionId: original.id,
				reason: 'Nominalnya keliru.'
			})
		).rejects.toThrow(PeriodLockedError);
		expect(
			await testDb.db
				.select()
				.from(cashTransactions)
				.where(eq(cashTransactions.categoryId, category.id))
		).toHaveLength(1);

		await unlockPeriod(testDb.db, new FakeClock(START), {
			actorId: superuserId,
			year: 2026,
			month: 9,
			reason: 'Nota bulan itu baru ditemukan dan harus masuk.'
		});

		const accepted = await record({
			actorId: adminId,
			categoryId: category.id,
			occurredOn: '2026-09-11'
		});
		expect(accepted.occurredOn).toBe('2026-09-11');

		const corrected = await recordCashCorrection(testDb.db, new FakeClock(START), {
			actorId: adminId,
			transactionId: original.id,
			reason: 'Nominalnya keliru.'
		});
		expect(corrected.correctionOf).toBe(original.id);
	});

	it('refuses a superuser who is not also an admin, and a resident, and writes nothing', async () => {
		// `mencatat Transaksi Kas` is Admin's in `CONTEXT.md` and is not on Superuser's list, and
		// `docs/spec-fondasi-v1.md` makes the three roles a set rather than a ladder.
		const category = await addCategory('Gaji satpam malam');
		const superuserId = await insertSuperuser('Pengurus Tanpa Peran Harian');
		const residentId = await insertUser('Warga Biasa Kas');

		for (const actorId of [superuserId, residentId]) {
			await expect(record({ actorId, categoryId: category.id })).rejects.toThrow(
				PermissionDeniedError
			);
		}

		expect(
			await testDb.db
				.select()
				.from(cashTransactions)
				.where(eq(cashTransactions.categoryId, category.id))
		).toHaveLength(0);
	});
});

describe('the receipt on a Transaksi Kas', () => {
	it('is stored under a key built from the row’s own id, and the row records that key', async () => {
		const adminId = await insertAdmin('Pengurus Catat Dengan Nota');
		const category = await addCategory('Perbaikan pompa');
		const fileStore = new FakeFileStore(new FakeClock(START));

		const recorded = await record(
			{
				actorId: adminId,
				categoryId: category.id,
				receipt: { contentType: 'image/jpeg', content: JPEG }
			},
			fileStore
		);

		const expectedKey = `cash-transactions/${recorded.id}/receipt.jpg`;
		expect(recorded.attachmentKey).toBe(expectedKey);
		expect(fileStore.keys).toEqual([expectedKey]);
		// The key is minted before the row exists, which is what lets `attachmentKey` be written on
		// the insert instead of by an update afterwards — see the module's doc comment.
		expect(await fileStore.read(expectedKey)).toEqual(JPEG);
	});

	it('is opened through a short-lived signed link, never through a path of its own', async () => {
		const adminId = await insertAdmin('Pengurus Catat Nota Tertaut');
		const category = await addCategory('Perbaikan atap pos');
		const clock = new FakeClock(START);
		const fileStore = new FakeFileStore(clock);

		const recorded = await record(
			{
				actorId: adminId,
				categoryId: category.id,
				receipt: { contentType: 'image/jpeg', content: JPEG }
			},
			fileStore
		);

		const link = await fileStore.signedLink(recorded.attachmentKey ?? '');
		expect(link.startsWith(`/files/${recorded.attachmentKey}?`)).toBe(true);
		expect(fileStore.verifySignedLink(link)).toMatchObject({
			valid: true,
			key: recorded.attachmentKey
		});

		// Ten minutes on, the same link is refused. That expiry, and the admin-only page the link is
		// rendered on, are together what "hanya bisa dibuka ... oleh peran admin atau superuser" means.
		clock.advance(10 * 60 * 1000 + 1000);
		expect(fileStore.verifySignedLink(link)).toMatchObject({ valid: false, reason: 'expired' });
	});

	it('refuses a file past the size limit, and stores neither the file nor the row', async () => {
		const adminId = await insertAdmin('Pengurus Catat Nota Besar');
		const category = await addCategory('Perbaikan gapura');
		const fileStore = new FakeFileStore(new FakeClock(START));
		const tooBig = new Uint8Array(MAXIMUM_RECEIPT_BYTES + 1);
		tooBig.set(JPEG);

		const refusal: unknown = await record(
			{
				actorId: adminId,
				categoryId: category.id,
				receipt: { contentType: 'image/jpeg', content: tooBig }
			},
			fileStore
		).catch((error: unknown) => error);

		expect(refusal).toMatchObject({ rule: CASH_RULE.receiptTooLarge });
		expect(fileStore.keys).toEqual([]);
		expect(
			await testDb.db
				.select()
				.from(cashTransactions)
				.where(eq(cashTransactions.categoryId, category.id))
		).toHaveLength(0);
	});

	it('refuses bytes that are not really the image they claim to be', async () => {
		const adminId = await insertAdmin('Pengurus Catat Nota Palsu');
		const category = await addCategory('Perbaikan paving');
		const fileStore = new FakeFileStore(new FakeClock(START));
		const notAnImage = new TextEncoder().encode('<script>alert(1)</script>');

		for (const receipt of [
			{ contentType: 'image/jpeg', content: notAnImage },
			{ contentType: 'text/html', content: notAnImage }
		]) {
			const refusal: unknown = await record(
				{ actorId: adminId, categoryId: category.id, receipt },
				fileStore
			).catch((error: unknown) => error);
			expect(refusal).toMatchObject({ rule: CASH_RULE.receiptNotAnImage });
		}

		expect(fileStore.keys).toEqual([]);
	});

	it.each(['constructor', '__proto__', 'toString'])(
		'refuses the content type "%s", which names a property of Object.prototype and not a format',
		async (contentType) => {
			// `File.type` is whatever the client sent, so the content type is as much the sender's to
			// choose as the bytes are. Looked up in an *object literal* each of these answers with
			// something truthy inherited from `Object.prototype` — `constructor` with `Object`,
			// `__proto__` with `Object.prototype` — which defeats both the `if (!extension)` guard and
			// the `?? []` fallback, and ends as `TypeError: signature.every is not a function`: a 500
			// where the contract here says a named refusal. `RECEIPT_EXTENSIONS` and `RECEIPT_SIGNATURES`
			// are `Map`s so that `get` answers `undefined` and the guards fire. This test is what keeps
			// them from being written back as literals.
			const adminId = await insertAdmin(`Pengurus Catat Nota ${contentType}`);
			const category = await addCategory(`Perbaikan selasar ${contentType}`);
			const fileStore = new FakeFileStore(new FakeClock(START));

			const refusal: unknown = await record(
				{
					actorId: adminId,
					categoryId: category.id,
					// Real JPEG bytes, so the only thing wrong with this upload is the name of its format.
					receipt: { contentType, content: JPEG }
				},
				fileStore
			).catch((error: unknown) => error);

			expect(refusal).toBeInstanceOf(CashRuleError);
			expect(refusal).toMatchObject({ rule: CASH_RULE.receiptNotAnImage });
			expect(fileStore.keys).toEqual([]);
			expect(
				await testDb.db
					.select()
					.from(cashTransactions)
					.where(eq(cashTransactions.categoryId, category.id))
			).toHaveLength(0);
		}
	);
});

describe('the amount a cash book line carries', () => {
	it('is a Rupiah, and stays one through the round trip to PostgreSQL and back', async () => {
		const adminId = await insertAdmin('Pengurus Catat Nominal Besar');
		const category = await addCategory('Pembangunan pos ronda');
		const amount: Rupiah = rupiah(2_147_483_648);

		const recorded = await record({ actorId: adminId, categoryId: category.id, amount });

		// Past the `int4` ceiling on purpose: `amount` is `bigint`, and a value that lost its top bits
		// on the way through the driver would come back as something else entirely.
		expect(recorded.amount).toBe(2_147_483_648);
	});
});

describe('recordDuesIncome — the one door into the system category "Iuran warga"', () => {
	/** Runs `recordDuesIncome` inside a transaction of its own, the way verification holds one. */
	async function recordDues(
		overrides: Partial<Parameters<typeof recordDuesIncome>[2]> & { readonly recordedBy: string }
	) {
		return testDb.db.transaction(async (transaction) =>
			recordDuesIncome(transaction, new FakeClock(START), {
				occurredOn: DAY,
				amount: rupiah(150_000),
				description: 'Iuran warga Blok D No 1 (pembayaran uji)',
				...overrides
			})
		);
	}

	it('writes one income row into the dues category, dated on the day the money was received', async () => {
		const adminId = await insertAdmin('Pengurus Verifikasi Menulis Kas');
		const categoryId = await systemCategoryId(SYSTEM_CATEGORY_KEY.dues);

		const row = await recordDues({ recordedBy: adminId });

		expect(row).toMatchObject({
			occurredOn: DAY,
			type: CASH_CATEGORY_TYPE.income,
			categoryId,
			amount: 150_000,
			description: 'Iuran warga Blok D No 1 (pembayaran uji)',
			attachmentKey: null,
			recordedBy: adminId,
			correctionOf: null
		});

		// No audit row of its own: the verification that calls this writes the single audit row the
		// acceptance criteria asks for, filed against the Pembayaran — see the function's doc comment.
		expect(await auditEntriesFor(testDb.db, row.id)).toHaveLength(0);
	});

	it('refuses a day inside a locked Periode by name, and writes nothing', async () => {
		const adminId = await insertAdmin('Pengurus Verifikasi Bulan Terkunci');
		const lockedDay = '2026-07-14';
		await testDb.db.transaction(async (transaction) => {
			await lockPeriod(transaction, new FakeClock(START), {
				actorId: adminId,
				year: 2026,
				month: 7,
				reason: 'Laporan bulanannya sudah terbit.'
			});
		});
		const before = await allTransactions();

		await expect(recordDues({ recordedBy: adminId, occurredOn: lockedDay })).rejects.toThrow(
			PeriodLockedError
		);

		expect(await allTransactions()).toEqual(before);
	});

	it.each([
		{ name: 'a zero amount', overrides: { amount: rupiah(0) }, rule: CASH_RULE.amountNotPositive },
		{
			name: 'a day that is not on the calendar',
			overrides: { occurredOn: '2026-02-31' },
			rule: CASH_RULE.notACalendarDay
		},
		{
			name: 'an empty keterangan',
			overrides: { description: '   ' },
			rule: CASH_RULE.descriptionMissing
		}
	])('refuses $name with the same named rule the manual path uses', async ({ overrides, rule }) => {
		const adminId = await insertAdmin(`Pengurus Verifikasi Tolak ${rule}`);
		const before = await allTransactions();

		const refusal: unknown = await recordDues({ recordedBy: adminId, ...overrides }).catch(
			(error: unknown) => error
		);

		expect(refusal).toBeInstanceOf(CashRuleError);
		expect(refusal).toMatchObject({ rule });
		expect(await allTransactions()).toEqual(before);
	});
});

describe('recordDuesRefund — the one expense door into the system category "Iuran warga"', () => {
	/** Runs `recordDuesRefund` inside a transaction of its own, the way #30's refund holds one. */
	async function recordRefund(
		overrides: Partial<Parameters<typeof recordDuesRefund>[2]> & { readonly recordedBy: string }
	) {
		return testDb.db.transaction(async (transaction) =>
			recordDuesRefund(transaction, new FakeClock(START), {
				occurredOn: DAY,
				amount: rupiah(125_000),
				description: 'Pengembalian saldo titipan Blok D No 1 (pembayaran uji)',
				...overrides
			})
		);
	}

	it('writes one expense row into the dues category, opposing the category’s own income type', async () => {
		// The mirror of `recordDuesIncome`: the row is money leaving, in the category whose figures
		// it must net against — writing `category.type` would record a payout as income. Never a
		// Koreksi: `correctionOf` stays null, because this row reverses nothing.
		const superuserId = await insertSuperuser('Pengurus Pengembalian Menulis Kas');
		const categoryId = await systemCategoryId(SYSTEM_CATEGORY_KEY.dues);

		const row = await recordRefund({ recordedBy: superuserId });

		expect(row).toMatchObject({
			occurredOn: DAY,
			type: CASH_CATEGORY_TYPE.expense,
			categoryId,
			amount: 125_000,
			description: 'Pengembalian saldo titipan Blok D No 1 (pembayaran uji)',
			attachmentKey: null,
			recordedBy: superuserId,
			correctionOf: null
		});

		// No audit row of its own: the refund that calls this writes the single audit row, filed
		// against the Unit — see the function's doc comment.
		expect(await auditEntriesFor(testDb.db, row.id)).toHaveLength(0);
	});

	it('leaves every row that already existed exactly as it was', async () => {
		// This writer's own append-only witness, beside the module-wide one above: driving the
		// refund door adds one row and rewrites none.
		const superuserId = await insertSuperuser('Pengurus Pengembalian Hanya Tambah');
		const before = await allTransactions();

		await recordRefund({ recordedBy: superuserId });

		const after = await allTransactions();
		for (const row of before) {
			expect(after.find((candidate) => candidate.id === row.id)).toEqual(row);
		}
		expect(after).toHaveLength(before.length + 1);
	});

	it('refuses a day inside a locked Periode by name, and writes nothing', async () => {
		// June, a month no other test in this file locks, so the lock reaches nothing else.
		const superuserId = await insertSuperuser('Pengurus Pengembalian Bulan Terkunci');
		await testDb.db.transaction(async (transaction) => {
			await lockPeriod(transaction, new FakeClock(START), {
				actorId: superuserId,
				year: 2026,
				month: 6,
				reason: 'Laporan bulan itu sudah terbit.'
			});
		});
		const before = await allTransactions();

		await expect(
			recordRefund({ recordedBy: superuserId, occurredOn: '2026-06-20' })
		).rejects.toThrow(PeriodLockedError);

		expect(await allTransactions()).toEqual(before);
	});

	it.each([
		{ name: 'a zero amount', overrides: { amount: rupiah(0) }, rule: CASH_RULE.amountNotPositive },
		{
			name: 'a day that is not on the calendar',
			overrides: { occurredOn: '2026-02-31' },
			rule: CASH_RULE.notACalendarDay
		},
		{
			name: 'an empty keterangan',
			overrides: { description: '   ' },
			rule: CASH_RULE.descriptionMissing
		}
	])('refuses $name with the same named rule the other doors use', async ({ overrides, rule }) => {
		const superuserId = await insertSuperuser(`Pengurus Pengembalian Tolak ${rule}`);
		const before = await allTransactions();

		const refusal: unknown = await recordRefund({ recordedBy: superuserId, ...overrides }).catch(
			(error: unknown) => error
		);

		expect(refusal).toBeInstanceOf(CashRuleError);
		expect(refusal).toMatchObject({ rule });
		expect(await allTransactions()).toEqual(before);
	});
});
