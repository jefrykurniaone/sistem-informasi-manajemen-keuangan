import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditEntriesFor } from '$lib/server/audit';
import { user } from '$lib/server/db/schema/auth';
import {
	COMPLAINT_STATUS,
	COMPLAINT_VISIBILITY,
	complaintAttachments,
	complaints,
	type ComplaintVisibility
} from '$lib/server/db/schema/complaint';
import { residents } from '$lib/server/db/schema/resident';
import { testDatabase } from '$lib/server/db/test-helpers';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import {
	COMPLAINT_ATTACHMENT_RULE,
	COMPLAINT_CREATED_ACTION,
	COMPLAINT_RULE,
	ComplaintAttachmentRuleError,
	ComplaintRuleError,
	createComplaint,
	type ComplaintAttachmentUpload,
	type CreateComplaintRequest
} from '$lib/server/services/complaint';

/**
 * `createComplaint`: the export the orchestrator's correction added to this ticket's `writes:`
 * because #43 left reporting a Keluhan to whichever ticket built the screens. User stories 1
 * through 3 of `docs/spec-keluhan-v1.md`, and the acceptance criteria this ticket's own tests
 * cover — the shape and permission rules here, the Lampiran limit and its format/size checks in
 * `tests/unit/complaint-attachment.test.ts`.
 */

const testDb = testDatabase();
const START = '2026-02-01T00:00:00.000Z';

/** The bytes a real JPEG starts with, followed by filler — enough for the signature check. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

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

/** An account with a `residents` row — the normal state of an admitted Warga. */
async function insertReporter(name: string): Promise<string> {
	const userId = await insertUser(name);
	await testDb.db.insert(residents).values({ userId, createdAt: new Date(START) });
	return userId;
}

async function residentIdOf(userId: string): Promise<string> {
	const [row] = await testDb.db
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, userId));
	return row.id;
}

/** Reports a complaint with this file's defaults, overridden by whatever the test cares about. */
async function report(
	overrides: Partial<CreateComplaintRequest> & { readonly actorId: string },
	fileStore: FakeFileStore = new FakeFileStore(new FakeClock(START)),
	clock: FakeClock = new FakeClock(START)
) {
	return createComplaint(testDb.db, clock, fileStore, {
		title: unique('Lampu jalan mati'),
		category: 'penerangan',
		description: 'Lampu di depan blok sudah mati tiga hari.',
		visibility: COMPLAINT_VISIBILITY.private,
		attachments: [],
		...overrides
	});
}

describe('createComplaint', () => {
	it('writes a complaint that starts "new" with statusChangedAt equal to createdAt', async () => {
		const reporterUserId = await insertReporter(unique('Warga Lapor'));

		const created = await report({ actorId: reporterUserId });

		expect(created).toMatchObject({
			reporterId: await residentIdOf(reporterUserId),
			status: COMPLAINT_STATUS.new,
			visibility: COMPLAINT_VISIBILITY.private,
			rejectionReason: null
		});
		expect(created.statusChangedAt.getTime()).toBe(created.createdAt.getTime());
		expect(created.createdAt.getTime()).toBe(Date.parse(START));
	});

	it.each([COMPLAINT_VISIBILITY.private, COMPLAINT_VISIBILITY.public])(
		'writes the visibility "%s" exactly as the reporter chose it',
		async (visibility: ComplaintVisibility) => {
			const reporterUserId = await insertReporter(unique(`Warga Visibilitas ${visibility}`));

			const created = await report({ actorId: reporterUserId, visibility });

			expect(created.visibility).toBe(visibility);
		}
	);

	it('records who reported it, against the account rather than the residents row', async () => {
		const reporterUserId = await insertReporter(unique('Warga Beraudit'));

		const created = await report({ actorId: reporterUserId });

		const entries = await auditEntriesFor(testDb.db, created.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorId: reporterUserId,
			action: COMPLAINT_CREATED_ACTION,
			targetId: created.id,
			after: {
				title: created.title,
				category: 'penerangan',
				visibility: COMPLAINT_VISIBILITY.private
			}
		});
	});

	it('refuses an account with no residents row, and writes nothing', async () => {
		const strangerUserId = await insertUser(unique('Warga Belum Disetujui'));

		const attempt = report({ actorId: strangerUserId });

		await expect(attempt).rejects.toThrow(ComplaintRuleError);
		await expect(attempt).rejects.toMatchObject({ rule: COMPLAINT_RULE.actorNotRegistered });
	});

	it.each([
		{ title: '', category: 'penerangan', description: 'Uraian.' },
		{ title: '  ', category: 'penerangan', description: 'Uraian.' },
		{ title: 'Judul', category: '', description: 'Uraian.' },
		{ title: 'Judul', category: 'penerangan', description: '   ' }
	])('refuses an empty title, category or description: %j', async (fields) => {
		const reporterUserId = await insertReporter(unique('Warga Formulir Kosong'));

		await expect(report({ actorId: reporterUserId, ...fields })).rejects.toThrow(TypeError);
	});

	it('refuses a visibility value outside the two the schema allows', async () => {
		const reporterUserId = await insertReporter(unique('Warga Visibilitas Aneh'));

		await expect(
			report({
				actorId: reporterUserId,
				visibility: 'archived' as unknown as ComplaintVisibility
			})
		).rejects.toThrow(TypeError);
	});

	describe('attachments', () => {
		it('stores each photo through the FileStore and writes one complaint_attachments row per file', async () => {
			const reporterUserId = await insertReporter(unique('Warga Lampiran'));
			const fileStore = new FakeFileStore(new FakeClock(START));
			const uploads: ComplaintAttachmentUpload[] = [
				{ contentType: 'image/jpeg', content: JPEG },
				{ contentType: 'image/jpeg', content: JPEG }
			];

			const created = await report({ actorId: reporterUserId, attachments: uploads }, fileStore);

			const rows = await testDb.db
				.select()
				.from(complaintAttachments)
				.where(eq(complaintAttachments.complaintId, created.id));
			expect(rows).toHaveLength(2);
			expect(fileStore.keys).toHaveLength(2);
			for (const row of rows) {
				expect(row.fileKey).toBe(`complaints/${created.id}/${row.id}.jpg`);
				expect(await fileStore.read(row.fileKey)).toEqual(JPEG);
			}
		});

		it('writes a complaint with no attachments at all when none were submitted', async () => {
			const reporterUserId = await insertReporter(unique('Warga Tanpa Lampiran'));
			const fileStore = new FakeFileStore(new FakeClock(START));

			const created = await report({ actorId: reporterUserId, attachments: [] }, fileStore);

			expect(
				await testDb.db
					.select()
					.from(complaintAttachments)
					.where(eq(complaintAttachments.complaintId, created.id))
			).toEqual([]);
			expect(fileStore.keys).toEqual([]);
		});

		it('refuses a fourth attachment, and writes neither the complaint nor any file', async () => {
			const reporterUserId = await insertReporter(unique('Warga Lampiran Berlebih'));
			const fileStore = new FakeFileStore(new FakeClock(START));
			const uploads: ComplaintAttachmentUpload[] = Array.from({ length: 4 }, () => ({
				contentType: 'image/jpeg',
				content: JPEG
			}));

			const attempt = report({ actorId: reporterUserId, attachments: uploads }, fileStore);

			await expect(attempt).rejects.toBeInstanceOf(ComplaintAttachmentRuleError);
			await expect(attempt).rejects.toMatchObject({ rule: COMPLAINT_ATTACHMENT_RULE.tooMany });
			// The count is checked before the batch's first file is ever stored, so a refused batch of
			// four leaves nothing in the file store to clean up.
			expect(fileStore.keys).toEqual([]);
			expect(
				await testDb.db
					.select()
					.from(complaints)
					.where(eq(complaints.reporterId, await residentIdOf(reporterUserId)))
			).toEqual([]);
		});

		it('refuses a file that is not really an image, and writes no complaint row', async () => {
			const reporterUserId = await insertReporter(unique('Warga Lampiran Palsu'));
			const fileStore = new FakeFileStore(new FakeClock(START));
			const notAnImage = new TextEncoder().encode('<script>alert(1)</script>');

			const attempt = report(
				{
					actorId: reporterUserId,
					attachments: [{ contentType: 'image/jpeg', content: notAnImage }]
				},
				fileStore
			);

			await expect(attempt).rejects.toBeInstanceOf(ComplaintAttachmentRuleError);
			await expect(attempt).rejects.toMatchObject({
				rule: COMPLAINT_ATTACHMENT_RULE.attachmentNotAnImage
			});
			expect(fileStore.keys).toEqual([]);
			expect(
				await testDb.db
					.select()
					.from(complaints)
					.where(eq(complaints.reporterId, await residentIdOf(reporterUserId)))
			).toEqual([]);
		});
	});
});
