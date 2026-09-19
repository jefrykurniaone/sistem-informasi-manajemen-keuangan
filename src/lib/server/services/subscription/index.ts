import { and, eq } from 'drizzle-orm';
import { PermissionDeniedError } from '$lib/errors';
import type { Database } from '../../db';
import type { DatabaseWriter } from '../../authz';
import { user } from '../../db/schema/auth';
import { residents } from '../../db/schema/resident';
import { subscriptions } from '../../db/schema/subscription';
import type { Clock } from '../../ports/clock';
import {
	SUBSCRIPTION_KINDS,
	isMandatorySubscriptionKind,
	subscriptionKindDefinition
} from './kinds';
import { verifyUnsubscribeToken, type UnsubscribeTokenRejection } from './unsubscribe-token';

/**
 * Langganan: whether one resident wants one kind of notification. This is the only place
 * `subscriptions` is written outside the trigger-free default-seeding path below, and the only
 * place that decides which kinds a resident may switch off — see `./kinds.ts` for the registry and
 * `src/lib/server/db/schema/subscription.ts` for why that decision does not live in SQL.
 *
 * **The guard is row ownership, not a `PERMISSIONS` action.** `spec-warga-unit-v1.md` and
 * `CONTEXT.md`'s "Warga" role both say a Warga may only manage their own Langganan, and that is a
 * fact about whose row it is, not a right some Warga have and others do not — every resident has it,
 * for their own row. `assertOwnResident` below reads the same shape `requirePermission` in
 * `src/lib/server/authz.ts` throws, `PermissionDeniedError`, so a route still translates it to
 * `error(403, …)` without a second error type to know about.
 *
 * **There is one write that has no caller session at all**, added by #37: `disableSubscriptionByToken`
 * below, which the unsubscribe link in a notification email leads to. It cannot go through
 * `setSubscriptionPreference`'s owner check, because the whole point of that link is that it works
 * out of an inbox without signing in — what stands in for the check is the signed token itself, and
 * `./unsubscribe-token.ts` is where the argument for that lives. It is still refused for a mandatory
 * kind, by the same `MandatorySubscriptionKindError`, and it can only ever switch a kind *off*.
 *
 * **Nothing here creates a `residents` row.** `ensureDefaultSubscriptions` takes a `residents.id`
 * that already exists — #20 (undangan) and #21 (persetujuan pendaftaran) call it right after they
 * insert one, and this ticket's own tests call it the same way. It is exported so those tickets, and
 * a test, never invent the default set of rows by hand.
 */

/** Thrown by `setSubscriptionPreference` when a caller asks to switch a mandatory kind off. */
export class MandatorySubscriptionKindError extends Error {
	override readonly name = 'MandatorySubscriptionKindError';

	/** The kind that cannot be switched off, as `./kinds.ts` names it. */
	readonly kind: string;

	constructor(kind: string) {
		super(`The notification kind "${kind}" is mandatory and cannot be switched off.`);
		this.kind = kind;
	}
}

/** One notification kind together with a resident's current answer, ready for the preferences screen. */
export interface SubscriptionPreference {
	readonly kind: string;
	readonly enabled: boolean;
	readonly mandatory: boolean;
}

/**
 * Every known notification kind together with `residentId`'s current answer for it — the registry's
 * default filled in for a kind that has no row yet, so the screen always lists every kind
 * `spec-warga-unit-v1.md` asks for ("menampilkan setiap jenis notifikasi yang dikenal") even for a
 * resident whose row predates a kind, or whose defaults were never seeded.
 */
export async function subscriptionPreferencesFor(
	db: DatabaseWriter,
	residentId: string
): Promise<readonly SubscriptionPreference[]> {
	const rows = await db
		.select({ kind: subscriptions.kind, enabled: subscriptions.enabled })
		.from(subscriptions)
		.where(eq(subscriptions.residentId, residentId));
	const enabledByKind = new Map(rows.map((row) => [row.kind, row.enabled]));

	return SUBSCRIPTION_KINDS.map((definition) => ({
		kind: definition.kind,
		enabled: enabledByKind.get(definition.kind) ?? definition.defaultEnabled,
		mandatory: definition.mandatory
	}));
}

/**
 * Writes one row per known kind for `residentId`, at its registry default, skipping any kind that
 * already has an answer. Safe to call more than once for the same resident — a second call changes
 * nothing, which is what lets a test call it the same way #20 and #21 will: once, right after the
 * `residents` row itself is inserted.
 */
export async function ensureDefaultSubscriptions(
	db: DatabaseWriter,
	clock: Clock,
	residentId: string
): Promise<void> {
	const createdAt = clock.now();
	await db
		.insert(subscriptions)
		.values(
			SUBSCRIPTION_KINDS.map((definition) => ({
				residentId,
				kind: definition.kind,
				enabled: definition.defaultEnabled,
				createdAt
			}))
		)
		.onConflictDoNothing();
}

/** Who is asking, and what they are asking to change. */
export interface SetSubscriptionPreferenceRequest {
	/** The signed-in account making the request. Checked against `residentId`'s owner before anything else. */
	readonly callerUserId: string;
	readonly residentId: string;
	/** As `./kinds.ts` names it. An unknown kind is written as asked — see that module's doc comment. */
	readonly kind: string;
	readonly enabled: boolean;
}

/**
 * Sets one resident's answer for one notification kind.
 *
 * @throws {PermissionDeniedError} when `callerUserId` does not own the `residents` row `residentId`
 *   names.
 * @throws {MandatorySubscriptionKindError} when `enabled` is `false` and `kind` is mandatory —
 *   turning a mandatory kind back on is always allowed, only switching it off is refused.
 */
export async function setSubscriptionPreference(
	db: Database,
	clock: Clock,
	request: SetSubscriptionPreferenceRequest
): Promise<void> {
	await db.transaction(async (transaction) => {
		await assertOwnResident(
			transaction,
			request.callerUserId,
			request.residentId,
			'subscriptions.setPreference'
		);

		if (!request.enabled && isMandatorySubscriptionKind(request.kind)) {
			throw new MandatorySubscriptionKindError(request.kind);
		}

		await transaction
			.insert(subscriptions)
			.values({
				residentId: request.residentId,
				kind: request.kind,
				enabled: request.enabled,
				createdAt: clock.now()
			})
			.onConflictDoUpdate({
				target: [subscriptions.residentId, subscriptions.kind],
				set: { enabled: request.enabled }
			});
	});
}

/**
 * Why an unsubscribe token was refused. The first two come from `./unsubscribe-token.ts`; the third
 * is this module's own, for a token that verifies but names a `residents` row that is no longer
 * there.
 */
export type UnsubscribeRefusal = UnsubscribeTokenRejection | 'unknownResident';

/** Thrown by `disableSubscriptionByToken` when the token is not one this application issued. */
export class UnsubscribeTokenError extends Error {
	override readonly name = 'UnsubscribeTokenError';

	/** Which check refused it. Useful in a log; never shown to whoever presented the token. */
	readonly refusal: UnsubscribeRefusal;

	constructor(refusal: UnsubscribeRefusal) {
		super(`The unsubscribe token was refused (${refusal}).`);
		this.refusal = refusal;
	}
}

/** Who was unsubscribed from what, once a token has been believed. */
export interface UnsubscribeOutcome {
	readonly residentId: string;
	readonly kind: string;
}

/** What `disableSubscriptionByToken` may have handed to it instead of the production wiring. */
export interface DisableSubscriptionByTokenSettings {
	/**
	 * The raw `BETTER_AUTH_SECRET` the token was signed with. Defaults to the one in the
	 * environment; a test passes its own so it never depends on which secret the machine has.
	 */
	readonly secret?: string;
}

/**
 * Switches one notification kind off for whoever a signed unsubscribe token names, with no session
 * involved — the one-click "berhenti berlangganan" link every Langganan email carries.
 *
 * Exactly one row is written, for exactly the resident and the kind inside the token, so a link can
 * never reach another resident's preferences or another kind of notification. Replaying the same
 * token writes `enabled: false` over `enabled: false`, which is why the token needs no revocation —
 * see `./unsubscribe-token.ts`, decision 6.
 *
 * @throws {UnsubscribeTokenError} when the token is malformed, its signature does not match, or the
 *   resident it names no longer exists. A route answers all three the same way: a page saying the
 *   link is not valid, never which check refused it.
 * @throws {MandatorySubscriptionKindError} when the token names a kind that cannot be switched off.
 *   No token this application mints ever does — mandatory kinds carry no unsubscribe link — so this
 *   is the backstop for a token minted by a later caller that should not have.
 */
export async function disableSubscriptionByToken(
	db: Database,
	clock: Clock,
	token: string,
	settings: DisableSubscriptionByTokenSettings = {}
): Promise<UnsubscribeOutcome> {
	const verification = settings.secret
		? verifyUnsubscribeToken(token, settings.secret)
		: verifyUnsubscribeToken(token);
	if (!verification.valid) {
		throw new UnsubscribeTokenError(verification.reason);
	}
	const { residentId, kind } = verification;
	if (isMandatorySubscriptionKind(kind)) {
		throw new MandatorySubscriptionKindError(kind);
	}

	await db.transaction(async (transaction) => {
		const [row] = await transaction
			.select({ id: residents.id })
			.from(residents)
			.where(eq(residents.id, residentId))
			.limit(1);
		if (!row) {
			throw new UnsubscribeTokenError('unknownResident');
		}
		await transaction
			.insert(subscriptions)
			.values({ residentId, kind, enabled: false, createdAt: clock.now() })
			.onConflictDoUpdate({
				target: [subscriptions.residentId, subscriptions.kind],
				set: { enabled: false }
			});
	});

	return { residentId, kind };
}

/** One resident subscribed to a notification kind, as the sender needs it. */
export interface SubscribedResident {
	readonly residentId: string;
	readonly userId: string;
	readonly name: string;
	readonly email: string;
}

/**
 * Every resident currently subscribed to `kind` — the contract `spec-warga-unit-v1.md` promises to
 * the specs that send these notifications: iuran (tagihan terbit, pembayaran diverifikasi),
 * kas-laporan (laporan bulanan), konten (post baru), and keluhan (perubahan status keluhan sendiri).
 *
 * A resident with no row for `kind` is counted using the registry's default for it, exactly as
 * `subscriptionPreferencesFor` reads the screen — so a sender never has to know whether
 * `ensureDefaultSubscriptions` already ran for a particular resident.
 */
export async function residentsSubscribedTo(
	db: DatabaseWriter,
	kind: string
): Promise<readonly SubscribedResident[]> {
	const defaultEnabled = subscriptionKindDefinition(kind)?.defaultEnabled ?? false;

	const rows = await db
		.select({
			residentId: residents.id,
			userId: residents.userId,
			name: user.name,
			email: user.email,
			enabled: subscriptions.enabled
		})
		.from(residents)
		.innerJoin(user, eq(user.id, residents.userId))
		.leftJoin(
			subscriptions,
			and(eq(subscriptions.residentId, residents.id), eq(subscriptions.kind, kind))
		);

	return rows
		.filter((row) => row.enabled ?? defaultEnabled)
		.map(({ residentId, userId, name, email }) => ({ residentId, userId, name, email }));
}

/** Throws unless `residentId` is the row belonging to `callerUserId`. */
async function assertOwnResident(
	db: DatabaseWriter,
	callerUserId: string,
	residentId: string,
	action: string
): Promise<void> {
	const [row] = await db
		.select({ userId: residents.userId })
		.from(residents)
		.where(eq(residents.id, residentId))
		.limit(1);
	if (!row || row.userId !== callerUserId) {
		throw new PermissionDeniedError(callerUserId, action);
	}
}
