import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { user } from '#lib/server/db/schema/auth.ts';
import { ROLE, userRoles } from '#lib/server/db/schema/authz.ts';
import { occupancies, OCCUPANCY_ROLE } from '#lib/server/db/schema/occupancy.ts';
import { residents } from '#lib/server/db/schema/resident.ts';
import { units } from '#lib/server/db/schema/unit.ts';
import { testDatabase } from '#lib/server/db/test-helpers.ts';
import { FakeClock } from '#lib/server/ports/fakes.ts';
import {
	currentDay,
	isStillRunningOn,
	isVisibleOn,
	mergeDateRanges,
	occupiedRangesOfUnit,
	stillRunningOn,
	unitVisibilityFor,
	visibilityDateFilter,
	VISIBLE_ALWAYS,
	VISIBLE_NEVER,
	type UnitVisibility
} from '#lib/server/services/occupancy/visibility.ts';

/**
 * The visibility contract the iuran and kas-laporan specs are going to filter their rows with —
 * `spec-warga-unit-v1.md`'s "Penyaringan tampilan menurut masa huni".
 *
 * The scenario the spec names by hand is the one at the bottom of this file: a tenant turnover, with
 * the proof that whoever moved in later cannot see the days before they arrived while the pengurus
 * sees the whole history of the house.
 */

const testDb = testDatabase();

const START = '2026-01-01T00:00:00.000Z';

/** The old occupant's stay. */
const OLD_FROM = '2026-01-01';
const OLD_UNTIL = '2026-03-31';
/** The new occupant's stay, starting the day after the old one ended. */
const NEW_FROM = '2026-04-01';
/** A day inside the old occupant's stay, and one inside the new occupant's. */
const DAY_IN_MARCH = '2026-03-15';
const DAY_IN_MAY = '2026-05-15';

/** Makes every block this file writes different from every other one. */
let sequence = 0;
function unique(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

/** Inserts a bare `user` row, picking up the trigger's default `resident` role. */
async function insertUser(name: string): Promise<string> {
	const id = randomUUID();
	const now = new Date(START);
	await testDb.db.insert(user).values({
		id,
		name,
		email: `${id}@komplek.local`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

/** An account together with the `residents` row that points at it. */
async function insertResident(name: string): Promise<{ userId: string; residentId: string }> {
	const userId = await insertUser(name);
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning();
	return { userId, residentId: row.id };
}

/** A superuser: the "admin melihat seluruh riwayat Unit" side of the contract. */
async function insertSuperuser(name: string): Promise<string> {
	const userId = await insertUser(name);
	await testDb.db
		.insert(userRoles)
		.values({ userId, role: ROLE.superuser, createdAt: new Date(START) });
	return userId;
}

/** One house. */
async function insertUnitRow(): Promise<string> {
	const [row] = await testDb.db
		.insert(units)
		.values({ block: unique('B'), number: '1', createdAt: new Date(START) })
		.returning();
	return row.id;
}

/** One stay, written directly: this file tests the reading side, not the writing one. */
async function insertOccupancyRow(
	unitId: string,
	residentId: string,
	startedOn: string,
	endedOn: string | null
): Promise<void> {
	await testDb.db.insert(occupancies).values({
		unitId,
		residentId,
		role: OCCUPANCY_ROLE.tenant,
		startedOn,
		endedOn,
		createdAt: new Date(START)
	});
}

describe('mergeDateRanges', () => {
	it('sorts ranges by their first day', () => {
		const merged = mergeDateRanges([
			{ from: '2026-05-01', to: '2026-05-31' },
			{ from: '2026-01-01', to: '2026-01-31' }
		]);

		expect(merged).toEqual([
			{ from: '2026-01-01', to: '2026-01-31' },
			{ from: '2026-05-01', to: '2026-05-31' }
		]);
	});

	it('folds two overlapping ranges into one', () => {
		const merged = mergeDateRanges([
			{ from: '2026-01-01', to: '2026-03-31' },
			{ from: '2026-03-01', to: '2026-06-30' }
		]);

		expect(merged).toEqual([{ from: '2026-01-01', to: '2026-06-30' }]);
	});

	it('leaves a range that is wholly inside another one alone', () => {
		const merged = mergeDateRanges([
			{ from: '2026-01-01', to: '2026-12-31' },
			{ from: '2026-05-01', to: '2026-05-31' }
		]);

		expect(merged).toEqual([{ from: '2026-01-01', to: '2026-12-31' }]);
	});

	it('lets a range that has not ended swallow everything after it', () => {
		const merged = mergeDateRanges([
			{ from: '2026-01-01', to: null },
			{ from: '2026-05-01', to: '2026-05-31' }
		]);

		expect(merged).toEqual([{ from: '2026-01-01', to: null }]);
	});

	it('keeps two stays that do not touch apart', () => {
		const merged = mergeDateRanges([
			{ from: OLD_FROM, to: OLD_UNTIL },
			{ from: '2026-09-01', to: null }
		]);

		expect(merged).toEqual([
			{ from: OLD_FROM, to: OLD_UNTIL },
			{ from: '2026-09-01', to: null }
		]);
	});
});

describe('isVisibleOn', () => {
	const twoStays: UnitVisibility = {
		kind: 'ranges',
		ranges: [
			{ from: OLD_FROM, to: OLD_UNTIL },
			{ from: '2026-09-01', to: null }
		]
	};

	it.each([
		['the first day of a stay', OLD_FROM, true],
		['the last day of a stay', OLD_UNTIL, true],
		['a day inside a stay', DAY_IN_MARCH, true],
		['a day between two stays', DAY_IN_MAY, false],
		['a day before every stay', '2025-12-31', false],
		['a day long after a stay that has not ended', '2030-01-01', true]
	])('answers %s', (_description, day, expected) => {
		expect(isVisibleOn(twoStays, day)).toBe(expected);
	});

	it('says yes to every day for a viewer who may see the whole history', () => {
		expect(isVisibleOn(VISIBLE_ALWAYS, DAY_IN_MARCH)).toBe(true);
	});

	it('says no to every day for a viewer who never lived there', () => {
		expect(isVisibleOn(VISIBLE_NEVER, DAY_IN_MARCH)).toBe(false);
	});
});

describe('visibilityDateFilter', () => {
	it('is undefined for the whole history, so and() composes it away', () => {
		expect(visibilityDateFilter(occupancies.startedOn, VISIBLE_ALWAYS)).toBeUndefined();
	});

	it('matches no row at all when the viewer may see nothing', async () => {
		const unitId = await insertUnitRow();
		const { residentId } = await insertResident('Warga Tanpa Rentang');
		await insertOccupancyRow(unitId, residentId, OLD_FROM, null);

		const rows = await testDb.db
			.select()
			.from(occupancies)
			.where(
				and(
					eq(occupancies.unitId, unitId),
					visibilityDateFilter(occupancies.startedOn, VISIBLE_NEVER)
				)
			);

		expect(rows).toHaveLength(0);
	});

	it('keeps only the rows whose day falls inside one of the ranges', async () => {
		const unitId = await insertUnitRow();
		const early = await insertResident('Warga Awal Tahun');
		const late = await insertResident('Warga Akhir Tahun');
		await insertOccupancyRow(unitId, early.residentId, OLD_FROM, OLD_UNTIL);
		await insertOccupancyRow(unitId, late.residentId, DAY_IN_MAY, null);

		const rows = await testDb.db
			.select({ startedOn: occupancies.startedOn })
			.from(occupancies)
			.where(
				and(
					eq(occupancies.unitId, unitId),
					visibilityDateFilter(occupancies.startedOn, {
						kind: 'ranges',
						ranges: [{ from: OLD_FROM, to: OLD_UNTIL }]
					})
				)
			);

		expect(rows).toEqual([{ startedOn: OLD_FROM }]);
	});

	it('keeps every row from the first day onwards when the range has not ended', async () => {
		const unitId = await insertUnitRow();
		const early = await insertResident('Warga Masuk Duluan');
		const late = await insertResident('Warga Menyusul');
		await insertOccupancyRow(unitId, early.residentId, OLD_FROM, OLD_UNTIL);
		await insertOccupancyRow(unitId, late.residentId, DAY_IN_MAY, null);

		const rows = await testDb.db
			.select({ startedOn: occupancies.startedOn })
			.from(occupancies)
			.where(
				and(
					eq(occupancies.unitId, unitId),
					visibilityDateFilter(occupancies.startedOn, {
						kind: 'ranges',
						ranges: [{ from: NEW_FROM, to: null }]
					})
				)
			);

		expect(rows).toEqual([{ startedOn: DAY_IN_MAY }]);
	});
});

describe('occupiedRangesOfUnit', () => {
	it('reads back one range per stay, merged and sorted', async () => {
		const unitId = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Dua Kali');
		await insertOccupancyRow(unitId, residentId, '2026-09-01', null);
		await insertOccupancyRow(unitId, residentId, OLD_FROM, OLD_UNTIL);

		expect(await occupiedRangesOfUnit(testDb.db, userId, unitId)).toEqual([
			{ from: OLD_FROM, to: OLD_UNTIL },
			{ from: '2026-09-01', to: null }
		]);
	});

	it('counts no stay in another house', async () => {
		const unitId = await insertUnitRow();
		const otherUnitId = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Rumah Sebelah');
		await insertOccupancyRow(otherUnitId, residentId, OLD_FROM, null);

		expect(await occupiedRangesOfUnit(testDb.db, userId, unitId)).toEqual([]);
	});
});

describe('unitVisibilityFor', () => {
	it('answers the whole history to whoever may manage occupancies', async () => {
		const unitId = await insertUnitRow();
		const superuserId = await insertSuperuser('Pengurus Lihat Semua');

		expect(await unitVisibilityFor(testDb.db, { viewerUserId: superuserId, unitId })).toEqual(
			VISIBLE_ALWAYS
		);
	});

	it('answers nothing to a signed-in account with no residents row yet', async () => {
		const unitId = await insertUnitRow();
		const userId = await insertUser('Warga Belum Tercatat');

		expect(await unitVisibilityFor(testDb.db, { viewerUserId: userId, unitId })).toEqual(
			VISIBLE_NEVER
		);
	});

	it('answers nothing to a resident who never lived in that house', async () => {
		const unitId = await insertUnitRow();
		const { userId } = await insertResident('Warga Rumah Lain');

		expect(await unitVisibilityFor(testDb.db, { viewerUserId: userId, unitId })).toEqual(
			VISIBLE_NEVER
		);
	});

	it('answers the days a resident lived there', async () => {
		const unitId = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Menghuni');
		await insertOccupancyRow(unitId, residentId, OLD_FROM, OLD_UNTIL);

		expect(await unitVisibilityFor(testDb.db, { viewerUserId: userId, unitId })).toEqual({
			kind: 'ranges',
			ranges: [{ from: OLD_FROM, to: OLD_UNTIL }]
		});
	});
});

describe('currentDay', () => {
	it('reads the instant as a WIB calendar day', () => {
		expect(currentDay(new FakeClock('2026-08-01T12:00:00.000Z'))).toBe('2026-08-01');
	});

	it.each([
		['the first moment of a UTC day', '2026-08-01T00:00:00.000Z', '2026-08-01'],
		// The complex is at UTC+7, so `23:59:59.999Z` on the 1st is already `06:59:59.999` WIB on the
		// 2nd — `currentDay` answers the WIB day rather than the UTC one.
		[
			'the last moment of a UTC day, already tomorrow in Jakarta',
			'2026-08-01T23:59:59.999Z',
			'2026-08-02'
		],
		['an instant that is already tomorrow in Jakarta', '2026-08-01T18:00:00.000Z', '2026-08-02']
	])('answers %s', (_description, instant, expected) => {
		expect(currentDay(new FakeClock(instant))).toBe(expected);
	});
});

describe('isStillRunningOn', () => {
	it.each([
		['a stay with no end date at all', OLD_FROM, null, true],
		['a stay ending after today', OLD_FROM, '2027-12-31', true],
		['a stay ending today', OLD_FROM, '2026-08-01', true],
		['a stay that ended yesterday', OLD_FROM, '2026-07-31', false],
		['a stay starting today', '2026-08-01', null, true],
		['a stay starting tomorrow, with no end date', '2026-08-02', null, false],
		['a stay starting tomorrow, with an end date', '2026-08-02', '2027-12-31', false],
		['a one-day stay that is today', '2026-08-01', '2026-08-01', true]
	])('answers %s', (_description, startedOn, endedOn, expected) => {
		expect(isStillRunningOn({ startedOn, endedOn }, '2026-08-01')).toBe(expected);
	});
});

describe('stillRunningOn', () => {
	it('keeps the stays running on the given day, and drops the ones that ended or have not started', async () => {
		const unitId = await insertUnitRow();
		const leavingNextYear = await insertResident('Warga Akan Pergi');
		const gone = await insertResident('Warga Sudah Pergi');
		const staying = await insertResident('Warga Tanpa Tanggal Selesai');
		const lastDayToday = await insertResident('Warga Hari Terakhir');
		const arrivingTomorrow = await insertResident('Warga Masuk Besok');
		await insertOccupancyRow(unitId, leavingNextYear.residentId, OLD_FROM, '2027-12-31');
		await insertOccupancyRow(unitId, gone.residentId, OLD_FROM, OLD_UNTIL);
		await insertOccupancyRow(unitId, staying.residentId, OLD_FROM, null);
		await insertOccupancyRow(unitId, lastDayToday.residentId, OLD_FROM, '2026-08-01');
		await insertOccupancyRow(unitId, arrivingTomorrow.residentId, '2026-08-02', null);

		const rows = await testDb.db
			.select({ residentId: occupancies.residentId })
			.from(occupancies)
			.where(and(eq(occupancies.unitId, unitId), stillRunningOn(occupancies, '2026-08-01')));

		expect(rows.map((row) => row.residentId).sort()).toEqual(
			[leavingNextYear.residentId, staying.residentId, lastDayToday.residentId].sort()
		);
	});
});

describe('a stay whose end date has not arrived', () => {
	it('still shows the resident the days they are living through', async () => {
		// The other half of the defect reported against `/my-unit`: whatever the occupant count says,
		// the visibility contract must not cut someone off from days they are still living in. It
		// answers the days as data, so an end date in the future is simply part of the range.
		const unitId = await insertUnitRow();
		const { userId, residentId } = await insertResident('Warga Pamit Untuk Tahun Depan');
		await insertOccupancyRow(unitId, residentId, OLD_FROM, '2027-12-31');

		const visibility = await unitVisibilityFor(testDb.db, { viewerUserId: userId, unitId });

		expect(visibility).toEqual({ kind: 'ranges', ranges: [{ from: OLD_FROM, to: '2027-12-31' }] });
		expect(isVisibleOn(visibility, '2026-08-01')).toBe(true);
		expect(isVisibleOn(visibility, '2027-12-31')).toBe(true);
		expect(isVisibleOn(visibility, '2028-01-01')).toBe(false);
	});
});

describe('a tenant turnover', () => {
	/** The house, the occupant who left, the one who arrived, and the pengurus watching both. */
	async function turnover() {
		const unitId = await insertUnitRow();
		const leaving = await insertResident('Warga Penghuni Lama');
		const arriving = await insertResident('Warga Penghuni Baru');
		const superuserId = await insertSuperuser('Pengurus Pergantian Penghuni');
		await insertOccupancyRow(unitId, leaving.residentId, OLD_FROM, OLD_UNTIL);
		await insertOccupancyRow(unitId, arriving.residentId, NEW_FROM, null);
		return { unitId, leaving, arriving, superuserId };
	}

	it('hides every day before the new occupant moved in, and shows every day after', async () => {
		const { unitId, arriving } = await turnover();

		const visibility = await unitVisibilityFor(testDb.db, {
			viewerUserId: arriving.userId,
			unitId
		});

		expect(visibility).toEqual({ kind: 'ranges', ranges: [{ from: NEW_FROM, to: null }] });
		expect(isVisibleOn(visibility, DAY_IN_MARCH)).toBe(false);
		expect(isVisibleOn(visibility, DAY_IN_MAY)).toBe(true);
	});

	it('leaves the previous occupant their own months and nothing after them', async () => {
		const { unitId, leaving } = await turnover();

		const visibility = await unitVisibilityFor(testDb.db, {
			viewerUserId: leaving.userId,
			unitId
		});

		expect(isVisibleOn(visibility, DAY_IN_MARCH)).toBe(true);
		expect(isVisibleOn(visibility, DAY_IN_MAY)).toBe(false);
	});

	it('shows the pengurus the whole history of the house', async () => {
		const { unitId, superuserId } = await turnover();

		const visibility = await unitVisibilityFor(testDb.db, {
			viewerUserId: superuserId,
			unitId
		});

		expect(visibility).toEqual(VISIBLE_ALWAYS);
		expect(isVisibleOn(visibility, DAY_IN_MARCH)).toBe(true);
		expect(isVisibleOn(visibility, DAY_IN_MAY)).toBe(true);
	});

	it('filters a query of the unit’s own history down to what each of them may see', async () => {
		const { unitId, arriving, superuserId } = await turnover();

		const forNewOccupant = await visibleStartDates(unitId, arriving.userId);
		const forPengurus = await visibleStartDates(unitId, superuserId);

		expect(forNewOccupant).toEqual([NEW_FROM]);
		expect(forPengurus).toEqual([OLD_FROM, NEW_FROM]);
	});

	/** Every stay of `unitId` whose first day `viewerUserId` is allowed to see, in order. */
	async function visibleStartDates(unitId: string, viewerUserId: string): Promise<string[]> {
		const visibility = await unitVisibilityFor(testDb.db, { viewerUserId, unitId });
		const rows = await testDb.db
			.select({ startedOn: occupancies.startedOn })
			.from(occupancies)
			.where(
				and(eq(occupancies.unitId, unitId), visibilityDateFilter(occupancies.startedOn, visibility))
			)
			.orderBy(occupancies.startedOn);
		return rows.map((row) => row.startedOn);
	}
});

describe('the personal screens', () => {
	// #313: `unitVisibilityFor` answers the whole history to a superuser, which is an admin screen's
	// answer. Every personal screen reads `src/lib/server/services/occupancy/resident-view.ts`
	// instead, which reads no role. This holds the boundary at the source: no personal route, no dues
	// or dashboard service, and not `resident-view.ts` itself reaches `unitVisibilityFor` or
	// `VISIBLE_ALWAYS`, by any import, re-export or dynamic `import()` of the visibility module; and
	// `resident-view.ts` takes nothing but types from the authorisation modules.
	const root = fileURLToPath(new URL('../..', import.meta.url));
	const visibilityModule = join(root, 'src/lib/server/services/occupancy/visibility.ts');
	const residentViewModule = join(root, 'src/lib/server/services/occupancy/resident-view.ts');
	const authorisationModules = [
		join(root, 'src/lib/server/authz.ts'),
		join(root, 'src/lib/server/db/schema/authz.ts')
	];
	const forbiddenNames = new Set(['unitVisibilityFor', 'VISIBLE_ALWAYS']);

	/** One name an import or re-export takes from a module, and whether only its type is taken. */
	interface TakenName {
		readonly name: string;
		readonly typeOnly: boolean;
	}

	/** One reference from a file to another module. */
	interface ModuleReference {
		readonly kind: 'import' | 'export' | 'dynamic';
		/** The file it names, without extension, or `null` for a package or a non-literal `import()`. */
		readonly target: string | null;
		/** `'everything'` for a namespace import, `export *`, a dynamic import or a bare import. */
		readonly names: readonly TakenName[] | 'everything';
		/** Whether the whole declaration is `import type` or `export type`. */
		readonly typeOnly: boolean;
	}

	/** `path` without a `.ts` or `.js` extension, so two spellings of one module compare equal. */
	function withoutExtension(path: string): string {
		return path.replace(/\.(ts|js)$/, '');
	}

	/** The file `specifier` names, seen from `importer`, or `null` when it names a package. */
	function resolveSpecifier(importer: string, specifier: string): string | null {
		if (specifier.startsWith('#lib/') || specifier.startsWith('$lib/')) {
			return withoutExtension(join(root, 'src', 'lib', specifier.slice('#lib/'.length)));
		}
		if (specifier.startsWith('.')) {
			return withoutExtension(resolve(dirname(importer), specifier));
		}
		return null;
	}

	/** The names an import or export clause takes, each with its own `type` modifier. */
	function takenNames(
		elements: ts.NodeArray<ts.ImportSpecifier> | ts.NodeArray<ts.ExportSpecifier>
	): TakenName[] {
		return elements.map((element) => ({
			name: (element.propertyName ?? element.name).text,
			typeOnly: element.isTypeOnly
		}));
	}

	/** Every import, re-export and dynamic `import()` in `text`, read as the file at `path`. */
	function referencesIn(path: string, text: string): ModuleReference[] {
		const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
		const found: ModuleReference[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
				const clause = node.importClause;
				const bindings = clause?.namedBindings;
				found.push({
					kind: 'import',
					target: resolveSpecifier(path, node.moduleSpecifier.text),
					names:
						clause === undefined ||
						clause.name !== undefined ||
						!bindings ||
						ts.isNamespaceImport(bindings)
							? 'everything'
							: takenNames(bindings.elements),
					typeOnly: clause?.isTypeOnly ?? false
				});
			} else if (
				ts.isExportDeclaration(node) &&
				node.moduleSpecifier &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				const clause = node.exportClause;
				found.push({
					kind: 'export',
					target: resolveSpecifier(path, node.moduleSpecifier.text),
					names: clause && ts.isNamedExports(clause) ? takenNames(clause.elements) : 'everything',
					typeOnly: node.isTypeOnly
				});
			} else if (
				ts.isCallExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ImportKeyword
			) {
				const [argument] = node.arguments;
				found.push({
					kind: 'dynamic',
					target:
						argument && ts.isStringLiteralLike(argument)
							? resolveSpecifier(path, argument.text)
							: null,
					names: 'everything',
					typeOnly: false
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		return found;
	}

	/** Whether `text`, read as the file at `path`, reaches the visibility module's "all" answer. */
	function reachesWholeHistory(path: string, text: string): boolean {
		return referencesIn(path, text).some(
			(reference) =>
				(reference.kind === 'dynamic' && reference.target === null) ||
				(reference.target === withoutExtension(visibilityModule) &&
					(reference.names === 'everything' ||
						reference.names.some((taken) => forbiddenNames.has(taken.name))))
		);
	}

	/** Whether `text`, read as the file at `path`, takes any value from an authorisation module. */
	function takesAuthorisationValue(path: string, text: string): boolean {
		const modules = new Set(authorisationModules.map(withoutExtension));
		return referencesIn(path, text).some(
			(reference) =>
				(reference.kind === 'dynamic' && reference.target === null) ||
				(reference.target !== null &&
					modules.has(reference.target) &&
					!reference.typeOnly &&
					(reference.names === 'everything' || reference.names.some((taken) => !taken.typeOnly)))
		);
	}

	/** The `.ts` files directly inside `directory`. */
	function tsFilesIn(directory: string): string[] {
		return readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
			.map((entry) => join(directory, entry.name));
	}

	/** Every `.ts` file under `directory`, leaving out any directory in `skipped`. */
	function tsFilesUnder(directory: string, skipped: ReadonlySet<string>): string[] {
		const found: string[] = [];
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!skipped.has(path)) {
					found.push(...tsFilesUnder(path, skipped));
				}
			} else if (entry.name.endsWith('.ts')) {
				found.push(path);
			}
		}
		return found;
	}

	/** The files the boundary covers: dues and dashboard services, personal routes, the view. */
	function personalScreenFiles(): string[] {
		const appRoutes = join(root, 'src', 'routes', '(app)');
		return [
			...tsFilesIn(join(root, 'src/lib/server/services/dues')),
			...tsFilesIn(join(root, 'src/lib/server/services/dashboard')),
			...tsFilesUnder(appRoutes, new Set([join(appRoutes, 'admin')])),
			residentViewModule
		];
	}

	it('covers the services and routes that build a personal screen', () => {
		const covered = personalScreenFiles().map((path) => relative(root, path));

		expect(covered).toEqual(
			expect.arrayContaining([
				'src/lib/server/services/dues/queries.ts',
				'src/lib/server/services/dues/payment.ts',
				'src/lib/server/services/dashboard/index.ts',
				'src/lib/server/services/occupancy/resident-view.ts',
				'src/routes/(app)/+page.server.ts',
				'src/routes/(app)/invoices/+page.server.ts',
				'src/routes/(app)/payments/+page.server.ts',
				'src/routes/(app)/payments/new/+page.server.ts'
			])
		);
		expect(covered.some((path) => path.includes('/admin/'))).toBe(false);
	});

	it('never reach unitVisibilityFor or VISIBLE_ALWAYS', () => {
		const offenders = personalScreenFiles()
			.filter((path) => reachesWholeHistory(path, readFileSync(path, 'utf8')))
			.map((path) => relative(root, path));

		expect(offenders).toEqual([]);
	});

	it('leave resident-view.ts nothing but types from the authorisation modules', () => {
		expect(
			takesAuthorisationValue(residentViewModule, readFileSync(residentViewModule, 'utf8'))
		).toBe(false);
	});

	describe('the check itself', () => {
		// The two detectors above, run on planted sources, so a blind spot in them fails here rather
		// than letting a real import through unnoticed.
		it.each([
			['a relative named import', `import { unitVisibilityFor } from './visibility';`],
			['an aliased import', `import { unitVisibilityFor as all } from './visibility.ts';`],
			['VISIBLE_ALWAYS', `import { VISIBLE_ALWAYS } from './visibility';`],
			[
				'a #lib import',
				`import { unitVisibilityFor } from '#lib/server/services/occupancy/visibility.ts';`
			],
			[
				'a $lib import',
				`import { VISIBLE_ALWAYS } from '$lib/server/services/occupancy/visibility';`
			],
			['a namespace import', `import * as visibility from './visibility';`],
			['a re-export', `export { unitVisibilityFor } from './visibility';`],
			['a star re-export', `export * from './visibility';`],
			['a dynamic import', `const visibility = await import('./visibility');`],
			['a dynamic import of a computed path', `const anything = await import(path);`]
		])('catches %s from resident-view.ts', (_form, text) => {
			expect(reachesWholeHistory(residentViewModule, text)).toBe(true);
		});

		it('lets the rest of the visibility module through', () => {
			const text = `import { currentDay, isVisibleOn, type DateRange } from './visibility';`;
			expect(reachesWholeHistory(residentViewModule, text)).toBe(false);
		});

		it.each([
			['a value import', `import { rolesOf } from '../../authz';`],
			['a mixed import', `import { ACTION, type DatabaseWriter } from '../../authz';`],
			['the roles table', `import { userRoles } from '../../db/schema/authz';`],
			['a namespace import', `import * as authz from '#lib/server/authz.ts';`],
			['a dynamic import', `const authz = await import('../../authz');`]
		])('catches %s of authorisation', (_form, text) => {
			expect(takesAuthorisationValue(residentViewModule, text)).toBe(true);
		});

		it.each([
			[`import type { DatabaseWriter } from '../../authz';`],
			[`import { type DatabaseWriter } from '../../authz';`]
		])('lets a type-only import of authorisation through: %s', (text) => {
			expect(takesAuthorisationValue(residentViewModule, text)).toBe(false);
		});
	});
});
