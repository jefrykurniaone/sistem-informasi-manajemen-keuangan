/**
 * The old home of Pembatalan Tagihan, which #324 moved into the dues-correction module,
 * `./dues-correction.ts`, together with Pelepasan Alokasi and Pengembalian. Everything this file
 * used to export is re-exported here unchanged, the same objects, because
 * `src/lib/server/route-action.ts` and `tests/unit/route-action.test.ts` import the error classes
 * from this path and neither is in #324's surface. New code imports from `./dues-correction.ts`.
 */
export {
	INVOICE_VOIDED_ACTION,
	InvoiceNotFoundError,
	VOID_RULE,
	VoidRefusedAllocatedError,
	VoidRuleError,
	voidInvoice,
	type BlockingAllocation,
	type VoidInvoiceRequest,
	type VoidRule
} from './dues-correction';
