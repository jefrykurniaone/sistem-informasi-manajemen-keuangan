import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { civilDayOf, civilMonthOf } from '../src/lib/time';
import { rupiah } from '../src/lib/money';
import { createAuth, readAuthSecret, readOrigin, type Auth } from '../src/lib/server/auth';
import { createConnection, readDatabaseUrl, type Database } from '../src/lib/server/db';
import { user } from '../src/lib/server/db/schema/auth';
import { ROLE } from '../src/lib/server/db/schema/authz';
import { units } from '../src/lib/server/db/schema/unit';
import { systemClock, type Clock } from '../src/lib/server/ports/clock';
import type { FileStore } from '../src/lib/server/ports/file-store';
import {
	DEFAULT_FILE_STORE_ROOT,
	localFileStoreFromEnvironment
} from '../src/lib/server/storage/local-file-store';
import { runJob } from '../src/lib/server/scheduler';
import {
	createCashCategory,
	listActiveCashCategories
} from '../src/lib/server/services/cash/category';
import { recordCashCorrection } from '../src/lib/server/services/cash/correction';
import { recordOpeningBalance } from '../src/lib/server/services/cash/opening-balance';
import { recordCashTransaction } from '../src/lib/server/services/cash/transaction';
import { addComplaintReply } from '../src/lib/server/services/complaint/reply';
import {
	changeComplaintStatus,
	createComplaint,
	withdrawComplaint
} from '../src/lib/server/services/complaint';
import { describeIssuance } from '../src/lib/server/services/dues/issuance';
import { invoiceIssuanceJob } from '../src/lib/server/services/dues/jobs';
import { recordPayment } from '../src/lib/server/services/dues/payment';
import { listOverdueUnits } from '../src/lib/server/services/dues/queries';
import { createDuesRate } from '../src/lib/server/services/dues/rate';
import { rejectPayment, verifyPayment } from '../src/lib/server/services/dues/verification';
import { listUnitOccupancies, setPrimaryOccupant } from '../src/lib/server/services/occupancy';
import {
	archivePost,
	createPost,
	publishPost,
	setPostCoverImage
} from '../src/lib/server/services/post';
import { combineCivilDateTime } from '../src/lib/server/services/post/time';
import {
	approveRegistration,
	listPendingRegistrations,
	submitRegistration
} from '../src/lib/server/services/registration';
import { setSubscriptionPreference } from '../src/lib/server/services/subscription';
import { createUnit } from '../src/lib/server/services/unit';
import { bootstrapSuperuser } from '../src/lib/server/services/user/bootstrap';
import { grantRole } from '../src/lib/server/services/user/roles';
import {
	ADMIN_EMAIL,
	CORRECTED_EXPENSE_INDEX,
	CORRECTION_REASON,
	COMPLAINT_REJECTION_REASON,
	DUES_AMOUNT,
	OPENING_BALANCE_AMOUNT,
	PAYMENT_OUTCOME,
	PENGURUS_UNITS,
	RESIDENT_COUNT,
	RESIDENT_NAMES,
	RESIDENT_UNIT_LABELS,
	SEED_CASH_CATEGORIES,
	SEED_CASH_EXPENSES,
	SEED_COMPLAINTS,
	SEED_PASSWORD,
	SEED_PAYMENTS,
	SEED_POSTS,
	SEED_SUBSCRIPTION_OPT_INS,
	SEED_UNITS,
	SMALL_PNG_CONTENT_TYPE,
	SUPERUSER_EMAIL,
	smallPngBytes,
	type SeedComplaint,
	type SeedPayment,
	type SeedPost
} from './seed-data';

/**
 * `bun run db:seed-dev -- --yes` — empties a local database and fills it with the Data Contoh of one
 * komplek for the current WIB month, so that every main screen has something on it.
 *
 * `docs/spec-data-contoh-v1.md` is the spec. The tables live in `./seed-data.ts`; this module owns
 * the order they are written in, the guards that stop the command running anywhere it should not,
 * and the reset that comes first.
 *
 * ## Everything goes through the service layer
 *
 * The seeder calls `createUnit`, `approveRegistration`, `createDuesRate`, `recordOpeningBalance`,
 * `recordPayment`, `verifyPayment`, `recordCashTransaction`, `createPost`, `createComplaint` and the
 * rest exactly as a screen does, with a real `actorId` that really holds the action. That is not
 * tidiness: a seeder that inserted rows directly would happily produce states the application itself
 * refuses — a Tagihan with no Tarif behind it, a Pembayaran whose allocations exceed its nominal, a
 * Koreksi of a row that was already corrected — and the Data Contoh's whole job is to look like a
 * komplek that has been using this application, not like one that bypassed it.
 *
 * Two writes are deliberately **not** service calls, and there are only two:
 *
 * 1. **The reset**, which is `TRUNCATE`. No service deletes a Unit, a Tagihan or a Transaksi Kas,
 *    and none should — `src/lib/server/services/cash/transaction.ts` is built around the absence of
 *    a delete. Emptying a database is not a domain operation.
 * 2. **`user.emailVerified`**, set to true straight after sign-up. better-auth's
 *    `requireEmailVerification` makes `signInEmail` refuse an unverified account, and the only way
 *    through the front door is a link in an inbox. Nothing in the service layer flips that flag on
 *    its own — `acceptInvitation` writes it as part of redeeming a token — so the seeder writes it.
 *
 * ## Accounts come from better-auth, not from an insert
 *
 * Every account is created with `signUpEmail`, so its password is hashed by exactly the scrypt
 * configuration `signInEmail` will verify against. Writing an `account` row with a hand-rolled hash
 * would produce twenty-seven accounts nobody can sign in with, and the failure would only show up in
 * a browser.
 *
 * It uses **`createAuth()`, never `auth()`**, which `src/lib/server/auth.ts` is explicit about: the
 * singleton carries the SvelteKit cookie plugin, that plugin calls `getRequestEvent()`, and that
 * throws when there is no request in flight — "A scheduled job, a seed script or a command-line tool
 * that needs better-auth builds its own instance with `createAuth()` and no plugins."
 *
 * Importing `src/lib/server/auth.ts` at all is why this command needs
 * `--tsconfig-override scripts/tsconfig.seed.json`: that module imports `$app/server`, a SvelteKit
 * virtual module plain `bun run` cannot resolve. See `scripts/app-server-shim.ts`.
 *
 * ## Residents come from the registration flow
 *
 * There is no `createResident` service, and this module does not invent one. A `residents` row is
 * created by exactly three paths in this codebase — approving a Pendaftaran, accepting an Undangan,
 * and the spreadsheet import — and the seeder uses the first: `submitRegistration` then
 * `approveRegistration`, which also writes the Masa Huni and the default Langganan in one
 * transaction. Every seeded registration is therefore `approved`, and **none is left `pending`**,
 * which is what the spec asks for.
 *
 * ## Dates
 *
 * Everything is relative to `civilMonthOf(clock.now())` — the WIB month the clock is in. The tables
 * in `./seed-data.ts` carry a day of the month, and `dayInSeedMonth` below turns each into a
 * calendar day, **clamped to today**: `assertReceiptDay` in
 * `src/lib/server/services/dues/payment.ts` refuses money dated into the future, and a cash row
 * dated forward would make a running balance of something that has not happened.
 *
 * One consequence is worth stating plainly, because it is visible on a screen. A Tagihan falls due
 * on the fifth (`INVOICE_DUE_DAY_OF_MONTH`), and `listOverdueUnits` calls a house menunggak only
 * once that day has **passed**. Seeding on the first through the fifth of a month therefore leaves
 * `/admin/overdue` empty — not because the three unpaid houses are missing, but because nothing is
 * late yet. The summary this script prints says how many houses are overdue, so the operator sees
 * which of the two situations they are in rather than guessing.
 *
 * ## Determinism
 *
 * No `Math.random`, and no reading of the wall clock except through the injected `Clock`. Running
 * the seeder twice against the same database produces the same counts, because the reset puts it
 * back to the same starting point first. `tests/unit/seed-dev.test.ts` runs it twice and compares.
 *
 * ## The messages this script prints
 *
 * English, like `scripts/grant-superuser.ts` next to it and like `describeIssuance`, whose line this
 * script prints verbatim. They are operator output at a shell prompt rather than interface text; the
 * Indonesian in this seeder is the *data* — names, keterangan, judul — which is what a resident
 * actually reads.
 */

/** The `--yes` a caller has to type, because this command empties a database. */
const CONFIRMATION_FLAG = '--yes';

/** The database hosts this seeder is willing to run against. */
const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', 'db'];

/**
 * Every table the reset empties.
 *
 * `cash_categories` is **not** here, and that is the one deliberate departure from "every table in
 * the schema". Two of its rows are seeded by `drizzle/0009_cash_report.sql` and carry a `systemKey`;
 * the application treats their absence as a broken deployment rather than as an empty database —
 * `SystemCategoryMissingError` says so in as many words, "the migrations have not all run" — and
 * nothing can recreate them, because `createCashCategory` never writes `systemKey`. Truncating them
 * would leave `recordOpeningBalance` and every payment verification throwing. They are migration
 * output, the same class of thing as the Drizzle migration table, so the reset deletes only the
 * *ordinary* categories and leaves those two exactly as they are, ids included. See `resetDatabase`.
 *
 * `scaffold_probe` and Drizzle's own migration table are untouched for the same reason.
 *
 * `tests/unit/seed-dev.test.ts` compares this list against the tables a freshly migrated schema
 * really has, so a migration that adds a table fails that test instead of quietly leaving its rows
 * behind on the next seed.
 */
export const RESET_TABLES: readonly string[] = [
	'allocations',
	'refunds',
	'payments',
	'invoices',
	'exemptions',
	'dues_rates',
	'cash_transactions',
	'monthly_reports',
	'periods',
	'complaint_replies',
	'complaint_status_changes',
	'complaint_attachments',
	'complaints',
	'posts',
	'subscriptions',
	'occupancies',
	'residents',
	'units',
	'invitations',
	'registrations',
	'user_roles',
	'session',
	'account',
	'verification',
	'user',
	'audit_log',
	'email_queue',
	'job_runs',
	'rate_limit_buckets'
];

/** The tables the reset leaves alone on purpose, for the test that checks nothing was forgotten. */
export const PRESERVED_TABLES: readonly string[] = ['cash_categories', 'scaffold_probe'];

/**
 * Refuses to run anywhere this command has no business running.
 *
 * Pure, and exported, so that `tests/unit/seed-dev.test.ts` can walk all three refusals without a
 * database — which is the only honest way to test a guard whose whole job is to stop before it
 * touches one.
 *
 * @throws {Error} with a different message for each of the three refusals: a production
 *   `NODE_ENV`, a `DATABASE_URL` pointing somewhere that is not this machine, and a missing
 *   `--yes`.
 */
export function assertSeedAllowed(environment: NodeJS.ProcessEnv, argv: readonly string[]): void {
	if (environment.NODE_ENV === 'production') {
		throw new Error(
			'NODE_ENV is "production". db:seed-dev deletes every row in the database it is pointed at, so it refuses to run in a production environment under any circumstances.'
		);
	}

	const host = databaseHostOf(environment.DATABASE_URL);
	if (!host || !LOCAL_HOSTS.includes(host)) {
		throw new Error(
			`DATABASE_URL points at host "${host ?? '(unreadable)'}", and db:seed-dev only runs against ${LOCAL_HOSTS.join(', ')}. It deletes every row in the database it is pointed at, so a host it does not recognise as this machine is refused rather than emptied.`
		);
	}

	if (!argv.includes(CONFIRMATION_FLAG)) {
		throw new Error(
			`db:seed-dev deletes every row in the local database and every file under the storage directory. Say so on purpose: bun run db:seed-dev -- ${CONFIRMATION_FLAG}`
		);
	}
}

/** The host part of a PostgreSQL URL, or `undefined` when there is no URL or it will not parse. */
function databaseHostOf(url: string | undefined): string | undefined {
	const trimmed = url?.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		return new URL(trimmed).hostname;
	} catch {
		return undefined;
	}
}

/** What one seeded account turned into, once it has an account, a Warga record and a house. */
interface SeededPerson {
	readonly email: string;
	readonly name: string;
	readonly userId: string;
	readonly residentId: string;
	/** The house `approveRegistration` attached them to, as `SeedUnit.label`. */
	readonly unitLabel: string;
}

/** How many of each thing the seeder wrote, as the closing summary reports them. */
export interface SeedSummary {
	/** The WIB month everything is dated into, as `YYYY-MM`. */
	readonly period: string;
	readonly units: number;
	readonly residents: number;
	readonly occupancies: number;
	readonly primaryOccupants: number;
	readonly cashCategories: number;
	readonly invoices: number;
	readonly paymentsVerified: number;
	readonly paymentsPending: number;
	readonly paymentsRejected: number;
	readonly cashExpenses: number;
	readonly cashCorrections: number;
	readonly posts: number;
	readonly complaints: number;
	readonly subscriptionOptIns: number;
	/** How many houses `/admin/overdue` will list. Zero before the sixth of the month — see above. */
	readonly overdueUnits: number;
	/** `describeIssuance`'s own line for the issuance run. */
	readonly issuance: string;
}

/** Everything one run of the seeder needs. */
export interface SeedOptions {
	readonly db: Database;
	/** Decides the month everything is dated into, and stamps every row. */
	readonly clock: Clock;
	/** Where proofs, Sampul and Lampiran are written. */
	readonly fileStore: FileStore;
	/** The origin links in queued emails are built on. */
	readonly origin: string;
	/** The key better-auth signs with — `BETTER_AUTH_SECRET`. */
	readonly secret: string;
	/**
	 * The directory whose contents are deleted after the tables are emptied. Left out by the test,
	 * which hands in an in-memory `FileStore` and has no directory to clear.
	 */
	readonly storageRoot?: string;
}

/**
 * Empties the database and writes the whole Data Contoh.
 *
 * Exported so that `tests/unit/seed-dev.test.ts` can run it against a test schema with a fake clock
 * and an in-memory file store. The command-line entry point below is a thin wrapper that opens a
 * connection, reads the environment and prints what this returned.
 */
export async function seedDevelopmentData(options: SeedOptions): Promise<SeedSummary> {
	const { clock, db, fileStore } = options;
	const period = civilMonthOf(clock.now());
	const latestDay = Number(civilDayOf(clock.now()).slice(8, 10));

	await resetDatabase(db);
	if (options.storageRoot !== undefined) {
		await clearDirectoryContents(options.storageRoot);
	}

	const auth = createAuth({ db, clock, baseURL: options.origin, secret: options.secret });
	const people = await seedPeople(db, clock, auth, options.origin);
	const pengurus = requirePerson(people, SUPERUSER_EMAIL);
	const admin = requirePerson(people, ADMIN_EMAIL);
	const unitIds = await unitIdsByLabel(db);

	const primaryOccupants = await markPrimaryOccupants(db, clock, pengurus.userId, unitIds, people);
	await seedDuesRate(db, clock, pengurus.userId, period);
	const cashCategories = await seedCashCategories(db, clock, pengurus.userId);
	await recordOpeningBalance(db, clock, {
		actorId: pengurus.userId,
		amount: rupiah(OPENING_BALANCE_AMOUNT),
		occurredOn: dayInSeedMonth(period, 1, latestDay)
	});

	const issuance = await issueThisMonth(db, clock);
	const dated = { period, latestDay };
	await seedPayments(db, clock, fileStore, { admin, people, unitIds, dated });
	const cashCorrections = await seedCashBook(db, clock, fileStore, admin.userId, dated);
	await seedPosts(db, clock, fileStore, admin.userId, dated);
	await seedComplaints(db, clock, fileStore, admin.userId, people);
	await seedSubscriptions(db, clock, people);

	return {
		period,
		units: SEED_UNITS.length,
		residents: people.size,
		occupancies: people.size,
		primaryOccupants,
		cashCategories,
		invoices: SEED_UNITS.length,
		paymentsVerified: countOutcome(PAYMENT_OUTCOME.verified),
		paymentsPending: countOutcome(PAYMENT_OUTCOME.pending),
		paymentsRejected: countOutcome(PAYMENT_OUTCOME.rejected),
		cashExpenses: SEED_CASH_EXPENSES.length,
		cashCorrections,
		posts: SEED_POSTS.length,
		complaints: SEED_COMPLAINTS.length,
		subscriptionOptIns: SEED_SUBSCRIPTION_OPT_INS.length,
		overdueUnits: (await listOverdueUnits(db, clock, admin.userId)).length,
		issuance
	};
}

/** How many rows of `SEED_PAYMENTS` end in one outcome. */
function countOutcome(outcome: string): number {
	return SEED_PAYMENTS.filter((payment) => payment.outcome === outcome).length;
}

/**
 * Empties every table in `RESET_TABLES` and removes the ordinary Kategori Kas, in one transaction.
 *
 * One statement for the truncate, so that no foreign key can refuse it: `TRUNCATE a, b, c CASCADE`
 * empties them together rather than in an order somebody would have to keep right by hand. `CASCADE`
 * is belt and braces — every table that references a truncated one is itself in the list — and it is
 * kept because a later migration adding a table this list has not caught should fail loudly on the
 * test that compares them, not silently leave rows behind here.
 *
 * The `delete` that follows is the whole of why `cash_categories` is not in the truncate: see
 * `RESET_TABLES`. Deleting only `system_key is null` rows is safe in this transaction because
 * `cash_transactions` — the one table that points at a category — has just been emptied by the
 * statement above it.
 */
async function resetDatabase(db: Database): Promise<void> {
	const tableList = RESET_TABLES.map((table) => `"${table}"`).join(', ');
	await db.transaction(async (transaction) => {
		await transaction.execute(sql.raw(`truncate table ${tableList} cascade`));
		await transaction.execute(sql.raw('delete from "cash_categories" where "system_key" is null'));
	});
}

/**
 * Deletes everything inside `root`, leaving the directory itself.
 *
 * A directory that is not there yet is not an error: `LocalFileStore` creates it on the first write,
 * so a fresh checkout has none and has nothing to clear either.
 *
 * @returns how many entries were removed.
 */
async function clearDirectoryContents(root: string): Promise<number> {
	let entries: readonly string[];
	try {
		entries = await readdir(root);
	} catch (error) {
		if (isMissingDirectory(error)) {
			return 0;
		}
		throw error;
	}

	for (const entry of entries) {
		await rm(path.join(root, entry), { recursive: true, force: true });
	}
	return entries.length;
}

/** Whether an error is the one `readdir` throws for a directory that does not exist. */
function isMissingDirectory(error: unknown): boolean {
	return (
		error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT'
	);
}

/** The calendar day `day` of `period`, never later than `latestDay`, as `YYYY-MM-DD`. */
function dayInSeedMonth(period: string, day: number, latestDay: number): string {
	const clamped = Math.min(day, latestDay);
	return `${period}-${String(clamped).padStart(2, '0')}`;
}

/** The month and the last day the seeder may date anything into — passed around as one value. */
interface SeedCalendar {
	readonly period: string;
	readonly latestDay: number;
}

/** The first day of the month before `period`, as `YYYY-MM-DD`. */
function firstDayOfPreviousMonth(period: string): string {
	const year = Number(period.slice(0, 4));
	const month = Number(period.slice(5, 7));
	if (month === 1) {
		return `${year - 1}-12-01`;
	}
	return `${year}-${String(month - 1).padStart(2, '0')}-01`;
}

/** Every account the Data Contoh needs, in the order they are created. */
function seedAccounts(): readonly { readonly email: string; readonly name: string }[] {
	return [
		{ email: SUPERUSER_EMAIL, name: 'Pengurus Superuser' },
		{ email: ADMIN_EMAIL, name: 'Pengurus Admin' },
		...RESIDENT_NAMES.map((name, index) => ({
			email: `warga${String(index + 1).padStart(2, '0')}@komplek.local`,
			name
		}))
	];
}

/** Which house each account is attached to, by email. */
function unitLabelFor(email: string, index: number): string {
	if (email === SUPERUSER_EMAIL) {
		return PENGURUS_UNITS[0];
	}
	if (email === ADMIN_EMAIL) {
		return PENGURUS_UNITS[1];
	}
	// The two pengurus come first in `seedAccounts`, so a Warga's own index is two lower.
	return RESIDENT_UNIT_LABELS[index - PENGURUS_UNITS.length];
}

/**
 * Creates every account, verifies its address, hands out the two roles, and turns each one into a
 * Warga of a house through the Pendaftaran flow.
 *
 * The order inside is forced rather than chosen. `createUnit` and `approveRegistration` both demand
 * a caller holding `superuser`, and `bootstrapSuperuser` is the only way the first one comes into
 * being — so: accounts, then the superuser role, then the roles it can grant, then the houses, then
 * the registrations that attach people to them.
 */
async function seedPeople(
	db: Database,
	clock: Clock,
	auth: Auth,
	origin: string
): Promise<ReadonlyMap<string, SeededPerson>> {
	const accounts = seedAccounts();
	for (const account of accounts) {
		await auth.api.signUpEmail({
			body: { name: account.name, email: account.email, password: SEED_PASSWORD }
		});
	}

	// The one direct write outside the reset. See this module's doc comment.
	await db.update(user).set({ emailVerified: true, updatedAt: clock.now() });

	const userIds = await userIdsByEmail(db);
	const superuserId = requireValue(userIds.get(SUPERUSER_EMAIL), `account ${SUPERUSER_EMAIL}`);
	await grantPengurusRoles(db, clock, superuserId, requireValue(userIds.get(ADMIN_EMAIL), 'admin'));
	await createUnits(db, clock, superuserId);

	return approveEveryone(db, clock, { accounts, origin, superuserId, userIds });
}

/** Every `user` row's id, keyed by the address better-auth stored it under. */
async function userIdsByEmail(db: Database): Promise<ReadonlyMap<string, string>> {
	const rows = await db.select({ id: user.id, email: user.email }).from(user);
	return new Map(rows.map((row) => [row.email, row.id]));
}

/**
 * Gives the two pengurus accounts their roles.
 *
 * `bootstrapSuperuser` first, because `grantRole` begins with `requirePermission(…, manageRoles)`
 * and nobody holds it on a freshly emptied database — the same closed loop `scripts/grant-superuser.ts`
 * exists to open.
 *
 * The superuser account then grants itself `admin` as well, which is not belt-and-braces: `readOverdue`
 * and `verifyPayments` are granted to `admin` **alone** in `src/lib/server/authz.ts`, so without it
 * `superuser@komplek.local` opens `/admin/overdue` and `/admin/payments` and is answered 403.
 */
async function grantPengurusRoles(
	db: Database,
	clock: Clock,
	superuserId: string,
	adminId: string
): Promise<void> {
	await bootstrapSuperuser(db, clock, SUPERUSER_EMAIL);
	await grantRole(db, clock, {
		actorId: superuserId,
		targetUserId: superuserId,
		role: ROLE.admin
	});
	await grantRole(db, clock, { actorId: superuserId, targetUserId: adminId, role: ROLE.admin });
}

/** Registers all twenty houses. */
async function createUnits(db: Database, clock: Clock, superuserId: string): Promise<void> {
	for (const unit of SEED_UNITS) {
		await createUnit(db, clock, {
			actorId: superuserId,
			block: unit.block,
			number: unit.number
		});
	}
}

/** What `approveEveryone` needs beyond the database and the clock. */
interface ApprovalContext {
	readonly accounts: readonly { readonly email: string; readonly name: string }[];
	readonly origin: string;
	readonly superuserId: string;
	readonly userIds: ReadonlyMap<string, string>;
}

/**
 * Submits one Pendaftaran per account and approves every one of them, leaving each person with a
 * `residents` row, their default Langganan and a Masa Huni on the house `unitLabelFor` gives them.
 *
 * The claim on the form is the house they are really given, so the admin screen would have shown a
 * matched claim — a Data Contoh whose registrations all look like typos would be a poor example of
 * the screen it is meant to fill.
 */
async function approveEveryone(
	db: Database,
	clock: Clock,
	context: ApprovalContext
): Promise<ReadonlyMap<string, SeededPerson>> {
	const unitIds = await unitIdsByLabel(db);

	for (const [index, account] of context.accounts.entries()) {
		const label = unitLabelFor(account.email, index);
		await submitRegistration(db, clock, {
			name: account.name,
			email: account.email,
			claimedBlock: label.slice(0, 1),
			claimedNumber: label.slice(2)
		});
	}

	const pending = await listPendingRegistrations(db, context.superuserId);
	const registrationIds = new Map(pending.map((row) => [row.email, row.registrationId]));

	const people = new Map<string, SeededPerson>();
	for (const [index, account] of context.accounts.entries()) {
		const label = unitLabelFor(account.email, index);
		const approved = await approveRegistration(db, clock, {
			actorId: context.superuserId,
			registrationId: requireValue(
				registrationIds.get(account.email),
				`registration ${account.email}`
			),
			unitId: requireValue(unitIds.get(label), `unit ${label}`),
			origin: context.origin
		});
		people.set(account.email, {
			email: account.email,
			name: account.name,
			userId: requireValue(context.userIds.get(account.email), `account ${account.email}`),
			residentId: approved.residentId,
			unitLabel: label
		});
	}
	return people;
}

/**
 * Every house's id, keyed by `SeedUnit.label`.
 *
 * Read straight off `units` rather than collected from `createUnit`'s return values, so that the
 * two callers — the approval loop and the payment loop — ask the same question of the same table
 * and cannot end up holding two different ideas of which id is `A-01`.
 */
async function unitIdsByLabel(db: Database): Promise<ReadonlyMap<string, string>> {
	const rows = await db
		.select({ id: units.id, block: units.block, number: units.number })
		.from(units);
	return new Map(rows.map((row) => [`${row.block}-${row.number}`, row.id]));
}

/**
 * Marks one Penanggung Jawab per house: the first Warga recorded as living there.
 *
 * `approveRegistration` never sets the flag — that is a superuser decision with its own uniqueness
 * rule, made on its own screen — so the seeder makes it here, the way the screen does. It matters
 * beyond looking complete: `notifyInvoiceIssued` has nobody to send a Tagihan to on a house with no
 * running Penanggung Jawab, and the issuance run would report every house as unnotified.
 *
 * @returns how many houses now have one.
 */
async function markPrimaryOccupants(
	db: Database,
	clock: Clock,
	superuserId: string,
	unitIds: ReadonlyMap<string, string>,
	people: ReadonlyMap<string, SeededPerson>
): Promise<number> {
	let marked = 0;
	for (const unit of SEED_UNITS) {
		const unitId = requireValue(unitIds.get(unit.label), `unit ${unit.label}`);
		const occupancies = await listUnitOccupancies(db, clock, superuserId, unitId);
		const residentIds = new Set(
			[...people.values()]
				.filter((person) => person.unitLabel === unit.label && !isPengurus(person.email))
				.map((person) => person.residentId)
		);
		const first = occupancies.findLast((record) => residentIds.has(record.residentId));
		if (!first) {
			continue;
		}
		await setPrimaryOccupant(db, clock, { actorId: superuserId, occupancyId: first.occupancyId });
		marked += 1;
	}
	return marked;
}

/** Whether an address belongs to one of the two pengurus accounts. */
function isPengurus(email: string): boolean {
	return email === SUPERUSER_EMAIL || email === ADMIN_EMAIL;
}

/** Sets the one Tarif, running since the first of last month. */
async function seedDuesRate(
	db: Database,
	clock: Clock,
	superuserId: string,
	period: string
): Promise<void> {
	await createDuesRate(db, clock, {
		actorId: superuserId,
		amount: rupiah(DUES_AMOUNT),
		effectiveFrom: firstDayOfPreviousMonth(period)
	});
}

/** Adds the ordinary Kategori Kas and answers how many there are in total afterwards. */
async function seedCashCategories(
	db: Database,
	clock: Clock,
	superuserId: string
): Promise<number> {
	for (const category of SEED_CASH_CATEGORIES) {
		await createCashCategory(db, clock, {
			actorId: superuserId,
			name: category.name,
			type: category.type
		});
	}
	return (await listActiveCashCategories(db)).length;
}

/**
 * Issues this month's Tagihan **through the scheduled job**, not by calling
 * `issueInvoicesForPeriod` directly.
 *
 * That is the point of doing it this way: `runJob` claims `(issue-invoices, YYYY-MM)` in `job_runs`
 * and marks it `succeeded`, and a `succeeded` row keeps its slot in `job_runs_claim_unique` for
 * good. So a superuser who then presses "jalankan sekarang" on `/admin/jobs` is answered `skipped`
 * and no second month of Tagihan is issued — which is exactly what the acceptance criteria asks
 * somebody to check by hand.
 *
 * @returns `describeIssuance`'s own line, so the summary reports what the run came to rather than a
 *   number this function counted for itself.
 */
async function issueThisMonth(db: Database, clock: Clock): Promise<string> {
	let line = 'no issuance summary was reported';
	const outcome = await runJob({
		db,
		clock,
		job: invoiceIssuanceJob({
			report: (summary) => {
				line = describeIssuance(summary);
			}
		})
	});
	if (outcome.outcome !== 'succeeded') {
		throw new Error(
			`The invoice issuance job came to "${outcome.outcome}" for period ${outcome.period}${outcome.error ? `: ${outcome.error}` : ''}. The Data Contoh needs it to succeed, because every Pembayaran below answers a Tagihan it issues.`
		);
	}
	return line;
}

/** Everything `seedPayments` needs beyond the database, the clock and the file store. */
interface PaymentContext {
	readonly admin: SeededPerson;
	readonly people: ReadonlyMap<string, SeededPerson>;
	readonly unitIds: ReadonlyMap<string, string>;
	readonly dated: SeedCalendar;
}

/**
 * Records every Pembayaran in `SEED_PAYMENTS` and decides each one, in table order.
 *
 * The Warga records their own payment and the admin decides it, which is the real pair of actions:
 * `recordPayment` refuses a house the caller is not living in, and `verifyPayment` refuses a caller
 * without `verifyPayments`. Doing it any other way would produce rows the application cannot.
 */
async function seedPayments(
	db: Database,
	clock: Clock,
	fileStore: FileStore,
	context: PaymentContext
): Promise<void> {
	for (const seeded of SEED_PAYMENTS) {
		const payer = residentAt(context.people, seeded.payer);
		const payment = await recordPayment(db, clock, fileStore, {
			actorUserId: payer.userId,
			unitId: requireValue(context.unitIds.get(seeded.unit), `unit ${seeded.unit}`),
			amount: rupiah(seeded.amount),
			receivedOn: dayInSeedMonth(context.dated.period, seeded.day, context.dated.latestDay),
			proof: { contentType: SMALL_PNG_CONTENT_TYPE, content: smallPngBytes() }
		});
		await decidePayment(db, clock, context.admin.userId, seeded, payment.id);
	}
}

/** Verifies, rejects or leaves one Pembayaran, according to its row's outcome. */
async function decidePayment(
	db: Database,
	clock: Clock,
	adminUserId: string,
	seeded: SeedPayment,
	paymentId: string
): Promise<void> {
	if (seeded.outcome === PAYMENT_OUTCOME.verified) {
		await verifyPayment(db, clock, { actorId: adminUserId, paymentId });
		return;
	}
	if (seeded.outcome === PAYMENT_OUTCOME.rejected) {
		await rejectPayment(db, clock, {
			actorId: adminUserId,
			paymentId,
			reason: requireValue(seeded.reason, `rejection reason for ${seeded.unit}`)
		});
	}
	// A `pending` row is left exactly as `recordPayment` wrote it — that is what makes it pending.
}

/**
 * Records the month's Transaksi Kas keluar and the one Koreksi.
 *
 * @returns how many Koreksi were written.
 */
async function seedCashBook(
	db: Database,
	clock: Clock,
	fileStore: FileStore,
	adminUserId: string,
	dated: SeedCalendar
): Promise<number> {
	const categories = new Map(
		(await listActiveCashCategories(db)).map((category) => [category.name, category.id])
	);

	const written: string[] = [];
	for (const expense of SEED_CASH_EXPENSES) {
		const row = await recordCashTransaction(db, clock, fileStore, {
			actorId: adminUserId,
			occurredOn: dayInSeedMonth(dated.period, expense.day, dated.latestDay),
			categoryId: requireValue(categories.get(expense.category), `category ${expense.category}`),
			amount: rupiah(expense.amount),
			description: expense.description
		});
		written.push(row.id);
	}

	await recordCashCorrection(db, clock, {
		actorId: adminUserId,
		transactionId: requireValue(written[CORRECTED_EXPENSE_INDEX], 'the expense row to correct'),
		reason: CORRECTION_REASON
	});
	return 1;
}

/**
 * Writes the six Posts and moves each to the state its row asks for.
 *
 * `createPost` always writes a `draft`, so a published Post is created and then published, and an
 * archived one is created, published and archived — the path `isAllowedPostTransition` permits and
 * the one an admin walks on the screen.
 */
async function seedPosts(
	db: Database,
	clock: Clock,
	fileStore: FileStore,
	adminUserId: string,
	dated: SeedCalendar
): Promise<void> {
	for (const seeded of SEED_POSTS) {
		const post = await createPost(db, clock, {
			actorId: adminUserId,
			type: seeded.type as 'event' | 'announcement',
			title: seeded.title,
			summary: seeded.summary,
			bodyHtml: seeded.bodyHtml,
			category: seeded.category,
			startsAt: eventInstant(seeded, seeded.startTime, dated),
			endsAt: eventInstant(seeded, seeded.endTime, dated),
			location: seeded.location ?? null
		});

		if (seeded.cover) {
			await setPostCoverImage(db, clock, fileStore, {
				actorId: adminUserId,
				postId: post.id,
				contentType: SMALL_PNG_CONTENT_TYPE,
				content: smallPngBytes()
			});
		}
		await movePostToStatus(db, clock, adminUserId, post.id, seeded.status);
	}
}

/**
 * One end of an event's time, as an instant, or `null` for an announcement.
 *
 * `combineCivilDateTime` is the one place a WIB civil date and an `HH:mm` become a `Date`, so the
 * seeder's events land at the same instant the Post form would have produced for the same two
 * fields.
 */
function eventInstant(
	seeded: SeedPost,
	time: string | undefined,
	dated: SeedCalendar
): Date | null {
	if (seeded.startDay === undefined || time === undefined) {
		return null;
	}
	// Not clamped to today: an event is something that has not happened yet, and `posts` has no rule
	// against a future `startsAt` — unlike money, which `assertReceiptDay` refuses to date forward.
	const day = `${dated.period}-${String(seeded.startDay).padStart(2, '0')}`;
	return combineCivilDateTime(day, time);
}

/** Publishes and archives one Post as far as its row asks. A `draft` is already where it belongs. */
async function movePostToStatus(
	db: Database,
	clock: Clock,
	adminUserId: string,
	postId: string,
	status: string
): Promise<void> {
	if (status === 'draft') {
		return;
	}
	await publishPost(db, clock, { actorId: adminUserId, postId });
	if (status === 'archived') {
		await archivePost(db, clock, { actorId: adminUserId, postId });
	}
}

/** The statuses one Keluhan is walked through by the pengurus, in order, to reach its row's state. */
const COMPLAINT_PATHS: Readonly<Record<string, readonly string[]>> = {
	new: [],
	withdrawn: [],
	reviewing: ['reviewing'],
	working: ['reviewing', 'working'],
	resolved: ['reviewing', 'working', 'resolved'],
	rejected: ['rejected']
};

/**
 * Files the ten Keluhan, adds the Tanggapan, and walks each to its status.
 *
 * The Tanggapan is added before the status moves, so that a Keluhan that ends `rejected` or
 * `withdrawn` still carries one: those are terminal states, and a reply written afterwards would be
 * a reply to a conversation that is over.
 */
async function seedComplaints(
	db: Database,
	clock: Clock,
	fileStore: FileStore,
	adminUserId: string,
	people: ReadonlyMap<string, SeededPerson>
): Promise<void> {
	for (const seeded of SEED_COMPLAINTS) {
		const reporter = residentAt(people, seeded.reporter);
		const complaint = await createComplaint(db, clock, fileStore, {
			actorId: reporter.userId,
			title: seeded.title,
			category: seeded.category,
			description: seeded.description,
			visibility: seeded.visibility as 'private' | 'public',
			attachments: seeded.attachment
				? [{ contentType: SMALL_PNG_CONTENT_TYPE, content: smallPngBytes() }]
				: []
		});

		if (seeded.reply) {
			await addComplaintReply(db, clock, {
				actorId: adminUserId,
				complaintId: complaint.id,
				content: seeded.reply
			});
		}
		await moveComplaintToStatus(db, clock, { adminUserId, reporter, seeded, id: complaint.id });
	}
}

/** Everything `moveComplaintToStatus` needs to walk one Keluhan to where its row asks. */
interface ComplaintMove {
	readonly adminUserId: string;
	readonly reporter: SeededPerson;
	readonly seeded: SeedComplaint;
	readonly id: string;
}

/**
 * Walks one Keluhan to its status through the transitions
 * `src/lib/server/services/complaint/state-machine.ts` permits.
 *
 * `withdrawn` is the reporter's own move and has its own function — an admin cannot withdraw
 * somebody else's Keluhan, which is precisely what that table enforces — so it is the one branch
 * here that does not go through `changeComplaintStatus`.
 */
async function moveComplaintToStatus(
	db: Database,
	clock: Clock,
	move: ComplaintMove
): Promise<void> {
	if (move.seeded.status === 'withdrawn') {
		await withdrawComplaint(db, clock, {
			actorId: move.reporter.userId,
			complaintId: move.id
		});
		return;
	}

	const path = COMPLAINT_PATHS[move.seeded.status] ?? [];
	for (const step of path) {
		await changeComplaintStatus(db, clock, {
			actorId: move.adminUserId,
			complaintId: move.id,
			to: step as 'reviewing' | 'working' | 'resolved' | 'rejected',
			rejectionReason: step === 'rejected' ? COMPLAINT_REJECTION_REASON : null
		});
	}
}

/** Switches on the optional Langganan a few Warga opted into. */
async function seedSubscriptions(
	db: Database,
	clock: Clock,
	people: ReadonlyMap<string, SeededPerson>
): Promise<void> {
	for (const optIn of SEED_SUBSCRIPTION_OPT_INS) {
		const resident = residentAt(people, optIn.resident);
		await setSubscriptionPreference(db, clock, {
			callerUserId: resident.userId,
			residentId: resident.residentId,
			kind: optIn.kind,
			enabled: true
		});
	}
}

/** The Warga at `index` in `RESIDENT_NAMES`, as a seeded person. */
function residentAt(people: ReadonlyMap<string, SeededPerson>, index: number): SeededPerson {
	const email = `warga${String(index + 1).padStart(2, '0')}@komplek.local`;
	return requirePerson(people, email);
}

/** One seeded person by address, or a failure naming the address that was missing. */
function requirePerson(people: ReadonlyMap<string, SeededPerson>, email: string): SeededPerson {
	return requireValue(people.get(email), `seeded account ${email}`);
}

/**
 * `value`, or a failure naming what was missing.
 *
 * @throws {TypeError} when `value` is `undefined`, which means the seeder lost track of something it
 *   had just written — a broken assumption, not a state worth continuing from.
 */
function requireValue<T>(value: T | undefined, what: string): T {
	if (value === undefined) {
		throw new TypeError(`The seeder lost track of ${what}.`);
	}
	return value;
}

/** The summary the command prints when it is done, one line per kind of thing. */
export function describeSeed(summary: SeedSummary): string {
	return [
		`Data Contoh seeded for period ${summary.period}.`,
		`  units                ${summary.units}`,
		`  residents            ${summary.residents} (${RESIDENT_COUNT} warga + 2 pengurus)`,
		`  occupancies          ${summary.occupancies}, of which ${summary.primaryOccupants} are Penanggung Jawab`,
		`  cash categories      ${summary.cashCategories} (including the 2 seeded by migration)`,
		`  invoices             ${summary.invoices}`,
		`  payments             ${summary.paymentsVerified} verified, ${summary.paymentsPending} pending, ${summary.paymentsRejected} rejected`,
		`  cash transactions    ${summary.cashExpenses} expenses, ${summary.cashCorrections} correction`,
		`  posts                ${summary.posts}`,
		`  complaints           ${summary.complaints}`,
		`  subscription opt-ins ${summary.subscriptionOptIns}`,
		`  overdue units        ${summary.overdueUnits}`,
		`  issuance             ${summary.issuance}`,
		'',
		`Sign in with ${SUPERUSER_EMAIL}, ${ADMIN_EMAIL}, or warga01@komplek.local … warga${String(RESIDENT_COUNT).padStart(2, '0')}@komplek.local.`,
		`Every account's password is ${SEED_PASSWORD}.`
	].join('\n');
}

/** Opens a connection, seeds, prints, and closes whatever it opened. */
async function main(): Promise<number> {
	assertSeedAllowed(process.env, process.argv.slice(2));

	const connection = createConnection(readDatabaseUrl());
	try {
		const summary = await seedDevelopmentData({
			db: connection.db,
			clock: systemClock,
			fileStore: localFileStoreFromEnvironment(systemClock),
			origin: readOrigin(),
			secret: readAuthSecret(),
			storageRoot: process.env.FILE_STORE_ROOT?.trim() || DEFAULT_FILE_STORE_ROOT
		});
		console.log(describeSeed(summary));
		return 0;
	} finally {
		await connection.close();
	}
}

/**
 * `import.meta.main` is Bun's "this file is the entry point". It is not in `@types/node`, which is
 * the only ambient typing this repository installs, so it is read through a local interface rather
 * than with a cast that would also silence a real mistake.
 *
 * The guard is what lets `tests/unit/seed-dev.test.ts` import `assertSeedAllowed` and
 * `seedDevelopmentData` without the command running itself against `DATABASE_URL` the moment the
 * test file is loaded.
 */
interface EntryPointMeta {
	readonly main?: boolean;
}

if ((import.meta as EntryPointMeta).main === true) {
	try {
		process.exit(await main());
	} catch (error) {
		// A refused guard, a missing variable and a database that will not answer all land here. The
		// message alone is what an operator needs; the stack trace is noise at a shell prompt — the
		// same choice `scripts/grant-superuser.ts` makes.
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
