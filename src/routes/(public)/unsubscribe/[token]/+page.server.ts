import { fail } from '@sveltejs/kit';
import { database } from '$lib/server/db';
import { systemClock } from '$lib/server/ports/clock';
import {
	disableSubscriptionByToken,
	MandatorySubscriptionKindError,
	UnsubscribeTokenError
} from '$lib/server/services/subscription';
import { verifyUnsubscribeToken } from '$lib/server/services/subscription/unsubscribe-token';
import { isMandatorySubscriptionKind } from '$lib/server/services/subscription/kinds';
import type { Actions, PageServerLoad } from './$types';

/**
 * The page an email's "berhenti berlangganan" link opens — #37's "berhenti berlangganan cukup satu
 * klik dari email, tanpa perlu masuk".
 *
 * **No session is read here at all**, which is what makes that criterion hold: there is no
 * `locals.user` check to bypass, because none exists on this route. The signed token in the address
 * is the whole authorization, exactly as on `(auth)/invitations/[token]`, and what it can authorize
 * is deliberately tiny — switching one opt-in notification kind off for the one resident it names.
 * The argument for why that is safe to do without a session is in
 * `$lib/server/services/subscription/unsubscribe-token.ts`.
 *
 * **The GET changes nothing.** It only decides which of three things to show: the confirmation
 * button, "this link is not valid", or "this kind cannot be switched off". A link is followed by
 * mail clients, link scanners and antivirus proxies before a person ever sees it, so a GET that
 * unsubscribed would unsubscribe people who never clicked anything. The write happens on the POST
 * the button makes, and `disableSubscriptionByToken` verifies the token again at that moment rather
 * than trusting what the GET decided.
 *
 * The token is never rendered into the page's text and never put into a link; it travels only in the
 * address it already arrived in, and the form posts back to that same address.
 */

/** What the page has to show. Decided on the GET, and decided again by the POST. */
type UnsubscribeStatus = 'valid' | 'invalid' | 'mandatory';

export const load: PageServerLoad = async ({ params }) => {
	return { status: statusOf(params.token) };
};

export const actions: Actions = {
	unsubscribe: async ({ params }) => {
		try {
			await disableSubscriptionByToken(database(), systemClock, params.token);
		} catch (caught) {
			if (caught instanceof UnsubscribeTokenError) {
				return fail(400, { status: 'invalid' as const });
			}
			if (caught instanceof MandatorySubscriptionKindError) {
				return fail(400, { status: 'mandatory' as const });
			}
			throw caught;
		}
		return { status: 'done' as const };
	}
};

/**
 * What a token is worth, without touching the database.
 *
 * A malformed token, a forged one and one naming a mandatory kind are told apart here only so that
 * the page can say something useful; whoever holds the token is never told which check refused it.
 */
function statusOf(token: string): UnsubscribeStatus {
	const verification = verifyUnsubscribeToken(token);
	if (!verification.valid) {
		return 'invalid';
	}
	return isMandatorySubscriptionKind(verification.kind) ? 'mandatory' : 'valid';
}
