import { error, fail, redirect } from '@sveltejs/kit';
import { AUTH_PATHS } from '$lib/server/auth';
import { database } from '$lib/server/db';
import { PermissionDeniedError } from '$lib/errors';
import { systemClock } from '$lib/server/ports/clock';
import { residentProfileForUser } from '$lib/server/services/resident/profile';
import {
	MandatorySubscriptionKindError,
	setSubscriptionPreference,
	subscriptionPreferencesFor
} from '$lib/server/services/subscription';
import type { Actions, PageServerLoad } from './$types';

/**
 * A resident's own notification preferences — Langganan. Every known kind is listed, mandatory ones
 * shown as such with no control to switch them off; see `$lib/server/services/subscription/kinds.ts`
 * for the registry and `$lib/server/services/subscription/index.ts` for the guard.
 *
 * **A signed-in account with no `residents` row is expected, not an error** — the same state
 * `(app)/profile/+page.server.ts` handles, and for the same reason. `load` returns an empty
 * preference list and `+page.svelte` shows the honest "belum tercatat" state instead of a list of
 * switches.
 *
 * **A permission refusal becomes a 403; a mandatory-kind refusal becomes a rejected form
 * submission.** `PermissionDeniedError` is translated to `error(403, …)`.
 * `MandatorySubscriptionKindError` is not a 403 — the caller is allowed to manage their own
 * subscriptions, only this one change is refused — so it becomes `fail(400, …)`, the same split
 * `(app)/admin/roles/+page.server.ts` makes between `PermissionDeniedError` and `LastSuperuserError`.
 */

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const profile = await residentProfileForUser(database(), locals.user.id);
	if (!profile) {
		return { residentId: null, preferences: [] };
	}

	const preferences = await subscriptionPreferencesFor(database(), profile.residentId);
	return { residentId: profile.residentId, preferences };
};

export const actions: Actions = {
	update: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, AUTH_PATHS.login);
		}

		const form = await readPreferenceForm(request);
		if (!form.ok) {
			return fail(400, { message: form.complaint });
		}

		try {
			await setSubscriptionPreference(database(), systemClock, {
				callerUserId: locals.user.id,
				residentId: form.residentId,
				kind: form.kind,
				enabled: form.enabled
			});
		} catch (caught) {
			if (caught instanceof PermissionDeniedError) {
				throw error(403, 'Anda hanya dapat mengubah preferensi notifikasi Anda sendiri.');
			}
			if (caught instanceof MandatorySubscriptionKindError) {
				return fail(400, { message: 'Jenis notifikasi ini wajib dan tidak bisa dimatikan.' });
			}
			throw caught;
		}

		return { saved: true };
	}
};

/** What a preference-toggle form posts, after being checked for shape. */
type PreferenceForm =
	| {
			readonly ok: true;
			readonly residentId: string;
			readonly kind: string;
			readonly enabled: boolean;
	  }
	| { readonly ok: false; readonly complaint: string };

/** Reads and validates a preference-toggle form, without yet knowing whether the change is allowed. */
async function readPreferenceForm(request: Request): Promise<PreferenceForm> {
	const form = await request.formData();
	const residentId = String(form.get('residentId') ?? '').trim();
	const kind = String(form.get('kind') ?? '').trim();
	const enabledRaw = String(form.get('enabled') ?? '').trim();

	if (residentId === '' || kind === '' || (enabledRaw !== 'true' && enabledRaw !== 'false')) {
		return { ok: false, complaint: 'Permintaan tidak valid.' };
	}
	return { ok: true, residentId, kind, enabled: enabledRaw === 'true' };
}
