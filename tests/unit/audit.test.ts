import { describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
import * as auditModule from '$lib/server/audit';
import { auditEntriesFor, recordAuditEntry } from '$lib/server/audit';
import { scaffoldProbe } from '$lib/server/db/schema';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock } from '$lib/server/ports/fakes';

/**
 * The audit log module: what it writes, what it reads back, and — just as much the point of this
 * file — what it refuses to ever export.
 */

const testDb = testDatabase();

/** The instant most entries in this file are stamped with. */
const START = '2026-01-01T00:00:00.000Z';

describe('the audit log module', () => {
	it('exports exactly one way to write and one way to read, and nothing that updates or deletes', () => {
		// A future `updateAuditEntry` or `deleteAuditEntry` shows up here as a failing assertion,
		// not as something a reviewer has to notice by eye.
		expect(Object.keys(auditModule).sort()).toEqual(['auditEntriesFor', 'recordAuditEntry']);
	});
});

describe('recordAuditEntry', () => {
	it('writes the actor, action, target, before, after and the clock it was given', async () => {
		const clock = new FakeClock(START);

		const row = await recordAuditEntry(testDb.db, clock, {
			actorId: 'actor-1',
			action: 'role_change',
			targetId: 'target-1',
			before: ['resident'],
			after: ['resident', 'admin']
		});

		expect(row).toMatchObject({
			actorId: 'actor-1',
			action: 'role_change',
			targetId: 'target-1',
			before: ['resident'],
			after: ['resident', 'admin']
		});
		expect(row.occurredAt.getTime()).toBe(Date.parse(START));
	});

	it('accepts an action with no before or after to record', async () => {
		const row = await recordAuditEntry(testDb.db, new FakeClock(START), {
			actorId: 'actor-2',
			action: 'no-values',
			targetId: 'target-2'
		});

		expect(row.before).toBeNull();
		expect(row.after).toBeNull();
	});

	it('commits with the action that asked for it', async () => {
		await testDb.db.transaction(async (transaction) => {
			await transaction
				.insert(scaffoldProbe)
				.values({ description: 'an action that succeeds', amount: rupiah(1) });
			await recordAuditEntry(transaction, new FakeClock(START), {
				actorId: 'actor-committed',
				action: 'commit-test',
				targetId: 'target-committed'
			});
		});

		expect(await auditEntriesFor(testDb.db, 'target-committed')).toHaveLength(1);
	});

	it('is rolled back with the action that asked for it', async () => {
		await expect(
			testDb.db.transaction(async (transaction) => {
				await recordAuditEntry(transaction, new FakeClock(START), {
					actorId: 'actor-rolled-back',
					action: 'rollback-test',
					targetId: 'target-rolled-back'
				});
				throw new Error('the action failed after recording its audit entry');
			})
		).rejects.toThrow('the action failed');

		expect(await auditEntriesFor(testDb.db, 'target-rolled-back')).toHaveLength(0);
	});
});

describe('auditEntriesFor', () => {
	it('returns only the entries about one target, newest first', async () => {
		const clock = new FakeClock(START);
		await recordAuditEntry(testDb.db, clock, {
			actorId: 'actor-a',
			action: 'order-test',
			targetId: 'target-order'
		});
		clock.advance(60_000);
		await recordAuditEntry(testDb.db, clock, {
			actorId: 'actor-b',
			action: 'order-test',
			targetId: 'target-order'
		});
		await recordAuditEntry(testDb.db, clock, {
			actorId: 'actor-c',
			action: 'order-test',
			targetId: 'a-different-target'
		});

		const entries = await auditEntriesFor(testDb.db, 'target-order');

		expect(entries.map((entry) => entry.actorId)).toEqual(['actor-b', 'actor-a']);
	});
});
