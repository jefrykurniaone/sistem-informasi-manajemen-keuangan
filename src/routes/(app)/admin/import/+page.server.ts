import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { ACTION, requirePermission } from '$lib/server/authz';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	importResidents,
	previewResidentImport,
	ImportRejectedError
} from '$lib/server/services/import/resident-csv';
import {
	EmptyImportFileError,
	ImportHeaderError,
	ImportTooLargeError,
	MAX_IMPORT_ROWS
} from '$lib/server/services/import/validation';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for filling the register from a CSV file, in the two steps
 * `spec-warga-unit-v1.md` asks for: `upload` reads the file and answers with a preview that stored
 * nothing, and `confirm` writes the whole file or none of it.
 *
 * It follows the translation rule the rest of the admin screens follow: the service refuses, and
 * this file decides what the refusal is over HTTP. A caller who may not be here at all gets
 * `error(403, …)`; a file this import cannot use — a wrong header, no rows, too many rows, a row
 * that clashes with something already stored — is `fail(400, …)`, because the superuser did nothing
 * outside their rights and only this particular file is refused.
 *
 * **The file's text travels back to `confirm` in a hidden field**, and is parsed and checked again
 * there from scratch; see the doc comment of `$lib/server/services/import/resident-csv` for why that
 * is the transport and why nothing the preview computed is trusted on the way back.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		await requirePermission(database(), locals.user.id, ACTION.importResidents);
	} catch (caught) {
		throwAsRouteError(caught);
	}

	return { maxRows: MAX_IMPORT_ROWS };
};

export const actions: Actions = {
	upload: async ({ locals, request }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		// Before the body is read, not after: `previewResidentImport` checks the same permission, but
		// reaching it means an upload of up to `BODY_SIZE_LIMIT` has already been materialised for
		// somebody who was never allowed to send one.
		try {
			await requirePermission(database(), locals.user.id, ACTION.importResidents);
		} catch (caught) {
			throwAsRouteError(caught);
		}

		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: m.adminImport_noFile() });
		}

		const importRequest = {
			actorId: locals.user.id,
			fileName: trimmedFileName(file.name),
			content: await file.text()
		};
		try {
			return { preview: await previewResidentImport(database(), importRequest) };
		} catch (caught) {
			return refusalOrThrow(caught);
		}
	},

	confirm: async ({ locals, request }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const importRequest = {
			actorId: locals.user.id,
			fileName: trimmedFileName(String(form.get('fileName') ?? '')),
			content: String(form.get('content') ?? '')
		};
		if (importRequest.content.trim() === '') {
			return fail(400, { message: m.adminImport_missingContent() });
		}

		try {
			const result = await importResidents(database(), systemClock, importRequest);
			return { message: m.adminImport_importSuccess({ count: result.importedRowCount }) };
		} catch (caught) {
			if (caught instanceof ImportRejectedError) {
				// The refusal carries the reading that refused, so the rows to fix are shown exactly as
				// the transaction saw them — no second reading that could answer differently.
				return fail(400, { message: m.adminImport_importRejected(), preview: caught.preview });
			}
			return refusalOrThrow(caught);
		}
	}
};

/** The longest file name worth keeping. It is written into an audit row, and it is untrusted. */
const MAX_FILE_NAME_LENGTH = 255;

/** A file name as it is recorded: trimmed, and cut to a length an audit row can carry. */
function trimmedFileName(name: string): string {
	return name.trim().slice(0, MAX_FILE_NAME_LENGTH);
}

/** Turns a file this import cannot use into `fail(400, …)`, or hands anything else on. */
function refusalOrThrow(caught: unknown) {
	if (caught instanceof ImportHeaderError) {
		return fail(400, { message: m.adminImport_headerInvalid() });
	}
	if (caught instanceof EmptyImportFileError) {
		return fail(400, { message: m.adminImport_emptyFile() });
	}
	if (caught instanceof ImportTooLargeError) {
		return fail(400, {
			message: m.adminImport_tooLarge({ count: caught.rowCount, maximum: caught.maximum })
		});
	}
	throwAsRouteError(caught);
}

/**
 * Turns a permission refusal into a 403 and throws it, or rethrows whatever else it was. Always
 * throws, for the reason the other admin screens' copies of this helper record: a `catch` block that
 * sometimes *returned* an error is what breaks SvelteKit's inference of `ActionData`.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminImport_forbidden());
	}
	throw caught;
}
