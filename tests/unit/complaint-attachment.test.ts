import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
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
	ATTACHMENT_CONTENT_TYPES,
	COMPLAINT_ATTACHMENT_RULE,
	ComplaintAttachmentRuleError,
	MAX_ATTACHMENTS_PER_COMPLAINT,
	MAXIMUM_ATTACHMENT_BYTES,
	listComplaintAttachments,
	storeComplaintAttachments,
	type ComplaintAttachmentUpload,
	type StoredComplaintAttachment
} from '$lib/server/services/complaint';

/**
 * Lampiran: the photographs attached to a Keluhan. `storeComplaintAttachments` is what
 * `createComplaint` calls (`tests/unit/complaint-create.test.ts` covers that composition); this
 * file proves the three rules — the count, the format, the size — and the visibility of
 * `listComplaintAttachments` on their own, the same split `payment-proof.test.ts` draws between the
 * upload rules and `recordPayment`'s use of them.
 */

const testDb = testDatabase();
const START = '2026-02-01T00:00:00.000Z';

/** The bytes a real JPEG starts with, followed by filler — enough for the signature check. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** The eight bytes a real PNG starts with. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

/** A real WEBP header: `RIFF`, four bytes of length, then `WEBP`. */
const WEBP = Uint8Array.from([
	0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
]);

let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

async function insertAccount(name: string): Promise<string> {
	const userId = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id: userId,
		name,
		email: `${userId}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	await testDb.db.insert(residents).values({ userId, createdAt: now });
	return userId;
}

async function residentIdOf(userId: string): Promise<string> {
	const [row] = await testDb.db
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, userId));
	return row.id;
}

async function insertComplaint(
	reporterUserId: string,
	visibility: ComplaintVisibility = COMPLAINT_VISIBILITY.private
): Promise<string> {
	const reporterId = await residentIdOf(reporterUserId);
	const at = new Date(START);
	const [row] = await testDb.db
		.insert(complaints)
		.values({
			reporterId,
			title: unique('Selokan tersumbat'),
			category: 'lingkungan',
			description: 'Air tidak mengalir setelah hujan deras kemarin.',
			status: COMPLAINT_STATUS.new,
			visibility,
			rejectionReason: null,
			createdAt: at,
			statusChangedAt: at
		})
		.returning();
	return row.id;
}

/** Inserts `complaint_attachments` rows for what `storeComplaintAttachments` already stored. */
async function insertAttachmentRows(
	complaintId: string,
	stored: readonly StoredComplaintAttachment[]
): Promise<void> {
	await testDb.db.insert(complaintAttachments).values(
		stored.map((attachment, index) => ({
			id: attachment.id,
			complaintId,
			fileKey: attachment.fileKey,
			createdAt: new Date(Date.parse(START) + index * 1000)
		}))
	);
}

describe('storeComplaintAttachments', () => {
	it.each([
		{ contentType: 'image/jpeg', content: JPEG, extension: 'jpg' },
		{ contentType: 'image/png', content: PNG, extension: 'png' },
		{ contentType: 'image/webp', content: WEBP, extension: 'webp' }
	])(
		'stores a $contentType attachment at complaints/<complaintId>/<id>.$extension',
		async ({ contentType, content, extension }) => {
			const complaintId = randomUUID();
			const fileStore = new FakeFileStore(new FakeClock(START));

			const [stored] = await storeComplaintAttachments(fileStore, complaintId, [
				{ contentType, content }
			]);

			expect(stored.fileKey).toBe(`complaints/${complaintId}/${stored.id}.${extension}`);
			expect(fileStore.keys).toEqual([stored.fileKey]);
			expect(await fileStore.read(stored.fileKey)).toEqual(content);
		}
	);

	it('lists exactly the three accepted formats', () => {
		expect(ATTACHMENT_CONTENT_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
	});

	it('accepts exactly MAX_ATTACHMENTS_PER_COMPLAINT files in one batch', async () => {
		const complaintId = randomUUID();
		const fileStore = new FakeFileStore(new FakeClock(START));
		const uploads: ComplaintAttachmentUpload[] = Array.from(
			{ length: MAX_ATTACHMENTS_PER_COMPLAINT },
			() => ({ contentType: 'image/jpeg', content: JPEG })
		);

		const stored = await storeComplaintAttachments(fileStore, complaintId, uploads);

		expect(stored).toHaveLength(MAX_ATTACHMENTS_PER_COMPLAINT);
		expect(fileStore.keys).toHaveLength(MAX_ATTACHMENTS_PER_COMPLAINT);
	});

	it('refuses one more than MAX_ATTACHMENTS_PER_COMPLAINT, before storing anything', async () => {
		const complaintId = randomUUID();
		const fileStore = new FakeFileStore(new FakeClock(START));
		const uploads: ComplaintAttachmentUpload[] = Array.from(
			{ length: MAX_ATTACHMENTS_PER_COMPLAINT + 1 },
			() => ({ contentType: 'image/jpeg', content: JPEG })
		);

		const attempt = storeComplaintAttachments(fileStore, complaintId, uploads);

		await expect(attempt).rejects.toBeInstanceOf(ComplaintAttachmentRuleError);
		await expect(attempt).rejects.toMatchObject({ rule: COMPLAINT_ATTACHMENT_RULE.tooMany });
		expect(fileStore.keys).toEqual([]);
	});

	it('refuses a file past the size limit, and stores nothing', async () => {
		const complaintId = randomUUID();
		const fileStore = new FakeFileStore(new FakeClock(START));
		const tooBig = new Uint8Array(MAXIMUM_ATTACHMENT_BYTES + 1);
		tooBig.set(JPEG);

		const attempt = storeComplaintAttachments(fileStore, complaintId, [
			{ contentType: 'image/jpeg', content: tooBig }
		]);

		await expect(attempt).rejects.toMatchObject({
			rule: COMPLAINT_ATTACHMENT_RULE.attachmentTooLarge
		});
		expect(fileStore.keys).toEqual([]);
	});

	it('accepts a file exactly at the limit, so the boundary is the one that was written down', async () => {
		const complaintId = randomUUID();
		const fileStore = new FakeFileStore(new FakeClock(START));
		const exactly = new Uint8Array(MAXIMUM_ATTACHMENT_BYTES);
		exactly.set(JPEG);

		const [stored] = await storeComplaintAttachments(fileStore, complaintId, [
			{ contentType: 'image/jpeg', content: exactly }
		]);

		expect(stored.fileKey).toBe(`complaints/${complaintId}/${stored.id}.jpg`);
	});

	it('refuses bytes that are not really the image they claim to be', async () => {
		const complaintId = randomUUID();
		const fileStore = new FakeFileStore(new FakeClock(START));
		const notAnImage = new TextEncoder().encode('<script>alert(1)</script>');

		for (const upload of [
			{ contentType: 'image/jpeg', content: notAnImage },
			{ contentType: 'text/html', content: notAnImage },
			// A PNG's own bytes under a JPEG's name: the two maps have to agree, one entry at a time.
			{ contentType: 'image/jpeg', content: PNG }
		]) {
			const attempt = storeComplaintAttachments(fileStore, complaintId, [upload]);
			await expect(attempt).rejects.toBeInstanceOf(ComplaintAttachmentRuleError);
			await expect(attempt).rejects.toMatchObject({
				rule: COMPLAINT_ATTACHMENT_RULE.attachmentNotAnImage
			});
		}
		expect(fileStore.keys).toEqual([]);
	});

	it.each(['constructor', '__proto__', 'toString', 'valueOf'])(
		'refuses the content type "%s", which names a property of Object.prototype and not a format',
		async (contentType) => {
			// Looked up in an *object literal*, each of these answers with something truthy inherited
			// from `Object.prototype` — `constructor` with `Object`, `__proto__` with
			// `Object.prototype` — which would defeat the `if (!extension)` guard and, in the shape
			// `hasSignatureOf` must never take, a `?? []` fallback that makes `.every(...)` vacuously
			// `true`. `ATTACHMENT_EXTENSIONS` and `ATTACHMENT_SIGNATURES` are `Map`s so that `get`
			// answers `undefined`, and `hasSignatureOf` here answers `false` rather than defaulting to
			// an empty, trivially-satisfied signature list. Repository defect #93 is one place that
			// rule was broken; this is not a second.
			const complaintId = randomUUID();
			const fileStore = new FakeFileStore(new FakeClock(START));

			const attempt = storeComplaintAttachments(fileStore, complaintId, [
				// Real JPEG bytes, so the only thing wrong with this upload is the name of its format.
				{ contentType, content: JPEG }
			]);

			await expect(attempt).rejects.toBeInstanceOf(ComplaintAttachmentRuleError);
			await expect(attempt).rejects.toMatchObject({
				rule: COMPLAINT_ATTACHMENT_RULE.attachmentNotAnImage
			});
			expect(fileStore.keys).toEqual([]);
		}
	);
});

describe('listComplaintAttachments', () => {
	it('lists a complaint’s own attachments, oldest first, for its reporter', async () => {
		const reporterUserId = await insertAccount(unique('Warga Lihat Lampiran'));
		const complaintId = await insertComplaint(reporterUserId);
		const fileStore = new FakeFileStore(new FakeClock(START));
		const stored = await storeComplaintAttachments(fileStore, complaintId, [
			{ contentType: 'image/jpeg', content: JPEG },
			{ contentType: 'image/png', content: PNG }
		]);
		await insertAttachmentRows(complaintId, stored);

		const listed = await listComplaintAttachments(testDb.db, reporterUserId, complaintId);

		expect(listed.map((row) => row.fileKey)).toEqual(stored.map((row) => row.fileKey));
	});

	it('answers a private complaint’s attachments with nothing for a viewer who may not read it', async () => {
		const reporterUserId = await insertAccount(unique('Warga Lampiran Rahasia'));
		const strangerUserId = await insertAccount(unique('Tetangga Penebak Lampiran'));
		const complaintId = await insertComplaint(reporterUserId, COMPLAINT_VISIBILITY.private);
		const fileStore = new FakeFileStore(new FakeClock(START));
		const stored = await storeComplaintAttachments(fileStore, complaintId, [
			{ contentType: 'image/jpeg', content: JPEG }
		]);
		await insertAttachmentRows(complaintId, stored);

		expect(await listComplaintAttachments(testDb.db, strangerUserId, complaintId)).toEqual([]);
	});

	it('lists a public complaint’s attachments for any signed-in neighbour', async () => {
		const reporterUserId = await insertAccount(unique('Warga Lampiran Umum'));
		const neighbourUserId = await insertAccount(unique('Tetangga Lampiran Umum'));
		const complaintId = await insertComplaint(reporterUserId, COMPLAINT_VISIBILITY.public);
		const fileStore = new FakeFileStore(new FakeClock(START));
		const stored = await storeComplaintAttachments(fileStore, complaintId, [
			{ contentType: 'image/jpeg', content: JPEG }
		]);
		await insertAttachmentRows(complaintId, stored);

		const listed = await listComplaintAttachments(testDb.db, neighbourUserId, complaintId);

		expect(listed.map((row) => row.fileKey)).toEqual(stored.map((row) => row.fileKey));
	});
});
