/**
 * The old home of Pelepasan Alokasi, which #324 moved into the dues-correction module,
 * `./dues-correction.ts`, together with Pembatalan Tagihan and Pengembalian. Everything this file
 * used to export is re-exported here unchanged, the same objects, because
 * `src/lib/server/route-action.ts` and `tests/unit/route-action.test.ts` import the error classes
 * from this path and neither is in #324's surface. New code imports from `./dues-correction.ts`.
 */
export {
	ALLOCATION_RELEASED_ACTION,
	AllocationNotFoundError,
	RELEASE_RULE,
	ReleaseRuleError,
	releaseAllocation,
	type ReleaseAllocationRequest,
	type ReleaseRule
} from './dues-correction';
