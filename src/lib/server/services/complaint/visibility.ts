import { eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { ACTION, isAllowed, rolesOf, type DatabaseWriter } from '../../authz';
import {
	COMPLAINT_VISIBILITY,
	complaints,
	type ComplaintVisibility
} from '../../db/schema/complaint';
import { residents } from '../../db/schema/resident';

/**
 * **Which Keluhan a person may read, expressed as data a query can be built from.**
 *
 * `docs/spec-keluhan-v1.md` asks for exactly one of these: "Penyaringan itu ada di satu fungsi yang
 * dipakai semua jalur baca." Every read path in this feature — the admin queue, a resident's own
 * list, one complaint fetched by the id in a URL, and the status history behind it — goes through
 * `complaintReadScopeFor` and then puts `complaintScopeFilter` into its `where`. No read path
 * decides for itself, and none of them filters rows in memory after the query has already returned
 * them.
 *
 * ## The shape, and why it is this one
 *
 * `src/lib/server/services/occupancy/visibility.ts` settled this shape for Unit history and the
 * reasoning transfers whole, so this module follows it deliberately rather than inventing a second
 * idea of what a visibility answer looks like. `ComplaintReadScope` has exactly **two** cases:
 *
 * - `{ kind: 'all' }` — no restriction at all, for whoever holds `ACTION.readAllComplaints`.
 * - `{ kind: 'limited', visibilities, reporterIds }` — complaints whose `visibility` is one of
 *   `visibilities` whoever reported them, plus every complaint reported by one of `reporterIds`
 *   whatever its visibility.
 *
 * **There is no third case for "sees nothing", and there must not be one.** A `limited` scope with
 * both lists empty *is* "sees nothing", and it is the honest answer for a viewer who is not signed
 * in. One case fewer is one case fewer for a caller to forget, and the case a caller forgets is
 * always the one that should have shown less. `COMPLAINT_SCOPE_NONE` names that value so a caller
 * can compare against it without knowing how it is built.
 *
 * Two shapes were rejected on the way here:
 *
 * - **A boolean `mayRead(viewer, complaintId)`.** Enough for one row and useless for a list: the
 *   admin queue and a resident's own list both need a `where`, and asking a predicate once per
 *   candidate row means reading every complaint in the table first — which is the leak, not the
 *   protection.
 * - **A nullable filter that callers `and()` together.** `undefined` composes silently in Drizzle,
 *   which is exactly why it is the wrong thing to return for "this person may see nothing":
 *   `complaintScopeFilter` returns `undefined` only for `{ kind: 'all' }` and a never-true condition
 *   for an empty `limited` scope, never a missing clause. That is the same rule
 *   `visibilityDateFilter` states for occupancies, and for the same reason — the difference between
 *   those two answers is a whole table handed to somebody entitled to none of it.
 *
 * ## Who sees what, and where each line comes from
 *
 * - **Signed out: nothing.** The spec is explicit that a `umum` complaint "bisa dibaca setiap warga
 *   yang sudah masuk, tetapi tidak pernah publik tanpa akun". A `null` viewer is answered without
 *   touching the database, so there is no query for a missing session to accidentally widen.
 * - **Signed in: every `public` complaint.** The line the spec draws is between signed in and signed
 *   out, not between an admitted Warga and an account still waiting for its `residents` row. An
 *   account with no `residents` row therefore reads the public board and nothing else, which is
 *   also all it could own: it has reported nothing, because `complaints.reporterId` names a
 *   `residents` row.
 * - **Signed in: every complaint you reported**, whatever its visibility — story 4, "melihat daftar
 *   keluhan saya sendiri". This is the "only their own row" rule, and it is deliberately *not* a
 *   permission action: every Warga holds it for their own rows, so an entry in `PERMISSIONS` would
 *   be an entry every account matches. It is expressed here as data instead, which is what lets the
 *   same rule reach SQL.
 * - **`ACTION.readAllComplaints`: everything.** Admin and superuser; the argument for that pair is
 *   recorded next to `PERMISSIONS` in `src/lib/server/authz.ts`.
 *
 * Note which question this module does *not* answer. It says what a person may read; it never says
 * what they may change. Reading every complaint and handling one are two actions, and
 * `ACTION.handleComplaints` is the other one.
 */

/** The `kind` of a scope with no restriction. */
const SCOPE_ALL = 'all';

/** The `kind` of a scope built from what the viewer is entitled to. */
const SCOPE_LIMITED = 'limited';

/**
 * What a viewer may read of the complaint board. Two cases; see this module's doc comment.
 *
 * Both lists in the `limited` case are "or"ed together, never "and"ed: a complaint is readable when
 * its visibility is one the viewer may read *or* they reported it.
 */
export type ComplaintReadScope =
	| { readonly kind: typeof SCOPE_ALL }
	| {
			readonly kind: typeof SCOPE_LIMITED;
			/** Complaints carrying one of these visibility values, whoever reported them. */
			readonly visibilities: readonly ComplaintVisibility[];
			/** Every complaint reported by one of these `residents.id`, whatever its visibility. */
			readonly reporterIds: readonly string[];
	  };

/** Every complaint there is. The answer for a holder of `ACTION.readAllComplaints`. */
export const COMPLAINT_SCOPE_ALL: ComplaintReadScope = Object.freeze({ kind: SCOPE_ALL });

/**
 * No complaint at all — the answer for a viewer who is not signed in.
 *
 * A `limited` scope with nothing in either list, not a case of its own. See this module's doc
 * comment for why there is no third case.
 */
export const COMPLAINT_SCOPE_NONE: ComplaintReadScope = Object.freeze({
	kind: SCOPE_LIMITED,
	visibilities: Object.freeze([]),
	reporterIds: Object.freeze([])
});

/**
 * What `viewerUserId` may read.
 *
 * @param viewerUserId the signed-in account — a `user.id`, not a `residents.id` — or `null` when
 *   nobody is signed in.
 *
 * This function reads; it never refuses. "You may see nothing here" and "you may not ask" are
 * different answers and only the second one is a 403, the same division `unitVisibilityFor`
 * records.
 */
export async function complaintReadScopeFor(
	db: DatabaseWriter,
	viewerUserId: string | null
): Promise<ComplaintReadScope> {
	if (!viewerUserId) {
		return COMPLAINT_SCOPE_NONE;
	}

	const roles = await rolesOf(db, viewerUserId);
	if (isAllowed(roles, ACTION.readAllComplaints)) {
		return COMPLAINT_SCOPE_ALL;
	}

	const reporterId = await reporterIdForUser(db, viewerUserId);
	return {
		kind: SCOPE_LIMITED,
		visibilities: [COMPLAINT_VISIBILITY.public],
		reporterIds: reporterId ? [reporterId] : []
	};
}

/**
 * `scope` as a condition on `complaints`, for a query that must not read what the viewer may not
 * see.
 *
 * ```ts
 * const rows = await db
 *   .select()
 *   .from(complaints)
 *   .where(and(eq(complaints.id, complaintId), complaintScopeFilter(scope)));
 * ```
 *
 * `undefined` — which Drizzle's `and()` drops — for `{ kind: 'all' }`, and **only** for that case.
 * An empty `limited` scope becomes a condition that matches nothing, never a missing clause.
 */
export function complaintScopeFilter(scope: ComplaintReadScope): SQL | undefined {
	if (scope.kind === SCOPE_ALL) {
		return undefined;
	}

	const conditions: SQL[] = [];
	if (scope.visibilities.length > 0) {
		conditions.push(inArray(complaints.visibility, [...scope.visibilities]));
	}
	if (scope.reporterIds.length > 0) {
		conditions.push(inArray(complaints.reporterId, [...scope.reporterIds]));
	}

	if (conditions.length === 0) {
		return sql`false`;
	}
	// `or()` only widens to `undefined` when every argument is, and none of these is.
	return or(...conditions) as SQL;
}

/** The parts of a complaint that decide whether it may be read. */
export interface ComplaintReadSubject {
	readonly visibility: ComplaintVisibility;
	/** The `residents.id` that reported it. */
	readonly reporterId: string;
}

/**
 * Whether `scope` covers `complaint`, for a caller that already holds the row — after an `update
 * … returning`, say, where there was never a `select` to put a filter on.
 *
 * The same rule `complaintScopeFilter` pushes into SQL, and
 * `tests/unit/complaint-visibility.test.ts` asserts the two agree over every combination of role,
 * ownership and visibility rather than trusting that they do. **A read path chooses the filter, not
 * this** — deciding in memory means the rows were already fetched.
 */
export function mayReadComplaint(
	scope: ComplaintReadScope,
	complaint: ComplaintReadSubject
): boolean {
	if (scope.kind === SCOPE_ALL) {
		return true;
	}
	return (
		scope.visibilities.includes(complaint.visibility) ||
		scope.reporterIds.includes(complaint.reporterId)
	);
}

/** The `residents` row belonging to a signed-in account, or `undefined` when it has none. */
export async function reporterIdForUser(
	db: DatabaseWriter,
	userId: string
): Promise<string | undefined> {
	const [row] = await db
		.select({ id: residents.id })
		.from(residents)
		.where(eq(residents.userId, userId))
		.limit(1);
	return row?.id;
}
