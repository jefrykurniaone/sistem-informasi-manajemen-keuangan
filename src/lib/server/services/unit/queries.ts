import { and, asc, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Database } from '../../db';
import { occupancies } from '../../db/schema/occupancy';
import { units, type Unit } from '../../db/schema/unit';
import { stillRunningOn } from '../occupancy/visibility';

/**
 * Raw reads against `units` and `occupancies`, with no permission decision in them. The service
 * layer in `./index.ts` is the only caller, and it is the one that calls `requirePermission`
 * before any of these run — see the note there on why the split is drawn this way.
 */

/** One page of the admin unit list, before pagination is decided. */
export interface UnitPageQuery {
	/** 1-based. */
	readonly page: number;
	readonly pageSize: number;
	/**
	 * Matched case-insensitively against `block` and `number`, as a substring of either. When the
	 * keyword itself resolves to a block-and-number pair (`A 01`, `A-01`, `A01`, `Blok A No 01`), also
	 * matched against block and number together. See `buildUnitFilter`.
	 */
	readonly search?: string;
	/** `false` (the default the screen starts on) hides a unit once it is deactivated. */
	readonly includeInactive: boolean;
}

/** A page of `units` rows, plus how many rows the filter matches in total. */
export interface UnitPageResult {
	readonly rows: readonly Unit[];
	readonly totalCount: number;
}

/**
 * One page of `units`, filtered by search and active status, ordered by block then number —
 * the order a resident reads a street sign in.
 */
export async function queryUnitsPage(db: Database, query: UnitPageQuery): Promise<UnitPageResult> {
	const filter = buildUnitFilter(query);

	const [rows, totalRows] = await Promise.all([
		db
			.select()
			.from(units)
			.where(filter)
			.orderBy(asc(units.block), asc(units.number))
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(units).where(filter)
	]);

	return { rows, totalCount: totalRows[0]?.value ?? 0 };
}

/** The one row named by `unitId`, or `undefined` when there is none. */
export async function findUnitById(db: Database, unitId: string): Promise<Unit | undefined> {
	const [row] = await db.select().from(units).where(eq(units.id, unitId));
	return row;
}

/** What the admin screens need to know about one unit's occupancies. */
export interface OccupancySummary {
	/** How many people are living in the unit on the day this was asked about. */
	readonly activeOccupantCount: number;
	/** Whether the primary-occupant slot the database guards is currently filled. */
	readonly hasPrimaryOccupant: boolean;
}

/**
 * Each unit in `unitIds` summarised as of `today` — "jumlah penghuni aktifnya" and whether anyone
 * holds the Penanggung Jawab slot. A unit nobody is living in is absent from the result rather than
 * present with zeroes; the caller defaults a missing entry to none.
 *
 * **The two halves deliberately ask two different questions, with two different predicates.** They
 * used to share one, and sharing it put a false sentence on the screen.
 *
 * - `activeOccupantCount` counts a stay that is **still running on `today`**: `ended_on is null or
 *   ended_on >= today`. An end date written before it arrives — someone announcing in March that
 *   they leave next year — does not stop them living there in the meantime, and counting them as
 *   gone told a resident their own house had no occupants.
 * - `hasPrimaryOccupant` stays on `ended_on is null`, the predicate
 *   `occupancies_primary_occupant_unique` itself uses, so it means exactly "the slot the database
 *   guards is filled". A primary occupant with a future end date therefore reads as gone *here*, and
 *   that is the conservative direction on purpose: the unit surfaces on the admin list as needing a
 *   successor while there is still time to name one, rather than on the day the invoices go out with
 *   nobody to address them to. The `filter (where …)` clause is what keeps this half narrow while the
 *   row set around it is the wider one.
 *
 * `coalesce` is not decoration: `bool_or` over an empty filtered set is `null`, which would reach the
 * screen as a missing answer rather than as "no".
 */
export async function summarizeActiveOccupancies(
	db: Database,
	today: string,
	unitIds: readonly string[]
): Promise<ReadonlyMap<string, OccupancySummary>> {
	if (unitIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			unitId: occupancies.unitId,
			activeOccupantCount: count(),
			hasPrimaryOccupant: sql<boolean>`coalesce(bool_or(${occupancies.isPrimaryOccupant}) filter (where ${occupancies.endedOn} is null), false)`
		})
		.from(occupancies)
		.where(and(inArray(occupancies.unitId, unitIds), stillRunningOn(occupancies.endedOn, today)))
		.groupBy(occupancies.unitId);

	return new Map(
		rows.map(({ unitId, activeOccupantCount, hasPrimaryOccupant }) => [
			unitId,
			{ activeOccupantCount, hasPrimaryOccupant }
		])
	);
}

/**
 * The combined filter a unit list page reads through: active-only unless asked otherwise, and a
 * search-term match when one is given. `and()` drops an `undefined` argument, so an empty search and
 * `includeInactive: true` together yield an unfiltered `where`.
 */
function buildUnitFilter(query: UnitPageQuery) {
	return and(
		query.includeInactive ? undefined : eq(units.isActive, true),
		buildSearchFilter(query.search)
	);
}

/**
 * The search box's matching rule, `undefined` when there is nothing to search for.
 *
 * The whole trimmed keyword as a substring of block or number (point 1) is tried unconditionally and
 * kept byte-for-byte what it always did: every `listUnits` test that isolates its own rows by
 * searching its own `unique()` block (`PAGE-5` and the like) depends on that substring rule alone
 * continuing to find exactly that block, so it is never replaced, only added to.
 *
 * Point 2 adds a second way to match, tried in addition (`or`) rather than instead: a keyword that
 * resolves to a block and a number is matched against the two columns separately, `and`ed together.
 * See `buildTwoColumnMatch` for why it is never a single combined-string comparison.
 */
function buildSearchFilter(rawSearch: string | undefined) {
	const search = rawSearch?.trim();
	if (!search) {
		return undefined;
	}

	const wholeTermMatch = matchesEitherColumn(search);
	const twoColumnMatch = buildTwoColumnMatch(search);
	return twoColumnMatch ? or(wholeTermMatch, twoColumnMatch) : wholeTermMatch;
}

/**
 * Point 2: a keyword naming a block and a number together. `normalizeSearchTerm` strips the
 * `unit_label` words (`blok`, `block`, `no`, `no.`, `nomor`, Indonesian and English) so "Blok A No 01"
 * and "A 01" split the same way; `splitIntoPieces` then cuts on every run of separators (space, `-`,
 * `/`, `.`), dropping empty pieces.
 *
 * - Exactly two pieces name a block and a number outright.
 * - Exactly one piece (no separator was in it) is a keyword like "A01" or a normalized-down "Blok A":
 *   tried at its first letter-to-digit boundary for a block-and-number pair, and also, since the
 *   piece may simply be a shorter keyword with the label word gone, matched as a plain substring of
 *   either column on its own (point 1's rule, applied to the shorter piece).
 * - Three or more pieces name something this search does not resolve to a block and a number, so
 *   `undefined` leaves the keyword to point 1 alone.
 */
function buildTwoColumnMatch(search: string) {
	const pieces = splitIntoPieces(normalizeSearchTerm(search));

	if (pieces.length === 2) {
		return matchesBlockAndNumber(pieces[0], pieces[1]);
	}
	if (pieces.length === 1) {
		return matchSinglePiece(pieces[0]);
	}
	return undefined;
}

/** The single-piece case `buildTwoColumnMatch` defers to: see its own comment for what each half means. */
function matchSinglePiece(piece: string) {
	const singlePieceMatch = matchesEitherColumn(piece);
	const boundary = splitAtLetterToDigitBoundary(piece);
	return boundary
		? or(singlePieceMatch, matchesBlockAndNumber(boundary[0], boundary[1]))
		: singlePieceMatch;
}

/**
 * Block and number matched separately and `and`ed, never a single combined-string comparison: a
 * combined match on `${block}${number}` would make block `A1` number `2` and block `A` number `12`
 * both satisfy the keyword `A12`, which is exactly the ambiguity matching the two columns apart avoids.
 */
function matchesBlockAndNumber(block: string, number: string) {
	return and(ilike(units.block, likePattern(block)), ilike(units.number, likePattern(number)));
}

/** Point 1's rule as its own function: `term` as a substring of either column. */
function matchesEitherColumn(term: string) {
	const pattern = likePattern(term);
	return or(ilike(units.block, pattern), ilike(units.number, pattern));
}

/** An escaped `ILIKE` pattern that matches `term` as a substring, wildcards and all. */
function likePattern(term: string): string {
	return `%${escapeLikePattern(term)}%`;
}

/**
 * Whole tokens naming `unit_label` itself rather than a block or a number (the Indonesian and English
 * words `spec-warga-unit-v1.md` uses for it), stripped case-insensitively so "Blok A No 01" and "A 01"
 * normalize to the same thing. Matched as whole tokens, never a substring, so a real block or number
 * that merely contains these letters (`NOPJ`, say) is left untouched.
 */
const UNIT_LABEL_WORDS = new Set(['blok', 'block', 'no', 'no.', 'nomor']);

/** `search`, with every whitespace-delimited `UNIT_LABEL_WORDS` token removed. A pure function. */
function normalizeSearchTerm(term: string): string {
	return term
		.split(/\s+/)
		.filter((token) => token !== '' && !UNIT_LABEL_WORDS.has(token.toLowerCase()))
		.join(' ');
}

/** Every run of separator characters (space, `-`, `/`, `.`) is one cut; empty pieces are dropped. */
const SEPARATOR_RUN = /[\s\-/.]+/;

/** `normalized`, cut at every run of separators. A pure function. */
function splitIntoPieces(normalized: string): readonly string[] {
	return normalized.split(SEPARATOR_RUN).filter((piece) => piece !== '');
}

/**
 * The first point a digit directly follows a letter (`A01` becomes `['A', '01']`), or `null` when
 * `piece` has no such point (`AB`, `12`, digits with no leading letter). The lazy `+?` before the
 * first digit keeps this linear: it only ever extends one character at a time toward the first digit
 * it finds, never backtracks across alternatives, so it cannot blow up on a long input (S5852/S8786).
 *
 * Exported so the no-separator form (`A01`) can be proven correct directly: none of this file's tests
 * can build a letters-only block that stays unique against the shared schema (`unique()` always
 * appends a digit), so that acceptance case is tested against this pure function instead of through
 * `listUnits`.
 */
export function splitAtLetterToDigitBoundary(piece: string): readonly [string, string] | null {
	const match = /^([A-Za-z]+?)([0-9].*)$/.exec(piece);
	return match ? [match[1], match[2]] : null;
}

/**
 * Escapes `ILIKE`'s wildcard characters so a `%` or `_` the admin typed matches only itself, per
 * point 3. Backslash first: escaping it after `%`/`_` would double-escape the backslashes those two
 * steps just inserted. PostgreSQL's `ILIKE` uses `\` as its default escape character, so no `ESCAPE`
 * clause is needed. A pure function.
 */
function escapeLikePattern(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
