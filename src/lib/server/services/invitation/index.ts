import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { recordAuditEntry } from '../../audit';
import { MAXIMUM_PASSWORD_LENGTH, MINIMUM_PASSWORD_LENGTH, type Auth } from '../../auth';
import { ACTION, requirePermission, type Transaction } from '../../authz';
import type { Database } from '../../db';
import { account, user } from '../../db/schema/auth';
import { invitations, type Invitation } from '../../db/schema/invitation';
import { occupancies, OCCUPANCY_ROLE } from '../../db/schema/occupancy';
import { residents } from '../../db/schema/resident';
import { units } from '../../db/schema/unit';
import { enqueueEmail } from '../../email/queue';
import {
	INVITATION_KIND,
	INVITATION_LIFETIME_DAYS,
	invitationPayload
} from '../../email/templates/invitation';
import type { Clock } from '../../ports/clock';
import { currentDay, stillRunningOn } from '../occupancy/visibility';
import { ensureDefaultSubscriptions } from '../subscription';
import { UnitNotFoundError } from '../unit';
import { createInvitationToken, hashInvitationToken } from './token';

/**
 * Undangan: the controlled way in. A superuser sends a link to an email address about one house;
 * whoever opens that link sets their own password and becomes a Warga of that house. Every rule
 * about an invitation's life — how long it lasts, what "used" means, what accepting one creates —
 * is here, not in a route.
 *
 * ## The security shape, in one place
 *
 * - **The token is the whole credential.** 256 bits from `crypto.randomBytes` (see `./token.ts`),
 *   put into the email and never stored: `invitations.token_hash` holds only its SHA-256 digest,
 *   and redeeming looks the digest up through the table's unique index rather than comparing
 *   strings in application code.
 * - **Seven days, decided at send time.** `expiresAt` is stamped `createdAt + 7 days` from the same
 *   `INVITATION_LIFETIME_DAYS` the email's own text states, so the sentence a resident reads and
 *   the instant the database enforces cannot drift apart. A token presented at or after that
 *   instant is refused.
 * - **Single use is an atomic claim, not a read.** `acceptInvitation` marks the row used with
 *   `update … set used_at where id = … and used_at is null` and treats an empty result as "someone
 *   else got here first", so two racing redemptions of one link can never both create credentials.
 * - **Sending again invalidates the old link at that moment.** "Invalidated" is represented with
 *   the existing columns by setting `expiresAt` to now on every live row for the same
 *   (email, unit): `usedAt` would claim the link was redeemed, which is a different fact — an
 *   expired-now row reads back exactly as what it is, a link that stopped working early. The new
 *   row and the expiry of the old ones commit together.
 * - **An address that can already sign in is refused**, and the refusal names that case. "Can
 *   already sign in" means a `user` row with a `credential` account; a `user` row *without* one is
 *   accepted on purpose, because the CSV import (#19) creates exactly those — accounts waiting for
 *   their invitation.
 *
 * ## What accepting creates, and in which transaction
 *
 * One transaction covers the whole acceptance: the used-mark, the `user` row (or its
 * `emailVerified` flip), the `credential` account, the `residents` row, the default subscriptions,
 * the Masa Huni, and the audit row. A failure anywhere leaves nothing — no account without a house,
 * no house without an account.
 *
 * The password is hashed by **better-auth's own hasher**, handed in as a `PasswordHasher` — see
 * `passwordHasherOf`. Writing the `account` row directly with that hash is deliberately chosen over
 * `auth.api.signUpEmail`: the API call runs outside this transaction (its writes could survive a
 * rollback of ours), it queues a verification email for an address the invitation already proves,
 * and it opens a session from a code path that never saw the browser. Direct inserts keep the
 * atomicity; the hasher keeps `signInEmail` accepting the result, which
 * `tests/unit/invitation-service.test.ts` proves against a real instance.
 *
 * **The occupancy role defaults to `owner`.** The `invitations` table has no role column and this
 * ticket may not add one, so the admin form cannot carry a pemilik/penyewa choice; `owner` is the
 * overwhelmingly common case for an invited resident, and a superuser corrects the odd tenant on
 * the occupancy screen. Carrying the choice on the invitation is a schema follow-up, noted in the
 * PR that landed this file. The stay starts on the acceptance day per the `Clock`, is created only
 * when the resident has no running stay on that unit already, and is never marked primary occupant
 * here — that flag is a superuser decision with its own uniqueness rule, made on its own screen.
 */

/** The audit log's `action` for a newly sent invitation. */
export const INVITATION_SENT_ACTION = 'invitation_sent';
/** The audit log's `action` for an invitation that replaced an earlier one to the same address. */
export const INVITATION_RESENT_ACTION = 'invitation_resent';
/** The audit log's `action` for an invitation that was redeemed. */
export const INVITATION_ACCEPTED_ACTION = 'invitation_accepted';

/** Milliseconds in a day, for turning the seven-day lifetime into an instant. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The route group page that accepts a token, as a path under the origin. */
const ACCEPT_PATH = '/invitations';

/** better-auth's provider id for an email-and-password credential. */
const CREDENTIAL_PROVIDER = 'credential';

/** Hashes a password exactly the way sign-in will verify it. See `passwordHasherOf`. */
export type PasswordHasher = (password: string) => Promise<string>;

/**
 * The hasher of one better-auth instance, as `acceptInvitation` wants it. This is the same scrypt
 * configuration `signUpEmail` writes and `signInEmail` verifies, so a credential written with it is
 * indistinguishable from one created by an ordinary registration.
 */
export function passwordHasherOf(auth: Auth): PasswordHasher {
	return async (password) => {
		const context = await auth.$context;
		return context.password.hash(password);
	};
}

/** Thrown when a presented token matches no invitation at all. */
export class InvitationTokenUnknownError extends Error {
	override readonly name = 'InvitationTokenUnknownError';

	constructor() {
		super('The presented token matches no invitation.');
	}
}

/** Thrown when the invitation exists but its seven days are over, or it was invalidated by a resend. */
export class InvitationExpiredError extends Error {
	override readonly name = 'InvitationExpiredError';

	/** The instant the link stopped working. */
	readonly expiresAt: Date;

	constructor(expiresAt: Date) {
		super(`The invitation expired at ${expiresAt.toISOString()}.`);
		this.expiresAt = expiresAt;
	}
}

/** Thrown when the invitation was already redeemed — including by a racing second redemption. */
export class InvitationUsedError extends Error {
	override readonly name = 'InvitationUsedError';

	constructor() {
		super('The invitation has already been used.');
	}
}

/** Thrown when `invitationId` names no invitation row. A 404, like `UnitNotFoundError`. */
export class InvitationNotFoundError extends Error {
	override readonly name = 'InvitationNotFoundError';

	/** The id that named no invitation. */
	readonly invitationId: string;

	constructor(invitationId: string) {
		super(`No invitation exists with id "${invitationId}".`);
		this.invitationId = invitationId;
	}
}

/**
 * Thrown when the address can already sign in — a `user` row with a `credential` account. An
 * address with a `user` row but no credential is *not* this case; see the module doc comment.
 */
export class InvitationEmailAlreadyRegisteredError extends Error {
	override readonly name = 'InvitationEmailAlreadyRegisteredError';

	/** The address that already has a working account. */
	readonly email: string;

	constructor(email: string) {
		super(`The address "${email}" already has an account that can sign in.`);
		this.email = email;
	}
}

/** One address to invite to one house. */
export interface InvitationRecipient {
	readonly email: string;
	readonly unitId: string;
}

/** Who is asking, where the links should point, and who gets one. */
export interface SendInvitationsRequest {
	/** The user sending. Checked against `ACTION.manageInvitations` before anything else. */
	readonly actorId: string;
	/** The origin links are built on, from `readOrigin()` — never from a request header. */
	readonly origin: string;
	/** Everyone to invite. One entry sends one email; the whole list commits or none of it does. */
	readonly recipients: readonly InvitationRecipient[];
}

/**
 * Sends an invitation to each recipient: one row, one queued email and one audit entry per address,
 * all in one transaction — a refused recipient rolls the whole batch back, so a superuser never has
 * to guess which half of a list went out.
 *
 * Sending to an (email, unit) pair that already has a live invitation expires the old link in the
 * same transaction, so at most one link per pair works at any moment.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {TypeError} when the list is empty or an address is not shaped like an email.
 * @throws {UnitNotFoundError} when a recipient's `unitId` names no unit.
 * @throws {InvitationEmailAlreadyRegisteredError} when an address can already sign in.
 */
export async function sendInvitations(
	db: Database,
	clock: Clock,
	request: SendInvitationsRequest
): Promise<readonly Invitation[]> {
	const recipients = normalizeRecipients(request.recipients);

	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageInvitations);

		const sent: Invitation[] = [];
		for (const recipient of recipients) {
			sent.push(
				await issueInvitation(transaction, clock, {
					actorId: request.actorId,
					origin: request.origin,
					email: recipient.email,
					unitId: recipient.unitId,
					action: INVITATION_SENT_ACTION
				})
			);
		}
		return sent;
	});
}

/** Who is asking, and which unused invitation they want sent again. */
export interface ResendInvitationRequest {
	/** The user resending. Checked against `ACTION.manageInvitations` before anything else. */
	readonly actorId: string;
	readonly invitationId: string;
	/** The origin the new link is built on, from `readOrigin()`. */
	readonly origin: string;
}

/**
 * Sends an unused invitation again: a fresh token in a fresh row, and every older live link for the
 * same (email, unit) — the one being resent included — stops working in the same transaction.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 * @throws {InvitationNotFoundError} when `invitationId` names no invitation.
 * @throws {InvitationUsedError} when the invitation was already redeemed — there is nobody left to
 *   invite.
 * @throws {InvitationEmailAlreadyRegisteredError} when the address gained a working account since
 *   the original send.
 */
export async function resendInvitation(
	db: Database,
	clock: Clock,
	request: ResendInvitationRequest
): Promise<Invitation> {
	return db.transaction(async (transaction) => {
		await requirePermission(transaction, request.actorId, ACTION.manageInvitations);

		const [existing] = await transaction
			.select()
			.from(invitations)
			.where(eq(invitations.id, request.invitationId))
			.limit(1);
		if (!existing) {
			throw new InvitationNotFoundError(request.invitationId);
		}
		if (existing.usedAt !== null) {
			throw new InvitationUsedError();
		}

		return issueInvitation(transaction, clock, {
			actorId: request.actorId,
			origin: request.origin,
			email: existing.email,
			unitId: existing.unitId,
			action: INVITATION_RESENT_ACTION,
			previousInvitationId: existing.id
		});
	});
}

/** What one send or resend needs, once the caller's transaction and permission are settled. */
interface IssueInvitationRequest {
	readonly actorId: string;
	readonly origin: string;
	readonly email: string;
	readonly unitId: string;
	readonly action: typeof INVITATION_SENT_ACTION | typeof INVITATION_RESENT_ACTION;
	readonly previousInvitationId?: string;
}

/**
 * The shared body of sending and resending: refuse an address that can sign in, expire the live
 * links for this (email, unit), write the new row, queue the email, record the audit entry.
 */
async function issueInvitation(
	transaction: Transaction,
	clock: Clock,
	request: IssueInvitationRequest
): Promise<Invitation> {
	const now = clock.now();

	const [unit] = await transaction
		.select({ block: units.block, number: units.number })
		.from(units)
		.where(eq(units.id, request.unitId))
		.limit(1);
	if (!unit) {
		throw new UnitNotFoundError(request.unitId);
	}

	if (await hasCredentialAccount(transaction, request.email)) {
		throw new InvitationEmailAlreadyRegisteredError(request.email);
	}

	// Whatever else this row's story is, from this instant only the link written below works.
	await transaction
		.update(invitations)
		.set({ expiresAt: now })
		.where(
			and(
				eq(invitations.email, request.email),
				eq(invitations.unitId, request.unitId),
				isNull(invitations.usedAt),
				gt(invitations.expiresAt, now)
			)
		);

	const token = createInvitationToken();
	const [row] = await transaction
		.insert(invitations)
		.values({
			tokenHash: hashInvitationToken(token),
			email: request.email,
			unitId: request.unitId,
			expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_DAYS * MILLISECONDS_PER_DAY),
			usedAt: null,
			createdBy: request.actorId,
			createdAt: now
		})
		.returning();

	await enqueueEmail(transaction, clock, {
		recipient: request.email,
		kind: INVITATION_KIND,
		payload: invitationPayload({
			url: invitationLink(request.origin, token),
			block: unit.block,
			number: unit.number
		})
	});

	await recordAuditEntry(transaction, clock, {
		actorId: request.actorId,
		action: request.action,
		targetId: row.id,
		before:
			request.previousInvitationId === undefined
				? undefined
				: { previousInvitationId: request.previousInvitationId },
		after: { email: row.email, unitId: row.unitId, expiresAt: row.expiresAt.toISOString() }
	});

	return row;
}

/** What redeeming a link needs. There is no actor: the token itself is the authorization. */
export interface AcceptInvitationRequest {
	/** The token exactly as the link carried it. */
	readonly token: string;
	/** The invitee's name, used only when no `user` row exists for the address yet. */
	readonly name: string;
	/** The password the invitee chose. */
	readonly password: string;
	/** better-auth's hasher, from `passwordHasherOf` — never a hand-rolled one. */
	readonly hashPassword: PasswordHasher;
}

/** What accepting an invitation ends in, for the page that signs the new resident in. */
export interface AcceptedInvitation {
	readonly userId: string;
	readonly residentId: string;
	/** The address the account signs in with, exactly as the `user` row stores it. */
	readonly email: string;
	readonly unitId: string;
	/** False when a running stay on that unit already existed, so none was added. */
	readonly createdOccupancy: boolean;
}

/**
 * Redeems an invitation: in one transaction the token is spent, the account can sign in with the
 * chosen password, the address counts as verified, the person is a Warga of the invitation's house,
 * and their default subscriptions exist. See the module doc comment for every decision in that
 * sentence.
 *
 * @throws {TypeError} when the name is blank or the password is outside the allowed lengths — the
 *   page checks these first, so reaching this is a broken caller.
 * @throws {InvitationTokenUnknownError} when the token matches nothing.
 * @throws {InvitationUsedError} when the link was already redeemed. Checked before expiry, so a
 *   link that is both spent and old is reported as spent — the truer story.
 * @throws {InvitationExpiredError} when the seven days are over or a resend invalidated the link.
 * @throws {InvitationEmailAlreadyRegisteredError} when the address gained a working credential
 *   after this invitation was sent.
 */
export async function acceptInvitation(
	db: Database,
	clock: Clock,
	request: AcceptInvitationRequest
): Promise<AcceptedInvitation> {
	const name = request.name.trim();
	if (name === '') {
		throw new TypeError('Accepting an invitation needs a non-empty name.');
	}
	if (
		request.password.length < MINIMUM_PASSWORD_LENGTH ||
		request.password.length > MAXIMUM_PASSWORD_LENGTH
	) {
		throw new TypeError(
			`A password must be between ${MINIMUM_PASSWORD_LENGTH} and ${MAXIMUM_PASSWORD_LENGTH} characters.`
		);
	}

	return db.transaction(async (transaction) => {
		const now = clock.now();
		const invitation = await claimInvitation(transaction, request.token, now);

		const passwordHash = await request.hashPassword(request.password);
		const userId = await ensureCredentialedUser(transaction, {
			email: invitation.email,
			name,
			passwordHash,
			now
		});
		const residentId = await ensureResident(transaction, clock, userId, now);
		const createdOccupancy = await ensureOccupancy(
			transaction,
			clock,
			invitation.unitId,
			residentId,
			now
		);

		await recordAuditEntry(transaction, clock, {
			actorId: userId,
			action: INVITATION_ACCEPTED_ACTION,
			targetId: invitation.id,
			after: { email: invitation.email, unitId: invitation.unitId, residentId, createdOccupancy }
		});

		return {
			userId,
			residentId,
			email: invitation.email,
			unitId: invitation.unitId,
			createdOccupancy
		};
	});
}

/** The three ways a token can be dead, plus the one way it is alive — what the accept page shows. */
export type InvitationInspection =
	| { readonly status: 'unknown' | 'used' | 'expired' }
	| {
			readonly status: 'valid';
			readonly email: string;
			readonly block: string;
			readonly number: string;
			/** Whether the form needs to ask for a name — false when a `user` row already has one. */
			readonly requiresName: boolean;
	  };

/**
 * What a presented token is worth right now, for rendering the accept page — a read with no side
 * effect and no session, because whoever holds the token is exactly who the page is for. The POST
 * decides everything again; this only chooses what the GET shows.
 */
export async function inspectInvitation(
	db: Database,
	clock: Clock,
	token: string
): Promise<InvitationInspection> {
	const [row] = await db
		.select({
			usedAt: invitations.usedAt,
			expiresAt: invitations.expiresAt,
			email: invitations.email,
			block: units.block,
			number: units.number
		})
		.from(invitations)
		.innerJoin(units, eq(units.id, invitations.unitId))
		.where(eq(invitations.tokenHash, hashInvitationToken(token)))
		.limit(1);

	if (!row) {
		return { status: 'unknown' };
	}
	if (row.usedAt !== null) {
		return { status: 'used' };
	}
	if (row.expiresAt.getTime() <= clock.now().getTime()) {
		return { status: 'expired' };
	}

	const [existing] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, row.email))
		.limit(1);
	return {
		status: 'valid',
		email: row.email,
		block: row.block,
		number: row.number,
		requiresName: !existing
	};
}

/** One line of the admin screen: an invitation, its house, and what the link is worth right now. */
export interface InvitationListEntry {
	readonly invitationId: string;
	readonly email: string;
	readonly unitId: string;
	readonly block: string;
	readonly number: string;
	readonly expiresAt: Date;
	readonly usedAt: Date | null;
	readonly createdAt: Date;
	/** `pending` while the link still works; a resend is only offered for these and `expired`. */
	readonly status: 'pending' | 'expired' | 'used';
}

/**
 * Every invitation ever sent, newest first — the admin screen's whole read.
 *
 * @throws {PermissionDeniedError} when `actorId` does not hold `superuser`.
 */
export async function listInvitations(
	db: Database,
	clock: Clock,
	actorId: string
): Promise<readonly InvitationListEntry[]> {
	await requirePermission(db, actorId, ACTION.manageInvitations);

	const now = clock.now().getTime();
	const rows = await db
		.select({
			invitationId: invitations.id,
			email: invitations.email,
			unitId: invitations.unitId,
			block: units.block,
			number: units.number,
			expiresAt: invitations.expiresAt,
			usedAt: invitations.usedAt,
			createdAt: invitations.createdAt
		})
		.from(invitations)
		.innerJoin(units, eq(units.id, invitations.unitId))
		.orderBy(desc(invitations.createdAt));

	return rows.map((row) => ({ ...row, status: statusOf(row, now) }));
}

/** What one invitation's link is worth at `now`: spent beats old, exactly as `acceptInvitation` reports it. */
function statusOf(
	row: { usedAt: Date | null; expiresAt: Date },
	now: number
): InvitationListEntry['status'] {
	if (row.usedAt !== null) {
		return 'used';
	}
	return row.expiresAt.getTime() <= now ? 'expired' : 'pending';
}

/**
 * Looks the token up by digest and spends it. The `used_at is null` predicate on the update is the
 * single-use rule under concurrency: of two racing redemptions, exactly one gets the row back.
 */
async function claimInvitation(
	transaction: Transaction,
	token: string,
	now: Date
): Promise<Invitation> {
	const [found] = await transaction
		.select()
		.from(invitations)
		.where(eq(invitations.tokenHash, hashInvitationToken(token)))
		.limit(1);
	if (!found) {
		throw new InvitationTokenUnknownError();
	}
	if (found.usedAt !== null) {
		throw new InvitationUsedError();
	}
	if (found.expiresAt.getTime() <= now.getTime()) {
		throw new InvitationExpiredError(found.expiresAt);
	}

	const [claimed] = await transaction
		.update(invitations)
		.set({ usedAt: now })
		.where(and(eq(invitations.id, found.id), isNull(invitations.usedAt)))
		.returning();
	if (!claimed) {
		throw new InvitationUsedError();
	}
	return claimed;
}

/** What `ensureCredentialedUser` needs to leave an address able to sign in. */
interface CredentialedUserRequest {
	readonly email: string;
	readonly name: string;
	readonly passwordHash: string;
	readonly now: Date;
}

/**
 * Leaves `email` with a `user` row that is verified and has a `credential` account, whichever of
 * the two starting states it was in — no row at all (a fresh invitee), or a row without a
 * credential (a CSV import from #19). A row that already has a credential is refused; that person
 * can sign in already and an invitation must not overwrite their password.
 */
async function ensureCredentialedUser(
	transaction: Transaction,
	request: CredentialedUserRequest
): Promise<string> {
	const [existing] = await transaction
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, request.email))
		.limit(1);

	let userId: string;
	if (existing) {
		if (await hasCredentialAccount(transaction, request.email)) {
			throw new InvitationEmailAlreadyRegisteredError(request.email);
		}
		userId = existing.id;
		// The invitation reached this inbox and its holder is here, which is what "verified" means.
		// The name on the row stays: the import that created it is the registry, not this form.
		await transaction
			.update(user)
			.set({ emailVerified: true, updatedAt: request.now })
			.where(eq(user.id, userId));
	} else {
		userId = generateAuthId();
		await transaction.insert(user).values({
			id: userId,
			name: request.name,
			email: request.email,
			emailVerified: true,
			createdAt: request.now,
			updatedAt: request.now
		});
	}

	// The same columns better-auth's own sign-up writes for a credential: `accountId` mirrors the
	// user id, `providerId` is `credential`, and `password` is the scrypt hash `salt:key`.
	await transaction.insert(account).values({
		id: generateAuthId(),
		accountId: userId,
		providerId: CREDENTIAL_PROVIDER,
		userId,
		password: request.passwordHash,
		createdAt: request.now,
		updatedAt: request.now
	});

	return userId;
}

/** The `residents` row for `userId`, created — with its default subscriptions — when missing. */
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

/**
 * The Masa Huni the invitation promises, unless one is already running: role `owner` (see the
 * module doc comment for why), starting on the acceptance day, never the primary occupant.
 */
async function ensureOccupancy(
	transaction: Transaction,
	clock: Clock,
	unitId: string,
	residentId: string,
	now: Date
): Promise<boolean> {
	const today = currentDay(clock);
	const [running] = await transaction
		.select({ id: occupancies.id })
		.from(occupancies)
		.where(
			and(
				eq(occupancies.unitId, unitId),
				eq(occupancies.residentId, residentId),
				stillRunningOn(occupancies.endedOn, today)
			)
		)
		.limit(1);
	if (running) {
		return false;
	}

	await transaction.insert(occupancies).values({
		unitId,
		residentId,
		role: OCCUPANCY_ROLE.owner,
		startedOn: today,
		endedOn: null,
		isPrimaryOccupant: false,
		createdAt: now
	});
	return true;
}

/** Whether `email` belongs to a `user` row that has a `credential` account — someone who can sign in. */
async function hasCredentialAccount(transaction: Transaction, email: string): Promise<boolean> {
	const [row] = await transaction
		.select({ id: account.id })
		.from(account)
		.innerJoin(user, eq(user.id, account.userId))
		.where(and(eq(user.email, email), eq(account.providerId, CREDENTIAL_PROVIDER)))
		.limit(1);
	return row !== undefined;
}

/** The link the email carries: the accept page under `origin`, with the token as the path segment. */
function invitationLink(origin: string, token: string): string {
	return `${origin.replace(/\/+$/, '')}${ACCEPT_PATH}/${encodeURIComponent(token)}`;
}

/**
 * An identifier for a `user` or `account` row this service inserts itself: a version-4 UUID with
 * the dashes removed, 32 characters and 122 random bits. better-auth's own generator draws 32
 * alphanumeric characters; both shapes fit the `text` primary key and clear the "cannot be guessed"
 * bar the auth schema records, and nothing anywhere parses the id's shape back.
 */
function generateAuthId(): string {
	return randomUUID().replaceAll('-', '');
}

/**
 * The recipients trimmed, lower-cased and de-duplicated by (email, unit), refused when the result
 * is empty or an address is visibly not an email. Lower-casing matches better-auth, which
 * normalizes addresses the same way at sign-up — one address, one spelling, everywhere.
 */
function normalizeRecipients(
	recipients: readonly InvitationRecipient[]
): readonly InvitationRecipient[] {
	const byPair = new Map<string, InvitationRecipient>();
	for (const recipient of recipients) {
		const email = recipient.email.trim().toLowerCase();
		const at = email.indexOf('@');
		if (at < 1 || at === email.length - 1 || /\s/.test(email)) {
			throw new TypeError(`"${recipient.email}" is not an email address.`);
		}
		byPair.set(`${email}\n${recipient.unitId}`, { email, unitId: recipient.unitId });
	}
	if (byPair.size === 0) {
		throw new TypeError('An invitation batch needs at least one recipient.');
	}
	return [...byPair.values()];
}
