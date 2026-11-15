import { fail } from '@sveltejs/kit';
import * as m from '#lib/paraglide/messages.js';
import {
	failOrThrow,
	productionDependencies,
	readText,
	refusal,
	requireUser,
	throwRouteError,
	type FormMessages,
	type PageMessages
} from '#lib/server/route-action.ts';
import {
	CashCategoryNameTakenError,
	CashCategoryNotFoundError,
	createCashCategory,
	deactivateCashCategory,
	listCashCategories,
	reactivateCashCategory,
	SystemCashCategoryError,
	updateCashCategory
} from '#lib/server/services/cash/category.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The superuser screen for Kategori Kas: the whole list with its type and active flag, a form to
 * add one, and — on the ordinary ones only — a rename-and-retype form and a deactivate button.
 * Nobody who is not signed in reaches the service layer, `PermissionDeniedError` becomes
 * `error(403, …)` here and never in the service, and every rule the service refuses comes back as a
 * rejected form. All three go through `#lib/server/route-action.ts` (#318): this file names its
 * sentences and nothing else.
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

/**
 * The page's own refusal: the 403 for anyone without `ACTION.manageCashCategories`, on the page and
 * on every action. There is no 404 page: a category id only ever arrives from a form, and a missing
 * one is answered on that form below.
 */
const PAGE = { forbidden: m.adminCashCategories_forbidden } satisfies PageMessages;

/**
 * Every refusal the category service names, answered as a rejected form. Shared by all four
 * actions because any of them can be refused the same ways. A `TypeError` is the service refusing
 * an empty name or an unknown type, which this screen has always answered with its invalid-form
 * sentence.
 */
const FORM = {
	...PAGE,
	fallback: m.adminCashCategories_invalidForm,
	refusals: [
		refusal(CashCategoryNameTakenError, ({ error }) =>
			m.adminCashCategories_nameTaken({ name: error.categoryName })
		),
		refusal(SystemCashCategoryError, m.adminCashCategories_systemLocked),
		refusal(CashCategoryNotFoundError, m.adminCashCategories_notFound),
		refusal(TypeError, m.adminCashCategories_invalidForm)
	]
} satisfies FormMessages;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals);

	try {
		const categories = await listCashCategories(productionDependencies().db, user.id);
		return {
			categories: categories.map((category) => ({
				id: category.id,
				name: category.name,
				type: category.type,
				isActive: category.isActive,
				// Whether a category is a system one is a rule about the row, not a rendering choice, and
				// a component may not import from `#lib/server` — so the answer travels as data.
				isSystem: category.systemKey !== null
			}))
		};
	} catch (caught) {
		throwRouteError(caught, PAGE);
	}
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const name = readText(form, NAME_FIELD);
		const type = readText(form, TYPE_FIELD);
		if (name === '' || type === '') {
			return fail(400, { message: m.adminCashCategories_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const created = await createCashCategory(db, clock, {
				actorId: user.id,
				name,
				type
			});
			return { message: m.adminCashCategories_addSuccess({ name: created.name }) };
		} catch (caught) {
			return failOrThrow(caught, FORM);
		}
	},

	update: async ({ request, locals }) => {
		const user = requireUser(locals);

		const form = await request.formData();
		const categoryId = readText(form, CATEGORY_ID_FIELD);
		const name = readText(form, NAME_FIELD);
		const type = readText(form, TYPE_FIELD);
		if (categoryId === '' || name === '' || type === '') {
			return fail(400, { message: m.adminCashCategories_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const updated = await updateCashCategory(db, clock, {
				actorId: user.id,
				categoryId,
				name,
				type
			});
			return { message: m.adminCashCategories_saveSuccess({ name: updated.name }) };
		} catch (caught) {
			return failOrThrow(caught, FORM);
		}
	},

	deactivate: async ({ request, locals }) => {
		const user = requireUser(locals);

		const categoryId = readText(await request.formData(), CATEGORY_ID_FIELD);
		if (categoryId === '') {
			return fail(400, { message: m.adminCashCategories_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const changed = await deactivateCashCategory(db, clock, {
				actorId: user.id,
				categoryId
			});
			return { message: m.adminCashCategories_deactivateSuccess({ name: changed.name }) };
		} catch (caught) {
			return failOrThrow(caught, FORM);
		}
	},

	reactivate: async ({ request, locals }) => {
		const user = requireUser(locals);

		const categoryId = readText(await request.formData(), CATEGORY_ID_FIELD);
		if (categoryId === '') {
			return fail(400, { message: m.adminCashCategories_invalidForm() });
		}

		const { db, clock } = productionDependencies();
		try {
			const changed = await reactivateCashCategory(db, clock, {
				actorId: user.id,
				categoryId
			});
			return { message: m.adminCashCategories_reactivateSuccess({ name: changed.name }) };
		} catch (caught) {
			return failOrThrow(caught, FORM);
		}
	}
};
