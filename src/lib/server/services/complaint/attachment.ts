import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { DatabaseWriter } from '../../authz';
import { complaintAttachments, complaints } from '../../db/schema/complaint';
import type { FileStore } from '../../ports/file-store';
import { complaintReadScopeFor, complaintScopeFilter } from './visibility';

/**
 * **Lampiran: the photographs attached to one Keluhan, and the three rules that make them safe.**
 *
 * `docs/spec-keluhan-v1.md` puts all three at the service layer for the same stated reason the rest
 * of this feature's rules live there — "aturan … yang hanya hidup di formulir akan hilang begitu ada
 * jalan kedua menuju data yang sama" — so a form that blocks a fourth photo or a non-image file in
 * the browser blocks nothing on its own:
 *
 * - **At most three per complaint.** Checked against the whole batch a report is submitted with, in
 *   one pass, before anything is uploaded. There is no "add a photo to an existing complaint" screen
 *   in this ticket's surface, so this is the only place the count is ever checked.
 * - **Not an image is refused.** The content type on an upload is whatever the sender chose to send,
 *   so it is a claim rather than a fact, exactly as `src/lib/server/services/dues/payment.ts`'s doc
 *   comment argues for a Pembayaran's proof — a photograph of a broken gate is read back by whoever
 *   holds a signed link, and a file that is not an image but says it is one is the shape of an upload
 *   that becomes a script the moment anything downstream sniffs its bytes instead of believing the
 *   extension.
 * - **Past `MAXIMUM_ATTACHMENT_BYTES` is refused.**
 *
 * ## A near-copy of `payment.ts`'s upload checks, deliberately
 *
 * `PROOF_EXTENSIONS`/`PROOF_SIGNATURES` in `../dues/payment.ts` already check exactly these three
 * image formats the same way. This module copies the shape rather than importing it, for the reason
 * that module's own doc comment states about its own copy of the post service's cover-image check:
 * importing one spec's accepted formats into another makes each free to change only in lockstep with
 * a neighbour it has nothing to do with. `MAXIMUM_ATTACHMENT_BYTES` is `MAXIMUM_PROOF_BYTES`'s value
 * restated here as its own constant, per the orchestrator's correction to this ticket's `writes:` —
 * a limit the service enforces has to be readable in the service that enforces it.
 *
 * ## `Map`, never an object literal, and `hasSignatureOf` never defaults to "passes"
 *
 * Looked up in an object literal, `'constructor'` and `'__proto__'` both answer with something
 * truthy inherited from `Object.prototype`, which is exactly the defect open as #93. Both maps below
 * are `ReadonlyMap`s so that `get` has no prototype chain behind it. `hasSignatureOf` in
 * `payment.ts` reads `PROOF_SIGNATURES.get(contentType) ?? []`, and `[].every(...)` is `true` — a
 * default that lets an unrecognised content type's bytes through unchecked, which is the wrong shape
 * for a security check. This module's `hasSignatureOf` answers `false` when the content type has no
 * registered signature at all, never `true`.
 *
 * ## Storing is not writing the row
 *
 * `storeComplaintAttachments` only validates a batch and writes bytes through the `FileStore` port;
 * it returns the `{ id, fileKey }` pairs and leaves inserting `complaint_attachments` rows to
 * `createComplaint` in `./index.ts`, which is the one place `complaints.id` exists to build a key
 * from and the one place the row and its attachments are written in the same transaction. The order
 * — validate the whole batch, then store each file, then let the caller insert the rows — is
 * `recordPayment`'s order for its own single file, extended to several.
 */

/** How many photographs a single Keluhan may carry — the spec's "paling banyak tiga per Keluhan". */
export const MAX_ATTACHMENTS_PER_COMPLAINT = 3;

/**
 * The largest photograph this application accepts per attachment: 5 MiB, the same figure
 * `MAXIMUM_PROOF_BYTES` in `../dues/payment.ts` uses for a Pembayaran's proof, restated as this
 * module's own constant rather than imported — see this module's doc comment.
 */
export const MAXIMUM_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Bytes in a mebibyte, so the limit can also be stated in the unit a person reads. */
const BYTES_PER_MEBIBYTE = 1024 * 1024;

/**
 * `MAXIMUM_ATTACHMENT_BYTES` in the unit the messages state it in, exported so the sentence a
 * resident reads interpolates the same constant the service enforces.
 */
export const MAXIMUM_ATTACHMENT_MEBIBYTES = MAXIMUM_ATTACHMENT_BYTES / BYTES_PER_MEBIBYTE;

/**
 * The image formats an attachment may be in, and the file extension each is stored under.
 *
 * The extension comes from here, never from the uploaded file's name — that name arrives from a
 * browser and would become part of a storage key, and a storage key is a path. These are the same
 * three formats `src/routes/files/[...key]/+server.ts`'s `CONTENT_TYPES_BY_EXTENSION` already
 * serves, so a Lampiran needs no new format there.
 */
const ATTACHMENT_EXTENSIONS: ReadonlyMap<string, string> = new Map([
	['image/jpeg', 'jpg'],
	['image/png', 'png'],
	['image/webp', 'webp']
]);

/** Every content type an attachment may be uploaded as, for a screen that builds an `accept` list. */
export const ATTACHMENT_CONTENT_TYPES: readonly string[] = [...ATTACHMENT_EXTENSIONS.keys()];

/** Where a magic-number check looks in a file, and the bytes it expects to find there. */
interface ByteSignature {
	readonly offset: number;
	readonly bytes: readonly number[];
}

/** How a file of each accepted type really begins. See this module's doc comment. */
const ATTACHMENT_SIGNATURES: ReadonlyMap<string, readonly ByteSignature[]> = new Map<
	string,
	readonly ByteSignature[]
>([
	['image/jpeg', [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }]],
	['image/png', [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }]],
	[
		'image/webp',
		[
			{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
			{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }
		]
	]
]);

/** One photograph on its way in, as a route reads it off a multipart form. */
export interface ComplaintAttachmentUpload {
	/** What the upload claims the file is. Checked against the bytes, not believed. */
	readonly contentType: string;
	readonly content: Uint8Array;
}

/** Every rule this module refuses an attachment batch or one file for. */
export const COMPLAINT_ATTACHMENT_RULE = {
	/** More than `MAX_ATTACHMENTS_PER_COMPLAINT` files in one batch. */
	tooMany: 'tooMany',
	/** The uploaded bytes are not one of the accepted image formats. */
	attachmentNotAnImage: 'attachmentNotAnImage',
	/** The uploaded file is larger than `MAXIMUM_ATTACHMENT_BYTES`. */
	attachmentTooLarge: 'attachmentTooLarge'
} as const;

/** One of the rules above. */
export type ComplaintAttachmentRule =
	(typeof COMPLAINT_ATTACHMENT_RULE)[keyof typeof COMPLAINT_ATTACHMENT_RULE];

/**
 * Thrown when a Lampiran batch or one file in it breaks a rule in `COMPLAINT_ATTACHMENT_RULE`.
 *
 * A named, `instanceof`-checkable class of its own rather than reusing `ComplaintRuleError` from
 * `./index.ts`: a Lampiran's rules are about the upload, not about a complaint's status or
 * visibility, the same separation `ComplaintReplyRuleError` draws for a Tanggapan's own rules.
 */
export class ComplaintAttachmentRuleError extends Error {
	override readonly name = 'ComplaintAttachmentRuleError';

	/** Which rule refused the upload. */
	readonly rule: ComplaintAttachmentRule;

	constructor(rule: ComplaintAttachmentRule, detail: string) {
		super(`A Lampiran was refused by the rule "${rule}": ${detail}`);
		this.rule = rule;
	}
}

/** One photograph, once its bytes are safely stored. */
export interface StoredComplaintAttachment {
	/** Minted here, and already part of `fileKey`. */
	readonly id: string;
	/** The `FileStore` key the bytes were written at. */
	readonly fileKey: string;
}

/**
 * Validates a batch of photographs against every Lampiran rule and stores each one through
 * `fileStore`, returning the `{ id, fileKey }` pairs a caller inserts into `complaint_attachments`.
 *
 * The whole batch is checked — the count first, then each file's size and format — before anything
 * is written, so a batch that fails partway through leaves no orphaned blob for the files after the
 * one that failed. A file that fails after an earlier one in the same batch has already been stored
 * can still leave that earlier file behind; `createComplaint` in `./index.ts` accepts that as the
 * same cost `recordPayment` accepts for its own single upload, because the row that would reference
 * it is never written either.
 *
 * @throws {ComplaintAttachmentRuleError} `tooMany` when `uploads.length` exceeds
 *   `MAX_ATTACHMENTS_PER_COMPLAINT`, `attachmentTooLarge` past `MAXIMUM_ATTACHMENT_BYTES`, or
 *   `attachmentNotAnImage` when a content type is not accepted or its bytes do not start the way
 *   that format really starts.
 */
export async function storeComplaintAttachments(
	fileStore: FileStore,
	complaintId: string,
	uploads: readonly ComplaintAttachmentUpload[]
): Promise<readonly StoredComplaintAttachment[]> {
	if (uploads.length > MAX_ATTACHMENTS_PER_COMPLAINT) {
		throw new ComplaintAttachmentRuleError(
			COMPLAINT_ATTACHMENT_RULE.tooMany,
			`A complaint carries at most ${MAX_ATTACHMENTS_PER_COMPLAINT} attachments; ${uploads.length} were submitted.`
		);
	}

	const stored: StoredComplaintAttachment[] = [];
	for (const upload of uploads) {
		const id = randomUUID();
		const key = attachmentKeyFor(complaintId, id, upload);
		await fileStore.store(key, upload.content);
		stored.push({ id, fileKey: key });
	}
	return stored;
}

/** Checks one upload and works out the storage key it belongs at. */
function attachmentKeyFor(
	complaintId: string,
	attachmentId: string,
	upload: ComplaintAttachmentUpload
): string {
	if (upload.content.byteLength > MAXIMUM_ATTACHMENT_BYTES) {
		throw new ComplaintAttachmentRuleError(
			COMPLAINT_ATTACHMENT_RULE.attachmentTooLarge,
			`The uploaded attachment is ${upload.content.byteLength} bytes; the limit is ${MAXIMUM_ATTACHMENT_BYTES}.`
		);
	}

	const extension = ATTACHMENT_EXTENSIONS.get(upload.contentType);
	if (!extension || !hasSignatureOf(upload.content, upload.contentType)) {
		throw new ComplaintAttachmentRuleError(
			COMPLAINT_ATTACHMENT_RULE.attachmentNotAnImage,
			`"${upload.contentType}" is not one of ${ATTACHMENT_CONTENT_TYPES.join(', ')}, or its bytes do not start the way that format starts.`
		);
	}

	return `complaints/${complaintId}/${attachmentId}.${extension}`;
}

/**
 * Whether `content` really begins the way a file of `contentType` begins.
 *
 * Answers `false`, never `true`, when `contentType` has no registered signature — see this module's
 * doc comment for why `?? []` followed by `.every(...)` is the wrong shape here.
 */
function hasSignatureOf(content: Uint8Array, contentType: string): boolean {
	const signature = ATTACHMENT_SIGNATURES.get(contentType);
	if (!signature) {
		return false;
	}
	return signature.every((part) =>
		part.bytes.every((byte, index) => content[part.offset + index] === byte)
	);
}

/** One attachment, as a detail screen renders it before minting a signed link for it. */
export interface ComplaintAttachmentSummary {
	readonly id: string;
	readonly fileKey: string;
	readonly createdAt: Date;
}

/**
 * A complaint's attachments, in the order they were uploaded, for a viewer who may read that
 * complaint.
 *
 * The same visibility rule `complaintStatusHistory` and `listComplaintReplies` apply, through the
 * same join onto `complaints` and the same `complaintScopeFilter` in the `where` — a viewer who may
 * not read the complaint gets an empty list rather than somebody else's photographs, which is what
 * keeps a guessed id from confirming a private complaint's attachments exist. **This function
 * returns `FileStore` keys, never signed links**: minting a link is the page's job, done only after
 * this function has already proved the viewer may read the complaint those keys belong to — the same
 * split `OwnPayment.proofFileKey`'s doc comment states.
 *
 * @param viewerUserId the signed-in account, or `null` when nobody is signed in.
 */
export async function listComplaintAttachments(
	db: DatabaseWriter,
	viewerUserId: string | null,
	complaintId: string
): Promise<readonly ComplaintAttachmentSummary[]> {
	const scope = await complaintReadScopeFor(db, viewerUserId);

	return db
		.select({
			id: complaintAttachments.id,
			fileKey: complaintAttachments.fileKey,
			createdAt: complaintAttachments.createdAt
		})
		.from(complaintAttachments)
		.innerJoin(complaints, eq(complaints.id, complaintAttachments.complaintId))
		.where(and(eq(complaintAttachments.complaintId, complaintId), complaintScopeFilter(scope)))
		.orderBy(asc(complaintAttachments.createdAt), asc(complaintAttachments.id));
}
