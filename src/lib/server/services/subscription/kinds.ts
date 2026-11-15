/**
 * The registry of every notification kind this application knows about, and the one rule this
 * ticket has to prove: which of them a resident may switch off.
 *
 * `subscriptions.kind` in `src/lib/server/db/schema/subscription.ts` is free text with no check
 * constraint, on purpose — the schema's own doc comment says the set of kinds that really exist is
 * "the registry the notification service is given", and this module is that registry. A later spec
 * that sends a new kind of email adds one entry here; it never has to touch the `subscriptions`
 * table itself.
 *
 * **Which kinds are mandatory is decided here, not in SQL**, for the same reason: naming every
 * mandatory kind in a check constraint would mean a migration per notification, which is exactly
 * what the free-text column was chosen to avoid. `spec-warga-unit-v1.md`'s "Preferensi notifikasi
 * adalah data" section names the mandatory three by what they are about — a resident's own money and
 * a resident's own keluhan — and the opt-in two: the monthly report and a new post.
 *
 * Kind names are kebab-case, matching the vocabulary `email_queue.kind` already uses
 * (`verify-email`, `password-reset` — see `src/lib/server/email/templates/`), so a later spec that
 * sends one of these as an actual email queues it under the same name a resident's preference is
 * keyed by.
 *
 * ## The email kinds are named from this list
 *
 * `NOTIFICATION_EMAIL_KIND` below is every email sent about a change that has already been saved —
 * the emails `src/lib/server/email/announce.ts` queues. Its names are this module's Langganan kinds,
 * spread in rather than written again, plus the two emails that are not a Langganan of their own:
 * `payment-rejected`, which no Langganan governs and which therefore reaches every recipient the way
 * a mandatory kind does, and `monthly-report-revised`, which the monthly report Langganan governs —
 * whoever asked for the figures is told when they are corrected, and that Langganan's unsubscribe
 * link stops both. Neither of the two is added to `SUBSCRIPTION_KIND` or `SUBSCRIPTION_KINDS`: those
 * are what the preferences screen lists, and a switch for either would be one nobody could answer
 * sensibly. #309 decision 2 is the reason the list exists: email kind names used to come from two
 * vocabularies, some derived from here and some typed out by hand to match.
 */

/** Every notification kind a resident can have an opinion about. */
export const SUBSCRIPTION_KIND = {
	/** A resident's own Unit had a Tagihan issued. Mandatory: it is money the resident owes. */
	invoiceIssued: 'invoice-issued',
	/** A resident's own Pembayaran was verified. Mandatory: it is money the resident paid. */
	paymentVerified: 'payment-verified',
	/** A resident's own Keluhan changed status. Mandatory: it is a report the resident filed. */
	ownComplaintStatusChanged: 'own-complaint-status-changed',
	/** A new Laporan Bulanan was published. Opt-in, off by default. */
	monthlyReport: 'monthly-report',
	/** A new Post was published on the announcement board. Opt-in, off by default. */
	newPost: 'new-post',
	/**
	 * A new Keluhan was reported, for an admin to review. Opt-in, off by default — #46's own
	 * acceptance criterion is that this one email an admin may switch off, unlike the reporter's own
	 * `ownComplaintStatusChanged` above, which stays mandatory.
	 */
	newComplaint: 'new-complaint'
} as const;

/** One of the notification kinds above. */
export type SubscriptionKind = (typeof SUBSCRIPTION_KIND)[keyof typeof SUBSCRIPTION_KIND];

/** What the registry knows about one kind: whether it can be switched off, and what a fresh row starts as. */
export interface SubscriptionKindDefinition {
	readonly kind: SubscriptionKind;
	/**
	 * Whether a resident may switch this kind off. `setSubscriptionPreference` in `./index.ts`
	 * refuses `enabled: false` for a mandatory kind whatever the caller asks.
	 */
	readonly mandatory: boolean;
	/**
	 * What `ensureDefaultSubscriptions` writes for a resident who has never answered, and what
	 * `subscriptionPreferencesFor` and `residentsSubscribedTo` in `./index.ts` assume for a resident
	 * who has no row at all yet.
	 */
	readonly defaultEnabled: boolean;
}

/**
 * Every known kind, in the order the preferences screen lists them. The three mandatory kinds come
 * first — they are always on and never the ones a resident has to think about — then the opt-in
 * kinds.
 *
 * `as const` keeps each entry's `mandatory` as a literal, so that `OptInSubscriptionKind` below is
 * read off this very list rather than written out a second time; `satisfies` still holds every entry
 * to `SubscriptionKindDefinition`.
 */
export const SUBSCRIPTION_KINDS = [
	{ kind: SUBSCRIPTION_KIND.invoiceIssued, mandatory: true, defaultEnabled: true },
	{ kind: SUBSCRIPTION_KIND.paymentVerified, mandatory: true, defaultEnabled: true },
	{ kind: SUBSCRIPTION_KIND.ownComplaintStatusChanged, mandatory: true, defaultEnabled: true },
	{ kind: SUBSCRIPTION_KIND.monthlyReport, mandatory: false, defaultEnabled: false },
	{ kind: SUBSCRIPTION_KIND.newPost, mandatory: false, defaultEnabled: false },
	{ kind: SUBSCRIPTION_KIND.newComplaint, mandatory: false, defaultEnabled: false }
] as const satisfies readonly SubscriptionKindDefinition[];

/** A kind a resident may switch off: every entry in `SUBSCRIPTION_KINDS` that is not mandatory. */
export type OptInSubscriptionKind = Extract<
	(typeof SUBSCRIPTION_KINDS)[number],
	{ readonly mandatory: false }
>['kind'];

const DEFINITION_BY_KIND: ReadonlyMap<string, SubscriptionKindDefinition> = new Map(
	SUBSCRIPTION_KINDS.map((definition) => [definition.kind, definition])
);

/** The registry's entry for `kind`, or `undefined` when nothing that ever asked named it. */
export function subscriptionKindDefinition(kind: string): SubscriptionKindDefinition | undefined {
	return DEFINITION_BY_KIND.get(kind);
}

/** Whether `kind` is one of the Langganan kinds above. */
function isSubscriptionKind(kind: string): kind is SubscriptionKind {
	return DEFINITION_BY_KIND.has(kind);
}

/**
 * Whether `kind` cannot be switched off. A kind the registry has never heard of is never mandatory —
 * there is nothing to protect, and a row naming it is a row nothing reads, exactly as
 * `src/lib/server/db/schema/subscription.ts` says of an unknown kind.
 */
export function isMandatorySubscriptionKind(kind: string): boolean {
	return subscriptionKindDefinition(kind)?.mandatory ?? false;
}

/**
 * Every email sent about a change that has already been saved, by the `kind` its queue row carries
 * and its template is registered under. See this module's doc comment for why it is the Langganan
 * list plus two.
 */
export const NOTIFICATION_EMAIL_KIND = {
	...SUBSCRIPTION_KIND,
	/** A Pembayaran the resident recorded was rejected. Governed by no Langganan: always sent. */
	paymentRejected: 'payment-rejected',
	/** A Laporan Bulanan was published again as a new revision. Governed by `monthlyReport`. */
	monthlyReportRevised: 'monthly-report-revised'
} as const;

/** One of the email kinds above. */
export type NotificationEmailKind =
	(typeof NOTIFICATION_EMAIL_KIND)[keyof typeof NOTIFICATION_EMAIL_KIND];

/**
 * The Langganan that decides who receives each email kind that is not itself a Langganan kind, or
 * `null` for one that no Langganan governs. A Langganan kind governs its own email, so it has no
 * entry here.
 */
const GOVERNING_SUBSCRIPTION_KIND_OF_OTHER_EMAIL = {
	[NOTIFICATION_EMAIL_KIND.paymentRejected]: null,
	[NOTIFICATION_EMAIL_KIND.monthlyReportRevised]: SUBSCRIPTION_KIND.monthlyReport
} as const satisfies Readonly<
	Record<Exclude<NotificationEmailKind, SubscriptionKind>, SubscriptionKind | null>
>;

/** The Langganan kind that governs email kind `K`, as a type: `null` when none does. */
type GoverningSubscriptionKind<K extends NotificationEmailKind> = K extends SubscriptionKind
	? K
	: K extends keyof typeof GOVERNING_SUBSCRIPTION_KIND_OF_OTHER_EMAIL
		? (typeof GOVERNING_SUBSCRIPTION_KIND_OF_OTHER_EMAIL)[K]
		: never;

/**
 * An email kind a resident may switch off, because the Langganan governing it is opt-in. Every
 * email of one of these kinds goes only to the residents subscribed to that Langganan, and carries
 * that Langganan's unsubscribe link.
 */
export type OptInEmailKind = {
	[K in NotificationEmailKind]: GoverningSubscriptionKind<K> extends OptInSubscriptionKind
		? K
		: never;
}[NotificationEmailKind];

/** The Langganan kind that governs `kind`, or `null` when none does. */
export function governingSubscriptionKind(kind: NotificationEmailKind): SubscriptionKind | null {
	return isSubscriptionKind(kind) ? kind : GOVERNING_SUBSCRIPTION_KIND_OF_OTHER_EMAIL[kind];
}

/**
 * Whether `kind` is opt-in: governed by a Langganan that is not mandatory. Every other email kind —
 * governed by a mandatory Langganan or by none — reaches every recipient it is addressed to.
 */
export function isOptInEmailKind(kind: NotificationEmailKind): kind is OptInEmailKind {
	const governing = governingSubscriptionKind(kind);
	return governing !== null && !isMandatorySubscriptionKind(governing);
}
