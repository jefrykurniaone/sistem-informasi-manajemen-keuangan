import { readdirSync } from 'node:fs';
import path from 'node:path';
import { error, isActionFailure, isHttpError, isRedirect, redirect } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';
import * as m from '#lib/paraglide/messages.js';
import {
	ERROR_CATEGORY,
	LastSuperuserError,
	NotFoundError,
	PermissionDeniedError,
	RuleViolationError,
	type ErrorCategory
} from '#lib/errors.ts';
import { rupiah } from '#lib/money.ts';
import { PERIOD_STATUS } from '#lib/server/db/schema/period.ts';
import { systemClock } from '#lib/server/ports/clock.ts';
import { SIGNED_LINK_BASE_PATH } from '#lib/server/ports/file-store.ts';
import {
	errorCategoryOf,
	failOrThrow,
	productionDependencies,
	readOptionalText,
	readRupiah,
	readText,
	refusal,
	requireUser,
	requireUuidParam,
	throwRouteError,
	type FormMessages,
	type PageMessages,
	type SignedInUser
} from '#lib/server/route-action.ts';
import {
	CashCategoryNameTakenError,
	CashCategoryNotFoundError,
	SystemCashCategoryError,
	SystemCategoryMissingError
} from '#lib/server/services/cash/category.ts';
import { OpeningBalanceAlreadyRecordedError } from '#lib/server/services/cash/opening-balance.ts';
import { PeriodLockedError, PeriodRuleError } from '#lib/server/services/cash/period.ts';
import {
	CashCorrectionTargetError,
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
import { NoDuesRateError } from '#lib/server/services/dues/issuance.ts';
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
import * as cashCategoriesRoute from '../../src/routes/(app)/admin/cash-categories/+page.server';
import * as periodsRoute from '../../src/routes/(app)/admin/periods/+page.server';

/**
 * `src/lib/server/route-action.ts` (#318, spec #310): the session guard, the mapping from a domain
 * error to a route's answer, the production dependencies and the form field readers. No database:
 * the mapping is a pure function of the error and the route's sentences, which is the point of
 * putting it in one module, and the two pilot routes are driven only down the paths that end before
 * a service is called.
 *
 * The sentences in the mapping tests are plain strings rather than Paraglide messages, so that every
 * assertion on a sentence also proves the module said the route's sentence and wrote none of its
 * own.
 */

/** What a route did with a request, flattened so a table can compare it. */
type Outcome =
	| { readonly kind: 'page'; readonly status: number; readonly message: string }
	| { readonly kind: 'redirect'; readonly status: number; readonly location: string }
	| { readonly kind: 'form'; readonly status: number; readonly data: unknown }
	| { readonly kind: 'rethrown'; readonly thrown: unknown }
	| { readonly kind: 'returned'; readonly value: unknown };

/** The outcome of something that answers synchronously. */
function outcomeOf(run: () => unknown): Outcome {
	try {
		return outcomeOfReturned(run());
	} catch (thrown) {
		return outcomeOfThrown(thrown);
	}
}

/** The outcome of something that answers through a promise: a `load` or an action. */
async function settledOutcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
	try {
		return outcomeOfReturned(await run());
	} catch (thrown) {
		return outcomeOfThrown(thrown);
	}
}

function outcomeOfReturned(value: unknown): Outcome {
	if (isActionFailure(value)) {
		return { kind: 'form', status: value.status, data: value.data };
	}
	return { kind: 'returned', value };
}

function outcomeOfThrown(thrown: unknown): Outcome {
	if (isHttpError(thrown)) {
		return { kind: 'page', status: thrown.status, message: thrown.body.message };
	}
	if (isRedirect(thrown)) {
		return { kind: 'redirect', status: thrown.status, location: thrown.location };
	}
	return { kind: 'rethrown', thrown };
}

const FORBIDDEN = 'kalimat 403 milik route';
const NOT_FOUND = 'kalimat 404 milik route';
const FALLBACK = 'kalimat form milik route';
const NAMED = 'kalimat yang dinamai aksi';

const PAGE: PageMessages = { forbidden: () => FORBIDDEN, notFound: () => NOT_FOUND };
const PAGE_WITHOUT_404: PageMessages = { forbidden: () => FORBIDDEN };
const FORM: FormMessages = { ...PAGE, fallback: () => FALLBACK };
const FORM_WITHOUT_404: FormMessages = { ...PAGE_WITHOUT_404, fallback: () => FALLBACK };

/** Error classes written after the module, the way a later ticket writes one. */
class FreshRuleError extends RuleViolationError {
	override readonly name = 'FreshRuleError';
}
class FreshNotFoundError extends NotFoundError {
	override readonly name = 'FreshNotFoundError';
}
/** A class that declares no category: a bug, as far as a route can tell. */
class FreshUncategorisedError extends Error {
	override readonly name = 'FreshUncategorisedError';
}

/** A Periode row as `requireOpenPeriodFor` reads it, locked. */
const LOCKED_OCTOBER = {
	id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
	year: 2026,
	month: 10,
	status: PERIOD_STATUS.locked,
	createdAt: new Date(Date.UTC(2026, 9, 1))
};

describe('the mapping table, one row per category', () => {
	const unknown = new FreshUncategorisedError('a real defect');
	const bug = new TypeError("Cannot read properties of undefined (reading 'id')");

	it.each([
		{
			name: 'a permission refusal is a 403 with the route’s sentence',
			caught: new PermissionDeniedError('user-1', 'manageCashCategories'),
			messages: PAGE,
			expected: { kind: 'page', status: 403, message: FORBIDDEN }
		},
		{
			name: 'a not-found is a 404 with the route’s sentence',
			caught: new FreshNotFoundError('missing'),
			messages: PAGE,
			expected: { kind: 'page', status: 404, message: NOT_FOUND }
		},
		{
			name: 'a not-found on a page with no 404 sentence is rethrown, as it was',
			caught: new FreshNotFoundError('missing'),
			messages: PAGE_WITHOUT_404,
			expected: 'rethrown'
		},
		{
			name: 'a rule violation is rethrown, because a load has no form',
			caught: new FreshRuleError('broken'),
			messages: PAGE,
			expected: 'rethrown'
		},
		{
			name: 'an error that declares no category is rethrown',
			caught: unknown,
			messages: PAGE,
			expected: 'rethrown'
		},
		{
			name: 'a TypeError is rethrown',
			caught: bug,
			messages: PAGE,
			expected: 'rethrown'
		}
	])('throwRouteError: $name', ({ caught, messages, expected }) => {
		const outcome = outcomeOf(() => throwRouteError(caught, messages));

		if (expected === 'rethrown') {
			expect(outcome.kind === 'rethrown' && outcome.thrown).toBe(caught);
		} else {
			expect(outcome).toEqual(expected);
		}
	});

	it.each([
		{
			name: 'a permission refusal is a 403 with the route’s sentence',
			caught: new PermissionDeniedError('user-1', 'manageCashCategories'),
			messages: FORM,
			expected: { kind: 'page', status: 403, message: FORBIDDEN }
		},
		{
			name: 'a not-found the action did not name is a 404 with the route’s sentence',
			caught: new FreshNotFoundError('missing'),
			messages: FORM,
			expected: { kind: 'page', status: 404, message: NOT_FOUND }
		},
		{
			name: 'a not-found on a route with no 404 sentence is a rejected form',
			caught: new FreshNotFoundError('missing'),
			messages: FORM_WITHOUT_404,
			expected: { kind: 'form', status: 400, data: { message: FALLBACK } }
		},
		{
			name: 'a rule violation the action did not name is a rejected form',
			caught: new FreshRuleError('broken'),
			messages: FORM,
			expected: { kind: 'form', status: 400, data: { message: FALLBACK } }
		},
		{
			name: 'a class the action named is a rejected form with its own sentence',
			caught: new FreshRuleError('broken'),
			messages: { ...FORM, refusals: [refusal(FreshRuleError, () => NAMED)] },
			expected: { kind: 'form', status: 400, data: { message: NAMED } }
		},
		{
			name: 'a not-found the action named is a rejected form, not a 404',
			caught: new FreshNotFoundError('stale id'),
			messages: { ...FORM, refusals: [refusal(FreshNotFoundError, () => NAMED)] },
			expected: { kind: 'form', status: 400, data: { message: NAMED } }
		},
		{
			name: 'an uncategorised class the action named is a rejected form',
			caught: new TypeError('A cash category needs a non-empty name.'),
			messages: { ...FORM, refusals: [refusal(TypeError, () => NAMED)] },
			expected: { kind: 'form', status: 400, data: { message: NAMED } }
		},
		{
			name: 'an error that declares no category is rethrown',
			caught: unknown,
			messages: FORM,
			expected: 'rethrown'
		},
		{
			name: 'a TypeError the action did not name is rethrown',
			caught: bug,
			messages: { ...FORM, refusals: [refusal(FreshRuleError, () => NAMED)] },
			expected: 'rethrown'
		},
		{
			name: 'something thrown that is not an Error is rethrown',
			caught: 'not an error',
			messages: FORM,
			expected: 'rethrown'
		}
	])('failOrThrow: $name', ({ caught, messages, expected }) => {
		const outcome = outcomeOf(() => failOrThrow(caught, messages));

		if (expected === 'rethrown') {
			expect(outcome.kind === 'rethrown' && outcome.thrown).toBe(caught);
		} else {
			expect(outcome).toEqual(expected);
		}
	});
});

describe('a new error class is handled without editing the route', () => {
	/**
	 * A route's sentences as it would declare them today: nothing in here knows the two classes
	 * below, which stand for an error a later ticket adds to a service.
	 */
	const ROUTE: FormMessages = {
		...FORM,
		refusals: [refusal(CashCategoryNameTakenError, () => NAMED)]
	};

	class LaterRuleError extends RuleViolationError {
		override readonly name = 'LaterRuleError';
	}
	class LaterNotFoundError extends NotFoundError {
		override readonly name = 'LaterNotFoundError';
	}

	it('answers a new rule violation on the form, with the route’s own fallback sentence', () => {
		expect(outcomeOf(() => failOrThrow(new LaterRuleError('x'), ROUTE))).toEqual({
			kind: 'form',
			status: 400,
			data: { message: FALLBACK }
		});
	});

	it('answers a new not-found with the route’s 404 page, in an action and in a load', () => {
		const expected = { kind: 'page', status: 404, message: NOT_FOUND };

		expect(outcomeOf(() => failOrThrow(new LaterNotFoundError('x'), ROUTE))).toEqual(expected);
		expect(outcomeOf(() => throwRouteError(new LaterNotFoundError('x'), PAGE))).toEqual(expected);
	});

	it('still rethrows a new class that declares nothing', () => {
		const caught = new FreshUncategorisedError('x');
		const outcome = outcomeOf(() => failOrThrow(caught, ROUTE));

		expect(outcome.kind === 'rethrown' && outcome.thrown).toBe(caught);
	});
});

describe('the locked Periode regression (cb96a8c, #97)', () => {
	const locked = new PeriodLockedError('2026-10-15', LOCKED_OCTOBER);

	it('is a rejected form, not a 500, on an action that names only the cash rules', () => {
		// The shape `/admin/cash/new` had before cb96a8c: it named `CashRuleError` and nothing else,
		// so a locked month escaped its translator and reached the admin as a 500.
		const cashNewBefore97: FormMessages = {
			...FORM,
			refusals: [refusal(CashRuleError, () => NAMED)]
		};

		expect(outcomeOf(() => failOrThrow(locked, cashNewBefore97))).toEqual({
			kind: 'form',
			status: 400,
			data: { message: FALLBACK }
		});
	});

	it('carries the route’s own sentence, with the month, when the action names it', () => {
		const cashBook: FormMessages = {
			...FORM,
			refusals: [
				refusal(PeriodLockedError, ({ error }) =>
					m.adminCash_periodLocked({ period: error.period })
				)
			]
		};

		expect(outcomeOf(() => failOrThrow(locked, cashBook))).toEqual({
			kind: 'form',
			status: 400,
			data: { message: m.adminCash_periodLocked({ period: '2026-10' }) }
		});
	});

	it('is still rethrown from a load, which has no form to put it on', () => {
		const outcome = outcomeOf(() => throwRouteError(locked, PAGE));

		expect(outcome.kind === 'rethrown' && outcome.thrown).toBe(locked);
	});
});

describe('the order of the mapping', () => {
	it('answers a permission refusal with a 403 before anything the action named', () => {
		const messages: FormMessages = {
			...FORM,
			refusals: [refusal(RuleViolationError, () => NAMED), refusal(TypeError, () => NAMED)]
		};

		expect(
			outcomeOf(() => failOrThrow(new PermissionDeniedError('user-1', 'unlockPeriods'), messages))
		).toEqual({ kind: 'page', status: 403, message: FORBIDDEN });
	});

	it('refuses to name Error itself, or a permission refusal, as a form message', () => {
		class NarrowerPermissionDeniedError extends PermissionDeniedError {}

		expect(() => refusal(Error, () => NAMED)).toThrow(TypeError);
		expect(() => refusal(PermissionDeniedError, () => NAMED)).toThrow(TypeError);
		expect(() => refusal(NarrowerPermissionDeniedError, () => NAMED)).toThrow(TypeError);
	});

	it('rethrows a SvelteKit error or redirect untouched, past every refusal the action named', () => {
		const messages: FormMessages = {
			...FORM,
			refusals: [refusal(RuleViolationError, () => NAMED), refusal(TypeError, () => NAMED)]
		};
		const answered = thrownBy(() => error(404, 'sudah dijawab'));
		const sent = thrownBy(() => redirect(303, '/login'));

		for (const thrown of [answered, sent]) {
			expect(thrownBy(() => failOrThrow(thrown, messages))).toBe(thrown);
			expect(thrownBy(() => throwRouteError(thrown, PAGE))).toBe(thrown);
		}
	});

	it('takes the first refusal that matches, so a narrower class is listed before a wider one', () => {
		const messages: FormMessages = {
			...FORM,
			refusals: [
				refusal(FreshRuleError, () => 'sempit'),
				refusal(RuleViolationError, () => 'lebar')
			]
		};

		expect(outcomeOf(() => failOrThrow(new FreshRuleError('x'), messages))).toEqual({
			kind: 'form',
			status: 400,
			data: { message: 'sempit' }
		});
		expect(outcomeOf(() => failOrThrow(new LastSuperuserError('user-1'), messages))).toEqual({
			kind: 'form',
			status: 400,
			data: { message: 'lebar' }
		});
	});

	it('hands a refusal the error itself, typed as the class it named', () => {
		const messages: FormMessages = {
			...FORM,
			refusals: [
				refusal(CashCategoryNameTakenError, ({ error }) => `sudah ada: ${error.categoryName}`)
			]
		};

		expect(
			outcomeOf(() => failOrThrow(new CashCategoryNameTakenError('Kas kecil'), messages))
		).toEqual({ kind: 'form', status: 400, data: { message: 'sudah ada: Kas kecil' } });
	});

	it('carries extra form data on a rejected form, and never onto a 403', () => {
		const values = { unitId: 'u', amount: '150.000', receivedOn: '2026-10-15' };

		expect(outcomeOf(() => failOrThrow(new FreshRuleError('x'), FORM, { values }))).toEqual({
			kind: 'form',
			status: 400,
			data: { values, message: FALLBACK }
		});
		expect(
			outcomeOf(() =>
				failOrThrow(new PermissionDeniedError('user-1', 'verifyPayments'), FORM, { values })
			)
		).toEqual({ kind: 'page', status: 403, message: FORBIDDEN });
	});

	it('reads a route’s sentence only when it is said', () => {
		let read = 0;
		const counting: FormMessages = {
			forbidden: () => {
				read += 1;
				return FORBIDDEN;
			},
			fallback: () => {
				read += 1;
				return FALLBACK;
			}
		};

		outcomeOf(() => failOrThrow(new FreshRuleError('x'), counting));

		expect(read).toBe(1);
	});
});

/** What `run` threw. Fails the test when it threw nothing. */
function thrownBy(run: () => unknown): unknown {
	try {
		run();
	} catch (thrown) {
		return thrown;
	}
	throw new Error('expected a throw');
}

describe('errorCategoryOf', () => {
	/**
	 * Every error class a screen can be refused with, and the category it declares. Written out
	 * here a second time, on purpose: the list in the module is the implementation, this one is the
	 * decision, and a class moved from one category to another changes a screen's answer.
	 */
	const EXPECTED: readonly (readonly [abstract new (...args: never[]) => Error, ErrorCategory])[] =
		[
			[PermissionDeniedError, ERROR_CATEGORY.forbidden],
			[LastSuperuserError, ERROR_CATEGORY.rule],

			[CashCategoryNotFoundError, ERROR_CATEGORY.notFound],
			[CashTransactionNotFoundError, ERROR_CATEGORY.notFound],
			[ComplaintNotFoundError, ERROR_CATEGORY.notFound],
			[AllocationNotFoundError, ERROR_CATEGORY.notFound],
			[ExemptionNotFoundError, ERROR_CATEGORY.notFound],
			[InvoiceNotFoundError, ERROR_CATEGORY.notFound],
			[DuesUnitNotFoundError, ERROR_CATEGORY.notFound],
			[DuesRateNotFoundError, ERROR_CATEGORY.notFound],
			[PaymentNotFoundError, ERROR_CATEGORY.notFound],
			[InvitationNotFoundError, ERROR_CATEGORY.notFound],
			[InvitationTokenUnknownError, ERROR_CATEGORY.notFound],
			[OccupancyNotFoundError, ERROR_CATEGORY.notFound],
			[ResidentNotFoundError, ERROR_CATEGORY.notFound],
			[PostNotFoundError, ERROR_CATEGORY.notFound],
			[RegistrationNotFoundError, ERROR_CATEGORY.notFound],
			[UnsubscribeTokenError, ERROR_CATEGORY.notFound],
			[UnitNotFoundError, ERROR_CATEGORY.notFound],

			[CashCategoryNameTakenError, ERROR_CATEGORY.rule],
			[SystemCashCategoryError, ERROR_CATEGORY.rule],
			[OpeningBalanceAlreadyRecordedError, ERROR_CATEGORY.rule],
			[PeriodLockedError, ERROR_CATEGORY.rule],
			[PeriodRuleError, ERROR_CATEGORY.rule],
			[CashCorrectionTargetError, ERROR_CATEGORY.rule],
			[CashRuleError, ERROR_CATEGORY.rule],
			[CashTransactionAlreadyCorrectedError, ERROR_CATEGORY.rule],
			[ComplaintAttachmentRuleError, ERROR_CATEGORY.rule],
			[ComplaintRuleError, ERROR_CATEGORY.rule],
			[ComplaintReplyRuleError, ERROR_CATEGORY.rule],
			[ComplaintTransitionError, ERROR_CATEGORY.rule],
			[ReleaseRuleError, ERROR_CATEGORY.rule],
			[RefundRuleError, ERROR_CATEGORY.rule],
			[ExemptionActorNotRegisteredError, ERROR_CATEGORY.rule],
			[ExemptionDateOrderError, ERROR_CATEGORY.rule],
			[ExemptionOverlapError, ERROR_CATEGORY.rule],
			[VoidRefusedAllocatedError, ERROR_CATEGORY.rule],
			[VoidRuleError, ERROR_CATEGORY.rule],
			[PaymentRuleError, ERROR_CATEGORY.rule],
			[DuesRateConflictError, ERROR_CATEGORY.rule],
			[DuesRateInUseError, ERROR_CATEGORY.rule],
			[VerificationRuleError, ERROR_CATEGORY.rule],
			[ImportRejectedError, ERROR_CATEGORY.rule],
			[EmptyImportFileError, ERROR_CATEGORY.rule],
			[ImportHeaderError, ERROR_CATEGORY.rule],
			[ImportTooLargeError, ERROR_CATEGORY.rule],
			[InvitationEmailAlreadyRegisteredError, ERROR_CATEGORY.rule],
			[InvitationExpiredError, ERROR_CATEGORY.rule],
			[InvitationUsedError, ERROR_CATEGORY.rule],
			[OccupancyDateOrderError, ERROR_CATEGORY.rule],
			[OccupancyEndOverlapError, ERROR_CATEGORY.rule],
			[OccupancyOverlapError, ERROR_CATEGORY.rule],
			[PrimaryOccupantAlreadyEndedError, ERROR_CATEGORY.rule],
			[PrimaryOccupantNotStartedError, ERROR_CATEGORY.rule],
			[PostRuleError, ERROR_CATEGORY.rule],
			[PostTransitionError, ERROR_CATEGORY.rule],
			[RegistrationAccountMissingError, ERROR_CATEGORY.rule],
			[RegistrationAlreadyDecidedError, ERROR_CATEGORY.rule],
			[ReportRuleError, ERROR_CATEGORY.rule],
			[MandatorySubscriptionKindError, ERROR_CATEGORY.rule],
			[UnitConflictError, ERROR_CATEGORY.rule]
		];

	it.each(
		EXPECTED.map(([errorClass, category]) => ({ name: errorClass.name, errorClass, category }))
	)('$name is $category', ({ errorClass, category }) => {
		// An instance without running the constructor: the category is a property of the class,
		// and each constructor here wants a different domain value to build.
		expect(errorCategoryOf(Object.create(errorClass.prototype))).toBe(category);
	});

	it('declares nothing for an error outside every list, nor for a value that is not an error', () => {
		expect(errorCategoryOf(new Error('x'))).toBeUndefined();
		expect(errorCategoryOf(new TypeError('x'))).toBeUndefined();
		expect(errorCategoryOf(new RangeError('x'))).toBeUndefined();
		expect(errorCategoryOf(new FreshUncategorisedError('x'))).toBeUndefined();
		expect(errorCategoryOf('PermissionDeniedError')).toBeUndefined();
		expect(errorCategoryOf({ name: 'PeriodLockedError' })).toBeUndefined();
		expect(errorCategoryOf(undefined)).toBeUndefined();
	});
});

describe('every error class a service exports declares a category', () => {
	/**
	 * The exported error classes that are deliberately left without a category, and why. A route
	 * rethrows each of them, which is right for a defect: a screen must not dress it up as a refusal.
	 */
	const DELIBERATELY_UNCATEGORISED: ReadonlyMap<unknown, string> = new Map<unknown, string>([
		[
			SystemCategoryMissingError,
			'a broken installation: the migration that seeds the system categories did not run'
		],
		[
			NoDuesRateError,
			'a failure of the issuance job, recorded in job_runs and shown on /admin/jobs, never thrown at a route'
		]
	]);

	const SERVICES = path.resolve(process.cwd(), 'src/lib/server/services');

	/** Every TypeScript module under `directory`, recursively. */
	function modulesUnder(directory: string): string[] {
		return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				return modulesUnder(full);
			}
			return entry.name.endsWith('.ts') ? [full] : [];
		});
	}

	it('extends RuleViolationError or NotFoundError, is listed in route-action.ts, or is listed here', async () => {
		const uncategorised: string[] = [];
		let seen = 0;
		for (const file of modulesUnder(SERVICES)) {
			const exported: Record<string, unknown> = await import(file);
			for (const [exportName, value] of Object.entries(exported)) {
				if (typeof value !== 'function' || !(value.prototype instanceof Error)) {
					continue;
				}
				seen += 1;
				if (DELIBERATELY_UNCATEGORISED.has(value)) {
					continue;
				}
				if (errorCategoryOf(Object.create(value.prototype)) === undefined) {
					uncategorised.push(`${exportName} in ${path.relative(process.cwd(), file)}`);
				}
			}
		}

		// The walk reached the services at all: the table above holds 59 of their classes, and the
		// two deliberate exceptions make 61 (a re-export counts again in each module that has it).
		expect(seen).toBeGreaterThanOrEqual(61);
		expect(uncategorised).toEqual([]);
	});

	it('keeps the deliberate exceptions uncategorised, so the list above stays true', () => {
		for (const errorClass of DELIBERATELY_UNCATEGORISED.keys()) {
			const prototype = (errorClass as { prototype: object }).prototype;
			expect(errorCategoryOf(Object.create(prototype))).toBeUndefined();
		}
	});
});

describe('requireUser', () => {
	it('sends a visitor nobody signed in as to the login page with a 303', () => {
		expect(outcomeOf(() => requireUser({ user: null }))).toEqual({
			kind: 'redirect',
			status: 303,
			location: '/login'
		});
	});

	it('hands back the signed-in account itself', () => {
		const user = { id: 'user-1', email: 'warga@komplek.local' } as SignedInUser;

		expect(requireUser({ user })).toBe(user);
	});
});

describe('requireUuidParam', () => {
	const messages = { forbidden: () => FORBIDDEN, notFound: () => NOT_FOUND };

	it('hands back an id shaped like a uuid', () => {
		expect(requireUuidParam('3f2504e0-4f89-41d3-9a0c-0305e82c3301', messages)).toBe(
			'3f2504e0-4f89-41d3-9a0c-0305e82c3301'
		);
	});

	it.each(['new', 'abc', '1', ''])(
		'answers %j with the route’s 404, the page an unused id gets',
		(value) => {
			expect(outcomeOf(() => requireUuidParam(value, messages))).toEqual({
				kind: 'page',
				status: 404,
				message: NOT_FOUND
			});
		}
	);
});

describe('the form field readers', () => {
	function formWith(fields: Record<string, string>): FormData {
		const form = new FormData();
		for (const [name, value] of Object.entries(fields)) {
			form.set(name, value);
		}
		return form;
	}

	it('reads a text field trimmed, and a missing one as the empty string', () => {
		const form = formWith({ name: '  Kas kecil \n', blank: '   ' });

		expect(readText(form, 'name')).toBe('Kas kecil');
		expect(readText(form, 'blank')).toBe('');
		expect(readText(form, 'missing')).toBe('');
	});

	it('reads an optional field as null when nothing but spacing was posted', () => {
		const form = formWith({ phone: ' 0812 3456 ', blank: ' \t ' });

		expect(readOptionalText(form, 'phone')).toBe('0812 3456');
		expect(readOptionalText(form, 'blank')).toBeNull();
		expect(readOptionalText(form, 'missing')).toBeNull();
	});

	it.each([
		{ text: '150000', expected: 150_000 },
		{ text: '150.000', expected: 150_000 },
		{ text: 'Rp 1.500.000', expected: 1_500_000 },
		{ text: '  2 500 000 ', expected: 2_500_000 },
		{ text: '-Rp 25.000', expected: -25_000 }
	])('reads $text as whole rupiah', ({ text, expected }) => {
		expect(readRupiah(formWith({ amount: text }), 'amount')).toBe(rupiah(expected));
	});

	it.each([
		{ name: 'a fraction with a decimal comma', text: '150,50' },
		{ name: 'a fraction with a decimal point', text: '150.5' },
		{ name: 'a fraction of a thousand', text: '1.5' },
		{ name: 'a word', text: 'seratus ribu' },
		{ name: 'an empty field', text: '' },
		{ name: 'a value past the safe range', text: '9007199254740993' }
	])('rejects $name rather than rounding it', ({ text }) => {
		expect(readRupiah(formWith({ amount: text }), 'amount')).toBeUndefined();
	});

	it('reads a missing money field as no amount', () => {
		expect(readRupiah(formWith({}), 'amount')).toBeUndefined();
	});
});

describe('productionDependencies', () => {
	const originalSecret = process.env.FILE_STORE_SECRET;

	afterEach(() => {
		if (originalSecret === undefined) {
			delete process.env.FILE_STORE_SECRET;
		} else {
			process.env.FILE_STORE_SECRET = originalSecret;
		}
	});

	// `db` is not read here: reading it builds the pool for DATABASE_URL, the development database,
	// which no test may point at. It is `database()` and nothing else.

	it('builds nothing until a route reads it, and hands out the wall clock', () => {
		delete process.env.FILE_STORE_SECRET;

		const dependencies = productionDependencies();

		expect(dependencies.clock).toBe(systemClock);
		expect(() => dependencies.fileStore).toThrow(/FILE_STORE_SECRET/);
	});

	it('builds the file store from the environment when a route reads it', async () => {
		process.env.FILE_STORE_SECRET = 'rahasia-uji-route-action-'.padEnd(40, 'x');

		const link = await productionDependencies().fileStore.signedLink('payments/p-1/proof.jpg');

		expect(link.startsWith(`${SIGNED_LINK_BASE_PATH}/payments/p-1/proof.jpg?`)).toBe(true);
	});
});

describe('the two pilot routes', () => {
	/** A route's load or action, whatever its generated event type. */
	type Handler = ((event: never) => unknown) | undefined;

	const SIGNED_IN = { id: 'user-1', email: 'superuser@komplek.local' } as SignedInUser;

	/** Runs `handler` the way SvelteKit would for a POST of `fields`, signed in as `user` or nobody. */
	function run(
		handler: Handler,
		user: SignedInUser | null,
		fields: Record<string, string> = {}
	): Promise<Outcome> {
		const body = new FormData();
		for (const [name, value] of Object.entries(fields)) {
			body.set(name, value);
		}
		const event = {
			locals: { user, session: null },
			request: new Request('http://localhost/admin', { method: 'POST', body }),
			url: new URL('http://localhost/admin')
		};
		return settledOutcomeOf(async () => {
			if (!handler) {
				throw new Error('no such handler');
			}
			return handler(event as never);
		});
	}

	const toLogin = { kind: 'redirect', status: 303, location: '/login' };

	it.each([
		{ name: 'the periods page', handler: periodsRoute.load },
		{ name: 'the periods unlock action', handler: periodsRoute.actions.unlock },
		{ name: 'the cash categories page', handler: cashCategoriesRoute.load },
		{ name: 'the cash categories create action', handler: cashCategoriesRoute.actions.create },
		{ name: 'the cash categories update action', handler: cashCategoriesRoute.actions.update },
		{
			name: 'the cash categories deactivate action',
			handler: cashCategoriesRoute.actions.deactivate
		},
		{
			name: 'the cash categories reactivate action',
			handler: cashCategoriesRoute.actions.reactivate
		}
	])('sends a visitor nobody signed in as from $name to the login page', async ({ handler }) => {
		expect(await run(handler as Handler, null, { reason: 'x', name: 'x', type: 'income' })).toEqual(
			toLogin
		);
	});

	it('answers an unlock with an empty reason with the same sentence as before', async () => {
		expect(
			await run(periodsRoute.actions.unlock as Handler, SIGNED_IN, {
				year: '2026',
				month: '10',
				reason: '   '
			})
		).toEqual({ kind: 'form', status: 400, data: { message: m.adminPeriods_invalidForm() } });
	});

	const emptyCategoryForms: readonly {
		readonly name: string;
		readonly action: 'create' | 'update' | 'deactivate' | 'reactivate';
		readonly fields: Record<string, string>;
	}[] = [
		{ name: 'create without a name', action: 'create', fields: { name: ' ', type: 'income' } },
		{
			name: 'update without a category',
			action: 'update',
			fields: { name: 'Kas', type: 'income' }
		},
		{ name: 'deactivate without a category', action: 'deactivate', fields: {} },
		{ name: 'reactivate without a category', action: 'reactivate', fields: { categoryId: '  ' } }
	];

	it.each(emptyCategoryForms)(
		'answers a cash category $name with the same sentence as before',
		async ({ action, fields }) => {
			expect(await run(cashCategoriesRoute.actions[action] as Handler, SIGNED_IN, fields)).toEqual({
				kind: 'form',
				status: 400,
				data: { message: m.adminCashCategories_invalidForm() }
			});
		}
	);
});
