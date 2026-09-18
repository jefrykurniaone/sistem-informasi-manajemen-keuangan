import { and, asc, desc, eq } from 'drizzle-orm';
import { recordAuditEntry } from '../../audit';
import { AUTH_PATHS } from '../../auth';
import { ACTION, requirePermission, type DatabaseWriter, type Transaction } from '../../authz';
import type { Database } from '../../db';
import { user } from '../../db/schema/auth';
import { occupancies, OCCUPANCY_ROLE } from '../../db/schema/occupancy';
import {
	registrations,
	REGISTRATION_STATUS,
	type Registration,
	type RegistrationStatus
} from '../../db/schema/registration';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import { enqueueEmail } from '../../email/queue';
import {
	REGISTRATION_APPROVED_KIND,
	registrationApprovedPayload
} from '../../email/templates/registration-approved';
import type { Clock } from '../../ports/clock';
import { currentDay, stillRunningOn } from '../occupancy/visibility';
import { ensureDefaultSubscriptions } from '../subscription';
import { UnitNotFoundError } from '../unit';

/**
 * Pendaftaran: the way in for someone nobody invited. They sign themselves up, say which house they
 * live in, and wait — the claim is a sentence they typed, and a superuser is the one who checks it.
 * Every rule about what a registration is worth before and after that check is here, not in a route.
 *
 * ## The claim never grants anything, and that is enforced twice
 *
 * A `registrations` row is a request and nothing else. It has no foreign key to `units` (see the
 * decisions in `src/lib/server/db/schema/registration.ts`) and nothing in this module reads
 * `claimedBlock` or `claimedNumber` to decide access. Approval writes a Masa Huni on the unit the
 * *superuser* chose, which may be a different one.
 *
 * What actually refuses an unapproved registrant is the service layer, not a page:
 *
 * - They have no `residents` row, so `residentProfileForUser` answers `undefined` and
 *   `occupiedUnitsForUser` answers an empty list — every Warga service is keyed by one of those.
 * - They hold only the `resident` role the `user_created_gets_resident_role_trigger` grants, and no
 *   entry in `PERMISSIONS` names that role, so `requirePermission` refuses them every action there
 *   is.
 *
 * `src/routes/(app)/+layout.server.ts` redirects them to `/pending-approval` on top of that. That
 * guard is the experience, never the boundary: a layout `load` does not run for a child page's form
 * action, so a guard written only there would be one form post away from nothing.
 *
 * ## Submitting: the account first, the row second
 *
 * `submitRegistration` writes the row and nothing else. The account is better-auth's — `/register`
 * calls `signUpEmail` before calling this — and the order is deliberate, because `signUpEmail` runs
 * outside any transaction this module opens and cannot be rolled back with one:
 *
 * - **Account first, then the row.** If the row were written first and `signUpEmail` then failed,
 *   the result would be a `pending` registration for an address with no account. That row cannot be
 *   approved (see `RegistrationAccountMissingError`), and `registrations_pending_email_unique` would
 *   stop the person from ever submitting the form again — a dead end nobody can leave.
 * - The other order's failure mode is an account with no registration, which the person leaves by
 *   submitting the form again: better-auth answers a duplicate address with the same shape as a new
 *   one, and the row then lands.
 *
 * **The answer is the same whether or not anything was written.** `submitRegistration` returns
 * nothing and swallows the pending-uniqueness conflict with `onConflictDoNothing`, so a second
 * submission for an address that is already waiting is indistinguishable from a first one. That is
 * the same anti-enumeration property `/register` already had from better-auth, and a function that
 * reported "already waiting" would hand it back.
 *
 * ## Deciding: one atomic claim, and only once
 *
 * Approving and rejecting both go through `claimRegistration`, which moves the row out of `pending`
 * with `update … where id = … and status = 'pending' returning` — the same single-use shape
 * `acceptInvitation` uses on a token. Two superusers pressing approve at the same instant therefore
 * produce exactly one decision and exactly one Masa Huni; the loser is refused with
 * `RegistrationAlreadyDecidedError` rather than writing a second stay.
 *
 * ## What approval creates, and in which transaction
 *
 * One transaction covers the decision, the `residents` row, its default Langganan, the Masa Huni,
 * the queued email and the audit row. **No account is created**: the registrant already has one, and
 * this module looks it up by `user.email`, which better-auth stores lower-cased — a registration
 * whose account is missing is refused by name rather than papered over with an account nobody asked
 * for.
 *
 * **The occupancy role defaults to `owner`**, for the reason
 * `src/lib/server/services/invitation/index.ts` records: `registrations` has no role column, so the
 * approval form cannot carry a pemilik/penyewa choice, and a superuser corrects the odd tenant on
 * the occupancy screen. The stay starts on the approval day per the `Clock`, is created only when
 * the resident has no running stay on that unit already, and is never marked Penanggung Jawab —
 * that flag is a superuser decision with its own uniqueness rule, made on its own screen.
 */

/** The audit log's `action` for a registration a superuser let in. */
export const REGISTRATION_APPROVED_ACTION = 'registration_approved';
/** The audit log's `action` for a registration a superuser turned down. */
export const REGISTRATION_REJECTED_ACTION = 'registration_rejected';

/** Thrown when `registrationId` names no registration at all. A 404, like `UnitNotFoundError`. */
export class RegistrationNotFoundError extends Error {
	override readonly name = 'RegistrationNotFoundError';

	/** The id that named no registration. */
	readonly registrationId: string;

	constructor(registrationId: string) {
		super(`No registration exists with id "${registrationId}".`);
		this.registrationId = registrationId;
	}
}

/**
 * Thrown when the registration has already been approved or rejected — including by a superuser who
 * pressed the other button a moment earlier on another screen.
 */
export class RegistrationAlreadyDecidedError extends Error {
	override readonly name = 'RegistrationAlreadyDecidedError';

	/** The registration that was already decided. */
	readonly registrationId: string;
	/** What it was decided to be. */
	readonly status: RegistrationStatus;

	constructor(registrationId: string, status: RegistrationStatus) {
		super(`Registration "${registrationId}" has already been decided as "${status}".`);
		this.registrationId = registrationId;
		this.status = status;
	}
}

/**
 * Thrown when a registration is approved but no `user` row carries its address — the row landed and
 * the sign-up that should have preceded it did not. Approving creates a house, never an account, so
 * there is nothing this service may do about it except say so.
 */
export class RegistrationAccountMissingError extends Error {
	override readonly name = 'RegistrationAccountMissingError';

	/** The address that has a registration but no account. */
	readonly email: string;

	constructor(email: string) {
		super(`No account exists for "${email}", so this registration cannot be approved.`);
		this.email = email;
	}
}

/** What somebody filled in at `/register`, beyond the name, address and password better-auth took. */
export interface SubmitRegistrationRequest {
	/** The registrant's name, as they typed it. */
	readonly name: string;
	/** The address they signed up with. Lower-cased here, the way better-auth stores it. */
	readonly email: string;
	/** The block they say they live in. Never checked against `units` before a superuser looks. */
	readonly claimedBlock: string;
	/** The house number they say they live at. */
	readonly claimedNumber: string;
}

/**
 * Records one request to be let in, waiting for a superuser.
 *
 * Returns nothing, whatever happened — see this module's doc comment on why an address that is
 * already waiting must be answered exactly like one that was not.
 *
 * @throws {TypeError} when the name, the address, the block or the number is empty after trimming.
 *   The page checks these first, so reaching this is a broken caller rather than a bad form.
 */
export async function submitRegistration(
	db: DatabaseWriter,
	clock: Clock,
	request: SubmitRegistrationRequest
): Promise<void> {
	const name = request.name.trim();
	const email = request.email.trim().toLowerCase();
	const claimedBlock = request.claimedBlock.trim();
	const claimedNumber = request.claimedNumber.trim();

	if (name === '' || email === '' || claimedBlock === '' || claimedNumber === '') {
		throw new TypeError('A registration needs a name, an address, a block and a house number.');
	}

	await db
		.insert(registrations)
		.values({
			name,
			email,
			claimedBlock,
			claimedNumber,
			status: REGISTRATION_STATUS.pending,
			rejectionReason: null,
			reviewedBy: null,
			reviewedAt: null,
			createdAt: clock.now()
		})
		// `registrations_pending_email_unique` refusing a second waiting row for one address is a
		// normal outcome, not an error: the first row is the request, and the form must answer the
		// same way either way.
		.onConflictDoNothing();
}

/** The house a claim turned out to name, when it named one. */
export interface MatchedUnit {
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
}

/** One line of the superuser's queue: a request, and what its claim matched. */
export interface PendingRegistration {
	readonly registrationId: string;
	readonly name: string;
	readonly email: string;
	readonly claimedBlock: string;
	readonly claimedNumber: string;
	readonly createdAt: Date;
	/** The unit the claim names, or `undefined` when it names none — which is shown, not refused. */
	readonly matchedUnit: MatchedUnit | undefined;
}

/**
 * Every registration still waiting, oldest first, each with the unit its claim matches.
 *
 * A claim is matched to a house by its (block, number) pair trimmed and compared without regard to
 * case, which is as far as normalising goes: `units` stores both columns as the sign on the house
 * spells them (see `src/lib/server/db/schema/unit.ts`), and `createUnit` only trims. A claim that
 * matches nothing comes back with `matchedUnit: undefined`, and the screen shows that rather than
 * hiding the row — the registration is still a real request, and an unrecognised address is exactly
 * the thing a superuser is being asked to look at.
 *
 * **Only units still in service are matched.** A deactivated house is not one anybody can be moved
 * into, and the approval form only offers the units the register lists as active, so matching a
 * claim to a deactivated one would preselect an option that form does not have.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 */
export async function listPendingRegistrations(
	db: Database,
	actorId: string
): Promise<readonly PendingRegistration[]> {
	await requirePermission(db, actorId, ACTION.manageRegistrations);

	const [waiting, register] = await Promise.all([
		db
			.select()
			.from(registrations)
			.where(eq(registrations.status, REGISTRATION_STATUS.pending))
			.orderBy(asc(registrations.createdAt)),
		db
			.select({ unitId: units.id, block: units.block, number: units.number })
			.from(units)
			.where(eq(units.isActive, true))
	]);

	const byClaim = new Map(register.map((unit) => [claimKey(unit.block, unit.number), unit]));
	return waiting.map((row) => ({
		registrationId: row.id,
		name: row.name,
		email: row.email,
		claimedBlock: row.claimedBlock,
		claimedNumber: row.claimedNumber,
		createdAt: row.createdAt,
		matchedUnit: byClaim.get(claimKey(row.claimedBlock, row.claimedNumber))
	}));
}

/** Who is deciding, which registration, and which house they chose for it. */
export interface ApproveRegistrationRequest {
	/** The superuser deciding. Checked against `ACTION.manageRegistrations` before anything else. */
	readonly actorId: string;
	readonly registrationId: string;
	/** The house to attach them to. May be a different one from the claim. */
	readonly unitId: string;
	/** The origin the sign-in link is built on, from `readOrigin()` — never from a request header. */
	readonly origin: string;
}

/** What approving one registration ended in. */
export interface ApprovedRegistration {
	readonly registrationId: string;
	/** The account that already existed, found by the registration's address. */
	readonly userId: string;
	readonly residentId: string;
	readonly unitId: string;
	/** The address the account signs in with, exactly as the `user` row stores it. */
	readonly email: string;
	/** False when a running stay on that unit already existed, so none was added. */
	readonly createdOccupancy: boolean;
}

/**
 * Lets a registration in: the row is claimed as approved, the person becomes a Warga with their
 * default Langganan and a Masa Huni on the unit the superuser chose, the approval email is queued,
 * and one audit row records it — all in one transaction. See the module doc comment for every
 * decision in that sentence.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {UnitNotFoundError} when `unitId` names no unit.
 * @throws {RegistrationNotFoundError} when `registrationId` names no registration.
 * @throws {RegistrationAlreadyDecidedError} when it was already approved or rejected, including by
 *   a racing second decision.
 * @throws {RegistrationAccountMissingError} when no account carries the registration's address.
 */
export async function approveRegistration(
	db: Database,
	clock: Clock,
	request: ApproveRegistrationRequest
): Promise<ApprovedRegistration> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageRegistrations);

		const now = clock.now();
		const [unit] = await transaction
			.select({ block: units.block, number: units.number })
			.from(units)
			.where(eq(units.id, request.unitId))
			.limit(1);
		if (!unit) {
			throw new UnitNotFoundError(request.unitId);
		}

		const registration = await claimRegistration(transaction, {
			registrationId: request.registrationId,
			actorId: request.actorId,
			status: REGISTRATION_STATUS.approved,
			rejectionReason: null,
			now
		});

		const [account] = await transaction
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, registration.email))
			.limit(1);
		if (!account) {
			throw new RegistrationAccountMissingError(registration.email);
		}

		const residentId = await ensureResident(transaction, clock, account.id, now);
		const createdOccupancy = await ensureOccupancy(transaction, clock, {
			unitId: request.unitId,
			residentId,
			now
		});

		await enqueueEmail(transaction, clock, {
			recipient: registration.email,
			kind: REGISTRATION_APPROVED_KIND,
			payload: registrationApprovedPayload({
				url: signInLink(request.origin),
				block: unit.block,
				number: unit.number
			})
		});

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: REGISTRATION_APPROVED_ACTION,
			targetId: registration.id,
			before: { status: REGISTRATION_STATUS.pending },
			after: {
				status: registration.status,
				email: registration.email,
				unitId: request.unitId,
				residentId,
				createdOccupancy
			}
		});

		return {
			registrationId: registration.id,
			userId: account.id,
			residentId,
			unitId: request.unitId,
			email: registration.email,
			createdOccupancy
		};
	});
}

/** Who is deciding, which registration, and the reason the registrant will read. */
export interface RejectRegistrationRequest {
	/** The superuser deciding. Checked against `ACTION.manageRegistrations` before anything else. */
	readonly actorId: string;
	readonly registrationId: string;
	/** Why. Required here, although `registrations_rejection_reason_check` only forbids the reverse. */
	readonly reason: string;
}

/**
 * Turns a registration down, with the reason the registrant reads on `/pending-approval`, and one
 * audit row. Nothing else is written: no account is touched, and there is no Masa Huni to undo.
 *
 * The reason is required here rather than by the table. `registrations_rejection_reason_check` only
 * forbids a reason on a row that is not rejected, because whether a superuser must type one is a
 * rule about the form — and this service is that rule's one home, so the screen cannot forget it.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when the reason is empty after trimming.
 * @throws {RegistrationNotFoundError} when `registrationId` names no registration.
 * @throws {RegistrationAlreadyDecidedError} when it was already approved or rejected.
 */
export async function rejectRegistration(
	db: Database,
	clock: Clock,
	request: RejectRegistrationRequest
): Promise<Registration> {
	const reason = request.reason.trim();
	if (reason === '') {
		throw new TypeError('Rejecting a registration needs a reason the registrant can read.');
	}

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageRegistrations);

		const now = clock.now();
		const registration = await claimRegistration(transaction, {
			registrationId: request.registrationId,
			actorId: request.actorId,
			status: REGISTRATION_STATUS.rejected,
			rejectionReason: reason,
			now
		});

		await recordAuditEntry(transaction, clock, {
			actorId: request.actorId,
			action: REGISTRATION_REJECTED_ACTION,
			targetId: registration.id,
			before: { status: REGISTRATION_STATUS.pending },
			after: { status: registration.status, email: registration.email, rejectionReason: reason }
		});

		return registration;
	});
}

/** What `/pending-approval` tells one person about their own request. */
export interface OwnRegistration {
	readonly status: RegistrationStatus;
	/** Why it was turned down, when it was. */
	readonly rejectionReason: string | null;
	readonly claimedBlock: string;
	readonly claimedNumber: string;
	readonly createdAt: Date;
}

/**
 * The most recent registration submitted with `email`, or `undefined` when there is none.
 *
 * Keyed by the address alone, and the only caller passes the signed-in account's own — which is why
 * this read needs no action and no actor: there is no id in a URL or a form that anybody could swap
 * for somebody else's, the same reasoning
 * `src/lib/server/services/resident/profile.ts` records for guarding by row ownership.
 *
 * The newest row is the answer because a rejected registrant may submit again: the older, rejected
 * rows are history, and the page is about where they stand now.
 */
export async function ownRegistrationStatus(
	db: DatabaseWriter,
	email: string
): Promise<OwnRegistration | undefined> {
	const [row] = await db
		.select({
			status: registrations.status,
			rejectionReason: registrations.rejectionReason,
			claimedBlock: registrations.claimedBlock,
			claimedNumber: registrations.claimedNumber,
			createdAt: registrations.createdAt
		})
		.from(registrations)
		.where(eq(registrations.email, email.trim().toLowerCase()))
		.orderBy(desc(registrations.createdAt))
		.limit(1);
	return row;
}

/** What one decision needs, once the caller's transaction and permission are settled. */
interface RegistrationDecision {
	readonly registrationId: string;
	readonly actorId: string;
	readonly status: RegistrationStatus;
	readonly rejectionReason: string | null;
	readonly now: Date;
}

/**
 * Moves one registration out of `pending`, and refuses when it is not there any more.
 *
 * The `status = 'pending'` predicate on the update is what makes a decision single-use under
 * concurrency: of two racing decisions, exactly one gets the row back, so approval can never create
 * two Masa Huni for one request.
 */
async function claimRegistration(
	transaction: Transaction,
	decision: RegistrationDecision
): Promise<Registration> {
	const [found] = await transaction
		.select()
		.from(registrations)
		.where(eq(registrations.id, decision.registrationId))
		.limit(1);
	if (!found) {
		throw new RegistrationNotFoundError(decision.registrationId);
	}
	if (found.status !== REGISTRATION_STATUS.pending) {
		throw new RegistrationAlreadyDecidedError(decision.registrationId, found.status);
	}

	const [claimed] = await transaction
		.update(registrations)
		.set({
			status: decision.status,
			rejectionReason: decision.rejectionReason,
			reviewedBy: decision.actorId,
			reviewedAt: decision.now
		})
		.where(
			and(
				eq(registrations.id, decision.registrationId),
				eq(registrations.status, REGISTRATION_STATUS.pending)
			)
		)
		.returning();
	if (!claimed) {
		throw new RegistrationAlreadyDecidedError(
			decision.registrationId,
			await decidedStatusOf(transaction, decision.registrationId)
		);
	}
	return claimed;
}

/**
 * What a registration another decision got to first ended up as. Read only on that losing path, so
 * the error names the decision that actually won rather than guessing at one.
 */
async function decidedStatusOf(
	transaction: Transaction,
	registrationId: string
): Promise<RegistrationStatus> {
	const [row] = await transaction
		.select({ status: registrations.status })
		.from(registrations)
		.where(eq(registrations.id, registrationId))
		.limit(1);
	return row?.status ?? REGISTRATION_STATUS.approved;
}

/** The `residents` row for `userId`, created — with its default Langganan — when missing. */
async function ensureResident(
	transaction: Transaction,
	clock: Clock,
	userId: string,
	now: Date
): Promise<string> {
	const [existing] = await transaction
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, userId))
		.limit(1);
	if (existing) {
		return existing.id;
	}

	const [created] = await transaction
		.insert(residents)
		.values({ userId, createdAt: now })
		.returning({ id: residents.id });
	await ensureDefaultSubscriptions(transaction, clock, created.id);
	return created.id;
}

/** Which house, for whom, and when — everything `ensureOccupancy` needs beyond its transaction. */
interface OccupancyToEnsure {
	readonly unitId: string;
	readonly residentId: string;
	readonly now: Date;
}

/**
 * The Masa Huni the approval promises, unless one is already running: role `owner` (see the module
 * doc comment), starting on the approval day, never the Penanggung Jawab.
 */
async function ensureOccupancy(
	transaction: Transaction,
	clock: Clock,
	stay: OccupancyToEnsure
): Promise<boolean> {
	const today = currentDay(clock);
	const [running] = await transaction
		.select({ id: occupancies.id })
		.from(occupancies)
		.where(
			and(
				eq(occupancies.unitId, stay.unitId),
				eq(occupancies.residentId, stay.residentId),
				stillRunningOn(occupancies.endedOn, today)
			)
		)
		.limit(1);
	if (running) {
		return false;
	}

	await transaction.insert(occupancies).values({
		unitId: stay.unitId,
		residentId: stay.residentId,
		role: OCCUPANCY_ROLE.owner,
		startedOn: today,
		endedOn: null,
		isPrimaryOccupant: false,
		createdAt: stay.now
	});
	return true;
}

/**
 * The key a claimed address and a registered house are compared by: both halves trimmed and
 * lower-cased, then written as JSON rather than joined by a separator — a block and a number are
 * free text, so any separator could appear inside one of them and make `A-1` and `A` `-1` the same
 * house.
 */
function claimKey(block: string, number: string): string {
	return JSON.stringify([block.trim().toLowerCase(), number.trim().toLowerCase()]);
}

/** The link the approval email carries: this application's own sign-in page under `origin`. */
function signInLink(origin: string): string {
	return `${origin.replace(/\/+$/, '')}${AUTH_PATHS.login}`;
}
