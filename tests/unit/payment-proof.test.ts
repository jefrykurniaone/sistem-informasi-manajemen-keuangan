import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rupiah } from '$lib/money';
import { user } from '$lib/server/db/schema/auth';
import { occupancies, OCCUPANCY_ROLE } from '$lib/server/db/schema/occupancy';
import { payments } from '$lib/server/db/schema/payment';
import { residents } from '$lib/server/db/schema/resident';
import { units } from '$lib/server/db/schema/unit';
import { testDatabase } from '$lib/server/db/test-helpers';
import { DEFAULT_SIGNED_LINK_LIFETIME_MILLISECONDS } from '$lib/server/ports/file-store';
import { FakeClock, FakeFileStore } from '$lib/server/ports/fakes';
import {
	MAXIMUM_PROOF_BYTES,
	PAYMENT_RULE,
	PROOF_CONTENT_TYPES,
	PaymentRuleError,
	recordPayment,
	type PaymentProofUpload
} from '$lib/server/services/dues/payment';

/**
 * The photograph a Warga attaches to a Pembayaran: where it is stored, how it is read back, and
 * every way it is refused.
 *
 * A proof of transfer carries a bank account number and the name of whoever owns it
 * (`docs/spec-iuran-v1.md`), which is why it goes through the `FileStore` port and comes back only
 * through a short-lived signed link — and why the bytes are checked against the format they claim to
 * be rather than believed.
 */

const testDb = testDatabase();

/** The instant every clock in this file starts at. */
const START = '2026-01-01T00:00:00.000Z';

/** The day the money moved in these tests. */
const RECEIVED_ON = '2025-12-29';

/** The bytes a real JPEG starts with, followed by filler — enough for the signature check. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** The eight bytes a real PNG starts with. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

/** A real WEBP header: `RIFF`, four bytes of length, then `WEBP`. */
const WEBP = Uint8Array.from([
	0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
]);

/** An account with a residents row, a house, and a running stay in it. */
async function insertPayer(name: string, block: string, number: string): Promise<[string, string]> {
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
	const [resident] = await testDb.db
		.insert(residents)
		.values({ userId, phone: null, createdAt: now })
		.returning();
	const [unit] = await testDb.db
		.insert(units)
		.values({ block, number, createdAt: now })
		.returning();
	await testDb.db.insert(occupancies).values({
		unitId: unit.id,
		residentId: resident.id,
		role: OCCUPANCY_ROLE.owner,
		startedOn: '2025-01-01',
		endedOn: null,
		isPrimaryOccupant: false,
		createdAt: now
	});
	return [userId, unit.id];
}

/** Records a payment carrying `proof`, with everything else at this file's defaults. */
async function recordWithProof(
	actorUserId: string,
	unitId: string,
	proof: PaymentProofUpload,
	fileStore: FakeFileStore,
	clock: FakeClock = new FakeClock(START)
) {
	return recordPayment(testDb.db, clock, fileStore, {
		actorUserId,
		unitId,
		amount: rupiah(150_000),
		receivedOn: RECEIVED_ON,
		proof
	});
}

describe('where a proof is stored', () => {
	it.each([
		{ contentType: 'image/jpeg', content: JPEG, extension: 'jpg' },
		{ contentType: 'image/png', content: PNG, extension: 'png' },
		{ contentType: 'image/webp', content: WEBP, extension: 'webp' }
	])(
		'stores a $contentType proof at payments/<id>/proof.$extension',
		async ({ contentType, content, extension }) => {
			const [userId, unitId] = await insertPayer(`Warga Bukti ${extension}`, 'A', extension);
			const fileStore = new FakeFileStore(new FakeClock(START));

			const recorded = await recordWithProof(userId, unitId, { contentType, content }, fileStore);

			// The key is derived from the row's own id, which is minted before the row exists — that is
			// what lets `proofFileKey` be written on the insert instead of by an update afterwards.
			const expectedKey = `payments/${recorded.id}/proof.${extension}`;
			expect(recorded.proofFileKey).toBe(expectedKey);
			expect(fileStore.keys).toEqual([expectedKey]);
			expect(await fileStore.read(expectedKey)).toEqual(content);
		}
	);

	it('takes the extension from the verified bytes, never from what the browser called the file', () => {
		// There is no file name in `PaymentProofUpload` at all, which is the strongest form of this:
		// a name cannot become part of a storage key if it never reaches the service. The three
		// extensions the service can write are the three it checks signatures for.
		expect(PROOF_CONTENT_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
	});
});

describe('how a proof is read back', () => {
	it('is opened through a short-lived signed link, and never through a path of its own', async () => {
		const [userId, unitId] = await insertPayer('Warga Bukti Tertaut', 'B', '1');
		const clock = new FakeClock(START);
		const fileStore = new FakeFileStore(clock);

		const recorded = await recordWithProof(
			userId,
			unitId,
			{ contentType: 'image/jpeg', content: JPEG },
			fileStore,
			clock
		);

		const link = await fileStore.signedLink(recorded.proofFileKey ?? '');
		expect(link.startsWith(`/files/${recorded.proofFileKey}?`)).toBe(true);
		expect(fileStore.verifySignedLink(link)).toMatchObject({
			valid: true,
			key: recorded.proofFileKey
		});

		// Ten minutes on, the same link is dead. That expiry, plus the fact that the only page minting
		// one lists the caller's own payments, is what "hanya bisa dibuka lewat tautan bertanda tangan
		// berumur pendek" means in practice.
		clock.advance(DEFAULT_SIGNED_LINK_LIFETIME_MILLISECONDS + 1000);
		expect(fileStore.verifySignedLink(link)).toMatchObject({ valid: false, reason: 'expired' });
	});

	it('refuses a link whose key has been edited to point at somebody else’s proof', async () => {
		const [firstUser, firstUnit] = await insertPayer('Warga Bukti Sendiri', 'B', '2');
		const [secondUser, secondUnit] = await insertPayer('Warga Bukti Orang Lain', 'B', '3');
		const clock = new FakeClock(START);
		const fileStore = new FakeFileStore(clock);
		const mine = await recordWithProof(
			firstUser,
			firstUnit,
			{ contentType: 'image/jpeg', content: JPEG },
			fileStore,
			clock
		);
		const theirs = await recordWithProof(
			secondUser,
			secondUnit,
			{ contentType: 'image/jpeg', content: JPEG },
			fileStore,
			clock
		);

		const link = await fileStore.signedLink(mine.proofFileKey ?? '');
		const repointed = link.replace(mine.id, theirs.id);

		expect(repointed).not.toBe(link);
		// The signature covers the key, so re-pointing it invalidates it. Nothing about the other
		// person's file is revealed, not even whether it exists.
		expect(fileStore.verifySignedLink(repointed)).toMatchObject({
			valid: false,
			reason: 'signature'
		});
	});
});

describe('what is refused as a proof', () => {
	it('refuses a payment with no proof at all, and writes no row', async () => {
		// `payments.proofFileKey` is nullable because user story 17's cash payment has no receipt to
		// photograph. A transfer a resident records is the other case, and it always carries one.
		const [userId, unitId] = await insertPayer('Warga Tanpa Bukti', 'C', '1');
		const fileStore = new FakeFileStore(new FakeClock(START));

		const refusal: unknown = await recordWithProof(
			userId,
			unitId,
			{ contentType: 'image/jpeg', content: new Uint8Array(0) },
			fileStore
		).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(PaymentRuleError);
		expect(refusal).toMatchObject({ rule: PAYMENT_RULE.proofMissing });
		expect(await testDb.db.select().from(payments).where(eq(payments.unitId, unitId))).toEqual([]);
		expect(fileStore.keys).toEqual([]);
	});

	it('refuses a file past the size limit, and stores neither the file nor the row', async () => {
		const [userId, unitId] = await insertPayer('Warga Bukti Besar', 'C', '2');
		const fileStore = new FakeFileStore(new FakeClock(START));
		const tooBig = new Uint8Array(MAXIMUM_PROOF_BYTES + 1);
		tooBig.set(JPEG);

		const refusal: unknown = await recordWithProof(
			userId,
			unitId,
			{ contentType: 'image/jpeg', content: tooBig },
			fileStore
		).catch((error: unknown) => error);

		expect(refusal).toMatchObject({ rule: PAYMENT_RULE.proofTooLarge });
		expect(fileStore.keys).toEqual([]);
		expect(await testDb.db.select().from(payments).where(eq(payments.unitId, unitId))).toEqual([]);
	});

	it('accepts a file exactly at the limit, so the boundary is the one that was written down', async () => {
		const [userId, unitId] = await insertPayer('Warga Bukti Pas Batas', 'C', '3');
		const fileStore = new FakeFileStore(new FakeClock(START));
		const exactly = new Uint8Array(MAXIMUM_PROOF_BYTES);
		exactly.set(JPEG);

		const recorded = await recordWithProof(
			userId,
			unitId,
			{ contentType: 'image/jpeg', content: exactly },
			fileStore
		);

		expect(recorded.proofFileKey).toBe(`payments/${recorded.id}/proof.jpg`);
	});

	it('refuses bytes that are not really the image they claim to be', async () => {
		const [userId, unitId] = await insertPayer('Warga Bukti Palsu', 'C', '4');
		const fileStore = new FakeFileStore(new FakeClock(START));
		const notAnImage = new TextEncoder().encode('<script>alert(1)</script>');

		for (const proof of [
			// A script claiming to be a photograph …
			{ contentType: 'image/jpeg', content: notAnImage },
			// … and one that does not even claim it.
			{ contentType: 'text/html', content: notAnImage },
			// A PNG's own bytes under a JPEG's name: the two maps have to agree, one entry at a time.
			{ contentType: 'image/jpeg', content: PNG }
		]) {
			const refusal: unknown = await recordWithProof(userId, unitId, proof, fileStore).catch(
				(error: unknown) => error
			);
			expect(refusal).toBeInstanceOf(PaymentRuleError);
			expect(refusal).toMatchObject({ rule: PAYMENT_RULE.proofNotAnImage });
		}

		expect(fileStore.keys).toEqual([]);
		expect(await testDb.db.select().from(payments).where(eq(payments.unitId, unitId))).toEqual([]);
	});

	it.each(['constructor', '__proto__', 'toString', 'valueOf'])(
		'refuses the content type "%s", which names a property of Object.prototype and not a format',
		async (contentType) => {
			// `File.type` is whatever the client sent, so the content type is as much the sender's to
			// choose as the bytes are. Looked up in an *object literal*, each of these answers with
			// something truthy inherited from `Object.prototype` — `constructor` with `Object`,
			// `__proto__` with `Object.prototype` — which defeats both the `if (!extension)` guard and
			// the `?? []` fallback, and then throws `TypeError: signature.every is not a function`: a
			// 500 where the contract says a named refusal, reachable from a forged upload.
			// `PROOF_EXTENSIONS` and `PROOF_SIGNATURES` are `Map`s so that `get` answers `undefined`.
			// This test is what keeps them from being written back as literals. Repository defect #93
			// is one place that rule was broken; this is not a second.
			const [userId, unitId] = await insertPayer(`Warga Bukti ${contentType}`, 'D', contentType);
			const fileStore = new FakeFileStore(new FakeClock(START));

			const refusal: unknown = await recordWithProof(
				userId,
				unitId,
				// Real JPEG bytes, so the only thing wrong with this upload is the name of its format.
				{ contentType, content: JPEG },
				fileStore
			).catch((error: unknown) => error);

			expect(refusal).toBeInstanceOf(PaymentRuleError);
			expect(refusal).toMatchObject({ rule: PAYMENT_RULE.proofNotAnImage });
			expect(fileStore.keys).toEqual([]);
			expect(await testDb.db.select().from(payments).where(eq(payments.unitId, unitId))).toEqual(
				[]
			);
		}
	);
});
