import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { rupiah, type Rupiah } from '#lib/money.ts';
import { allocations } from '#lib/server/db/schema/allocation.ts';
import { user } from '#lib/server/db/schema/auth.ts';
import { ROLE, userRoles } from '#lib/server/db/schema/authz.ts';
import { invoices } from '#lib/server/db/schema/invoice.ts';
import { OCCUPANCY_ROLE, occupancies } from '#lib/server/db/schema/occupancy.ts';
import { PAYMENT_METHOD, PAYMENT_STATUS, payments } from '#lib/server/db/schema/payment.ts';
import { residents } from '#lib/server/db/schema/resident.ts';
import { units } from '#lib/server/db/schema/unit.ts';
import { testDatabase } from '#lib/server/db/test-helpers.ts';
import { FakeClock } from '#lib/server/ports/fakes.ts';
import { adminDashboard } from '#lib/server/services/dashboard/index.ts';
import {
	INVOICE_STATUS,
	allocatedAmountsOf,
	invoiceStandings,
	type InvoiceStandingInput
} from '#lib/server/services/dues/invoice-standing.ts';
import { invoicesForUser, type ResidentInvoiceRow } from '#lib/server/services/dues/queries.ts';
import { residentViewFor } from '#lib/server/services/occupancy/resident-view.ts';
import { composeReportFigures } from '#lib/server/services/report/composition.ts';

/**
 * Where a Tagihan stands, tested at the seam every reader now goes through: the allocated amount,
 * the remaining amount and the status `invoiceStandings` answers, against real rows. These replace
 * the pure `invoiceStatus` table `tests/unit/invoice-queries.test.ts` used to carry and the
 * re-implementation of it `tests/unit/dashboard.test.ts` used to compare against.
 *
 * The last block is #306's cross-check: on one set of Tagihan, the pengurus Beranda, the Laporan
 * Bulanan and "Tagihan saya" give the same answer, on both sides of a WIB due date.
 *
 * Every test writes its own houses. The scenario tests use Periode `2026-03`; the cross-check alone
 * uses `2026-09`, because the Beranda and the report count a whole Periode of the schema.
 */

const testDb = testDatabase();

/** The instant rows in this file are created at. */
const START = '2026-01-01T00:00:00.000Z';

/** The amount of every Tagihan in this file. */
const AMOUNT = rupiah(150_000);

/** The Periode of the scenario tests. Its Tagihan fall due on 5 March 2026. */
const PERIOD = '2026-03';

/** 10.00 WIB on 1 March 2026: inside the Periode, before the due date. */
const BEFORE_DUE = '2026-03-01T03:00:00.000Z';

/** 23.59.59 WIB on 5 March 2026, the due date itself. Still 5 March in UTC as well. */
const LAST_SECOND_OF_DUE_DATE = '2026-03-05T16:59:59.000Z';

/** 00.00 WIB on 6 March 2026, the first instant past the due date. Still 5 March in UTC. */
const FIRST_SECOND_PAST_DUE = '2026-03-05T17:00:00.000Z';

/** Makes every block this file writes different from every other one. */
let sequence = 0;

/** An account with the `residents` row a Masa Huni and a Pembayaran point at. */
async function insertPerson(name: string): Promise<{ userId: string; residentId: string }> {
	const userId = randomUUID();
	await testDb.db.insert(user).values({
		id: userId,
		name,
		email: `${userId}@komplek.local`,
		emailVerified: true,
		createdAt: new Date(START),
		updatedAt: new Date(START)
	});
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning();
	return { userId, residentId: row.id };
}

/** A house. */
async function insertUnit(): Promise<string> {
	sequence += 1;
	const [row] = await testDb.db
		.insert(units)
		.values({ block: `POS-${sequence}`, number: '1', createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One Masa Huni, written directly. */
async function insertOccupancy(
	unitId: string,
	residentId: string,
	startedOn: string,
	endedOn: string | null
): Promise<void> {
	await testDb.db.insert(occupancies).values({
		unitId,
		residentId,
		role: OCCUPANCY_ROLE.owner,
		startedOn,
		endedOn,
		createdAt: new Date(START)
	});
}

/** One Tagihan, written directly, in the shape `invoiceStandings` takes. */
async function insertInvoice(
	unitId: string,
	period: string = PERIOD,
	voidedBy: string | null = null
): Promise<InvoiceStandingInput> {
	const voidedAt = voidedBy === null ? null : new Date(START);
	const [row] = await testDb.db
		.insert(invoices)
		.values({
			unitId,
			period,
			amount: AMOUNT,
			dueDate: `${period}-05`,
			issuedAt: new Date(`${period}-01T00:00:00.000Z`),
			voidedAt,
			voidReason: voidedBy === null ? null : 'Salah terbit',
			voidedBy
		})
		.returning();
	return {
		invoiceId: row.id,
		unitId: row.unitId,
		period: row.period,
		amount: row.amount,
		dueDate: row.dueDate,
		voidedAt: row.voidedAt
	};
}

/** A verified Pembayaran of `amount` and one Alokasi of all of it to `invoiceId`. */
async function payInto(
	unitId: string,
	residentId: string,
	invoiceId: string,
	amount: Rupiah
): Promise<void> {
	const [payment] = await testDb.db
		.insert(payments)
		.values({
			unitId,
			recordedBy: residentId,
			amount,
			receivedOn: '2026-03-02',
			method: PAYMENT_METHOD.transfer,
			status: PAYMENT_STATUS.verified,
			verifiedBy: residentId,
			verifiedAt: new Date('2026-03-02T03:00:00.000Z'),
			createdAt: new Date('2026-03-02T03:00:00.000Z')
		})
		.returning();
	await testDb.db.insert(allocations).values({
		paymentId: payment.id,
		invoiceId,
		amount,
		createdAt: new Date('2026-03-02T03:00:00.000Z')
	});
}

/** A house with one Tagihan for `PERIOD` and a payer, nothing allocated yet. */
async function houseWithInvoice(name: string) {
	const unitId = await insertUnit();
	const payer = await insertPerson(name);
	const invoice = await insertInvoice(unitId);
	return { unitId, payer, invoice };
}

/** The one standing `invoiceStandings` answers for `invoice` at `instant`. */
async function standingAt(invoice: InvoiceStandingInput, instant: string) {
	const [standing] = await invoiceStandings(testDb.db, new FakeClock(instant), [invoice]);
	return standing;
}

describe('invoiceStandings', () => {
	it('answers belum bayar, with the whole amount left, for a Tagihan nothing is allocated to', async () => {
		const { invoice } = await houseWithInvoice('Warga Belum Bayar');

		expect(await standingAt(invoice, BEFORE_DUE)).toEqual({
			...invoice,
			allocatedAmount: 0,
			remainingAmount: AMOUNT,
			status: INVOICE_STATUS.unpaid
		});
	});

	it('answers sebagian, summing every Alokasi from every Pembayaran, with what is left', async () => {
		const { unitId, payer, invoice } = await houseWithInvoice('Warga Bayar Dua Kali');
		await payInto(unitId, payer.residentId, invoice.invoiceId, rupiah(60_000));
		await payInto(unitId, payer.residentId, invoice.invoiceId, rupiah(40_000));

		expect(await standingAt(invoice, BEFORE_DUE)).toMatchObject({
			allocatedAmount: 100_000,
			remainingAmount: 50_000,
			status: INVOICE_STATUS.partial
		});
	});

	it('answers lunas once the Alokasi reach the amount, and stays lunas past the due date', async () => {
		const { unitId, payer, invoice } = await houseWithInvoice('Warga Lunas');
		await payInto(unitId, payer.residentId, invoice.invoiceId, AMOUNT);

		for (const instant of [BEFORE_DUE, FIRST_SECOND_PAST_DUE]) {
			expect(await standingAt(invoice, instant)).toMatchObject({
				allocatedAmount: AMOUNT,
				remainingAmount: 0,
				status: INVOICE_STATUS.paid
			});
		}
	});

	it('turns belum bayar and sebagian into menunggak at WIB midnight after the due date, not at UTC midnight', async () => {
		// Both instants below fall on 5 March in UTC. Only the WIB calendar puts the second one on the
		// 6th, past the due date: a UTC reading would keep both Tagihan on time for seven more hours.
		const unpaid = await houseWithInvoice('Warga Batas Jatuh Tempo');
		const partly = await houseWithInvoice('Warga Batas Jatuh Tempo Sebagian');
		await payInto(partly.unitId, partly.payer.residentId, partly.invoice.invoiceId, rupiah(50_000));
		const both = [unpaid.invoice, partly.invoice];

		const onTheDueDate = await invoiceStandings(
			testDb.db,
			new FakeClock(LAST_SECOND_OF_DUE_DATE),
			both
		);
		const pastIt = await invoiceStandings(testDb.db, new FakeClock(FIRST_SECOND_PAST_DUE), both);

		expect(onTheDueDate.map((standing) => standing.status)).toEqual([
			INVOICE_STATUS.unpaid,
			INVOICE_STATUS.partial
		]);
		expect(pastIt.map((standing) => standing.status)).toEqual([
			INVOICE_STATUS.overdue,
			INVOICE_STATUS.overdue
		]);
		// Menunggak changes the status, never what is owed.
		expect(pastIt.map((standing) => standing.remainingAmount)).toEqual([AMOUNT, 100_000]);
	});

	it('answers void for a cancelled Tagihan, whatever its due date says', async () => {
		const unitId = await insertUnit();
		const pengurus = await insertPerson('Pengurus Pembatal');
		const voided = await insertInvoice(unitId, PERIOD, pengurus.residentId);

		expect(await standingAt(voided, FIRST_SECOND_PAST_DUE)).toMatchObject({
			allocatedAmount: 0,
			remainingAmount: AMOUNT,
			status: INVOICE_STATUS.void
		});
	});

	it('keeps the order it was given and every field the caller selected', async () => {
		const first = await houseWithInvoice('Warga Urutan Pertama');
		const second = await houseWithInvoice('Warga Urutan Kedua');
		const selected = [
			{ ...second.invoice, block: 'kedua' },
			{ ...first.invoice, block: 'pertama' }
		];

		const standings = await invoiceStandings(testDb.db, new FakeClock(BEFORE_DUE), selected);

		expect(standings.map((standing) => [standing.invoiceId, standing.block])).toEqual([
			[second.invoice.invoiceId, 'kedua'],
			[first.invoice.invoiceId, 'pertama']
		]);
	});

	it('answers nothing for no Tagihan', async () => {
		expect(await invoiceStandings(testDb.db, new FakeClock(BEFORE_DUE), [])).toEqual([]);
	});

	it('narrows to the Tagihan one person may see when given their ResidentView', async () => {
		// The previous occupant left February unpaid; the person moved in on 1 March. Narrowed to them,
		// only March comes back. Unnarrowed, as an admin screen reads it, both do.
		const unitId = await insertUnit();
		const previous = await insertPerson('Penghuni Sebelumnya');
		const current = await insertPerson('Penghuni Sekarang');
		await insertOccupancy(unitId, previous.residentId, '2026-01-01', '2026-02-28');
		await insertOccupancy(unitId, current.residentId, '2026-03-01', null);
		const february = await insertInvoice(unitId, '2026-02');
		const march = await insertInvoice(unitId, '2026-03');
		const clock = new FakeClock(FIRST_SECOND_PAST_DUE);

		const narrowed = await invoiceStandings(testDb.db, clock, [february, march], {
			visibleTo: await residentViewFor(testDb.db, clock, current.userId)
		});
		const whole = await invoiceStandings(testDb.db, clock, [february, march]);

		expect(narrowed.map((standing) => standing.invoiceId)).toEqual([march.invoiceId]);
		expect(whole.map((standing) => standing.invoiceId)).toEqual([
			february.invoiceId,
			march.invoiceId
		]);
	});
});

describe('allocatedAmountsOf, the second door', () => {
	it('answers the allocated and remaining amounts only, with no status, in the order given', async () => {
		const paid = await houseWithInvoice('Warga Pintu Kedua Lunas');
		const untouched = await houseWithInvoice('Warga Pintu Kedua Kosong');
		await payInto(paid.unitId, paid.payer.residentId, paid.invoice.invoiceId, rupiah(150_000));

		const amounts = await allocatedAmountsOf(testDb.db, [
			{ invoiceId: untouched.invoice.invoiceId, amount: AMOUNT },
			{ invoiceId: paid.invoice.invoiceId, amount: AMOUNT }
		]);

		expect(amounts).toEqual([
			{
				invoiceId: untouched.invoice.invoiceId,
				amount: AMOUNT,
				allocatedAmount: 0,
				remainingAmount: AMOUNT
			},
			{
				invoiceId: paid.invoice.invoiceId,
				amount: AMOUNT,
				allocatedAmount: AMOUNT,
				remainingAmount: 0
			}
		]);
	});
});

/** The repository root, and the server tree the scan below reads. */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER_ROOT = join(ROOT, 'src', 'lib', 'server');

/** Every `.ts` file under `directory`, as absolute paths. */
function sourceFilesUnder(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			found.push(...sourceFilesUnder(path));
		} else if (entry.name.endsWith('.ts')) {
			found.push(path);
		}
	}
	return found;
}

describe('the one per-Tagihan sum of Alokasi', () => {
	it('is grouped by Tagihan only in the module of where a Tagihan stands', () => {
		// Parsed rather than searched as text, so a comment that names the query is never a match.
		const found: string[] = [];
		for (const file of sourceFilesUnder(SERVER_ROOT)) {
			const source = ts.createSourceFile(
				file,
				readFileSync(file, 'utf8'),
				ts.ScriptTarget.Latest,
				true
			);
			const visit = (node: ts.Node): void => {
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					node.expression.name.text === 'groupBy' &&
					node.arguments.some((argument) => argument.getText(source) === 'allocations.invoiceId')
				) {
					found.push(relative(ROOT, file));
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}

		expect(found).toEqual(['src/lib/server/services/dues/invoice-standing.ts']);
	});
});

describe('the Beranda, the Laporan Bulanan and "Tagihan saya" on one set of Tagihan', () => {
	it('agree on lunas, belum lunas, menunggak and the money, on both sides of a WIB due date', async () => {
		// #306's cross-check. Four houses billed for `2026-09`: one paid, one partly paid, one not paid
		// at all, and one whose Tagihan was cancelled. Each house has its own Warga.
		const month = '2026-09';
		const pengurus = await insertPerson('Pengurus Tes Silang');
		await testDb.db
			.insert(userRoles)
			.values({ userId: pengurus.userId, role: ROLE.admin, createdAt: new Date(START) });

		const wargas: { userId: string }[] = [];
		const billHouse = async (name: string, paidAmount: number, voided = false) => {
			const unitId = await insertUnit();
			const warga = await insertPerson(name);
			await insertOccupancy(unitId, warga.residentId, '2026-01-01', null);
			const invoice = await insertInvoice(unitId, month, voided ? pengurus.residentId : null);
			if (paidAmount > 0) {
				await payInto(unitId, warga.residentId, invoice.invoiceId, rupiah(paidAmount));
			}
			wargas.push(warga);
		};
		await billHouse('Warga Silang Lunas', 150_000);
		await billHouse('Warga Silang Sebagian', 40_000);
		await billHouse('Warga Silang Belum Bayar', 0);
		await billHouse('Warga Silang Dibatalkan', 0, true);

		const cases = [
			// 23.59.59 WIB on the due date: nothing is menunggak yet.
			{ instant: '2026-09-05T16:59:59.000Z', paid: 1, unpaid: 2, overdue: 0 },
			// 00.00 WIB the day after: both unpaid houses are menunggak.
			{ instant: '2026-09-05T17:00:00.000Z', paid: 1, unpaid: 2, overdue: 2 }
		];
		for (const expected of cases) {
			const clock = new FakeClock(expected.instant);
			const beranda = (await adminDashboard(testDb.db, clock, pengurus.userId)).invoices;
			const report = await composeReportFigures(testDb.db, clock, month);
			const own: ResidentInvoiceRow[] = [];
			for (const warga of wargas) {
				const view = await invoicesForUser(testDb.db, clock, warga.userId);
				own.push(...view.invoices.filter((invoice) => invoice.period === month));
			}

			const ownPaid = own.filter((invoice) => invoice.status === INVOICE_STATUS.paid);
			const ownOverdue = own.filter((invoice) => invoice.status === INVOICE_STATUS.overdue);

			// The cancelled Tagihan is in none of the three.
			expect(own).toHaveLength(expected.paid + expected.unpaid);
			expect(beranda.issuedCount).toBe(own.length);

			expect(ownPaid).toHaveLength(expected.paid);
			expect(beranda.paidCount).toBe(ownPaid.length);
			expect(report.duesUnitsPaid).toBe(ownPaid.length);
			expect(report.duesUnitsUnpaid).toBe(own.length - ownPaid.length);
			expect(report.duesUnitsUnpaid).toBe(expected.unpaid);

			expect(ownOverdue).toHaveLength(expected.overdue);
			expect(beranda.overdueCount).toBe(ownOverdue.length);
			expect(beranda.overdueAmount).toBe(
				ownOverdue.reduce((total, invoice) => total + invoice.remainingAmount, 0)
			);

			expect(report.duesCollected).toBe(
				own.reduce((total, invoice) => total + invoice.allocatedAmount, 0)
			);
			expect(report.duesCollected).toBe(150_000 + 40_000);
		}
	});
});
