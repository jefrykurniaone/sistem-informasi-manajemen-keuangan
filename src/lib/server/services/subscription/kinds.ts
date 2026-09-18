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
	newPost: 'new-post'
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
 * first — they are always on and never the ones a resident has to think about — then the two opt-in
 * kinds.
 */
export const SUBSCRIPTION_KINDS: readonly SubscriptionKindDefinition[] = [
	{ kind: SUBSCRIPTION_KIND.invoiceIssued, mandatory: true, defaultEnabled: true },
	{ kind: SUBSCRIPTION_KIND.paymentVerified, mandatory: true, defaultEnabled: true },
	{ kind: SUBSCRIPTION_KIND.ownComplaintStatusChanged, mandatory: true, defaultEnabled: true },
	{ kind: SUBSCRIPTION_KIND.monthlyReport, mandatory: false, defaultEnabled: false },
	{ kind: SUBSCRIPTION_KIND.newPost, mandatory: false, defaultEnabled: false }
];

const DEFINITION_BY_KIND = new Map(
	SUBSCRIPTION_KINDS.map((definition) => [definition.kind, definition])
);

/** The registry's entry for `kind`, or `undefined` when nothing that ever asked named it. */
export function subscriptionKindDefinition(kind: string): SubscriptionKindDefinition | undefined {
	return DEFINITION_BY_KIND.get(kind as SubscriptionKind);
}

/**
 * Whether `kind` cannot be switched off. A kind the registry has never heard of is never mandatory —
 * there is nothing to protect, and a row naming it is a row nothing reads, exactly as
 * `src/lib/server/db/schema/subscription.ts` says of an unknown kind.
 */
export function isMandatorySubscriptionKind(kind: string): boolean {
	return subscriptionKindDefinition(kind)?.mandatory ?? false;
}
