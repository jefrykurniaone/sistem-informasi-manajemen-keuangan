import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '$lib/errors';
import { auditEntriesFor } from '$lib/server/audit';
import { user } from '$lib/server/db/schema/auth';
import { ROLE, userRoles, type Role } from '$lib/server/db/schema/authz';
import {
	COMPLAINT_STATUS,
	COMPLAINT_VISIBILITY,
	complaints,
	type Complaint,
	type ComplaintVisibility
} from '$lib/server/db/schema/complaint';
import { residents } from '$lib/server/db/schema/resident';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';
import {
	COMPLAINT_RULE,
	COMPLAINT_VISIBILITY_CHANGED_ACTION,
	ComplaintNotFoundError,
	getComplaint,
	listComplaints,
	setComplaintVisibility
} from '$lib/server/services/complaint';
import {
	COMPLAINT_SCOPE_ALL,
	COMPLAINT_SCOPE_NONE,
	complaintReadScopeFor,
	complaintScopeFilter,
	mayReadComplaint
} from '$lib/server/services/complaint/visibility';

/**
 * Who may read which Keluhan. `docs/spec-keluhan-v1.md` asks for this as "tabel kasus antara peran
 * pembaca, pemilik keluhan, dan visibilitas keluhan, untuk daftar maupun pembacaan satu keluhan
 * dengan pengenal yang ditebak", and that matrix is `EVERY_CASE` below — walked three times, once
 * against the list, once against a direct read by id, and once against the in-memory predicate, so
 * that the three cannot answer differently.
 *
 * The guessed-id half is the one that matters most. A complaint somebody else reported privately
 * must answer exactly as a complaint that does not exist, or a neighbour can confirm one exists by
 * trying its address.
 */

const testDb = testDatabase();

const START = '2026-05-01T00:00:00.000Z';
const CLOCK = new FakeClock(START);

/** Every account and complaint the matrix reads against, written once for the whole file. */
interface Fixture {
	readonly reporterUserId: string;
	readonly neighbourUserId: string;
	readonly adminUserId: string;
	readonly superuserUserId: string;
	/** Signed in, but with no `residents` row — a self-registrant still waiting to be admitted. */
	readonly strangerUserId: string;
	readonly privateComplaintId: string;
	readonly publicComplaintId: string;
}

let fixture: Fixture;

/** Makes every complaint this file writes distinguishable from every other one. */
let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role like any sign-up. */
async function insertUser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: `${id}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

/** A signed-in account with the `residents` row a complaint can be attributed to. */
async function insertAccount(name: string, role?: Role): Promise<string> {
	const userId = await insertUser(name);
	if (role) {
		await testDb.db.insert(userRoles).values({ userId, role, createdAt: new Date(START) });
	}
	await testDb.db.insert(residents).values({ userId, createdAt: new Date(START) });
	return userId;
}

/** The `residents.id` behind an account, which is what a complaint's `reporterId` names. */
async function residentIdOf(userId: string): Promise<string> {
	const [row] = await testDb.db
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, userId));
	return row.id;
}

/** A complaint with a chosen visibility, written straight to the table as a fixture. */
async function insertComplaint(
	reporterUserId: string,
	visibility: ComplaintVisibility
): Promise<Complaint> {
	const reporterId = await residentIdOf(reporterUserId);
	const createdAt = new Date(START);
	const [row] = await testDb.db
		.insert(complaints)
		.values({
			reporterId,
			title: unique('Saluran air tersumbat'),
			category: 'kebersihan',
			description: 'Saluran di belakang blok B tersumbat dan mulai berbau.',
			status: COMPLAINT_STATUS.new,
			visibility,
			rejectionReason: null,
			createdAt,
			statusChangedAt: createdAt
		})
		.returning();
	return row;
}

beforeAll(async () => {
	const reporterUserId = await insertAccount('Warga Pelapor');
	fixture = {
		reporterUserId,
		neighbourUserId: await insertAccount('Warga Tetangga'),
		adminUserId: await insertAccount('Pengurus Pembaca', ROLE.admin),
		superuserUserId: await insertAccount('Superuser Pembaca', ROLE.superuser),
		strangerUserId: await insertUser('Pendaftar Belum Disetujui'),
		privateComplaintId: (await insertComplaint(reporterUserId, COMPLAINT_VISIBILITY.private)).id,
		publicComplaintId: (await insertComplaint(reporterUserId, COMPLAINT_VISIBILITY.public)).id
	};
});

/** Which of the accounts above a case reads as. `null` is nobody signed in. */
type ViewerKey = 'signedOut' | 'stranger' | 'neighbour' | 'reporter' | 'admin' | 'superuser';

/** The account behind a `ViewerKey`, resolved once the fixture exists. */
function viewerUserId(key: ViewerKey): string | null {
	const accounts: Readonly<Record<Exclude<ViewerKey, 'signedOut'>, string>> = {
		stranger: fixture.strangerUserId,
		neighbour: fixture.neighbourUserId,
		reporter: fixture.reporterUserId,
		admin: fixture.adminUserId,
		superuser: fixture.superuserUserId
	};
	return key === 'signedOut' ? null : accounts[key];
}

/** What the spec says each kind of viewer may read, by the complaint's visibility. */
const VIEWERS: readonly {
	readonly viewer: ViewerKey;
	readonly readsPrivate: boolean;
	readonly readsPublic: boolean;
}[] = [
	// "tidak pernah publik tanpa akun" — a `umum` complaint is still invisible to a stranger.
	{ viewer: 'signedOut', readsPrivate: false, readsPublic: false },
	// The line the spec draws is signed in against signed out, not admitted against pending.
	{ viewer: 'stranger', readsPrivate: false, readsPublic: true },
	{ viewer: 'neighbour', readsPrivate: false, readsPublic: true },
	// Story 4: a reporter reads their own complaints whatever their visibility.
	{ viewer: 'reporter', readsPrivate: true, readsPublic: true },
	// `ACTION.readAllComplaints`, held by both — see `src/lib/server/authz.ts`.
	{ viewer: 'admin', readsPrivate: true, readsPublic: true },
	{ viewer: 'superuser', readsPrivate: true, readsPublic: true }
];

/** Every combination of reader, ownership and visibility. The matrix the spec asks for. */
const EVERY_CASE = VIEWERS.flatMap((row) => [
	{
		viewer: row.viewer,
		visibility: COMPLAINT_VISIBILITY.private,
		owned: row.viewer === 'reporter',
		readable: row.readsPrivate
	},
	{
		viewer: row.viewer,
		visibility: COMPLAINT_VISIBILITY.public,
		owned: row.viewer === 'reporter',
		readable: row.readsPublic
	}
]);

/** The fixture complaint a case is about. */
function complaintIdFor(visibility: ComplaintVisibility): string {
	return visibility === COMPLAINT_VISIBILITY.private
		? fixture.privateComplaintId
		: fixture.publicComplaintId;
}

describe('listComplaints', () => {
	it.each(EVERY_CASE)(
		'$viewer, $visibility complaint, owned: $owned -> listed: $readable',
		async ({ viewer, visibility, readable }) => {
			const listed = await listComplaints(testDb.db, CLOCK, { viewerUserId: viewerUserId(viewer) });

			expect(listed.some((row) => row.id === complaintIdFor(visibility))).toBe(readable);
		}
	);

	it('answers a signed-out viewer with an empty list rather than every complaint', async () => {
		// The failure this guards against is a filter that widens to "no restriction" instead of
		// "matches nothing" — which would hand the whole table to somebody entitled to none of it.
		expect(await listComplaints(testDb.db, CLOCK, { viewerUserId: null })).toEqual([]);
	});
});

describe('getComplaint with an id the caller guessed', () => {
	it.each(EVERY_CASE)(
		'$viewer, $visibility complaint, owned: $owned -> readable: $readable',
		async ({ viewer, visibility, readable }) => {
			const complaintId = complaintIdFor(visibility);
			const read = getComplaint(testDb.db, CLOCK, viewerUserId(viewer), complaintId);

			if (readable) {
				expect((await read).id).toBe(complaintId);
				return;
			}
			await expect(read).rejects.toThrow(ComplaintNotFoundError);
		}
	);

	it('answers an unreadable complaint exactly as it answers one that does not exist', async () => {
		const missing = getComplaint(testDb.db, CLOCK, fixture.neighbourUserId, randomUUID());
		const forbidden = getComplaint(
			testDb.db,
			CLOCK,
			fixture.neighbourUserId,
			fixture.privateComplaintId
		);

		await expect(missing).rejects.toThrow(ComplaintNotFoundError);
		await expect(forbidden).rejects.toThrow(ComplaintNotFoundError);
	});
});

describe('complaintReadScopeFor', () => {
	it.each([
		{ viewer: 'admin' as const, scope: COMPLAINT_SCOPE_ALL },
		{ viewer: 'superuser' as const, scope: COMPLAINT_SCOPE_ALL },
		{ viewer: 'signedOut' as const, scope: COMPLAINT_SCOPE_NONE }
	])('answers $viewer with the named scope', async ({ viewer, scope }) => {
		expect(await complaintReadScopeFor(testDb.db, viewerUserId(viewer))).toEqual(scope);
	});

	it.each(VIEWERS)(
		'gives $viewer a filter that is missing only when the scope really is unrestricted',
		async ({ viewer }) => {
			// The one property the whole module exists for: `undefined` composes silently inside
			// Drizzle's `and()`, so it may only ever come back for the scope that has no restriction.
			const scope = await complaintReadScopeFor(testDb.db, viewerUserId(viewer));

			expect(complaintScopeFilter(scope) === undefined).toBe(scope.kind === 'all');
		}
	);
});

describe('mayReadComplaint', () => {
	it.each(EVERY_CASE)(
		'$viewer, $visibility complaint, owned: $owned -> $readable, agreeing with the query',
		async ({ viewer, visibility, readable }) => {
			const scope = await complaintReadScopeFor(testDb.db, viewerUserId(viewer));
			const [row] = await testDb.db
				.select()
				.from(complaints)
				.where(eq(complaints.id, complaintIdFor(visibility)));

			expect(mayReadComplaint(scope, row)).toBe(readable);
		}
	);
});

describe('setComplaintVisibility', () => {
	it('lets the reporter lower a complaint from public to private, and records it', async () => {
		const reporterUserId = await insertAccount(unique('Warga Menurunkan'));
		const complaint = await insertComplaint(reporterUserId, COMPLAINT_VISIBILITY.public);

		const lowered = await setComplaintVisibility(testDb.db, CLOCK, {
			actorId: reporterUserId,
			complaintId: complaint.id,
			to: COMPLAINT_VISIBILITY.private
		});

		expect(lowered.visibility).toBe(COMPLAINT_VISIBILITY.private);
		const entries = await auditEntriesFor(testDb.db, complaint.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: reporterUserId,
			action: COMPLAINT_VISIBILITY_CHANGED_ACTION,
			targetId: complaint.id,
			before: { visibility: COMPLAINT_VISIBILITY.public },
			after: { visibility: COMPLAINT_VISIBILITY.private }
		});
	});

	it('stops the neighbours reading it from the moment it is lowered', async () => {
		const reporterUserId = await insertAccount(unique('Warga Menyembunyikan'));
		const complaint = await insertComplaint(reporterUserId, COMPLAINT_VISIBILITY.public);
		expect((await getComplaint(testDb.db, CLOCK, fixture.neighbourUserId, complaint.id)).id).toBe(
			complaint.id
		);

		await setComplaintVisibility(testDb.db, CLOCK, {
			actorId: reporterUserId,
			complaintId: complaint.id,
			to: COMPLAINT_VISIBILITY.private
		});

		await expect(
			getComplaint(testDb.db, CLOCK, fixture.neighbourUserId, complaint.id)
		).rejects.toThrow(ComplaintNotFoundError);
	});

	it.each([
		{ from: COMPLAINT_VISIBILITY.private, to: COMPLAINT_VISIBILITY.public, what: 'a widening' },
		{
			from: COMPLAINT_VISIBILITY.private,
			to: COMPLAINT_VISIBILITY.private,
			what: 'a private no-op'
		},
		{ from: COMPLAINT_VISIBILITY.public, to: COMPLAINT_VISIBILITY.public, what: 'a public no-op' }
	])('refuses $what, $from -> $to', async ({ from, to }) => {
		const reporterUserId = await insertAccount(unique('Warga Menaikkan'));
		const complaint = await insertComplaint(reporterUserId, from);

		const failure = setComplaintVisibility(testDb.db, CLOCK, {
			actorId: reporterUserId,
			complaintId: complaint.id,
			to
		});

		await expect(failure).rejects.toMatchObject({ rule: COMPLAINT_RULE.visibilityOnlyLowers });
		const [row] = await testDb.db.select().from(complaints).where(eq(complaints.id, complaint.id));
		expect(row.visibility).toBe(from);
		expect(await auditEntriesFor(testDb.db, complaint.id)).toEqual([]);
	});

	it.each([
		{ who: 'a neighbour', role: undefined },
		{ who: 'an admin', role: ROLE.admin },
		{ who: 'a superuser', role: ROLE.superuser }
	])('refuses $who, who did not report it, with PermissionDeniedError', async ({ role }) => {
		const reporterUserId = await insertAccount(unique('Warga Pemilik Visibilitas'));
		const callerUserId = await insertAccount(unique('Bukan Pelapor Visibilitas'), role);
		const complaint = await insertComplaint(reporterUserId, COMPLAINT_VISIBILITY.public);

		await expect(
			setComplaintVisibility(testDb.db, CLOCK, {
				actorId: callerUserId,
				complaintId: complaint.id,
				to: COMPLAINT_VISIBILITY.private
			})
		).rejects.toThrow(PermissionDeniedError);
	});

	it('refuses an account with no residents row before it reads any complaint', async () => {
		await expect(
			setComplaintVisibility(testDb.db, CLOCK, {
				actorId: fixture.strangerUserId,
				complaintId: fixture.publicComplaintId,
				to: COMPLAINT_VISIBILITY.private
			})
		).rejects.toMatchObject({ rule: COMPLAINT_RULE.actorNotRegistered });
	});
});
