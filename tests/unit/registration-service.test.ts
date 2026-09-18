import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { auditEntriesFor } from '$lib/server/audit';
import { createAuth, type Auth } from '$lib/server/auth';
import { ACTION, requirePermission, type Action } from '$lib/server/authz';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles } from '$lib/server/db/schema/authz';
import { emailQueue } from '$lib/server/db/schema/email';
import { occupancies, OCCUPANCY_ROLE } from '$lib/server/db/schema/occupancy';
import { registrations, REGISTRATION_STATUS } from '$lib/server/db/schema/registration';
import { residents } from '$lib/server/db/schema/resident';
import { subscriptions } from '$lib/server/db/schema/subscription';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import {
	REGISTRATION_APPROVED_KIND,
	registrationApprovedTemplate
} from '$lib/server/email/templates/registration-approved';
import { FakeClock } from '$lib/server/ports/fakes';
import { occupiedUnitsForUser } from '$lib/server/services/occupancy';
import {
	approveRegistration,
	listPendingRegistrations,
	ownRegistrationStatus,
	rejectRegistration,
	submitRegistration,
	RegistrationAccountMissingError,
	RegistrationAlreadyDecidedError,
	RegistrationNotFoundError,
	REGISTRATION_APPROVED_ACTION,
	REGISTRATION_REJECTED_ACTION
} from '$lib/server/services/registration';
import { residentProfileForUser } from '$lib/server/services/resident/profile';
import { UnitNotFoundError } from '$lib/server/services/unit';

/**
 * The Pendaftaran service, against a real PostgreSQL and a real better-auth instance.
 *
 * What this file exists to prove is adversarial: a claimed house is worth nothing until a superuser
 * says so, a decided registration cannot be decided again, two superusers approving at the same
 * instant produce one Masa Huni rather than two, and a waiting registrant can reach no service at
 * all. The friendly half — that approving really leaves a person a Warga of the chosen house, with
 * their default Langganan — is asserted on the rows the approval wrote.
 *
 * The accounts are created through `signUpEmail` on a real `createAuth()`, because that is what
 * `/register` does: this service never creates an account, it finds one.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';
const TEST_ORIGIN = 'http://localhost:5173';

/** A secret of the length the reader insists on. A literal in a test, protecting nothing. */
const TEST_SECRET = 'a-test-secret-that-is-long-enough-to-pass';

/** A password that clears the minimum length. A literal in a test, protecting nothing. */
const GOOD_PASSWORD = 'kata sandi pendaftaran panjang';

/** The name every self-registrant in this file signs up with. */
const REGISTRANT_NAME = 'Warga Mendaftar Sendiri';

/** The reason every rejection in this file carries. */
const REJECTION_REASON = 'Nama Anda tidak ada pada daftar penghuni blok itu.';

let instance: Auth | undefined;

/** A real better-auth bound to this file's schema — the only thing here that creates an account. */
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

/** An address no other test in this file will have used. */
function anAddress(label: string): string {
	return `${unique(label)}@komplek.local`;
}

/** A bare `user` row, for an actor that never signs in. */
async function insertUser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: anAddress('actor'),
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

/** An account holding one extra role beyond the `resident` the trigger grants. */
async function insertActorWithRole(role: (typeof ROLE)[keyof typeof ROLE]): Promise<string> {
	const id = await insertUser(`Pengurus ${role}`);
	await testDb.db.insert(userRoles).values({ userId: id, role, createdAt: new Date(START) });
	return id;
}

/** A superuser, ready to act as `actorId`. */
async function insertSuperuser(): Promise<string> {
	return insertActorWithRole(ROLE.superuser);
}

/** A unit row written directly, for a fixture. Its block is unique to this test. */
async function insertUnitRow(
	number = '1'
): Promise<{ unitId: string; block: string; number: string }> {
	const block = unique('B');
	const [row] = await testDb.db
		.insert(units)
		.values({ block, number, createdAt: new Date(START) })
		.returning();
	return { unitId: row.id, block: row.block, number: row.number };
}

/** What one registrant is, once their account exists and their request is on file. */
interface Registrant {
	readonly email: string;
	readonly userId: string;
	readonly registrationId: string;
}

/**
 * The whole of what `/register` does, in the order that page does it: the account first, through
 * better-auth, then the request. `claim` is what they typed as their house.
 */
async function register(
	label: string,
	claim: { block: string; number: string },
	clock: FakeClock = new FakeClock(START)
): Promise<Registrant> {
	const email = anAddress(label);
	await authentication().api.signUpEmail({
		body: { name: REGISTRANT_NAME, email, password: GOOD_PASSWORD }
	});
	await submitRegistration(testDb.db, clock, {
		name: REGISTRANT_NAME,
		email,
		claimedBlock: claim.block,
		claimedNumber: claim.number
	});

	const [account] = await testDb.db.select().from(user).where(eq(user.email, email));
	const [row] = await testDb.db.select().from(registrations).where(eq(registrations.email, email));
	return { email, userId: account.id, registrationId: row.id };
}

/** Every registration row on file for one address, newest first. */
async function registrationRowsOf(email: string) {
	return testDb.db.select().from(registrations).where(eq(registrations.email, email));
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

describe('submitRegistration', () => {
	it('writes one waiting row carrying the claim exactly as it was typed', async () => {
		const clock = new FakeClock(START);
		const email = anAddress('submitted');

		await submitRegistration(testDb.db, clock, {
			name: `  ${REGISTRANT_NAME}  `,
			email: `  ${email.toUpperCase()}  `,
			claimedBlock: '  C  ',
			claimedNumber: '  12A  '
		});

		const [row] = await registrationRowsOf(email);
		expect(row).toMatchObject({
			name: REGISTRANT_NAME,
			email,
			claimedBlock: 'C',
			claimedNumber: '12A',
			status: REGISTRATION_STATUS.pending,
			rejectionReason: null,
			reviewedBy: null,
			reviewedAt: null
		});
		// No foreign key, no lookup: the claim names a house that does not exist and is stored anyway.
		expect(await testDb.db.select().from(units).where(eq(units.block, 'C'))).toHaveLength(0);
	});

	it('answers a second waiting registration for one address exactly like the first', async () => {
		const clock = new FakeClock(START);
		const email = anAddress('twice');
		const submission = {
			name: REGISTRANT_NAME,
			email,
			claimedBlock: 'D',
			claimedNumber: '2'
		};

		const first = await submitRegistration(testDb.db, clock, submission);
		const second = await submitRegistration(testDb.db, clock, {
			...submission,
			claimedNumber: '99'
		});

		// Both answers are the same nothing — there is no value a caller could branch on.
		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		// And the first request is the one on file: the second did not overwrite it.
		const rows = await registrationRowsOf(email);
		expect(rows).toHaveLength(1);
		expect(rows[0].claimedNumber).toBe('2');
	});

	it('accepts a fresh request from someone who was turned down before', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const registrant = await register('reapplies', unit, clock);
		await rejectRegistration(testDb.db, clock, {
			actorId,
			registrationId: registrant.registrationId,
			reason: REJECTION_REASON
		});

		await submitRegistration(testDb.db, clock, {
			name: REGISTRANT_NAME,
			email: registrant.email,
			claimedBlock: unit.block,
			claimedNumber: unit.number
		});

		const rows = await registrationRowsOf(registrant.email);
		expect(rows).toHaveLength(2);
		expect(rows.filter((row) => row.status === REGISTRATION_STATUS.pending)).toHaveLength(1);
	});

	it.each([
		{ name: 'no name', overrides: { name: '  ' } },
		{ name: 'no address', overrides: { email: '' } },
		{ name: 'no block', overrides: { claimedBlock: ' ' } },
		{ name: 'no house number', overrides: { claimedNumber: '' } }
	])('refuses a submission with $name', async ({ overrides }) => {
		const refused = await rejection(
			submitRegistration(testDb.db, new FakeClock(START), {
				name: REGISTRANT_NAME,
				email: anAddress('incomplete'),
				claimedBlock: 'E',
				claimedNumber: '3',
				...overrides
			})
		);

		expect(refused).toBeInstanceOf(TypeError);
	});
});

describe('listPendingRegistrations', () => {
	it('shows the matched unit for a claim that names one and marks one that names none', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		// Typed in a different case and with stray spaces: the same house, as a person writes it.
		const matched = await register(
			'matched',
			{ block: `  ${unit.block.toLowerCase()} `, number: ` ${unit.number} ` },
			clock
		);
		const unmatched = await register(
			'unmatched',
			{ block: unique('NOWHERE'), number: '404' },
			clock
		);

		const listed = await listPendingRegistrations(testDb.db, actorId);

		const byEmail = new Map(listed.map((entry) => [entry.email, entry]));
		expect(byEmail.get(matched.email)?.matchedUnit).toMatchObject({
			unitId: unit.unitId,
			block: unit.block,
			number: unit.number
		});
		expect(byEmail.get(unmatched.email)?.matchedUnit).toBeUndefined();
		// The unmatched request is listed all the same — it is a real request, not a rejected one.
		expect(byEmail.get(unmatched.email)?.claimedNumber).toBe('404');
	});

	it('leaves a decided registration off the queue', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const registrant = await register('decided', unit, clock);
		await rejectRegistration(testDb.db, clock, {
			actorId,
			registrationId: registrant.registrationId,
			reason: REJECTION_REASON
		});

		const listed = await listPendingRegistrations(testDb.db, actorId);

		expect(listed.map((entry) => entry.email)).not.toContain(registrant.email);
	});

	it('refuses the queue to an admin who is not also a superuser', async () => {
		const adminId = await insertActorWithRole(ROLE.admin);

		const refused = await rejection(listPendingRegistrations(testDb.db, adminId));

		expect(refused).toBeInstanceOf(PermissionDeniedError);
	});
});

describe('approveRegistration', () => {
	it('attaches the registrant to the claimed unit, with the defaults and an audit row', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock('2026-02-03T10:00:00.000Z');
		const unit = await insertUnitRow();
		const registrant = await register('approved', unit, clock);

		const approved = await approveRegistration(testDb.db, clock, {
			actorId,
			registrationId: registrant.registrationId,
			unitId: unit.unitId,
			origin: TEST_ORIGIN
		});

		expect(approved).toMatchObject({
			userId: registrant.userId,
			unitId: unit.unitId,
			email: registrant.email,
			createdOccupancy: true
		});
		const [stay] = await testDb.db
			.select()
			.from(occupancies)
			.where(eq(occupancies.residentId, approved.residentId));
		expect(stay).toMatchObject({
			unitId: unit.unitId,
			role: OCCUPANCY_ROLE.owner,
			startedOn: '2026-02-03',
			endedOn: null,
			isPrimaryOccupant: false
		});
		const seeded = await testDb.db
			.select()
			.from(subscriptions)
			.where(eq(subscriptions.residentId, approved.residentId));
		expect(seeded.length).toBeGreaterThan(0);
		const [row] = await registrationRowsOf(registrant.email);
		expect(row).toMatchObject({
			status: REGISTRATION_STATUS.approved,
			reviewedBy: actorId,
			rejectionReason: null
		});
		expect(row.reviewedAt?.getTime()).toBe(clock.now().getTime());
		const entries = await auditEntriesFor(testDb.db, registrant.registrationId);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ actorId, action: REGISTRATION_APPROVED_ACTION });
	});

	it('attaches the registrant to whichever unit the superuser chose, not the one claimed', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const claimed = await insertUnitRow();
		const chosen = await insertUnitRow('7');
		const registrant = await register('moved', claimed, clock);

		const approved = await approveRegistration(testDb.db, clock, {
			actorId,
			registrationId: registrant.registrationId,
			unitId: chosen.unitId,
			origin: TEST_ORIGIN
		});

		const stays = await testDb.db
			.select()
			.from(occupancies)
			.where(eq(occupancies.residentId, approved.residentId));
		expect(stays).toHaveLength(1);
		expect(stays[0].unitId).toBe(chosen.unitId);
	});

	it('queues the approval email naming the approved house and the sign-in page', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow('9B');
		const registrant = await register('emailed', unit, clock);

		await approveRegistration(testDb.db, clock, {
			actorId,
			registrationId: registrant.registrationId,
			unitId: unit.unitId,
			origin: TEST_ORIGIN
		});

		const [queued] = await testDb.db
			.select()
			.from(emailQueue)
			.where(
				and(
					eq(emailQueue.recipient, registrant.email),
					eq(emailQueue.kind, REGISTRATION_APPROVED_KIND)
				)
			);
		expect(queued.payload).toMatchObject({
			url: `${TEST_ORIGIN}/login`,
			block: unit.block,
			number: '9B'
		});
		const rendered = registrationApprovedTemplate(queued.payload);
		expect(rendered.subject).toBe('Pendaftaran Anda disetujui');
		expect(rendered.text).toContain(`blok ${unit.block} nomor 9B`);
	});

	it('refuses a registration whose address carries no account, and creates none', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const email = anAddress('accountless');
		await submitRegistration(testDb.db, clock, {
			name: REGISTRANT_NAME,
			email,
			claimedBlock: unit.block,
			claimedNumber: unit.number
		});
		const [row] = await registrationRowsOf(email);

		const refused = await rejection(
			approveRegistration(testDb.db, clock, {
				actorId,
				registrationId: row.id,
				unitId: unit.unitId,
				origin: TEST_ORIGIN
			})
		);

		expect(refused).toBeInstanceOf(RegistrationAccountMissingError);
		expect(await testDb.db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
		// The whole transaction rolled back, so the request is still waiting for a real decision.
		const [afterwards] = await registrationRowsOf(email);
		expect(afterwards.status).toBe(REGISTRATION_STATUS.pending);
	});

	it('refuses an unknown unit and an unknown registration by name', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const registrant = await register('unknown-targets', unit, clock);

		const unknownUnit = await rejection(
			approveRegistration(testDb.db, clock, {
				actorId,
				registrationId: registrant.registrationId,
				unitId: randomUUID(),
				origin: TEST_ORIGIN
			})
		);
		const unknownRegistration = await rejection(
			approveRegistration(testDb.db, clock, {
				actorId,
				registrationId: randomUUID(),
				unitId: unit.unitId,
				origin: TEST_ORIGIN
			})
		);

		expect(unknownUnit).toBeInstanceOf(UnitNotFoundError);
		expect(unknownRegistration).toBeInstanceOf(RegistrationNotFoundError);
	});

	it('refuses an admin who is not also a superuser, and writes nothing at all', async () => {
		const adminId = await insertActorWithRole(ROLE.admin);
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const registrant = await register('admin-refused', unit, clock);

		const refused = await rejection(
			approveRegistration(testDb.db, clock, {
				actorId: adminId,
				registrationId: registrant.registrationId,
				unitId: unit.unitId,
				origin: TEST_ORIGIN
			})
		);

		expect(refused).toBeInstanceOf(PermissionDeniedError);
		expect(
			await testDb.db.select().from(residents).where(eq(residents.userId, registrant.userId))
		).toHaveLength(0);
		const [row] = await registrationRowsOf(registrant.email);
		expect(row.status).toBe(REGISTRATION_STATUS.pending);
	});
});

describe('deciding a registration twice', () => {
	it('refuses a second decision, whichever way the first one went', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const approvedOnce = await register('approve-twice', unit, clock);
		const rejectedOnce = await register('reject-twice', unit, clock);
		await approveRegistration(testDb.db, clock, {
			actorId,
			registrationId: approvedOnce.registrationId,
			unitId: unit.unitId,
			origin: TEST_ORIGIN
		});
		await rejectRegistration(testDb.db, clock, {
			actorId,
			registrationId: rejectedOnce.registrationId,
			reason: REJECTION_REASON
		});

		const approvedAgain = await rejection(
			approveRegistration(testDb.db, clock, {
				actorId,
				registrationId: approvedOnce.registrationId,
				unitId: unit.unitId,
				origin: TEST_ORIGIN
			})
		);
		const rejectedAgain = await rejection(
			rejectRegistration(testDb.db, clock, {
				actorId,
				registrationId: rejectedOnce.registrationId,
				reason: REJECTION_REASON
			})
		);

		expect(approvedAgain).toBeInstanceOf(RegistrationAlreadyDecidedError);
		expect((approvedAgain as RegistrationAlreadyDecidedError).status).toBe(
			REGISTRATION_STATUS.approved
		);
		expect(rejectedAgain).toBeInstanceOf(RegistrationAlreadyDecidedError);
		expect((rejectedAgain as RegistrationAlreadyDecidedError).status).toBe(
			REGISTRATION_STATUS.rejected
		);
	});

	it('leaves exactly one Masa Huni when two approvals of one registration race', async () => {
		// The rule the atomic claim exists for. Both calls read the row as waiting; only the one whose
		// `update … where status = 'pending'` matches may go on, so the other writes no second stay.
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const registrant = await register('raced', unit, clock);
		const approval = () =>
			approveRegistration(testDb.db, clock, {
				actorId,
				registrationId: registrant.registrationId,
				unitId: unit.unitId,
				origin: TEST_ORIGIN
			});

		const outcomes = await Promise.allSettled([approval(), approval()]);

		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		const refused = outcomes.find((outcome) => outcome.status === 'rejected');
		expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(
			RegistrationAlreadyDecidedError
		);
		const [resident] = await testDb.db
			.select()
			.from(residents)
			.where(eq(residents.userId, registrant.userId));
		expect(
			await testDb.db.select().from(occupancies).where(eq(occupancies.residentId, resident.id))
		).toHaveLength(1);
		expect(
			await testDb.db
				.select()
				.from(emailQueue)
				.where(
					and(
						eq(emailQueue.recipient, registrant.email),
						eq(emailQueue.kind, REGISTRATION_APPROVED_KIND)
					)
				)
		).toHaveLength(1);
	});
});

describe('rejectRegistration', () => {
	it('records the reason the registrant reads, and one audit row', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const registrant = await register('rejected', unit, clock);

		await rejectRegistration(testDb.db, clock, {
			actorId,
			registrationId: registrant.registrationId,
			reason: `  ${REJECTION_REASON}  `
		});

		const [row] = await registrationRowsOf(registrant.email);
		expect(row).toMatchObject({
			status: REGISTRATION_STATUS.rejected,
			rejectionReason: REJECTION_REASON,
			reviewedBy: actorId
		});
		// Nothing was created: a rejection is a decision, not a half-admission.
		expect(
			await testDb.db.select().from(residents).where(eq(residents.userId, registrant.userId))
		).toHaveLength(0);
		const entries = await auditEntriesFor(testDb.db, registrant.registrationId);
		expect(entries.map((entry) => entry.action)).toEqual([REGISTRATION_REJECTED_ACTION]);
	});

	it('refuses a rejection with no reason', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const registrant = await register('reasonless', unit, clock);

		const refused = await rejection(
			rejectRegistration(testDb.db, clock, {
				actorId,
				registrationId: registrant.registrationId,
				reason: '   '
			})
		);

		expect(refused).toBeInstanceOf(TypeError);
	});

	it('refuses an admin who is not also a superuser', async () => {
		const adminId = await insertActorWithRole(ROLE.admin);
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const registrant = await register('reject-refused', unit, clock);

		const refused = await rejection(
			rejectRegistration(testDb.db, clock, {
				actorId: adminId,
				registrationId: registrant.registrationId,
				reason: REJECTION_REASON
			})
		);

		expect(refused).toBeInstanceOf(PermissionDeniedError);
	});
});

describe('ownRegistrationStatus', () => {
	it('answers the newest request, so a rejection gives way to the next attempt', async () => {
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const registrant = await register('own-status', unit, clock);

		expect(await ownRegistrationStatus(testDb.db, registrant.email)).toMatchObject({
			status: REGISTRATION_STATUS.pending,
			rejectionReason: null,
			claimedBlock: unit.block
		});

		await rejectRegistration(testDb.db, clock, {
			actorId,
			registrationId: registrant.registrationId,
			reason: REJECTION_REASON
		});
		expect(await ownRegistrationStatus(testDb.db, registrant.email)).toMatchObject({
			status: REGISTRATION_STATUS.rejected,
			rejectionReason: REJECTION_REASON
		});

		clock.advance(1000);
		await submitRegistration(testDb.db, clock, {
			name: REGISTRANT_NAME,
			email: registrant.email.toUpperCase(),
			claimedBlock: unit.block,
			claimedNumber: '77'
		});
		expect(await ownRegistrationStatus(testDb.db, registrant.email)).toMatchObject({
			status: REGISTRATION_STATUS.pending,
			claimedNumber: '77'
		});
	});

	it('answers nothing for an address that never registered', async () => {
		expect(await ownRegistrationStatus(testDb.db, anAddress('never'))).toBeUndefined();
	});
});

describe('a registrant who is still waiting', () => {
	it('is no Warga at all, and becomes one the moment they are approved', async () => {
		// The binding acceptance criterion: an unapproved registrant cannot call a single service that
		// needs the full `warga` role. That is proven at the service layer rather than at a layout,
		// because a layout `load` never runs for a child page's form action.
		const actorId = await insertSuperuser();
		const clock = new FakeClock(START);
		const unit = await insertUnitRow();
		const registrant = await register('not-yet', unit, clock);

		// No record of the person, so every Warga service keyed by one answers empty.
		expect(await residentProfileForUser(testDb.db, registrant.userId)).toBeUndefined();
		expect(await occupiedUnitsForUser(testDb.db, clock, registrant.userId)).toHaveLength(0);
		expect(
			await testDb.db.select().from(residents).where(eq(residents.userId, registrant.userId))
		).toHaveLength(0);
		// And no action at all is permitted to them: `resident` is named by no entry in `PERMISSIONS`.
		expect(
			await testDb.db.select().from(userRoles).where(eq(userRoles.userId, registrant.userId))
		).toMatchObject([{ role: ROLE.resident }]);
		for (const action of Object.values(ACTION) as Action[]) {
			expect(
				await rejection(requirePermission(testDb.db, registrant.userId, action))
			).toBeInstanceOf(PermissionDeniedError);
		}

		await approveRegistration(testDb.db, clock, {
			actorId,
			registrationId: registrant.registrationId,
			unitId: unit.unitId,
			origin: TEST_ORIGIN
		});

		expect(await residentProfileForUser(testDb.db, registrant.userId)).toMatchObject({
			name: REGISTRANT_NAME
		});
		expect(await occupiedUnitsForUser(testDb.db, clock, registrant.userId)).toMatchObject([
			{ unitId: unit.unitId, block: unit.block, number: unit.number }
		]);
		// Approval admits them to their own house; it grants no new action, and must not.
		for (const action of Object.values(ACTION) as Action[]) {
			expect(
				await rejection(requirePermission(testDb.db, registrant.userId, action))
			).toBeInstanceOf(PermissionDeniedError);
		}
	});
});
