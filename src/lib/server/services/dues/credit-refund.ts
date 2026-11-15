/**
 * The old home of Pengembalian, which #324 moved into the dues-correction module,
 * `./dues-correction.ts`, together with Pembatalan Tagihan and Pelepasan Alokasi. Everything this
 * file used to export is re-exported here unchanged, the same objects, because
 * `src/lib/server/route-action.ts` and `tests/unit/route-action.test.ts` import `RefundRuleError`
 * from this path and `tests/unit/unit-money-invariant.test.ts` imports `refundCredit` from it, and
 * none of the three is in #324's surface. New code imports from `./dues-correction.ts`.
 */
export {
	CREDIT_REFUNDED_ACTION,
	REFUND_RULE,
	RefundRuleError,
	refundCredit,
	type RefundCreditRequest,
	type RefundedPortion,
	type RefundOutcome,
	type RefundRule
} from './dues-correction';
