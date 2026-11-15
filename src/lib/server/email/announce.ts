import { asc, eq, inArray, is } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import type { Locale } from '#lib/paraglide/runtime.js';
import { readOrigin } from '../auth';
import type { Database } from '../db';
import { user } from '../db/schema/auth';
import type { QueuedEmail } from '../db/schema/email';
import { residents } from '../db/schema/resident';
import type { Clock } from '../ports/clock';
import type { EmailPayload } from '../ports/email';
import { residentsSubscribedTo } from '../services/subscription';
import {
	governingSubscriptionKind,
	isOptInEmailKind,
	type NotificationEmailKind,
	type OptInEmailKind
} from '../services/subscription/kinds';
import {
	unsubscribeLink,
	unsubscribeTokenSecret
} from '../services/subscription/unsubscribe-token';
import { withoutTrailingSlashes } from '../url';
import { enqueueEmail } from './queue';

/**
 * Sending an email about a change that has already been saved: the one module in front of the email
 * queue that every domain notification goes through (#309, decision 1). A domain module names the
 * email kind, the residents it is addressed to, and how its payload is built; this module does the
 * rest, which every notification module used to do for itself and no two did the same way:
 *
 * - **Langganan.** Whether a kind is opt-in or mandatory is read off `../services/subscription/kinds.ts`
 *   through `isOptInEmailKind`. An opt-in kind reaches only the addressed residents who are
 *   subscribed to the Langganan governing it, by `residentsSubscribedTo`'s own rule (a resident who
 *   never answered gets the registry default). Every other kind reaches every addressed resident,
 *   whatever a `subscriptions` row says: a mandatory kind cannot be switched off, and
 *   `payment-rejected` has no switch at all.
 * - **The unsubscribe link.** Every email of an opt-in kind carries a signed link to that resident's
 *   own unsubscribe page for the governing Langganan, built with `unsubscribeLink` and the token
 *   mechanism in `../services/subscription/unsubscribe-token.ts`. It is written into the payload
 *   under `unsubscribeUrl` here, after the domain's builder has run, so the guarantee holds whatever
 *   the builder does; the builder is also handed the same address, typed `string`, for a template
 *   whose values require it. A mandatory kind carries none, and its builder is handed `null`.
 * - **Links.** Every address is built from `readOrigin()`, the configured `ORIGIN`, never from a
 *   request header a client could bend. A builder asks for one with `link('/posts/…')`.
 * - **Language.** Every email is written in `id` until a resident's own language is a stored fact.
 * - **One queue row per resident.** A resident named twice is sent one email.
 * - **A rule of the caller's own that leaves someone out.** `request.except` is applied after the
 *   Langganan, to the residents it would have reached, and the number it leaves out is reported as
 *   `AnnounceOutcome.skipped`. The Laporan Bulanan's "this Periode was already sent to that
 *   address" is such a rule: it is the caller's own fact (it reads `email_queue`), so it stays in
 *   the caller, while the Langganan stays here and never has to be read twice.
 *
 * ## Recipients are residents
 *
 * Every email this module sends is addressed to a `residents.id`: the Langganan and the unsubscribe
 * token are both keyed by it, and an address alone could carry neither. A caller gives either the list it already knows (a Pembayaran's recorder, a Keluhan's
 * reporter) or a `RecipientResolver` that finds them (`everyResident`, or every admin). The address
 * is looked up here, in one query. A resident whose row is gone is skipped without a word, which is
 * what each notification module did before.
 *
 * ## Two variants, by who reads the failure
 *
 * `announce` throws. It still tries every recipient before it does, so one recipient whose row could
 * not be written does not keep the email from the others (#309, story 2); it then throws
 * `AnnounceError` naming how many were queued. A job's body calls it directly: a job reports failure
 * by throwing, so that the scheduler records the run as failed and tries the day again.
 *
 * `announceAfterCommit` never throws. It is the one never-fail rule (#309, decision 1), and it sits
 * at the call site, after the transaction that saved the change has returned, wrapped around
 * whatever sends the email. Being at the call site is the point: a service that lets a caller inject
 * its notifier (`PublishPostSettings.notify`, `PublishReportSettings.notify`) keeps the guarantee for
 * the injected one too, which a catch inside the production notifier would not. A failure is logged
 * to the console, the honest place for it until this application has a logger, and the saved change
 * is reported as the success it is. It must never be used inside a transaction: PostgreSQL aborts a
 * transaction on the failed statement, and swallowing that error would let the caller go on to a
 * `COMMIT` that PostgreSQL answers with a rollback.
 *
 * `announce` is given the plain database, never a transaction, for the same reason the notification
 * modules always were: the email is queued once the change it announces has committed, so a failure
 * here can never undo that change. The `Database` type cannot say so, because a transaction handle
 * type-checks as one, so `announce` refuses a transaction itself, before it runs a single statement:
 * the refusal is an ordinary exception, which leaves the caller's transaction as healthy as it was.
 */

/** The locale every announced email is written in, until a resident's own language is stored. */
const ANNOUNCE_LOCALE: Locale = 'id';

/** One resident an email is addressed to, as a payload builder sees them. */
export interface AnnounceRecipient {
	/** The `residents.id` the email is for. */
	readonly residentId: string;
	/** The account's display name. */
	readonly name: string;
	/** The address the queue row is sent to. */
	readonly email: string;
}

/** Finds the `residents.id` of everyone an email is addressed to, before any Langganan is applied. */
export type RecipientResolver = (db: Database) => Promise<readonly string[]>;

/** Who an email is addressed to: the `residents.id` already known, or how to find them. */
export type AnnounceRecipients = readonly string[] | RecipientResolver;

/** What a payload builder is handed, once for every resident an email is queued for. */
export interface AnnounceContext<K extends NotificationEmailKind> {
	/** Who this one email is for. */
	readonly recipient: AnnounceRecipient;
	/** The locale the email is written in. */
	readonly locale: Locale;
	/**
	 * The absolute address of `path` on this application, built from `ORIGIN`.
	 *
	 * @throws {TypeError} when `path` does not start with `/`.
	 */
	readonly link: (path: string) => string;
	/**
	 * This resident's own unsubscribe page for the Langganan governing an opt-in kind, and `null` for
	 * every other kind. It is written into the payload as `unsubscribeUrl` whatever the builder does.
	 */
	readonly unsubscribeUrl: K extends OptInEmailKind ? string : null;
}

/** One email to send about a change that has already been saved. */
export interface AnnounceRequest<K extends NotificationEmailKind> {
	/** The kind on every queue row, and the template that renders it. */
	readonly kind: K;
	/** Who it is addressed to. An opt-in kind is then narrowed to the subscribed among them. */
	readonly recipients: AnnounceRecipients;
	/** Builds one recipient's payload. Called once for every resident the email reaches. */
	readonly payload: (context: AnnounceContext<K>) => EmailPayload;
	/**
	 * A rule of the caller's own that leaves a resident out: `true` skips them. Applied after the
	 * Langganan filter, so it is asked only about residents the email would otherwise have reached,
	 * and each one it skips is counted in `AnnounceOutcome.skipped`.
	 */
	readonly except?: (recipient: AnnounceRecipient) => boolean;
}

/** What `announce` queued. */
export interface AnnounceOutcome {
	/** One row per resident who was sent the email, in the order the recipients were given. */
	readonly queued: readonly QueuedEmail[];
	/** How many residents the email would have reached but `request.except` left out. */
	readonly skipped: number;
}

/**
 * Thrown by `announce` when the email could not be queued for one or more recipients. Every other
 * recipient was still queued; `errors` holds one failure per recipient that was not.
 */
export class AnnounceError extends AggregateError {
	override readonly name = 'AnnounceError';

	/** The kind that was being announced. */
	readonly kind: NotificationEmailKind;

	/** How many recipients were queued despite the failures. */
	readonly queued: number;

	constructor(kind: NotificationEmailKind, failures: readonly unknown[], queued: number) {
		super(
			failures,
			`Queuing "${kind}" failed for ${failures.length} recipient(s); ${queued} other(s) were queued.`
		);
		this.kind = kind;
		this.queued = queued;
	}
}

/** Every resident there is, for an email the whole complex may hear about. */
export const everyResident: RecipientResolver = async (db) => {
	const rows = await db
		.select({ id: residents.id })
		.from(residents)
		.orderBy(asc(residents.createdAt), asc(residents.id));
	return rows.map((row) => row.id);
};

/**
 * Queues one `request.kind` email for every resident it reaches — see this module's doc comment for
 * who that is and what each payload carries besides what the builder writes.
 *
 * @param db the plain database, once the change being announced has committed.
 * @throws {TypeError} when `db` is a transaction handle — see this module's doc comment.
 * @throws {AnnounceError} when one or more recipients could not be queued, after every other one
 *   was.
 * @throws whatever finding the recipients, reading `ORIGIN` or reading the signing secret threw,
 *   before anything was queued.
 */
export async function announce<K extends NotificationEmailKind>(
	db: Database,
	clock: Clock,
	request: AnnounceRequest<K>
): Promise<AnnounceOutcome> {
	// `is`, not `instanceof`: it reads drizzle's own entity marker, so a second copy of `drizzle-orm`
	// in `node_modules` (this repository has had one) cannot make a transaction look like a database.
	if (is(db, PgTransaction)) {
		throw new TypeError(
			`"${request.kind}" is announced once the change it announces has committed, so announce takes the database, not a transaction.`
		);
	}

	const addressed = distinct(
		typeof request.recipients === 'function' ? await request.recipients(db) : request.recipients
	);
	if (addressed.length === 0) {
		return { queued: [], skipped: 0 };
	}

	// Non-null exactly when the kind is opt-in: `isOptInEmailKind` holds only for a kind some
	// Langganan governs.
	const optInSubscription = isOptInEmailKind(request.kind)
		? governingSubscriptionKind(request.kind)
		: null;
	const reachable =
		optInSubscription === null
			? await residentsAmong(db, addressed)
			: await subscribedAmong(db, optInSubscription, addressed);
	const except = request.except;
	const recipients = except ? reachable.filter((recipient) => !except(recipient)) : reachable;
	const skipped = reachable.length - recipients.length;
	if (recipients.length === 0) {
		return { queued: [], skipped };
	}

	const origin = readOrigin();
	const secret = optInSubscription === null ? undefined : unsubscribeTokenSecret();
	const link = (path: string): string => absoluteLink(origin, path);

	const queued: QueuedEmail[] = [];
	const failures: unknown[] = [];
	for (const recipient of recipients) {
		try {
			const unsubscribeUrl =
				optInSubscription === null
					? null
					: unsubscribeLink(
							origin,
							{ residentId: recipient.residentId, kind: optInSubscription },
							secret
						);
			// The one place the opt-in/mandatory split is asserted to the type system: `unsubscribeUrl`
			// is a string exactly when `isOptInEmailKind(request.kind)` held above, which is what
			// `AnnounceContext<K>['unsubscribeUrl']` states for `K`.
			const context = {
				recipient,
				locale: ANNOUNCE_LOCALE,
				link,
				unsubscribeUrl
			} as AnnounceContext<K>;
			const built = request.payload(context);
			const payload = unsubscribeUrl === null ? built : { ...built, unsubscribeUrl };
			queued.push(
				await enqueueEmail(db, clock, { recipient: recipient.email, kind: request.kind, payload })
			);
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length > 0) {
		throw new AnnounceError(request.kind, failures, queued.length);
	}
	return { queued, skipped };
}

/**
 * Runs `send` after a change has committed and never lets it fail that change: whatever it throws is
 * logged to the console and answered with `undefined`. See this module's doc comment for why the
 * rule sits at the call site, and why never inside a transaction.
 *
 * @param what names the email for the console line, for example `the "new-post" email for Post …`.
 * @returns what `send` resolved to, or `undefined` when it threw.
 */
export async function announceAfterCommit<T>(
	what: string,
	send: () => Promise<T>
): Promise<T | undefined> {
	try {
		return await send();
	} catch (error) {
		console.error(
			`Queuing ${what} failed after the change it announces had already committed:`,
			error
		);
		return undefined;
	}
}

/** `ids` without repeats, in the order each first appeared. */
function distinct(ids: readonly string[]): readonly string[] {
	return [...new Set(ids)];
}

/** `path` on this application, absolute. */
function absoluteLink(origin: string, path: string): string {
	if (!path.startsWith('/')) {
		throw new TypeError(`A link is built from a path that starts with "/"; received "${path}".`);
	}
	return `${withoutTrailingSlashes(origin)}${path}`;
}

/** The residents among `residentIds` that still exist, in that order, with their addresses. */
async function residentsAmong(
	db: Database,
	residentIds: readonly string[]
): Promise<readonly AnnounceRecipient[]> {
	const rows = await db
		.select({ residentId: residents.id, name: user.name, email: user.email })
		.from(residents)
		.innerJoin(user, eq(user.id, residents.userId))
		.where(inArray(residents.id, [...residentIds]));
	return inOrderOf(residentIds, rows);
}

/** The residents among `residentIds` subscribed to `kind`, in that order, with their addresses. */
async function subscribedAmong(
	db: Database,
	kind: string,
	residentIds: readonly string[]
): Promise<readonly AnnounceRecipient[]> {
	const subscribed = await residentsSubscribedTo(db, kind);
	return inOrderOf(
		residentIds,
		subscribed.map(({ residentId, name, email }) => ({ residentId, name, email }))
	);
}

/** `found`, put in the order `residentIds` names them; an id with nothing found is left out. */
function inOrderOf(
	residentIds: readonly string[],
	found: readonly AnnounceRecipient[]
): readonly AnnounceRecipient[] {
	const byId = new Map(found.map((recipient) => [recipient.residentId, recipient]));
	return residentIds.flatMap((residentId) => {
		const recipient = byId.get(residentId);
		return recipient ? [recipient] : [];
	});
}
