import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { auditEntriesFor } from '$lib/server/audit';
import { createAuth, type Auth } from '$lib/server/auth';
import { account, user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { emailQueue } from '$lib/server/db/schema/email';
import { invitations } from '$lib/server/db/schema/invitation';
import { occupancies, OCCUPANCY_ROLE } from '$lib/server/db/schema/occupancy';
import { residents } from '$lib/server/db/schema/resident';
import { subscriptions } from '$lib/server/db/schema/subscription';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { INVITATION_KIND, invitationTemplate } from '$lib/server/email/templates/invitation';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	acceptInvitation,
	INVITATION_ACCEPTED_ACTION,
	INVITATION_RESENT_ACTION,
	INVITATION_SENT_ACTION,
	InvitationEmailAlreadyRegisteredError,
	InvitationExpiredError,
	InvitationNotFoundError,
	InvitationTokenUnknownError,
	InvitationUsedError,
	inspectInvitation,
	listInvitations,
	passwordHasherOf,
	resendInvitation,
	sendInvitations,
	type AcceptInvitationRequest
} from '$lib/server/services/invitation';
import { hashInvitationToken } from '$lib/server/services/invitation/token';
import { UnitNotFoundError } from '$lib/server/services/unit';

/**
 * The Undangan service, against a real PostgreSQL and better-auth's real hasher.
 *
 * What this file exists to prove is adversarial: a token is worth nothing once its seven days are
 * over, nothing after its first use, nothing after a resend, and the database never holds the value
 * a stranger could redeem. The friendly half — that accepting really leaves a person able to sign
 * in, with a house and their default subscriptions — is proven against `signInEmail` on a real
 * `createAuth()` instance, because "a credential better-auth accepts" is a fact about better-auth,
 * not about this service's own hashing.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';
const TEST_ORIGIN = 'http://localhost:5173';

/** A secret of the length the reader insists on. A literal in a test, protecting nothing. */
const TEST_SECRET = 'a-test-secret-that-is-long-enough-to-pass';

/** A password that clears the minimum length. A literal in a test, protecting nothing. */
const GOOD_PASSWORD = 'kata sandi undangan panjang';

/** The name every fresh invitee in this file signs up with. */
const INVITEE_NAME = 'Warga Undangan';

/** One hour, for walking the clock towards and past the seven-day line. */
const HOUR = 60 * 60 * 1000;

/** The seven-day lifetime, as milliseconds, for the boundary tests. */
const SEVEN_DAYS = 7 * 24 * HOUR;

let instance: Auth | undefined;

/** A real better-auth bound to this file's schema — the hasher, and the sign-in that must accept it. */
function authentication(): Auth {
	instance ??= createAuth({
		db: testDb.db,
		clock: new FakeClock(START),
		baseURL: TEST_ORIGIN,
		secret: TEST_SECRET
	});
	return instance;
}

let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** A bare `user` row, as the CSV import writes one: no credential, picking up the trigger's role. */
async function insertUser(name: string, email = `${randomUUID()}@komplek.local`): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db
		.insert(user)
		.values({ id, name, email, emailVerified: false, createdAt: now, updatedAt: now });
	return id;
}

/** A superuser, ready to act as `actorId`. */
async function insertSuperuser(): Promise<string> {
	const id = await insertUser('Pengurus Uji');
	await testDb.db
		.insert(userRoles)
		.values({ userId: id, role: ROLE.superuser, createdAt: new Date(START) });
	return id;
}

/** A unit row written directly, for a fixture. */
async function insertUnitRow(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: unique('B'), number: '1', createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** An address no other test in this file will have used. */
function anAddress(label: string): string {
	return `${unique(label)}@komplek.local`;
}

/** Sends one invitation and returns its row together with the token its email carries. */
async function sendOne(
	actorId: string,
	email: string,
	unitId: string,
	clock: FakeClock = new FakeClock(START)
) {
	const [row] = await sendInvitations(testDb.db, clock, {
		actorId,
		origin: TEST_ORIGIN,
		recipients: [{ email, unitId }]
	});
	return { row, token: await sentToken(email) };
}

/** The token inside the most recent invitation email queued for `recipient`. */
async function sentToken(recipient: string): Promise<string> {
	const [row] = await testDb.db
		.select()
		.from(emailQueue)
		.where(and(eq(emailQueue.recipient, recipient), eq(emailQueue.kind, INVITATION_KIND)))
		.orderBy(desc(emailQueue.createdAt))
		.limit(1);
	const url = row?.payload.url;
	if (typeof url !== 'string') {
		throw new TypeError(`No invitation email was queued for ${recipient}.`);
	}
	const segments = new URL(url).pathname.split('/');
	return decodeURIComponent(segments.at(-1) ?? '');
}

/** Everything an acceptance needs, with this file's defaults filled in. */
function acceptance(token: string, overrides: Partial<AcceptInvitationRequest> = {}) {
	return {
		token,
		name: INVITEE_NAME,
		password: GOOD_PASSWORD,
		hashPassword: passwordHasherOf(authentication()),
		...overrides
	};
}

/** Every message on an error's cause chain, joined — for asserting on a wrapped database error. */
function causeMessagesOf(error: unknown): string {
	const messages: string[] = [];
	let current: unknown = error;
	while (current instanceof Error) {
		messages.push(current.message);
		current = current.cause;
	}
	return messages.join(' | ');
}

/** Runs something that must be refused and hands back how it was refused. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('The service accepted something it was supposed to refuse.');
}

describe('sendInvitations', () => {
	it('refuses a caller who is not a superuser, and writes nothing at all', async () => {
		const outsiderId = await insertUser('Warga Iseng');
		const unitId = await insertUnitRow();
		const email = anAddress('refused');

		const refused = await rejection(
			sendInvitations(testDb.db, new FakeClock(START), {
				actorId: outsiderId,
				origin: TEST_ORIGIN,
				recipients: [{ email, unitId }]
			})
		);

		expect(refused).toBeInstanceOf(PermissionDeniedError);
		expect(
			await testDb.db.select().from(invitations).where(eq(invitations.email, email))
		).toHaveLength(0);
		expect(
			await testDb.db.select().from(emailQueue).where(eq(emailQueue.recipient, email))
		).toHaveLength(0);
	});

	it('stores only the SHA-256 digest of the token, never the token itself', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const email = anAddress('digest');

		const { row, token } = await sendOne(actorId, email, unitId);

		expect(row.tokenHash).toBe(hashInvitationToken(token));
		expect(row.tokenHash).not.toBe(token);
		// The whole table as text: the raw token appears in no column of any row.
		const dump = await testDb.db.execute<{ dump: string }>(
			sql`select coalesce(string_agg(to_jsonb(i)::text, ' '), '') as dump from invitations i`
		);
		expect(dump.rows[0]?.dump).not.toContain(token);
	});

	it('queues one email whose link points at the accept page and whose body states the seven days', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const email = anAddress('email');

		const { token } = await sendOne(actorId, email, unitId);

		const [queued] = await testDb.db
			.select()
			.from(emailQueue)
			.where(and(eq(emailQueue.recipient, email), eq(emailQueue.kind, INVITATION_KIND)));
		expect(queued.payload.url).toBe(`${TEST_ORIGIN}/invitations/${token}`);
		const rendered = invitationTemplate(queued.payload);
		expect(rendered.text).toContain('7 hari');
		expect(rendered.text).toContain('hanya bisa dipakai sekali');
	});

	it('stamps the expiry seven days after sending, and records the send in the audit log', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const clock = new FakeClock(START);

		const { row } = await sendOne(actorId, anAddress('expiry'), unitId, clock);

		expect(row.expiresAt.getTime()).toBe(clock.now().getTime() + SEVEN_DAYS);
		const entries = await auditEntriesFor(testDb.db, row.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ actorId, action: INVITATION_SENT_ACTION });
	});

	it('sends to several recipients in one transaction, and one refused address sinks the whole batch', async () => {
		const actorId = await insertSuperuser();
		const unitOne = await insertUnitRow();
		const unitTwo = await insertUnitRow();
		const fine = anAddress('batch-fine');
		const taken = anAddress('batch-taken');
		await authentication().api.signUpEmail({
			body: { name: INVITEE_NAME, email: taken, password: GOOD_PASSWORD }
		});

		const refused = await rejection(
			sendInvitations(testDb.db, new FakeClock(START), {
				actorId,
				origin: TEST_ORIGIN,
				recipients: [
					{ email: fine, unitId: unitOne },
					{ email: taken, unitId: unitTwo }
				]
			})
		);

		expect(refused).toBeInstanceOf(InvitationEmailAlreadyRegisteredError);
		expect((refused as InvitationEmailAlreadyRegisteredError).email).toBe(taken);
		// The fine recipient's half rolled back with the refused one's.
		expect(
			await testDb.db.select().from(invitations).where(eq(invitations.email, fine))
		).toHaveLength(0);
	});

	it('accepts a whole list at once, one invitation and one email per recipient', async () => {
		const actorId = await insertSuperuser();
		const unitOne = await insertUnitRow();
		const unitTwo = await insertUnitRow();
		const one = anAddress('bulk-one');
		const two = anAddress('bulk-two');

		const sent = await sendInvitations(testDb.db, new FakeClock(START), {
			actorId,
			origin: TEST_ORIGIN,
			recipients: [
				{ email: one, unitId: unitOne },
				{ email: two, unitId: unitTwo }
			]
		});

		expect(sent).toHaveLength(2);
		expect(await sentToken(one)).not.toBe(await sentToken(two));
	});

	it.each([
		{ name: 'an unknown unit', recipients: [{ email: 'x@komplek.local', unitId: randomUUID() }] },
		{ name: 'an empty list', recipients: [] },
		{ name: 'a non-address', recipients: [{ email: 'bukan-email', unitId: '' }] }
	])('refuses $name', async ({ recipients }) => {
		const actorId = await insertSuperuser();

		const refused = await rejection(
			sendInvitations(testDb.db, new FakeClock(START), {
				actorId,
				origin: TEST_ORIGIN,
				recipients
			})
		);

		expect(refused instanceof UnitNotFoundError || refused instanceof TypeError).toBe(true);
	});
});

describe('acceptInvitation and the seven days', () => {
	it('accepts a token presented at six days and twenty-three hours', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const clock = new FakeClock(START);
		const { token } = await sendOne(actorId, anAddress('young'), unitId, clock);

		clock.advance(SEVEN_DAYS - HOUR);

		await expect(acceptInvitation(testDb.db, clock, acceptance(token))).resolves.toMatchObject({
			unitId,
			createdOccupancy: true
		});
	});

	it('refuses a token presented one second past the seven days, as expired', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const clock = new FakeClock(START);
		const { token } = await sendOne(actorId, anAddress('old'), unitId, clock);

		clock.advance(SEVEN_DAYS + 1000);

		const refused = await rejection(acceptInvitation(testDb.db, clock, acceptance(token)));
		expect(refused).toBeInstanceOf(InvitationExpiredError);
	});

	it('refuses the same token a second time, as used — not as anything vaguer', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const clock = new FakeClock(START);
		const { token } = await sendOne(actorId, anAddress('once'), unitId, clock);
		await acceptInvitation(testDb.db, clock, acceptance(token));

		const refused = await rejection(acceptInvitation(testDb.db, clock, acceptance(token)));

		expect(refused).toBeInstanceOf(InvitationUsedError);
	});

	it('refuses a token that matches nothing, as unknown', async () => {
		const refused = await rejection(
			acceptInvitation(testDb.db, new FakeClock(START), acceptance('token-yang-tidak-pernah-ada'))
		);

		expect(refused).toBeInstanceOf(InvitationTokenUnknownError);
	});
});

describe('what accepting creates', () => {
	it('creates a verified account, the resident, the stay and the defaults — and signInEmail accepts the password', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const clock = new FakeClock('2026-02-03T10:00:00.000Z');
		const email = anAddress('fresh');
		const { row, token } = await sendOne(actorId, email, unitId, clock);

		const accepted = await acceptInvitation(testDb.db, clock, acceptance(token));

		const [createdUser] = await testDb.db.select().from(user).where(eq(user.email, email));
		expect(createdUser).toMatchObject({
			id: accepted.userId,
			name: INVITEE_NAME,
			emailVerified: true
		});
		// The trigger grants the Warga role, exactly as any other new account.
		expect(
			await testDb.db.select().from(userRoles).where(eq(userRoles.userId, accepted.userId))
		).toMatchObject([{ role: ROLE.resident }]);
		const [stay] = await testDb.db
			.select()
			.from(occupancies)
			.where(eq(occupancies.residentId, accepted.residentId));
		expect(stay).toMatchObject({
			unitId,
			role: OCCUPANCY_ROLE.owner,
			startedOn: '2026-02-03',
			endedOn: null,
			isPrimaryOccupant: false
		});
		const seeded = await testDb.db
			.select()
			.from(subscriptions)
			.where(eq(subscriptions.residentId, accepted.residentId));
		expect(seeded.length).toBeGreaterThan(0);
		const entries = await auditEntriesFor(testDb.db, row.id);
		expect(entries.map((entry) => entry.action)).toContain(INVITATION_ACCEPTED_ACTION);

		// The proof that the credential is one better-auth wrote, as far as sign-in can tell.
		await expect(
			authentication().api.signInEmail({ body: { email, password: GOOD_PASSWORD } })
		).resolves.toBeDefined();
	});

	it('completes an imported account — a user row with no credential — instead of refusing it', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const email = anAddress('imported');
		const importedName = 'Warga Impor CSV';
		const userId = await insertUser(importedName, email);
		const clock = new FakeClock(START);
		const { token } = await sendOne(actorId, email, unitId, clock);

		const accepted = await acceptInvitation(testDb.db, clock, acceptance(token));

		expect(accepted.userId).toBe(userId);
		const [existing] = await testDb.db.select().from(user).where(eq(user.id, userId));
		// Verified now, and the register's name kept — the form's name is only for fresh accounts.
		expect(existing).toMatchObject({ name: importedName, emailVerified: true });
		await expect(
			authentication().api.signInEmail({ body: { email, password: GOOD_PASSWORD } })
		).resolves.toBeDefined();
	});

	it('does not add a second stay when the imported resident already has one running on that unit', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const email = anAddress('housed');
		const userId = await insertUser('Warga Sudah Tercatat', email);
		const [residentRow] = await testDb.db
			.insert(residents)
			.values({ userId, createdAt: new Date(START) })
			.returning();
		await testDb.db.insert(occupancies).values({
			unitId,
			residentId: residentRow.id,
			role: OCCUPANCY_ROLE.tenant,
			startedOn: '2025-06-01',
			endedOn: null,
			isPrimaryOccupant: false,
			createdAt: new Date(START)
		});
		const clock = new FakeClock(START);
		const { token } = await sendOne(actorId, email, unitId, clock);

		const accepted = await acceptInvitation(testDb.db, clock, acceptance(token));

		expect(accepted).toMatchObject({ residentId: residentRow.id, createdOccupancy: false });
		expect(
			await testDb.db.select().from(occupancies).where(eq(occupancies.residentId, residentRow.id))
		).toHaveLength(1);
	});

	it('refuses an address that gained a working credential after the invitation was sent', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const email = anAddress('raced');
		const clock = new FakeClock(START);
		const { token } = await sendOne(actorId, email, unitId, clock);
		await authentication().api.signUpEmail({
			body: { name: INVITEE_NAME, email, password: GOOD_PASSWORD }
		});

		const refused = await rejection(acceptInvitation(testDb.db, clock, acceptance(token)));

		expect(refused).toBeInstanceOf(InvitationEmailAlreadyRegisteredError);
	});

	it('rolls the whole acceptance back when the occupancy write fails', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const email = anAddress('rollback');
		const clock = new FakeClock(START);
		const { row, token } = await sendOne(actorId, email, unitId, clock);
		// A trigger that makes the last write of the transaction fail, so everything before it —
		// the used-mark, the user, the credential, the resident — has already happened and has to
		// be taken back by the rollback rather than by anyone's tidying.
		await testDb.db.execute(
			sql.raw(`
				create function occupancy_boom() returns trigger language plpgsql as
					$$ begin raise exception 'boom'; end $$;
				create trigger occupancy_boom_trigger before insert on occupancies
					for each row execute function occupancy_boom();
			`)
		);

		try {
			// Drizzle wraps the trigger's exception in its own "Failed query" error, so the proof that
			// this really was the planted failure sits on the cause chain rather than on the message.
			const refused = await rejection(acceptInvitation(testDb.db, clock, acceptance(token)));
			expect(causeMessagesOf(refused)).toContain('boom');
		} finally {
			await testDb.db.execute(
				sql.raw(
					'drop trigger occupancy_boom_trigger on occupancies; drop function occupancy_boom();'
				)
			);
		}

		expect(await testDb.db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
		const [afterwards] = await testDb.db
			.select()
			.from(invitations)
			.where(eq(invitations.id, row.id));
		// The token was not spent by a failed attempt: the same link still works.
		expect(afterwards.usedAt).toBeNull();
		await expect(acceptInvitation(testDb.db, clock, acceptance(token))).resolves.toBeDefined();
	});
});

describe('resendInvitation', () => {
	it('invalidates the old link at that moment and the new one works', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const email = anAddress('resend');
		const clock = new FakeClock(START);
		const { row, token: oldToken } = await sendOne(actorId, email, unitId, clock);

		// An hour later, so the resent email is unambiguously the newer row in the queue.
		clock.advance(HOUR);
		const fresh = await resendInvitation(testDb.db, clock, {
			actorId,
			invitationId: row.id,
			origin: TEST_ORIGIN
		});

		const oldRefused = await rejection(acceptInvitation(testDb.db, clock, acceptance(oldToken)));
		expect(oldRefused).toBeInstanceOf(InvitationExpiredError);
		const newToken = await sentToken(email);
		expect(newToken).not.toBe(oldToken);
		await expect(acceptInvitation(testDb.db, clock, acceptance(newToken))).resolves.toMatchObject({
			unitId
		});
		const entries = await auditEntriesFor(testDb.db, fresh.id);
		expect(entries.map((entry) => entry.action)).toContain(INVITATION_RESENT_ACTION);
	});

	it('refuses to resend an invitation that was already redeemed', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const clock = new FakeClock(START);
		const { row, token } = await sendOne(actorId, anAddress('spent'), unitId, clock);
		await acceptInvitation(testDb.db, clock, acceptance(token));

		const refused = await rejection(
			resendInvitation(testDb.db, clock, { actorId, invitationId: row.id, origin: TEST_ORIGIN })
		);

		expect(refused).toBeInstanceOf(InvitationUsedError);
	});

	it('refuses an id that names no invitation', async () => {
		const actorId = await insertSuperuser();

		const refused = await rejection(
			resendInvitation(testDb.db, new FakeClock(START), {
				actorId,
				invitationId: randomUUID(),
				origin: TEST_ORIGIN
			})
		);

		expect(refused).toBeInstanceOf(InvitationNotFoundError);
	});
});

describe('the admin read and the page read', () => {
	it('lists every invitation with the status its link is worth right now', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const clock = new FakeClock(START);
		const pending = anAddress('list-pending');
		const spent = anAddress('list-spent');
		const stale = anAddress('list-stale');
		await sendOne(actorId, pending, unitId, clock);
		const { token } = await sendOne(actorId, spent, unitId, clock);
		await acceptInvitation(testDb.db, clock, acceptance(token));
		await sendOne(actorId, stale, unitId, clock);

		clock.advance(SEVEN_DAYS + 1000);
		const listed = await listInvitations(testDb.db, clock, actorId);

		const byEmail = new Map(listed.map((entry) => [entry.email, entry.status]));
		// Past the seven days, the unused ones read expired and the redeemed one stays used.
		expect(byEmail.get(pending)).toBe('expired');
		expect(byEmail.get(spent)).toBe('used');
		expect(byEmail.get(stale)).toBe('expired');
	});

	it('refuses the list to a caller who is not a superuser', async () => {
		const outsiderId = await insertUser('Warga Penasaran');

		const refused = await rejection(listInvitations(testDb.db, new FakeClock(START), outsiderId));

		expect(refused).toBeInstanceOf(PermissionDeniedError);
	});

	it('inspects a token into the four answers the accept page renders', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const clock = new FakeClock(START);
		const email = anAddress('inspect');
		const { token } = await sendOne(actorId, email, unitId, clock);

		expect(await inspectInvitation(testDb.db, clock, token)).toMatchObject({
			status: 'valid',
			email,
			requiresName: true
		});
		expect(await inspectInvitation(testDb.db, clock, 'tidak-ada')).toEqual({
			status: 'unknown'
		});

		clock.advance(SEVEN_DAYS + 1000);
		expect(await inspectInvitation(testDb.db, clock, token)).toEqual({ status: 'expired' });

		clock.set(START);
		await acceptInvitation(testDb.db, clock, acceptance(token));
		expect(await inspectInvitation(testDb.db, clock, token)).toEqual({ status: 'used' });
	});
});

describe('the account table after an acceptance', () => {
	it('holds one credential in scrypt salt:key form, never the password itself', async () => {
		const actorId = await insertSuperuser();
		const unitId = await insertUnitRow();
		const email = anAddress('hash-shape');
		const clock = new FakeClock(START);
		const { token } = await sendOne(actorId, email, unitId, clock);

		const accepted = await acceptInvitation(testDb.db, clock, acceptance(token));

		const rows = await testDb.db.select().from(account).where(eq(account.userId, accepted.userId));
		expect(rows).toHaveLength(1);
		expect(rows[0].providerId).toBe('credential');
		expect(rows[0].password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
		expect(rows[0].password).not.toContain(GOOD_PASSWORD);
	});
});
