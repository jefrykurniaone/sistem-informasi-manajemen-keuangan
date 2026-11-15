import { error, fail, isHttpError, isRedirect, redirect, type ActionFailure } from '@sveltejs/kit';
import {
	ERROR_CATEGORY,
	NotFoundError,
	PermissionDeniedError,
	RuleViolationError,
	type ErrorCategory
} from '#lib/errors.ts';
import { parseRupiah, type Rupiah } from '#lib/money.ts';
import { AUTH_PATHS } from '#lib/server/auth.ts';
import { database, type Database } from '#lib/server/db/index.ts';
import { systemClock, type Clock } from '#lib/server/ports/clock.ts';
import type { FileStore } from '#lib/server/ports/file-store.ts';
import {
	CashCategoryNameTakenError,
	CashCategoryNotFoundError,
	SystemCashCategoryError
} from '#lib/server/services/cash/category.ts';
import {
	OpeningBalanceAfterEarliestCashTransactionError,
	OpeningBalanceAlreadyRecordedError
} from '#lib/server/services/cash/opening-balance.ts';
import { PeriodLockedError, PeriodRuleError } from '#lib/server/services/cash/period.ts';
import {
	CashRuleError,
	CashTransactionAlreadyCorrectedError,
	CashTransactionNotFoundError
} from '#lib/server/services/cash/writer.ts';
import { ComplaintAttachmentRuleError } from '#lib/server/services/complaint/attachment.ts';
import {
	ComplaintNotFoundError,
	ComplaintRuleError
} from '#lib/server/services/complaint/index.ts';
import { ComplaintReplyRuleError } from '#lib/server/services/complaint/reply.ts';
import { ComplaintTransitionError } from '#lib/server/services/complaint/state-machine.ts';
import {
	AllocationNotFoundError,
	ReleaseRuleError
} from '#lib/server/services/dues/allocation-release.ts';
import { RefundRuleError } from '#lib/server/services/dues/credit-refund.ts';
import {
	ExemptionActorNotRegisteredError,
	ExemptionDateOrderError,
	ExemptionNotFoundError,
	ExemptionOverlapError
} from '#lib/server/services/dues/exemption.ts';
import {
	InvoiceNotFoundError,
	VoidRefusedAllocatedError,
	VoidRuleError
} from '#lib/server/services/dues/invoice-void.ts';
import { PaymentRuleError } from '#lib/server/services/dues/payment.ts';
import { UnitNotFoundError as DuesUnitNotFoundError } from '#lib/server/services/dues/queries.ts';
import {
	DuesRateConflictError,
	DuesRateInUseError,
	DuesRateNotFoundError
} from '#lib/server/services/dues/rate.ts';
import {
	PaymentNotFoundError,
	VerificationRuleError
} from '#lib/server/services/dues/verification.ts';
import { isUuid } from '#lib/server/services/identifier.ts';
import { ImportRejectedError } from '#lib/server/services/import/resident-import.ts';
import {
	EmptyImportFileError,
	ImportHeaderError,
	ImportTooLargeError
} from '#lib/server/services/import/validation.ts';
import {
	InvitationEmailAlreadyRegisteredError,
	InvitationExpiredError,
	InvitationNotFoundError,
	InvitationTokenUnknownError,
	InvitationUsedError
} from '#lib/server/services/invitation/index.ts';
import {
	OccupancyDateOrderError,
	OccupancyEndOverlapError,
	OccupancyNotFoundError,
	OccupancyOverlapError,
	PrimaryOccupantAlreadyEndedError,
	PrimaryOccupantNotStartedError,
	ResidentNotFoundError
} from '#lib/server/services/occupancy/index.ts';
import {
	PostNotFoundError,
	PostRuleError,
	PostTransitionError
} from '#lib/server/services/post/index.ts';
import {
	RegistrationAccountMissingError,
	RegistrationAlreadyDecidedError,
	RegistrationNotFoundError
} from '#lib/server/services/registration/index.ts';
import { ReportRuleError } from '#lib/server/services/report/publication.ts';
import {
	MandatorySubscriptionKindError,
	UnsubscribeTokenError
} from '#lib/server/services/subscription/index.ts';
import { UnitConflictError, UnitNotFoundError } from '#lib/server/services/unit/index.ts';
import { localFileStoreFromEnvironment } from '#lib/server/storage/local-file-store.ts';

/**
 * The route-action module: everything a `load` or a form action under `src/routes` repeats around
 * the one service call it exists to make (#318, spec #310).
 *
 * - **The session guard.** `requireUser` sends a visitor nobody signed in as to the login page.
 * - **The error mapping.** `throwRouteError` (in a `load`) and `failOrThrow` (in an action) turn
 *   whatever the service threw into the route's answer: a permission refusal into a 403, a missing
 *   or malformed identifier into a 404, a broken rule into `fail(400)` with the route's sentence,
 *   and anything else back into a throw. `requireUuidParam` is the malformed-identifier half of the
 *   404.
 * - **The production dependencies.** `productionDependencies` hands out the database, the clock and
 *   the file store a route passes to a service.
 * - **The form field readers.** `readText`, `readOptionalText` and `readRupiah`.
 *
 * ## The mapping, and who decides what
 *
 * The category of an error is a fact about the error (`ERROR_CATEGORY` in `src/lib/errors.ts`):
 * `PermissionDeniedError` is forbidden, a subclass of `NotFoundError` or `RuleViolationError` says
 * which it is, and every class written before those two base classes existed is listed below in
 * `NOT_FOUND_ERRORS` or `RULE_ERRORS`. Every sentence belongs to the route, through Paraglide:
 * this module never writes screen text, it only decides which of the route's sentences is said and
 * with which status.
 *
 * In this order, first match wins:
 *
 * 1. **A SvelteKit `error()` or `redirect()`** thrown inside the `try` is rethrown untouched.
 * 2. **`PermissionDeniedError`** is a 403 with the route's `forbidden` sentence, always. It is
 *    checked before anything the route named, and `refusal` refuses to name it or plain `Error`, so
 *    nothing a route hands this module can turn a permission refusal into a form message. This is
 *    the property the module exists to hold: it never lets through a request a route refused
 *    before. (A `catch` that answers before it calls this module is outside its reach, which is why
 *    a route's `catch` block does nothing but call it.)
 * 3. **A class the action named** with `refusal` is `fail(400)` with that sentence, whatever its
 *    category. That is how a not-found about something the form posted (a stale category id)
 *    stays a message on the form rather than a 404 page.
 * 4. **A not-found the action did not name** is a 404 with the route's `notFound` sentence. A route
 *    that has no such sentence answers it on the form with its `fallback` sentence (an action) or
 *    rethrows it (a `load`), because a 404 page needs a sentence the route wrote.
 * 5. **A rule violation the action did not name** is `fail(400)` with the action's `fallback`
 *    sentence. This is what spec #310 is for: `PeriodLockedError` reached `/admin/cash` and
 *    `/admin/cash/new` as a 500 until `cb96a8c` (#97), because each route listed only the rule
 *    errors it knew about. In a `load` there is no form, so a rule violation is rethrown.
 * 6. **Anything else is rethrown.** A `TypeError` from a bug, a driver error, an error class nobody
 *    categorised: hiding those behind a form message would hide real defects. A route that wants a
 *    message for one of them (several answer a `TypeError` from service-side validation with their
 *    invalid-form sentence) names it with `refusal`.
 *
 * ## Why a list here and not only base classes
 *
 * The ticket allowed either. The base classes in `src/lib/errors.ts` are the way forward: an error
 * class that extends one needs no edit here or in any route. But this ticket may not edit the
 * service modules, so every existing class is registered below instead. `tests/unit/route-action.test.ts`
 * walks every service module and fails on an exported error class that is in neither place, so a
 * new class has to choose, and an error class nobody categorised cannot reach a screen as a 500
 * unnoticed. A class that really is a bug signal rather than a refusal is listed in that test as
 * deliberately uncategorised, with its reason.
 *
 * The list imports each class from the module that defines it. A ticket that moves one of these
 * classes to another file keeps it exported from the old path, or edits this list in the same
 * change.
 *
 * ## The Elysia API
 *
 * `src/lib/server/api/app.ts` keeps its own `onError` for now; whether it reads `errorCategoryOf` is
 * #333's decision, and its current answer for anything but a permission refusal is a 500.
 */

/** A sentence the route says, read only when it is said, so it is in the request's language. */
export type Message = () => string;

/** What `refusal` hands its sentence: the error itself, typed as the class it named. */
export interface Refused<E extends Error> {
	readonly error: E;
}

/**
 * The sentences a route says when a request is refused outright: the 403 page, and the 404 page
 * when it has one. A route declares this once, at module scope, with `satisfies PageMessages` so
 * that a route with a `notFound` sentence keeps it non-optional for `requireUuidParam`.
 */
export interface PageMessages {
	/** The 403 page, for `PermissionDeniedError`. */
	readonly forbidden: Message;
	/**
	 * The 404 page, for a not-found error the action did not name and for a malformed identifier.
	 * Leave it out on a screen that has no 404 of its own: see step 4 of the mapping.
	 */
	readonly notFound?: Message;
}

/** What one form action says, on top of the page's sentences. */
export interface FormMessages extends PageMessages {
	/**
	 * The form's sentence for a rule violation the action did not name, and for a not-found when the
	 * route has no 404 sentence. Usually the screen's invalid-form sentence.
	 */
	readonly fallback: Message;
	/** The classes this action answers with a sentence of their own, each `fail(400)`. */
	readonly refusals?: readonly Refusal[];
}

/** An error class, concrete or abstract, whatever its constructor takes. */
type ErrorClass<E extends Error> = abstract new (...args: never[]) => E;

/**
 * One error class and the sentence an action answers it with. Built only by `refusal`: the private
 * field makes the type nominal, so a route cannot hand this module a hand-written matcher that
 * catches more than one named class.
 */
class Refusal {
	readonly #messageFor: (caught: unknown) => string | undefined;

	constructor(messageFor: (caught: unknown) => string | undefined) {
		this.#messageFor = messageFor;
	}

	/** The sentence for `caught`, or `undefined` when `caught` is not of the named class. */
	messageFor(caught: unknown): string | undefined {
		return this.#messageFor(caught);
	}
}

export type { Refusal };

/**
 * Names one error class an action answers with its own sentence, as `fail(400, { message })`.
 *
 * The sentence receives `{ error }`, not the error itself. Every `Error` has a `name`, and a
 * Paraglide message taking a `{name}` parameter would otherwise accept an error as its input and
 * print the class name on the screen. Wrapped, a message that needs a parameter has to be called by
 * hand (`({ error }) => m.x({ name: error.categoryName })`), and a message without one can still be
 * passed as it is (`m.x`).
 *
 * The wrapping moves the hole to one name rather than closing it: a Paraglide message whose only
 * parameter is `{error}` accepts `{ error }` as it stands, so passed directly it type-checks and
 * prints the error's own text, class name first, on the screen. No message is shaped like that
 * today. If one ever is, call it by hand with the field it means, never pass it as it is.
 *
 * @throws {TypeError} when `errorClass` is `Error` itself, which would turn every bug into a form
 *   message, or `PermissionDeniedError` or a subclass of it, which is always a 403.
 */
export function refusal<E extends Error>(
	errorClass: ErrorClass<E>,
	message: (refused: Refused<E>) => string
): Refusal {
	// Compared as `unknown`: TypeScript cannot see that an `ErrorClass<E>` may be one of these two.
	const named: unknown = errorClass;
	if (named === Error) {
		throw new TypeError(
			'A refusal may not name Error itself: every unexpected failure would become a form message.'
		);
	}
	if (named === PermissionDeniedError || errorClass.prototype instanceof PermissionDeniedError) {
		throw new TypeError(
			`A refusal may not name ${errorClass.name}: a permission refusal is always a 403.`
		);
	}
	return new Refusal((caught) =>
		caught instanceof errorClass ? message({ error: caught }) : undefined
	);
}

/**
 * The not-found errors written before `NotFoundError` existed. Each extends `Error` directly and
 * lives in a module this ticket may not edit; a new class extends `NotFoundError` instead.
 */
const NOT_FOUND_ERRORS: readonly ErrorClass<Error>[] = [
	CashCategoryNotFoundError,
	CashTransactionNotFoundError,
	ComplaintNotFoundError,
	AllocationNotFoundError,
	ExemptionNotFoundError,
	InvoiceNotFoundError,
	DuesUnitNotFoundError,
	DuesRateNotFoundError,
	PaymentNotFoundError,
	InvitationNotFoundError,
	InvitationTokenUnknownError,
	OccupancyNotFoundError,
	ResidentNotFoundError,
	PostNotFoundError,
	RegistrationNotFoundError,
	UnsubscribeTokenError,
	UnitNotFoundError
];

/**
 * The rule violations written before `RuleViolationError` existed, on the same terms as
 * `NOT_FOUND_ERRORS`. `LastSuperuserError` is not here: it lives in `src/lib/errors.ts` and extends
 * `RuleViolationError` itself.
 *
 * `CashCorrectionTargetError` is deliberately in neither list. Its own doc in
 * `#lib/server/services/cash/writer.ts` calls it a defect when the dues-correction module meets it
 * (the line was found through the wrong Audit Log entry), and a defect must reach the log as a 500,
 * not a quiet form message. A route that refuses an ordinary Koreksi with it names it with `refusal`.
 */
const RULE_ERRORS: readonly ErrorClass<Error>[] = [
	CashCategoryNameTakenError,
	SystemCashCategoryError,
	OpeningBalanceAfterEarliestCashTransactionError,
	OpeningBalanceAlreadyRecordedError,
	PeriodLockedError,
	PeriodRuleError,
	CashRuleError,
	CashTransactionAlreadyCorrectedError,
	ComplaintAttachmentRuleError,
	ComplaintRuleError,
	ComplaintReplyRuleError,
	ComplaintTransitionError,
	ReleaseRuleError,
	RefundRuleError,
	ExemptionActorNotRegisteredError,
	ExemptionDateOrderError,
	ExemptionOverlapError,
	VoidRefusedAllocatedError,
	VoidRuleError,
	PaymentRuleError,
	DuesRateConflictError,
	DuesRateInUseError,
	VerificationRuleError,
	ImportRejectedError,
	EmptyImportFileError,
	ImportHeaderError,
	ImportTooLargeError,
	InvitationEmailAlreadyRegisteredError,
	InvitationExpiredError,
	InvitationUsedError,
	OccupancyDateOrderError,
	OccupancyEndOverlapError,
	OccupancyOverlapError,
	PrimaryOccupantAlreadyEndedError,
	PrimaryOccupantNotStartedError,
	PostRuleError,
	PostTransitionError,
	RegistrationAccountMissingError,
	RegistrationAlreadyDecidedError,
	ReportRuleError,
	MandatorySubscriptionKindError,
	UnitConflictError
];

/**
 * The category `caught` declares, or `undefined` when it declares none, which a route treats as a
 * bug and rethrows. See this module's doc comment for where each answer comes from.
 */
export function errorCategoryOf(caught: unknown): ErrorCategory | undefined {
	if (caught instanceof PermissionDeniedError) {
		return ERROR_CATEGORY.forbidden;
	}
	if (caught instanceof NotFoundError || isInstanceOfAny(caught, NOT_FOUND_ERRORS)) {
		return ERROR_CATEGORY.notFound;
	}
	if (caught instanceof RuleViolationError || isInstanceOfAny(caught, RULE_ERRORS)) {
		return ERROR_CATEGORY.rule;
	}
	return undefined;
}

/** Whether `caught` is an instance of any class in `classes`, subclasses included. */
function isInstanceOfAny(caught: unknown, classes: readonly ErrorClass<Error>[]): boolean {
	return classes.some((errorClass) => caught instanceof errorClass);
}

/** Whether `caught` is SvelteKit's own answer, thrown by `error()` or `redirect()`. */
function isSvelteKitOutcome(caught: unknown): boolean {
	return isHttpError(caught) || isRedirect(caught);
}

/**
 * Turns what a `load` caught into the route's error page, or rethrows it. Always throws: the return
 * type is `never`, so it can end a `catch` block without widening what SvelteKit infers.
 *
 * A permission refusal is a 403 with `messages.forbidden`. A not-found is a 404 with
 * `messages.notFound` when the route has one. Everything else, rule violations included, is
 * rethrown as it was: a `load` has no form to put a sentence on.
 */
export function throwRouteError(caught: unknown, messages: PageMessages): never {
	if (isSvelteKitOutcome(caught)) {
		throw caught;
	}
	const category = errorCategoryOf(caught);
	if (category === ERROR_CATEGORY.forbidden) {
		throw error(403, messages.forbidden());
	}
	if (category === ERROR_CATEGORY.notFound && messages.notFound) {
		throw error(404, messages.notFound());
	}
	throw caught;
}

/** What every rejected form this module builds carries. */
export interface FormFailure {
	readonly message: string;
}

/**
 * Turns what a form action caught into a rejected form, or throws the route's error page, or
 * rethrows it. See the six steps in this module's doc comment.
 *
 * `extra` travels on every `fail(400)` this call returns, beside `message`: a form that refills what
 * was typed passes `{ values }`. It never reaches a 403 or a 404.
 *
 * **Always `return` it** (`return failOrThrow(caught, …)`). A rejected form is a value this call
 * returns, not something it throws, so a call whose result is discarded lets the action fall
 * through to whatever follows the `catch`: on a route whose success `return` comes after the `try`,
 * that is the success message for a request that was refused. A `catch` that should only ever throw
 * (403, 404, or the error itself) calls `throwRouteError` instead.
 */
export function failOrThrow(caught: unknown, messages: FormMessages): ActionFailure<FormFailure>;
export function failOrThrow<Extra extends object & { readonly message?: never }>(
	caught: unknown,
	messages: FormMessages,
	extra: Extra
): ActionFailure<FormFailure & Extra>;
export function failOrThrow(
	caught: unknown,
	messages: FormMessages,
	extra: object = {}
): ActionFailure<FormFailure> {
	if (isSvelteKitOutcome(caught)) {
		throw caught;
	}
	const category = errorCategoryOf(caught);
	if (category === ERROR_CATEGORY.forbidden) {
		throw error(403, messages.forbidden());
	}
	for (const named of messages.refusals ?? []) {
		const message = named.messageFor(caught);
		if (message !== undefined) {
			return fail(400, { ...extra, message });
		}
	}
	if (category === ERROR_CATEGORY.notFound && messages.notFound) {
		throw error(404, messages.notFound());
	}
	if (category === ERROR_CATEGORY.notFound || category === ERROR_CATEGORY.rule) {
		return fail(400, { ...extra, message: messages.fallback() });
	}
	throw caught;
}

/** The signed-in account `locals` carries, once `requireUser` has let the request through. */
export type SignedInUser = NonNullable<App.Locals['user']>;

/**
 * The session guard: the signed-in account, or a 303 to the login page when nobody is signed in.
 *
 * Every `load` and every action of a signed-in screen calls this first. It is the experience, not
 * the authorisation: whether this account may do what it asked is still `requirePermission`'s
 * answer inside the service, which is why a guard that let someone through could never grant a
 * right by itself.
 */
export function requireUser(locals: Pick<App.Locals, 'user'>): SignedInUser {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}
	return locals.user;
}

/**
 * A route param that has to be a `uuid`, or a 404 with the route's `notFound` sentence, before it
 * reaches a query comparing it to a `uuid` column, where it would be a 500 (#111 and
 * `src/lib/server/services/identifier.ts`). A malformed id and an unused one read the same page,
 * because the route hands both the same sentence.
 */
export function requireUuidParam(value: string, messages: Required<PageMessages>): string {
	if (!isUuid(value)) {
		throw error(404, messages.notFound());
	}
	return value;
}

/** The adapters a route hands to a service in the running application. */
export interface RouteDependencies {
	/** The application database, `database()`. */
	readonly db: Database;
	/** The wall clock, `systemClock`. */
	readonly clock: Clock;
	/**
	 * The file store, built from `FILE_STORE_ROOT` and `FILE_STORE_SECRET` each time it is read,
	 * as every route built its own before. Reading it throws, naming the variable, when the secret is
	 * missing or too short.
	 */
	readonly fileStore: FileStore;
}

/**
 * The production adapters, each built only when a route reads it: nothing here opens a pool or
 * reads the environment until then. Call it inside a `load` or an action, never at module scope,
 * where destructuring `db` would build the pool while `vite build` imports the route.
 */
export function productionDependencies(): RouteDependencies {
	return {
		get db() {
			return database();
		},
		clock: systemClock,
		get fileStore() {
			return localFileStoreFromEnvironment(systemClock);
		}
	};
}

/**
 * A text field, trimmed, or `''` when the form did not post it: `String(form.get(field) ?? '')`,
 * the read every action wrote by hand. A file posted under a text field's name reads as its
 * `String()`, exactly as it did before.
 */
export function readText(form: FormData, field: string): string {
	return String(form.get(field) ?? '').trim();
}

/** A text field that may be left empty: trimmed, or `null` when nothing but spacing was posted. */
export function readOptionalText(form: FormData, field: string): string | null {
	const text = readText(form, field);
	return text === '' ? null : text;
}

/**
 * A money field as `Rupiah`, or `undefined` when the text is not a whole-rupiah amount: empty,
 * holding a letter, or a fraction such as `150,50`, which `parseRupiah` rejects rather than rounds.
 * The route answers `undefined` with its own invalid-amount sentence.
 */
export function readRupiah(form: FormData, field: string): Rupiah | undefined {
	try {
		return parseRupiah(String(form.get(field) ?? ''));
	} catch (caught) {
		if (caught instanceof TypeError || caught instanceof RangeError) {
			return undefined;
		}
		throw caught;
	}
}
