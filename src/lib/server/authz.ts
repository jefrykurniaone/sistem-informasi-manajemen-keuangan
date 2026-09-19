import { eq } from 'drizzle-orm';
import { PermissionDeniedError } from '$lib/errors';
import type { Database } from './db';
import { ROLE, userRoles, type Role } from './db/schema/authz';

/**
 * The one guard every service calls before doing anything, and the one place "who is allowed to do
 * what" is decided — see `spec-fondasi-v1.md`'s "Peran" section. A service function that does not
 * take a caller and call `requirePermission` with it is not following this ticket's contract.
 *
 * ## Shape of the decision
 *
 * An action is permitted to a *set* of roles, not to a rank on a single scale: `PERMISSIONS` below
 * maps each known action to every role that may perform it, and a caller is let through the moment
 * any one role they hold appears in that set. `ACTION.manageRoles` was the first, because the
 * ticket that wrote this file was the first thing in the run that needed a decision at all — every
 * later spec adds its own actions to `ACTION` and `PERMISSIONS` in this same file, rather than
 * inventing a second place a permission could be decided. `ACTION.manageJobs` is the first of
 * those.
 *
 * ## Where a caller's roles come from
 *
 * `rolesOf` reads `user_roles` directly. It never falls back to treating an empty result as
 * `resident`: the migration in `drizzle/0003_authz_audit.sql` adds a trigger that inserts a
 * `resident` row for every `user` row the moment it exists, so an empty result here means the
 * trigger did not run — which is a broken migration, not a normal state this function should paper
 * over silently.
 */

/** A database, or a transaction on one — whatever this module is handed, it never opens its own. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything this module, or a caller of it, can run a query against. */
export type DatabaseWriter = Database | Transaction;

/** Every action this application currently knows how to permit. */
export const ACTION = {
	/** Granting or revoking a role. See `src/lib/server/services/user/roles.ts`. */
	manageRoles: 'manageRoles',
	/**
	 * Seeing the scheduled jobs and running one by hand. See `src/lib/server/scheduler/index.ts`.
	 * One action covers both halves because they are one screen: the list is only useful to whoever
	 * may press the button on it, and the button issues real work — a month's invoices, a batch of
	 * emails — so it is held to the same role as anything else that changes what has already
	 * happened.
	 */
	manageJobs: 'manageJobs',
	/**
	 * Seeing the admin list of Unit, adding a new one, and deactivating or reactivating one. See
	 * `src/lib/server/services/unit/index.ts`. One action for the read and the writes, same
	 * reasoning as `manageJobs`: the list is only useful to whoever may act on it, and every write
	 * here changes the house register the rest of the application anchors invoices and cash
	 * transactions to.
	 */
	manageUnits: 'manageUnits',
	/**
	 * Recording a Masa Huni, ending one, and marking which one is the Penanggung Jawab. See
	 * `src/lib/server/services/occupancy/index.ts`. `CONTEXT.md` puts "Unit dan Masa Huni" on
	 * Superuser, so this is a superuser-only action like the three above it.
	 *
	 * It is also what "admin melihat seluruh riwayat Unit" means in
	 * `spec-warga-unit-v1.md`: `unitVisibilityFor` in
	 * `src/lib/server/services/occupancy/visibility.ts` answers "the whole history" to whoever holds
	 * this action, and "only the days I lived here" to everyone else. Holding the right to change
	 * the occupancy record and the right to read all of it are the same right — someone who may
	 * reassign a house can already see who lived in it, and splitting them would let a screen show
	 * less than the form beside it accepts.
	 */
	manageOccupancies: 'manageOccupancies',
	/**
	 * Seeing the admin list of Post, writing one, editing it, previewing it, publishing it and
	 * archiving it. See `src/lib/server/services/post/index.ts`. One action for the read and the
	 * writes, the same reasoning as `manageJobs` and `manageUnits`.
	 *
	 * **The first action in this table that is not `superuser`'s.** See `PERMISSIONS` below.
	 */
	managePosts: 'managePosts',
	/**
	 * Moving a Keluhan through its statuses: taking it on, working it, resolving it, and rejecting
	 * it with a reason. See `src/lib/server/services/complaint/index.ts`.
	 *
	 * Named after `CONTEXT.md`'s own verb — Admin "menangani Keluhan" — rather than `manageComplaints`,
	 * because this action deliberately is *not* the whole of managing one. Reading every complaint is
	 * `readAllComplaints` below, and the two are held by different sets; calling this one "manage"
	 * would claim it covers the read as well.
	 *
	 * It also does not cover the two moves that belong to the reporter — withdrawing a complaint and
	 * lowering its visibility. Those are "only their own row" rules, which `PERMISSIONS` cannot
	 * express: every Warga holds them for their own rows, so an entry here would be one every account
	 * matches. They are guarded by comparing the row's `reporterId` to the running session instead,
	 * and still refused with `PermissionDeniedError` so that a route needs no second error class.
	 */
	handleComplaints: 'handleComplaints',
	/**
	 * Reading every Keluhan whatever its visibility, and the Riwayat Status behind it — the admin
	 * queue, a `pribadi` complaint somebody else reported, and who moved what and when. See
	 * `src/lib/server/services/complaint/visibility.ts`, which turns this answer into a `where`
	 * clause rather than letting each screen decide.
	 *
	 * **Split from `handleComplaints` on purpose, and it is the first read/write split in this
	 * table.** Every action above bundles a list with the writes on it, on the reasoning
	 * `manageJobs` records: a list is only useful to whoever may act on it. That reasoning does not
	 * survive here, because this spec asks for two different sets of people. See `PERMISSIONS`.
	 */
	readAllComplaints: 'readAllComplaints',
	/**
	 * Uploading a CSV of houses and their residents, reading the preview of it, and confirming the
	 * import that writes the lot. See `src/lib/server/services/import/resident-csv.ts`.
	 *
	 * One action for the preview and the write, the reasoning `manageJobs` records: a preview is only
	 * useful to whoever may press the button under it. It is `superuser`'s, by the same reading that
	 * put `manageUnits` and `manageOccupancies` there — one confirmed import writes the house register
	 * and creates the accounts of the people in it, which is both halves of what `CONTEXT.md` puts on
	 * Superuser ("Unit dan Masa Huni", and who exists at all).
	 *
	 * It is an action of its own rather than a use of `manageUnits` and `manageOccupancies` together
	 * because it does something neither of them does: it creates accounts. Answering "may this person
	 * import a file" by asking two other questions would also mean that a later spec narrowing either
	 * of them silently narrows this.
	 */
	importResidents: 'importResidents',
	/**
	 * Reading the buku kas with its running balance, recording a Transaksi Kas by hand, and
	 * recording a Koreksi of one. See `src/lib/server/services/cash/transaction.ts`,
	 * `correction.ts` and `balance.ts`. One action for the read and the two writes, the same
	 * reasoning as `manageJobs`: the cash book is only useful to whoever may add a line to it, and
	 * the correction button lives on the row it corrects.
	 *
	 * Named after `CONTEXT.md`'s own verb — Admin "mencatat Transaksi Kas" — and **it is `admin`'s,
	 * not `superuser`'s**, by the same reading that put `managePosts` and `handleComplaints` there.
	 * Superuser's list is "setiap tindakan yang mengubah masa lalu atau mengubah siapa boleh apa",
	 * and a Koreksi does neither: it *adds* a reversing row and leaves the row it corrects exactly as
	 * it was. That an append-only book never changes its past is what keeps recording out of
	 * Superuser's sentence, and it is why the two halves can share one action.
	 *
	 * Recording the Saldo awal is deliberately not covered here: it is `recordOpeningBalance` above,
	 * `superuser`'s, because the spec puts it there twice. The two are the only writers of
	 * `cash_transactions` that a person drives, and they are held by different roles on purpose.
	 */
	recordCashTransactions: 'recordCashTransactions',
	/**
	 * Seeing the admin list of Undangan, sending one, and sending one again. See
	 * `src/lib/server/services/invitation/index.ts`. One action for the read and the writes, the same
	 * reasoning as `manageJobs`: the list is only useful to whoever may act on it, and sending an
	 * invitation is what lets a stranger become a Warga of a named house — "mengubah siapa boleh
	 * apa", which `CONTEXT.md` puts on Superuser. Accepting an invitation is deliberately not covered
	 * here: the acceptor has no session yet, so that path is guarded by the token itself.
	 */
	manageInvitations: 'manageInvitations',
	/**
	 * Seeing the Tarif history and setting, changing or removing a rate. See
	 * `src/lib/server/services/dues/rate.ts`. One action for the read and the writes, the same
	 * reasoning as `manageJobs`: the history is only useful to whoever may act on it.
	 *
	 * `CONTEXT.md` names Tarif directly in Superuser's list — "mengelola Warga dan peran, Unit dan
	 * Masa Huni, Tarif, Pembebasan, pembatalan Tagihan, dan pembukaan kunci Periode" — so this is a
	 * superuser-only action, and an `admin` who is not also a superuser cannot change what the complex
	 * charges. Reading the rate in force on a given day is deliberately not covered here: the issuance
	 * job that reads it has no session at all, so `duesRateOn` takes no caller and checks nothing.
	 */
	manageDuesRates: 'manageDuesRates',
	/**
	 * Seeing the Kategori Kas list, adding one, renaming one, changing its type, and deactivating or
	 * reactivating one. See `src/lib/server/services/cash/category.ts`. One action for the read and
	 * the writes, the same reasoning as `manageJobs`: the list is only useful to whoever may act on
	 * it.
	 *
	 * It is `superuser`'s, which is what `docs/spec-kas-laporan-v1.md` asks for — user stories 1, 2
	 * and 3 all begin "sebagai superuser". Categories are the vocabulary every later cash figure is
	 * grouped by, so renaming or retiring one changes how money that has already moved is read, which
	 * is the sentence `CONTEXT.md` uses for Superuser.
	 *
	 * Reading the *active* categories for a recording form is deliberately not covered here, and is
	 * not an action at all: `listActiveCashCategories` takes no caller, because the admin who records
	 * a Transaksi Kas (#34) must be able to fill their own form without holding a superuser-only
	 * action. That read is guarded by whatever action the screen around it already needs.
	 */
	manageCashCategories: 'manageCashCategories',
	/**
	 * Recording the opening cash balance — the one Transaksi Kas that states how much money existed
	 * on the day the application started being used, and reading back whether it has been recorded.
	 * See `src/lib/server/services/cash/opening-balance.ts`. `docs/spec-kas-laporan-v1.md` puts it on
	 * Superuser twice: user story 11, and "Saldo awal … hanya bisa dibuat superuser".
	 *
	 * **An action of its own rather than a use of `manageCashCategories`, although both are
	 * superuser's today.** The reasoning `importResidents` records applies unchanged: it does
	 * something category management does not — it writes a money row into the append-only cash book,
	 * once, with no correction path — and answering "may this person record the opening balance" by
	 * asking "may they manage categories" would mean that a later spec widening category management
	 * to `admin`, which `CONTEXT.md` would allow for daily master data, silently hands every admin
	 * the opening balance too.
	 */
	recordOpeningBalance: 'recordOpeningBalance',
	/**
	 * Seeing the Pendaftaran still waiting to be decided, approving one onto a Unit, and turning one
	 * down with a reason. See `src/lib/server/services/registration/index.ts`. One action for the read
	 * and the two writes, the same reasoning as `manageJobs`: the queue is only useful to whoever may
	 * decide the rows on it.
	 *
	 * It is `superuser`'s by the same reading that put `manageInvitations` there — approving a
	 * registration is what turns a stranger who claimed a house into a Warga of one, which is
	 * "mengubah siapa boleh apa" in `CONTEXT.md`'s description of Superuser. Submitting a registration
	 * is deliberately not covered here and has no action at all: the registrant holds no rights yet,
	 * and their own submission is guarded by being an ordinary form about their own address.
	 */
	manageRegistrations: 'manageRegistrations',
	/**
	 * Seeing the units currently exempt from Tagihan, granting a new Pembebasan, and ending one
	 * that is running. See `src/lib/server/services/dues/exemption.ts`. One action for the read
	 * and the writes, the same reasoning as `manageJobs`: the list is only useful to whoever may
	 * act on it.
	 *
	 * `CONTEXT.md` names Pembebasan directly in Superuser's list — "mengelola Warga dan peran,
	 * Unit dan Masa Huni, Tarif, Pembebasan, pembatalan Tagihan, dan pembukaan kunci Periode" — so
	 * this is a superuser-only action, the same reading that put `manageDuesRates` there. Answering
	 * whether a unit is exempt on a given day is deliberately not covered here: the issuance job
	 * that reads it has no session at all, so `isUnitExemptOn` takes no caller and checks nothing.
	 */
	manageExemptions: 'manageExemptions',
	/**
	 * Seeing the list of Periode with each month's status and the Laporan Bulanan published inside
	 * it. See `src/lib/server/services/cash/period.ts`.
	 *
	 * **Held by `admin` and `superuser` both**, which makes it the second read in this table split
	 * away from the writes on its screen — `readAllComplaints` was the first, and for the same kind
	 * of reason. The screen has exactly one button, and that button is superuser-only, so the usual
	 * "a list is only useful to whoever may act on it" reasoning does not reach: the other reader is
	 * the Admin, who needs the list for two things Superuser's sentence has nothing to do with.
	 * An admin records a Transaksi Kas, and when a locked month refuses one, "which months are
	 * locked" is the question they are left holding; an admin also publishes a Laporan Bulanan
	 * (`CONTEXT.md` puts "menerbitkan Laporan Bulanan" on Admin), and publishing is what locks a
	 * month in the first place. One action held by `superuser` alone would answer 403 to the role
	 * that causes every lock on the screen.
	 *
	 * Reading whether one date falls in a locked month is deliberately not covered here and is not
	 * an action at all: `isDateInLockedPeriod` takes no caller, for the reason
	 * `listActiveCashCategories` records — the screen around it is already guarded by whatever
	 * action it needs.
	 */
	readPeriods: 'readPeriods',
	/**
	 * Reopening a locked Periode, with a reason that goes to the audit log. See
	 * `src/lib/server/services/cash/period.ts`.
	 *
	 * `CONTEXT.md` names it in Superuser's own sentence — "mengelola Warga dan peran, Unit dan Masa
	 * Huni, Tarif, Pembebasan, pembatalan Tagihan, dan **pembukaan kunci Periode**" — and
	 * `docs/spec-kas-laporan-v1.md` user story 15 asks for exactly that, so this is superuser-only
	 * and an `admin` who is not also a superuser cannot reopen a month. It is the clearest case in
	 * this table of "mengubah masa lalu": residents have already read the numbers the lock froze.
	 *
	 * **Locking is deliberately not covered here, and has no action of its own.** A Periode is
	 * locked by publishing its Laporan Bulanan, which `CONTEXT.md` puts on Admin, so guarding that
	 * transition with this superuser-only action would refuse the role that performs it. `lockPeriod`
	 * takes a `Transaction` and checks nothing, reachable only from a service that already checked
	 * the action entitling it to publish — see the argument recorded on that function.
	 */
	unlockPeriods: 'unlockPeriods',
	/**
	 * Seeing which houses are behind on iuran: every Unit's arrears total on the daftar penunggak,
	 * and the full Tagihan history of one Unit. See `src/lib/server/services/dues/queries.ts`. One
	 * action for both, the same reasoning as `manageJobs`: the per-unit history is only reachable
	 * from the list, and both are the same fact — who owes what — read at two grains.
	 *
	 * `docs/spec-iuran-v1.md:220` says the daftar penunggak "hanya bisa dibuka oleh admin", so this
	 * is `admin`'s alone, not `superuser`'s — the same reading that put `managePosts`,
	 * `handleComplaints` and `recordCashTransactions` there. `isAllowed` has no inheritance, so a
	 * superuser who is not also an admin is refused here too, which is what the spec asks for.
	 */
	readOverdue: 'readOverdue'
} as const;

/** One of the actions above. */
export type Action = (typeof ACTION)[keyof typeof ACTION];

/**
 * Which roles may perform which action. The one table this whole guard is built around.
 *
 * A later spec adds its own entry here when it adds its own action — this object, not a second map
 * somewhere closer to that feature, is "the one place" `spec-fondasi-v1.md` asks for.
 *
 * ## `managePosts` belongs to `admin`, and to `admin` alone
 *
 * Every other entry here is `superuser`'s, which made it easy to read this table as a ladder. It is
 * not one. `spec-fondasi-v1.md`'s "Peran" section is explicit — "Tiga peran sebagai himpunan, bukan
 * tingkatan tunggal" — and `isAllowed` below has no inheritance in it, so a role that is not named
 * on an action does not hold it, whatever else that role can do.
 *
 * `CONTEXT.md` then says which set this action belongs to. Admin is "peran pengurus harian", and the
 * very first thing it lists is "mengelola Post". Superuser is "peran yang memegang setiap tindakan
 * yang mengubah masa lalu atau mengubah siapa boleh apa", and its list — residents and roles, Unit
 * and Masa Huni, Tarif, Pembebasan, cancelling a Tagihan, unlocking a Periode — does not contain
 * Post, because writing an announcement changes nothing that already happened and nobody's rights.
 * The three actions above all do fall under that sentence, which is why they read the way they do.
 *
 * So a superuser who is not also an admin cannot write a Post. That is the intended reading of a set
 * rather than a rank, and it costs nothing to undo: whoever needs both grants both roles, which is
 * what `user_roles` is for. The binding acceptance criterion — that `resident` cannot call a single
 * write operation on a Post — holds either way, and it holds here because `resident` is not named.
 *
 * ## The two Keluhan actions are held by different sets, and that is the whole reason there are two
 *
 * `handleComplaints` is `admin`'s, by the same reading that put `managePosts` there. `CONTEXT.md`
 * lists "menangani Keluhan" as the second thing Admin does, and Superuser's list — residents and
 * roles, Unit and Masa Huni, Tarif, Pembebasan, cancelling a Tagihan, unlocking a Periode — does not
 * contain it, because moving a complaint from `reviewing` to `working` changes neither the past nor
 * anybody's rights.
 *
 * `readAllComplaints` is `admin`'s **and** `superuser`'s, and this is where the usual "one action for
 * the list and the writes on it" stops working. Two sentences of this feature's spec name a reader
 * who is not the handler. `docs/spec-keluhan-v1.md` says a `pribadi` complaint "hanya bisa dibaca
 * pelapornya dan pemegang peran admin atau superuser" — admin *or* superuser, not the admin set
 * alone — and user story 19 is "sebagai superuser, saya ingin melihat siapa mengubah status apa dan
 * kapan", which is a read of the Riwayat Status by somebody the spec never asks to handle anything.
 * One action held by `admin` alone would refuse both; one action held by both would hand a superuser
 * the power to reject a neighbour's complaint, which `CONTEXT.md` does not give them.
 *
 * Splitting the read from the write is therefore what the spec asks for rather than a preference,
 * and it stays honest in both directions: a superuser sees the whole queue and every private
 * complaint on it, and the buttons on that queue still refuse them.
 *
 * Neither action is held by `resident`. A Warga reads their own complaints and every `public` one
 * through `complaintReadScopeFor`, which is a rule about rows rather than about roles — see
 * `src/lib/server/services/complaint/visibility.ts`.
 */
const PERMISSIONS: Readonly<Record<Action, ReadonlySet<Role>>> = {
	[ACTION.manageRoles]: new Set([ROLE.superuser]),
	[ACTION.manageJobs]: new Set([ROLE.superuser]),
	[ACTION.manageUnits]: new Set([ROLE.superuser]),
	[ACTION.manageOccupancies]: new Set([ROLE.superuser]),
	[ACTION.managePosts]: new Set([ROLE.admin]),
	[ACTION.handleComplaints]: new Set([ROLE.admin]),
	[ACTION.readAllComplaints]: new Set([ROLE.admin, ROLE.superuser]),
	[ACTION.importResidents]: new Set([ROLE.superuser]),
	[ACTION.recordCashTransactions]: new Set([ROLE.admin]),
	[ACTION.manageInvitations]: new Set([ROLE.superuser]),
	[ACTION.manageDuesRates]: new Set([ROLE.superuser]),
	[ACTION.manageCashCategories]: new Set([ROLE.superuser]),
	[ACTION.recordOpeningBalance]: new Set([ROLE.superuser]),
	[ACTION.manageRegistrations]: new Set([ROLE.superuser]),
	[ACTION.manageExemptions]: new Set([ROLE.superuser]),
	[ACTION.readPeriods]: new Set([ROLE.admin, ROLE.superuser]),
	[ACTION.unlockPeriods]: new Set([ROLE.superuser]),
	[ACTION.readOverdue]: new Set([ROLE.admin])
};

/**
 * Whether any role in `roles` permits `action`, decided purely from the table above — no database
 * access, so a test can walk every combination of role and action without a connection.
 */
export function isAllowed(roles: Iterable<Role>, action: Action): boolean {
	const permitted = PERMISSIONS[action];
	for (const role of roles) {
		if (permitted.has(role)) {
			return true;
		}
	}
	return false;
}

/** Every role `userId` currently holds, read from `user_roles`. */
export async function rolesOf(db: DatabaseWriter, userId: string): Promise<ReadonlySet<Role>> {
	const rows = await db
		.select({ role: userRoles.role })
		.from(userRoles)
		.where(eq(userRoles.userId, userId));
	return new Set(rows.map((row) => row.role));
}

/**
 * Reads `callerId`'s roles and throws when none of them permit `action`.
 *
 * Every mutating function in this application's service layer starts with this call, given the
 * identity of whoever is asking — a service that skips it is not deciding permission anywhere, and
 * one that checks a role by hand instead of calling this is deciding it in a second place.
 *
 * @throws {PermissionDeniedError} naming `callerId` and `action`, when the caller's roles do not
 *   include one this action permits. A route catches this and answers with `error(403, …)` — see
 *   `src/lib/errors.ts`.
 */
export async function requirePermission(
	db: DatabaseWriter,
	callerId: string,
	action: Action
): Promise<void> {
	const roles = await rolesOf(db, callerId);
	if (!isAllowed(roles, action)) {
		throw new PermissionDeniedError(callerId, action);
	}
}
