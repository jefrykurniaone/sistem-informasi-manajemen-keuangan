import { fail } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import { auth } from '$lib/server/auth';
import { limitFormAction, RATE_LIMIT_POLICY } from '$lib/server/rate-limit';
import type { Actions, PageServerLoad } from './$types';

/**
 * Proving that an address belongs to the person who typed it, and asking for another try.
 *
 * This one page answers five situations, because they are five sentences about the same thing and
 * splitting them across routes would only mean more addresses to get wrong:
 *
 * - arriving from the registration form, with nothing to verify yet (`?sent=1`);
 * - arriving from the email, with a token that works, for the first time;
 * - arriving with a token whose address was already verified before this visit;
 * - arriving from the email too late, or with a token that has been tampered with;
 * - arriving from the sign-in form after being told the address is not verified yet.
 *
 * **Asking for another email says nothing about who is registered.** better-auth answers an
 * address that does not exist, an address that is already verified and an address that is waiting
 * for verification identically, and spends the same amount of time doing it. Whatever it reports,
 * this action shows the same sentence.
 *
 * **Asking too often is refused before better-auth is asked anything**, by `limitFormAction` in
 * `$lib/server/rate-limit`, which counts the caller's address and the email typed without looking
 * either up. Every post past the limit gets `TOO_MANY_REQUESTS` and a 429, whoever the address
 * belongs to, and queues nothing, the same reasoning as `/forgot-password`, because the two forms
 * are the same mail-sending lever with a different template behind it.
 *
 * Verifying does not sign anyone in — see the reasoning in `$lib/server/auth`. The page sends the
 * person to the sign-in form afterwards.
 *
 * **The `load` below still changes something, on a GET, and still cannot revoke a token early.**
 * A verification token is a signed JWT rather than a stored row, so it stays usable until it
 * expires; nothing here can revoke one early. What changed with #206 is only what the *second*
 * visit is told. better-auth's own `verifyEmail` (1.7.5, `node_modules/better-auth/dist/api/routes/email-verification.mjs`
 * lines 287-321) resolves to the exact same value, `{ status: true, user: null }`, whether the
 * address was already verified or is being verified for the first time, so that shape does not
 * tell the two visits apart, and this page must not pretend it does by reading `user` off it. So `load`
 * asks a question of its own first: it reads the token's payload without checking its signature,
 * purely to learn which address is named, and looks that address up through better-auth's
 * `internalAdapter.findUserByEmail` *before* calling `verifyEmail`, which is the only moment the
 * database still remembers whether this visit is the first one. `verifyEmail` itself still decides
 * `expired` and `invalid`, exactly as before; the unchecked payload is never trusted for anything
 * beyond picking which address to look up, and a payload that fails to parse goes straight to
 * `invalid` without a lookup or a call to `verifyEmail`, because a token in that shape cannot pass
 * signature verification either.
 *
 * A link scanner that opens the emailed link before the person does is exactly what turns their own
 * click into `used`, and the sentence stays true when that happens, because the address really is
 * already verified by the time they read it. Two truly simultaneous requests for the same token can
 * both read "not yet verified" before either one writes, and both then see `verified`; that race is
 * accepted rather than closed, because closing it needs a lock this ticket has no reason to add for
 * a page that changes nothing either visitor can act on differently.
 */

/** What this page is saying. The wording lives in the component; this is the situation. */
export type VerificationState = 'idle' | 'sent' | 'verified' | 'used' | 'expired' | 'invalid';

/**
 * What a verification token's middle segment names, read without checking the token's signature.
 * `verifyEmail` below is still the only thing that decides whether the token is genuine; this is
 * only ever used to pick which address to look up before that call runs.
 */
interface UncheckedTokenPayload {
	readonly email: string;
}

function isUncheckedTokenPayload(value: unknown): value is UncheckedTokenPayload {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const email = (value as Record<string, unknown>).email;
	return typeof email === 'string' && email !== '';
}

/**
 * Reads the address a verification token names, without checking its signature or its expiry. A
 * token that does not even decode to that shape cannot pass `verifyEmail`'s real, signature-checked
 * parse either, so callers treat `undefined` here the same as an invalid token.
 */
function decodeUncheckedTokenPayload(token: string): UncheckedTokenPayload | undefined {
	const segments = token.split('.');
	if (segments.length !== 3) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
	} catch {
		return undefined;
	}
	return isUncheckedTokenPayload(parsed) ? parsed : undefined;
}

/**
 * Whether `email` was already verified, read the instant before `verifyEmail` runs and possibly
 * changes it. Goes through better-auth's own `internalAdapter.findUserByEmail` rather than a
 * Drizzle query of this application's own, so this stays in step with whatever the installed
 * version actually stores instead of a copy kept in sync by hand.
 */
async function wasAlreadyVerified(email: string): Promise<boolean> {
	const context = await auth().$context;
	const found = await context.internalAdapter.findUserByEmail(email);
	return found?.user.emailVerified ?? false;
}

/** Shown when the limiter refuses, whoever the address belongs to. */
const TOO_MANY_REQUESTS =
	'Terlalu banyak permintaan email verifikasi. Tunggu beberapa menit, lalu coba lagi.';

export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	if (token === null) {
		return { state: (url.searchParams.has('sent') ? 'sent' : 'idle') satisfies VerificationState };
	}

	const payload = decodeUncheckedTokenPayload(token);
	if (!payload) {
		return { state: 'invalid' satisfies VerificationState };
	}

	// Read before `verifyEmail` runs: that call may itself flip this address to verified, which
	// would make the same question asked afterwards always answer "yes".
	const alreadyVerified = await wasAlreadyVerified(payload.email);

	try {
		await auth().api.verifyEmail({ query: { token } });
	} catch (error) {
		if (!(error instanceof APIError)) {
			throw error;
		}
		const expired = error.body?.code === 'TOKEN_EXPIRED';
		return { state: (expired ? 'expired' : 'invalid') satisfies VerificationState };
	}

	return { state: (alreadyVerified ? 'used' : 'verified') satisfies VerificationState };
};

export const actions: Actions = {
	resend: async (event) => {
		const form = await event.request.formData();
		const email = String(form.get('email') ?? '').trim();

		if (email === '') {
			return fail(400, { sent: false, message: 'Isi dulu alamat email Anda.' });
		}

		const decision = await limitFormAction(event, RATE_LIMIT_POLICY.resendVerification, email);
		if (!decision.allowed) {
			return fail(429, { sent: false, message: TOO_MANY_REQUESTS });
		}

		try {
			await auth().api.sendVerificationEmail({
				body: { email },
				headers: event.request.headers
			});
		} catch (error) {
			// Every answer better-auth can give about one address — it is unknown, it is already
			// verified, it has just been sent an email — leads to the same sentence below. Only a
			// failure that is not about the address at all, such as the database being unreachable,
			// is allowed to become an error page.
			if (!(error instanceof APIError)) {
				throw error;
			}
		}

		return {
			sent: true,
			message:
				'Kalau alamat itu terdaftar dan belum terverifikasi, email verifikasinya sudah kami kirim ulang. Periksa kotak masuk Anda.'
		};
	}
};
