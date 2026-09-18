import { error, fail, redirect } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PermissionDeniedError } from '$lib/errors';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	CashCategoryNameTakenError,
	CashCategoryNotFoundError,
	createCashCategory,
	deactivateCashCategory,
	listCashCategories,
	reactivateCashCategory,
	SystemCashCategoryError,
	updateCashCategory
} from '$lib/server/services/cash/category';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for Kategori Kas: the whole list with its type and active flag, a form to
 * add one, and — on the ordinary ones only — a rename-and-retype form and a deactivate button.
 * Follows the shape `src/routes/(app)/admin/units/+page.server.ts` settled: nobody who is not
 * signed in reaches the service layer, `PermissionDeniedError` becomes `error(403, …)` here and
 * never in the service, and every rule the service refuses comes back as a rejected form.
 *
 * The two system categories are rendered without those controls, which is a courtesy rather than
 * the guarantee — the guarantee is `SystemCashCategoryError`, thrown by the service whether or not
 * a button was ever drawn.
 */

/** The form field naming which category an action acts on. */
const CATEGORY_ID_FIELD = 'categoryId';
/** The form field carrying a category's display name. */
const NAME_FIELD = 'name';
/** The form field carrying `income` or `expense`. */
const TYPE_FIELD = 'type';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	try {
		const categories = await listCashCategories(database(), locals.user.id);
		return {
			categories: categories.map((category) => ({
				id: category.id,
				name: category.name,
				type: category.type,
				isActive: category.isActive,
				// Whether a category is a system one is a rule about the row, not a rendering choice, and
				// a component may not import from `$lib/server` — so the answer travels as data.
				isSystem: category.systemKey !== null
			}))
		};
	} catch (caught) {
		throwAsRouteError(caught);
	}
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const name = String(form.get(NAME_FIELD) ?? '').trim();
		const type = String(form.get(TYPE_FIELD) ?? '').trim();
		if (name === '' || type === '') {
			return fail(400, { message: m.adminCashCategories_invalidForm() });
		}

		try {
			const created = await createCashCategory(database(), systemClock, {
				actorId: locals.user.id,
				name,
				type
			});
			return { message: m.adminCashCategories_addSuccess({ name: created.name }) };
		} catch (caught) {
			return failAsRejectedForm(caught);
		}
	},

	update: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await request.formData();
		const categoryId = String(form.get(CATEGORY_ID_FIELD) ?? '').trim();
		const name = String(form.get(NAME_FIELD) ?? '').trim();
		const type = String(form.get(TYPE_FIELD) ?? '').trim();
		if (categoryId === '' || name === '' || type === '') {
			return fail(400, { message: m.adminCashCategories_invalidForm() });
		}

		try {
			const updated = await updateCashCategory(database(), systemClock, {
				actorId: locals.user.id,
				categoryId,
				name,
				type
			});
			return { message: m.adminCashCategories_saveSuccess({ name: updated.name }) };
		} catch (caught) {
			return failAsRejectedForm(caught);
		}
	},

	deactivate: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const categoryId = await readCategoryId(request);
		if (categoryId === '') {
			return fail(400, { message: m.adminCashCategories_invalidForm() });
		}

		try {
			const changed = await deactivateCashCategory(database(), systemClock, {
				actorId: locals.user.id,
				categoryId
			});
			return { message: m.adminCashCategories_deactivateSuccess({ name: changed.name }) };
		} catch (caught) {
			return failAsRejectedForm(caught);
		}
	},

	reactivate: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const categoryId = await readCategoryId(request);
		if (categoryId === '') {
			return fail(400, { message: m.adminCashCategories_invalidForm() });
		}

		try {
			const changed = await reactivateCashCategory(database(), systemClock, {
				actorId: locals.user.id,
				categoryId
			});
			return { message: m.adminCashCategories_reactivateSuccess({ name: changed.name }) };
		} catch (caught) {
			return failAsRejectedForm(caught);
		}
	}
};

/** The category id a one-button form posts, trimmed, or the empty string when it posted none. */
async function readCategoryId(request: Request): Promise<string> {
	const form = await request.formData();
	return String(form.get(CATEGORY_ID_FIELD) ?? '').trim();
}

/**
 * Turns each refusal the category service names into a rejected form, and everything else into a
 * route error. Shared by all four actions because any of them can be refused the same ways.
 */
function failAsRejectedForm(caught: unknown) {
	if (caught instanceof CashCategoryNameTakenError) {
		return fail(400, { message: m.adminCashCategories_nameTaken({ name: caught.categoryName }) });
	}
	if (caught instanceof SystemCashCategoryError) {
		return fail(400, { message: m.adminCashCategories_systemLocked() });
	}
	if (caught instanceof CashCategoryNotFoundError) {
		return fail(400, { message: m.adminCashCategories_notFound() });
	}
	if (caught instanceof TypeError) {
		return fail(400, { message: m.adminCashCategories_invalidForm() });
	}
	throwAsRouteError(caught);
}

/**
 * Turns a caught permission refusal into a 403 and throws it, or rethrows whatever else it was.
 * `never`, so it can end a `catch` block without widening what SvelteKit infers — the same helper
 * the units and invitations screens carry, for the same reason.
 */
function throwAsRouteError(caught: unknown): never {
	if (caught instanceof PermissionDeniedError) {
		throw error(403, m.adminCashCategories_forbidden());
	}
	throw caught;
}
