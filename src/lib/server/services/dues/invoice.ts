import type { Rupiah } from '$lib/money';
import type { DatabaseWriter } from '../../authz';
import { invoices, type Invoice } from '../../db/schema/invoice';

/**
 * Tagihan: the vocabulary of one obligation — which calendar month it is for, when it falls due, and
 * the one statement that creates it. `./issuance.ts` is the run that walks every house and calls
 * this once per house; this module knows nothing about schedules, units or exemptions.
 *
 * Everything here takes **no caller and checks no permission**, the same shape `duesRateOn` and
 * `isUnitExemptOn` take and for the same reason recorded in `./rate.ts`: the only writer today is a
 * scheduled job, which has no session. A later ticket that issues a Tagihan from a screen guards its
 * own route, exactly as `/admin/jobs` already guards the manual trigger behind `ACTION.manageJobs`.
 *
 * ## The idempotency key is the database's, not this module's
 *
 * `invoices_unit_id_period_unique` in `src/lib/server/db/schema/invoice.ts` is the whole of it:
 * "pasangan unit dan periode pada tagihan unik, dipaksakan basis data". `issueInvoice` below writes
 * `insert … on conflict do nothing returning *` and answers `undefined` when the pair is already
 * taken, so a second run neither duplicates a row nor has to read before it writes. There is no
 * check-then-insert anywhere in this module, and there must never be one: under `read committed` two
 * runs would both read "no Tagihan yet" and both insert, which is the failure
 * `src/lib/server/scheduler/lock.ts` spells out one level up for `job_runs`. The index refuses the
 * second insert at any isolation level, with no window between a check and a write because there is
 * no check.
 *
 * ## A period is a month, and both dates are derived from it
 *
 * `docs/spec-iuran-v1.md` asks for "satu Tagihan … untuk periode bulan itu, dengan jatuh tempo
 * tanggal 5", and both of the dates that follow from a period are pure functions of the period
 * string rather than of the clock. That is what makes "menjalankannya terlambat menghasilkan tagihan
 * yang sama" true: a run on the eighth writes exactly the row a run on the first would have written,
 * because nothing it writes is read off the wall clock except `issuedAt`, which records when the row
 * came into being and is not part of the key.
 */

/**
 * The day of the month a Tagihan falls due: the fifth.
 *
 * `docs/spec-iuran-v1.md`'s "jatuh tempo tanggal 5", and it lives here rather than in the schema
 * because `src/lib/server/db/schema/invoice.ts` deliberately ties nothing about `dueDate` to
 * `period` — a Tagihan issued late for a past month, or a due date the pengurus later agree to move,
 * are both things the table has to survive. This is the issuance policy, which is a different thing.
 */
export const INVOICE_DUE_DAY_OF_MONTH = 5;

/**
 * The shape a period is written in, the same one `invoices_period_shape_check` enforces. Fixed-width
 * and zero-padded, so two periods compare and sort correctly as plain text.
 */
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `INVOICE_DUE_DAY_OF_MONTH` as the two digits a `YYYY-MM-DD` day ends with. */
const DUE_DAY_OF_MONTH = String(INVOICE_DUE_DAY_OF_MONTH).padStart(2, '0');

/**
 * Refuses anything that is not a calendar month written as `YYYY-MM`.
 *
 * `invoices_period_shape_check` refuses the same thing, but only once the `insert` runs, by which
 * point a caller can only report it as a driver error — the same reasoning `assertDay` records in
 * `./rate.ts`.
 *
 * @throws {TypeError} when `period` is not a calendar month written as `YYYY-MM`.
 */
export function assertPeriod(period: string): void {
	if (!PERIOD_PATTERN.test(period)) {
		throw new TypeError(`A period is a calendar month written as YYYY-MM, not "${period}".`);
	}
}

/**
 * The first day of `period`, as `YYYY-MM-DD` — the day issuance reads the Tarif and the Pembebasan
 * on. See `./issuance.ts` for why that day comes from the period rather than from the clock.
 *
 * @throws {TypeError} when `period` is not a calendar month written as `YYYY-MM`.
 */
export function firstDayOfPeriod(period: string): string {
	assertPeriod(period);
	return `${period}-01`;
}

/**
 * The day a Tagihan for `period` falls due, as `YYYY-MM-DD`.
 *
 * @throws {TypeError} when `period` is not a calendar month written as `YYYY-MM`.
 */
export function dueDateOfPeriod(period: string): string {
	assertPeriod(period);
	return `${period}-${DUE_DAY_OF_MONTH}`;
}

/** One Tagihan on its way into being. */
export interface IssueInvoiceRequest {
	/** The house this Tagihan is for. */
	readonly unitId: string;
	/** The calendar month it is for, as `YYYY-MM`. */
	readonly period: string;
	/** The amount owed, frozen here and never changed afterwards. */
	readonly amount: Rupiah;
	/** The day payment is due, as `YYYY-MM-DD`. */
	readonly dueDate: string;
	/** When this row came into being. */
	readonly issuedAt: Date;
}

/**
 * Creates one Tagihan, unless this house already has one for this period.
 *
 * @param writer the transaction the caller is already in. Issuance passes its per-unit transaction,
 *   so that the Tarif it read under a share lock and the row it writes commit together — see
 *   `./issuance.ts`.
 * @returns the row that was created, or `undefined` when `invoices_unit_id_period_unique` already
 *   held that pair. `undefined` is the ordinary answer on a second run and is never an error.
 */
export async function issueInvoice(
	writer: DatabaseWriter,
	request: IssueInvoiceRequest
): Promise<Invoice | undefined> {
	const [row] = await writer
		.insert(invoices)
		.values({
			unitId: request.unitId,
			period: request.period,
			amount: request.amount,
			dueDate: request.dueDate,
			issuedAt: request.issuedAt
		})
		.onConflictDoNothing()
		.returning();

	return row;
}
