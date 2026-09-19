import { asc, eq } from 'drizzle-orm';
import { formatRupiah, type Rupiah } from '$lib/money';
import type { Transaction } from '../../authz';
import type { Database } from '../../db';
import { duesRates } from '../../db/schema/dues-rate';
import { units } from '../../db/schema/unit';
import type { Clock } from '../../ports/clock';
import { isUnitExemptOn } from './exemption';
import { dueDateOfPeriod, firstDayOfPeriod, issueInvoice } from './invoice';
import { duesRateOn } from './rate';

/**
 * Penerbitan tagihan: one Tagihan for every active Unit that is not exempt, for one Periode, priced
 * at the Tarif in force and due on the fifth. `./jobs.ts` registers this as a scheduled job and is
 * the only caller today; `./invoice.ts` owns the single row this writes, and `./rate.ts` and
 * `./exemption.ts` own the two contracts it reads.
 *
 * Nothing here takes a caller or checks a permission. A scheduled job has no session, which is the
 * reason `duesRateOn` and `isUnitExemptOn` were published without one; `/admin/jobs` already gates
 * the manual trigger behind `ACTION.manageJobs`, so the one path a person can reach this by is
 * guarded where the person is.
 *
 * ## The whole run is a pure function of the Periode
 *
 * The Tarif and the Pembebasan are both read on **the first day of the Periode being billed**, never
 * on the day the job happens to run. `docs/spec-iuran-v1.md` asks for exactly this — "menjalankannya
 * terlambat menghasilkan tagihan yang sama" — and nothing else satisfies it. Reading "today" instead
 * would mean a run delayed to the eighth by a power cut prices the month at a Tarif that started on
 * the fifth, and skips a house whose Pembebasan started on the third, so the late run would write
 * different rows from the ones the on-time run would have written. With the day derived from the
 * Periode, the only thing a late run writes differently is `issuedAt`, which records when the row
 * came into being and is not part of anything.
 *
 * It also settles what a backdated Pembebasan does, which the spec states from the other side: a
 * Pembebasan starting on the tenth does not cover the first, so that month's Tagihan is still issued
 * and stays issued. "Pembebasan yang ditetapkan mundur **tidak** membatalkan tagihan yang sudah
 * terbit secara otomatis; superuser membatalkannya satu per satu."
 *
 * ## Why running it twice cannot produce two Tagihan
 *
 * The key is `invoices_unit_id_period_unique` — the pair `(unit, period)` — and it is enforced by
 * the database, not by this module. Three things follow, and they are the whole idempotency
 * argument:
 *
 * 1. **A second run writes nothing.** `issueInvoice` inserts `on conflict do nothing` and answers
 *    `undefined` for a pair that is already taken, so the second run reports every house as already
 *    issued and creates no row. There is no check-then-insert to lose a race with — see
 *    `./invoice.ts`.
 * 2. **A partial re-run completes what is missing and disturbs nothing else.** Each house is one
 *    transaction of its own, so a run that dies after forty of a hundred houses leaves forty
 *    committed Tagihan. The next attempt — the lease expiring on the abandoned `job_runs` row, or a
 *    superuser pressing the button after the failure released the lock — walks all hundred, finds
 *    the forty taken, and issues the sixty that are missing. The end state is one Tagihan per house
 *    either way, and a house that was added to the register after the first run is picked up by the
 *    second without anything having to notice it is new.
 * 3. **No Tarif in force means nothing is issued at all.** The run reads the Tarif before it touches
 *    a single house and throws `NoDuesRateError` when there is none, so the failure is recorded on
 *    the `job_runs` row with a message naming the day, the period is released for another attempt,
 *    and no half-priced month exists to clean up. A Tarif that disappears *during* a run cannot
 *    happen once the run has committed its first Tagihan — see the next section — and in the moment
 *    before that first commit the per-house read throws the same error, rolling back a transaction
 *    that has written nothing.
 *
 * ## One transaction per house, and the share lock that goes in it
 *
 * `updateDuesRate` and `deleteDuesRate` in `./rate.ts` take `for update` on the rate rows and then
 * read `invoices` without a lock. Under `read committed` an issuance transaction that has read its
 * Tarif and not yet committed its Tagihan is invisible to that read, so a delete could pass the
 * in-use test and commit in between — and the month would be priced by a Tarif that no longer
 * exists. That module's doc comment names the fix and this is it: **the Tarif is read with
 * `for('share')` inside the same transaction that inserts the Tagihan**, which makes the other
 * side's `for update` wait for this one. `duesRateOn` itself deliberately takes no lock, so
 * `lockDuesRatesForIssuance` below takes it over the same rows `loadCalendarForWrite` locks, and
 * `duesRateOn` then picks from rows this transaction is already holding.
 *
 * The lock only has to cover the first house. From the moment one Tagihan for this Periode is
 * committed, `assertNeverBilled` and `assertClaimsNothingBilled` in `./rate.ts` refuse every
 * edit, insert and delete that would change which Tarif priced this Periode, so the answer to
 * `duesRateOn(firstDayOfPeriod(period))` is frozen for the rest of the run. Every house in one run
 * is therefore billed the same amount, which is what the share lock buys and why it does not have to
 * be held across the whole run.
 *
 * Splitting the run into one transaction per house rather than wrapping the lot in one is the same
 * rule `src/lib/server/scheduler/lock.ts` states for the job as a whole: work whose length grows
 * with the size of the complex does not belong inside a single database transaction, and a share
 * lock held for the whole run would block the Tarif screen for as long as the run takes. The price
 * is that a crash leaves a partial month, and point 2 above is why that is a state this design
 * welcomes rather than one it has to avoid.
 */

/**
 * The time zone the complex keeps its calendar in: `Asia/Jakarta`.
 *
 * **This is the decision `src/lib/server/scheduler/registry.ts` and `src/lib/server/ports/clock.ts`
 * both refused to make for themselves**, and this is the module it belongs to, because issuance is
 * what gives "the first of the month" something to be true of. `monthlySchedule` takes the zone as an
 * argument for exactly this reason — "A later spec that issues invoices on the first of the month
 * passes the complex's zone in when it registers its job, rather than finding one hard-coded here" —
 * and `./jobs.ts` is where it is passed in.
 *
 * `Asia/Jakarta` rather than a fixed `+07:00` offset, so the runtime's own tz database answers the
 * question and a complex that turns out to sit in WITA or WIT changes one constant rather than a
 * piece of arithmetic. The zone has no daylight saving and has not changed offset in living memory,
 * so every `YYYY-MM` this produces marks exactly one stretch of instants, with no hour that belongs
 * to two months and none that belongs to neither.
 *
 * **What it decides is when the job fires, and nothing else.** The run itself never asks the clock
 * what day it is — see this module's doc comment — so the zone cannot reach the rows that get
 * written. The one consequence worth stating: `currentDay(clock)` in
 * `src/lib/server/services/occupancy/visibility.ts` reads a **UTC** day, so between 00:00 and 07:00
 * local the two disagree by one day. That is a known gap in the screens that read `currentDay`, it
 * is recorded in that function's own comment, and it is not this module's to close — issuance reads
 * no day from the clock at all.
 */
export const COMPLEX_TIME_ZONE = 'Asia/Jakarta';

/**
 * Thrown when no Tarif is in force on the day a Periode is being issued for.
 *
 * Nothing is issued and nothing is written: the run refuses before it reaches the first house.
 * "Belum ada tarif sama sekali" is a real state of a fresh installation rather than a broken one,
 * which is why `duesRateOn` answers `undefined` instead of throwing and why deciding what issuance
 * does about it was left to this module.
 *
 * The message reaches a superuser through `job_runs.error` and the outcome line on `/admin/jobs`, so
 * it names the day that had no Tarif and what to do about it. It is in English, like
 * `ABANDONED_RUN_ERROR` and every other message that lands in that column.
 *
 * Declared here rather than in `src/lib/errors.ts` for the reason `DuesRateInUseError` records: this
 * ticket's `writes:` does not include that file, and a named, `instanceof`-checkable class in the
 * service module is what a caller catches either way.
 */
export class NoDuesRateError extends Error {
	override readonly name = 'NoDuesRateError';

	/** The Periode that was being issued, as `YYYY-MM`. */
	readonly period: string;

	/** The day no Tarif was in force on, as `YYYY-MM-DD`. */
	readonly day: string;

	constructor(period: string, day: string) {
		super(
			`No dues rate is in force on ${day}, so no invoice was issued for period ${period}. Set a dues rate effective on or before ${day}, then run this job again.`
		);
		this.period = period;
		this.day = day;
	}
}

/** Why one Unit went without a Tagihan in a run that reached it. */
export const UNIT_SKIP_REASON = {
	/** A Pembebasan covered the first day of the Periode. */
	exempt: 'exempt',
	/** This Unit already had a Tagihan for this Periode — the ordinary answer on a second run. */
	alreadyIssued: 'already-issued'
} as const;

/** One of the two reasons a Unit can be passed over. */
export type UnitSkipReason = (typeof UNIT_SKIP_REASON)[keyof typeof UNIT_SKIP_REASON];

/** One Unit a run considered and did not issue a Tagihan for. */
export interface SkippedUnit {
	readonly unitId: string;
	/** The block, so that a line a superuser reads names the house rather than a uuid. */
	readonly block: string;
	readonly number: string;
	readonly reason: UnitSkipReason;
}

/** What one run of issuance came to. */
export interface InvoiceIssuanceSummary {
	/** The Periode issued, as `YYYY-MM`. */
	readonly period: string;
	/** The day the Tarif and the Pembebasan were read on: the first of `period`. */
	readonly issuanceDay: string;
	/** The day every Tagihan in this run falls due. */
	readonly dueDate: string;
	/**
	 * The amount every Tagihan in this run was priced at, or `undefined` when it issued none. It is
	 * the amount that was actually written rather than the one the opening check read, so it cannot
	 * describe a Tarif that no Tagihan was ever priced at.
	 */
	readonly amount: Rupiah | undefined;
	/** How many active Unit this run considered. */
	readonly unitCount: number;
	/** How many Tagihan this run created. */
	readonly issuedCount: number;
	/** Every Unit that went without one, and why. */
	readonly skipped: readonly SkippedUnit[];
}

/** One house as a run walks it. */
interface BillableUnit {
	readonly id: string;
	readonly block: string;
	readonly number: string;
}

/** What one house's transaction came back with. */
interface UnitOutcome {
	/** Why no Tagihan was written, or `undefined` when one was. */
	readonly reason?: UnitSkipReason;
	/** The amount the Tagihan was written at, when one was. */
	readonly amount?: Rupiah;
}

/**
 * Issues one Tagihan for every active Unit that is not exempt on the first day of `period`.
 *
 * Safe to call as often as anything likes: a Unit that already has a Tagihan for this Periode is
 * reported as such and nothing is written for it. See this module's doc comment for the whole
 * idempotency argument.
 *
 * @param clock stamps `issuedAt` and nothing else. Which Tarif applies, which houses are exempt and
 *   when the Tagihan falls due are all read off `period`, so a test decides every one of them
 *   without touching the clock.
 * @throws {TypeError} when `period` is not a calendar month written as `YYYY-MM`.
 * @throws {NoDuesRateError} when no Tarif is in force on the first day of `period`, in which case
 *   nothing at all was issued.
 */
export async function issueInvoicesForPeriod(
	db: Database,
	clock: Clock,
	period: string
): Promise<InvoiceIssuanceSummary> {
	const issuanceDay = firstDayOfPeriod(period);
	const dueDate = dueDateOfPeriod(period);

	// Before the first house, so that "tidak ada tarif" leaves a failed run and an untouched month
	// rather than a month priced halfway.
	if (!(await duesRateOn(db, issuanceDay))) {
		throw new NoDuesRateError(period, issuanceDay);
	}

	const billable = await activeUnitsToBill(db);
	const skipped: SkippedUnit[] = [];
	let issuedCount = 0;
	let amount: Rupiah | undefined;

	for (const unit of billable) {
		const outcome = await issueForUnit(db, clock, { period, issuanceDay, dueDate }, unit);
		if (outcome.reason) {
			skipped.push({
				unitId: unit.id,
				block: unit.block,
				number: unit.number,
				reason: outcome.reason
			});
			continue;
		}
		issuedCount += 1;
		amount = outcome.amount;
	}

	return { period, issuanceDay, dueDate, amount, unitCount: billable.length, issuedCount, skipped };
}

/**
 * One line saying what a run came to, for the server log — "hasil eksekusi mencatat berapa tagihan
 * terbit, berapa unit dilewati, dan alasannya".
 *
 * Exported so that the wording is asserted in a test rather than only printed, and in English
 * because it is read in a server log next to `src/lib/server/scheduler/index.ts`'s own line.
 */
export function describeIssuance(summary: InvoiceIssuanceSummary): string {
	const issued =
		summary.issuedCount === 0 || summary.amount === undefined
			? 'no invoices issued'
			: `${summary.issuedCount} invoices issued at ${formatRupiah(summary.amount)}, due ${summary.dueDate}`;

	return `Period ${summary.period}: ${issued}. ${summary.skipped.length} of ${summary.unitCount} units skipped${describeSkips(summary.skipped)}.`;
}

/** The breakdown `describeIssuance` appends, or nothing at all when no Unit was passed over. */
function describeSkips(skipped: readonly SkippedUnit[]): string {
	if (skipped.length === 0) {
		return '';
	}
	const exempt = countReason(skipped, UNIT_SKIP_REASON.exempt);
	const alreadyIssued = countReason(skipped, UNIT_SKIP_REASON.alreadyIssued);
	return `: ${exempt} exempt, ${alreadyIssued} already issued`;
}

/** How many of `skipped` were passed over for `reason`. */
function countReason(skipped: readonly SkippedUnit[], reason: UnitSkipReason): number {
	return skipped.filter((unit) => unit.reason === reason).length;
}

/** Everything about the Periode that is the same for every house in one run. */
interface IssuancePlan {
	readonly period: string;
	readonly issuanceDay: string;
	readonly dueDate: string;
}

/**
 * One house, in one transaction: the Tarif read under a share lock, the Pembebasan, and the insert,
 * committing together or not at all.
 *
 * @throws {NoDuesRateError} when the Tarif disappeared between this run's opening check and this
 *   transaction — which can only happen before the run's first Tagihan is committed, so the run has
 *   written nothing and this transaction rolls back to the same state.
 */
async function issueForUnit(
	db: Database,
	clock: Clock,
	plan: IssuancePlan,
	unit: BillableUnit
): Promise<UnitOutcome> {
	return db.transaction(async (transaction) => {
		await lockDuesRatesForIssuance(transaction);

		const rate = await duesRateOn(transaction, plan.issuanceDay);
		if (!rate) {
			throw new NoDuesRateError(plan.period, plan.issuanceDay);
		}
		if (await isUnitExemptOn(transaction, unit.id, plan.issuanceDay)) {
			return { reason: UNIT_SKIP_REASON.exempt };
		}

		const issued = await issueInvoice(transaction, {
			unitId: unit.id,
			period: plan.period,
			amount: rate.amount,
			dueDate: plan.dueDate,
			issuedAt: clock.now()
		});

		return issued ? { amount: issued.amount } : { reason: UNIT_SKIP_REASON.alreadyIssued };
	});
}

/**
 * Takes a share lock on every Tarif row, so that `updateDuesRate` and `deleteDuesRate` — which lock
 * the same rows `for update` — wait for this transaction to commit its Tagihan before they decide
 * whether the rate has been used. See this module's doc comment.
 *
 * Every row rather than the one `duesRateOn` will pick: both writers in `./rate.ts` lock the whole
 * table anyway, because a rate's billing window depends on its neighbours, so locking the same set
 * is the exact counterpart rather than a wider one. An empty table takes no lock and needs none —
 * the run has already refused with `NoDuesRateError` by then.
 */
async function lockDuesRatesForIssuance(transaction: Transaction): Promise<void> {
	await transaction.select({ id: duesRates.id }).from(duesRates).for('share');
}

/**
 * Every house that is still a house, in the order a street sign reads — the same order
 * `queryUnitsPage` puts the admin list in.
 *
 * A deactivated Unit is not a house any more (`src/lib/server/db/schema/unit.ts`: "A house that no
 * longer exists is switched off"), so it is not a candidate this run passed over — it is not in the
 * run at all, and `unitCount` on the summary counts candidates.
 */
async function activeUnitsToBill(db: Database): Promise<readonly BillableUnit[]> {
	return db
		.select({ id: units.id, block: units.block, number: units.number })
		.from(units)
		.where(eq(units.isActive, true))
		.orderBy(asc(units.block), asc(units.number));
}
