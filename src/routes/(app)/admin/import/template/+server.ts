import { error, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { ACTION, requirePermission } from '$lib/server/authz';
import { database } from '$lib/server/db';
import {
	buildImportTemplate,
	IMPORT_TEMPLATE_CONTENT_TYPE,
	IMPORT_TEMPLATE_FILENAME
} from '$lib/server/services/import/template';
import type { RequestHandler } from './$types';

/**
 * The Template Impor download: the empty workbook a superuser fills in with Excel and uploads back
 * on `/admin/import`. Guarded by the same `importResidents` permission as that screen, checked
 * before `buildImportTemplate` runs — reaching the service would mean a workbook had already been
 * built for somebody who was never allowed to import.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		await requirePermission(database(), locals.user.id, ACTION.importResidents);
	} catch (caught) {
		if (caught instanceof PermissionDeniedError) {
			throw error(403, m.adminImport_forbidden());
		}
		throw caught;
	}

	const workbook = await buildImportTemplate();
	// `Response` wants a view over an `ArrayBuffer`; a Node `Buffer` is typed as one over
	// `ArrayBufferLike`, which `BodyInit` does not accept. `Uint8Array.from` settles that honestly,
	// the same way `src/routes/files/[...key]/+server.ts` does for the bytes it serves.
	return new Response(Uint8Array.from(workbook), {
		status: 200,
		headers: {
			'Content-Type': IMPORT_TEMPLATE_CONTENT_TYPE,
			'Content-Disposition': `attachment; filename="${IMPORT_TEMPLATE_FILENAME}"`
		}
	});
};
