import { inArray, sql } from 'drizzle-orm';
import { rupiah, type Rupiah } from '#lib/money.ts';
import { civilDayOf } from '#lib/time.ts';
import type { DatabaseWriter } from '../../authz';
import { allocations } from '../../db/schema/allocation';
import type { Clock } from '../../ports/clock';
import { isInvoiceVisible, type ResidentView } from '../occupancy/resident-view';

/**
 * **Where a Tagihan stands: how much is allocated to it, what is left, and its status, on one WIB
 * day.** The one place #306 decision 2 asks for.
 *
 * `invoices` has no status column (`src/lib/server/db/schema/invoice.ts`), so lunas, sebagian, belum
 * bayar and menunggak are worked out on every read. Before #320 the status comparison already lived
 * in one pure function, but its three ingredients did not: the allocated sum per Tagihan was written
 * four times (`../dues/queries.ts`, `./allocation.ts`, `../dashboard/index.ts`,
 * `../report/composition.ts`), the remaining amount three times, and "today" three times. Each
 * reader now hands its Tagihan here and reads the three answers back, so "Tagihan saya", both
 * Beranda cards, the Laporan Bulanan and the Alokasi module cannot disagree about one Tagihan.
 *
 * ## Two doors, one sum
 *
 * - **`invoiceStandings`** is the door for screens and reports: the allocated amount, the remaining
 *   amount and the status of every Tagihan handed in, on today's WIB day. A caller showing one
 *   person's screen passes that person's `ResidentView` as `visibleTo`, and only the Tagihan
 *   `isInvoiceVisible` in `../occupancy/resident-view.ts` lets them see come back. The visibility rule
 *   is that module's and is not restated here.
 * - **`allocatedAmountsOf`** is the small second door for `./allocation.ts`, whose locking read is
 *   what Payment verification plans against. It answers the allocated and remaining amounts only,
 *   reads no clock and decides no status, and it never takes a lock of its own: the caller selects
 *   and locks its rows first (the Unit's open Tagihan, `for update`, in `lockOpenInvoicesOfUnit`),
 *   then asks here, inside the same transaction. The sum is one statement after the locks, exactly
 *   as before #320, so the verification's lock order (payment row, the Unit's open Tagihan, the
 *   Periode) does not move. `tests/unit/payment-verification.test.ts` holds that order with a second
 *   connection.
 *
 * Both doors run the same private `allocatedByInvoice` and the same subtraction. That query is the
 * only `allocations` aggregate grouped by Tagihan under `src/lib/server`, which
 * `tests/unit/invoice-standing.test.ts` scans for. `unitFinanceFor` in `./corrections-history.ts`,
 * admin's correction screen, no longer adds Alokasi up itself: it reads each Tagihan's standing through `invoiceStandings`.
 *
 * ## "Today" is read once, from the shared time module
 *
 * `invoiceStandings` reads `civilDayOf(clock.now())` from `src/lib/time.ts` once per call: the
 * calendar day in `Asia/Jakarta` (WIB). A due date is written by `dueDateOfPeriod` in `./invoice.ts`
 * as a day in the same calendar, so "sudah lewat jatuh tempo" flips at WIB midnight and not seven
 * hours later. Every Tagihan in one call is judged on that one day.
 *
 * ## The status vocabulary
 *
 * `INVOICE_STATUS` is the vocabulary every screen badge already speaks
 * (`src/lib/components/dues/invoice-status-badge.svelte`). `void` is the one value that is a stored
 * fact rather than a comparison: a cancelled Tagihan is nothing owed, and `CONTEXT.md` names
 * "pembatalan Tagihan" `void`. A reader that leaves voided Tagihan out of its own list does so in its
 * own `where` clause; one that keeps them (admin's unit history) gets `void` back from here.
 */

/**
 * What a computed Tagihan status can be. Not in `CONTEXT.md`'s "Nama di kode" table because it is
 * not a stored value with a value set to enumerate: `docs/spec-iuran-v1.md:163-165` is explicit that
 * there is no status column at all. `void` is the one exception, and it is already the code name
 * `CONTEXT.md` gives "pembatalan Tagihan".
 */
export const INVOICE_STATUS = {
	paid: 'paid',
	partial: 'partial',
	unpaid: 'unpaid',
	overdue: 'overdue',
	void: 'void'
} as const;

/** One of the values `INVOICE_STATUS` names. */
export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];

/**
 * What this module needs of one Tagihan. Any row selected with these six columns fits, and every
 * other field the caller selected comes back untouched beside the answers.
 */
export interface InvoiceStandingInput {
	readonly invoiceId: string;
	readonly unitId: string;
	/** The Periode, as `YYYY-MM`. Read only when the caller narrows to one person. */
	readonly period: string;
	readonly amount: Rupiah;
	/** The day payment is due, as `YYYY-MM-DD`, in the complex's calendar. */
	readonly dueDate: string;
	/** When this Tagihan was cancelled, or `null` while it stands. */
	readonly voidedAt: Date | null;
}

/** The allocated and remaining amounts of one Tagihan: the second door's whole answer. */
export interface AllocatedAmounts {
	/** What every Alokasi to this Tagihan adds up to, from every Pembayaran there is. */
	readonly allocatedAmount: Rupiah;
	/** `amount` less `allocatedAmount`: what is still owed on this one Tagihan. */
	readonly remainingAmount: Rupiah;
}

/** Where one Tagihan stands on one WIB day. */
export interface InvoiceStanding extends AllocatedAmounts {
	readonly status: InvoiceStatus;
}

/** How a caller narrows `invoiceStandings`. */
export interface InvoiceStandingOptions {
	/**
	 * The one person whose personal screen this is. When given, only the Tagihan this person may see
	 * (by `isInvoiceVisible`) come back; the others are dropped before anything is summed. Omitted on
	 * admin screens and on the Laporan Bulanan, which count every Tagihan.
	 */
	readonly visibleTo?: ResidentView;
}

/**
 * Every Tagihan of `invoices`, in the order given, with its allocated amount, its remaining amount
 * and its status on today's WIB day.
 *
 * Takes no caller and checks no permission: it only reads `allocations` for the ids it was handed,
 * and deciding which Tagihan a screen may read at all is that screen's job, or `visibleTo`'s.
 *
 * @throws {TypeError} when `options.visibleTo` is given and a Tagihan's `period` is not `YYYY-MM`,
 *   from `isInvoiceVisible`.
 */
export async function invoiceStandings<T extends InvoiceStandingInput>(
	db: DatabaseWriter,
	clock: Clock,
	invoices: readonly T[],
	options: InvoiceStandingOptions = {}
): Promise<readonly (T & InvoiceStanding)[]> {
	const { visibleTo } = options;
	const kept = visibleTo
		? invoices.filter((invoice) => isInvoiceVisible(visibleTo, invoice))
		: invoices;
	const allocated = await allocatedByInvoice(db, kept);
	const today = civilDayOf(clock.now());

	return kept.map((invoice) => {
		const amounts = amountsOf(invoice, allocated);
		return {
			...invoice,
			...amounts,
			status: invoiceStatus(
				{
					amount: invoice.amount,
					allocatedAmount: amounts.allocatedAmount,
					dueDate: invoice.dueDate,
					voidedAt: invoice.voidedAt
				},
				today
			)
		};
	});
}

/**
 * The second door: every Tagihan of `invoices`, in the order given, with its allocated and remaining
 * amounts and nothing else. No clock, no status, no lock.
 *
 * For a caller that has already selected, and usually locked, its rows inside `db`'s transaction:
 * `lockOpenInvoicesOfUnit` in `./allocation.ts`, which Payment verification plans against, and its
 * unlocked twin `openInvoicesOfUnit`. The sum runs as one statement after the caller's locks, so it
 * sees every Alokasi committed before them and none can be added until the caller's transaction ends.
 */
export async function allocatedAmountsOf<
	T extends { readonly invoiceId: string; readonly amount: Rupiah }
>(db: DatabaseWriter, invoices: readonly T[]): Promise<readonly (T & AllocatedAmounts)[]> {
	const allocated = await allocatedByInvoice(db, invoices);
	return invoices.map((invoice) => ({ ...invoice, ...amountsOf(invoice, allocated) }));
}

/** Just enough of a Tagihan, plus what has been allocated to it, to decide its status. */
export interface InvoiceStatusInput {
	readonly amount: Rupiah;
	readonly allocatedAmount: Rupiah;
	/** The day payment is due, as `YYYY-MM-DD`. */
	readonly dueDate: string;
	/** When this Tagihan was cancelled, or `null` while it stands. */
	readonly voidedAt: Date | null;
}

/**
 * A Tagihan's status, computed rather than read. `docs/spec-iuran-v1.md:163-165` verbatim: "Lunas,
 * sebagian, atau belum bayar adalah perbandingan antara besaran Tagihan dan jumlah Alokasinya.
 * Menunggak adalah belum lunas dan sudah lewat jatuh tempo."
 *
 * Menunggak takes precedence over sebagian and belum bayar rather than sitting beside them: a
 * Tagihan that is both partly paid and past its due date is shown as menunggak, not sebagian, which
 * is what the glossary's own wording ("belum lunas **dan** sudah lewat jatuh tempo") asks for. On the
 * due date itself a Tagihan is not yet menunggak: "lewat" means the day has passed.
 *
 * The inner rule of `invoiceStandings`, which is the door every service reads it through. It stays
 * exported for `./queries.ts`'s re-export, which keeps the imports outside #320's surface
 * compiling; no service calls it.
 *
 * @param today the WIB day, as `YYYY-MM-DD`, that "sudah lewat jatuh tempo" is decided against.
 */
export function invoiceStatus(invoice: InvoiceStatusInput, today: string): InvoiceStatus {
	if (invoice.voidedAt !== null) {
		return INVOICE_STATUS.void;
	}
	if (invoice.allocatedAmount >= invoice.amount) {
		return INVOICE_STATUS.paid;
	}
	if (invoice.dueDate < today) {
		return INVOICE_STATUS.overdue;
	}
	return invoice.allocatedAmount > 0 ? INVOICE_STATUS.partial : INVOICE_STATUS.unpaid;
}

/** The allocated amount out of `allocated`, a missing entry read as zero, and the remainder. */
function amountsOf(
	invoice: { readonly invoiceId: string; readonly amount: Rupiah },
	allocated: ReadonlyMap<string, Rupiah>
): AllocatedAmounts {
	const allocatedAmount = allocated.get(invoice.invoiceId) ?? rupiah(0);
	return { allocatedAmount, remainingAmount: rupiah(invoice.amount - allocatedAmount) };
}

/**
 * How much has been allocated to each of `invoices`, keyed by invoice id and absent for one with no
 * Alokasi at all. The one `allocations` aggregate grouped by Tagihan in the codebase.
 *
 * A `Map`, never an object literal: the keys are ids, and a lookup in an object literal answers for
 * names nobody put in it. `::text` and `coalesce`, the idiom `SIGNED_TOTAL` in
 * `../cash/balance.ts` uses: PostgreSQL widens `sum(bigint)` to `numeric`, which the driver hands
 * back as a string, and `sum` over an empty group is `null`.
 */
async function allocatedByInvoice(
	db: DatabaseWriter,
	invoices: readonly { readonly invoiceId: string }[]
): Promise<ReadonlyMap<string, Rupiah>> {
	if (invoices.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			invoiceId: allocations.invoiceId,
			total: sql<string>`coalesce(sum(${allocations.amount}), 0)::text`
		})
		.from(allocations)
		.where(
			inArray(
				allocations.invoiceId,
				invoices.map((invoice) => invoice.invoiceId)
			)
		)
		.groupBy(allocations.invoiceId);

	return new Map(rows.map((row) => [row.invoiceId, rupiah(Number(row.total))]));
}
