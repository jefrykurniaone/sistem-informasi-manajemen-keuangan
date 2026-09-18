import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Rupiah } from '$lib/money';

export * from './allocation';
export * from './auth';
export * from './audit';
export * from './authz';
export * from './cash-category';
export * from './cash-transaction';
export * from './complaint';
export * from './dues-rate';
export * from './email';
export * from './exemption';
export * from './invitation';
export * from './invoice';
export * from './monthly-report';
export * from './occupancy';
export * from './payment';
export * from './period';
export * from './post';
export * from './registration';
export * from './resident';
export * from './scheduler';
export * from './subscription';
export * from './unit';

/**
 * The database schema. Every application table is exported from this file, and `drizzle-kit`
 * reads it through `schema` in `drizzle.config.ts`.
 *
 * Conventions settled here and followed by every later table:
 *
 * - **A table reaches a migration only by being re-exported here.** Tables live in a module of
 *   their own once there is more than one of them — `./email.ts` holds the email queue — and this
 *   file re-exports each of those modules. `drizzle-kit` follows nothing else: a table that is
 *   defined but not re-exported here generates no SQL and fails at run time against a database
 *   that never grew it.
 *
 * - **Identifiers are English, table and column names included.** The domain glossary in
 *   `CONTEXT.md` is written in Indonesian and stays that way; its "Code names" section maps each
 *   term to the one English identifier that represents it. A table introducing a term that has
 *   no entry there is inventing a concept and has to stop.
 * - **A column name is never written twice.** `casing: 'snake_case'` turns a TypeScript property
 *   name into a SQL column name (`createdAt` becomes `created_at`). That setting has to be in
 *   two places at once — `drizzle.config.ts` for migration generation and the `drizzle()` call in
 *   `src/lib/server/db/index.ts` for queries at run time. If only one of them has it, queries
 *   will name columns that do not exist in the database.
 * - **Primary keys are `uuid`**, not an integer sequence: an invoice number or a payment number
 *   must not be guessable from the address of a neighbour's page.
 * - **Money values are `bigint` with `mode: 'number'`**, not `integer`. The `integer` (`int4`)
 *   ceiling is 2,147,483,647 rupiah; one complex's cash book can pass it over a decade or two,
 *   and an overflowing column costs more than eight bytes per row. `mode: 'number'` makes the
 *   driver return a `number` rather than a string, and `.$type<Rupiah>()` carries the money type
 *   from `src/lib/money.ts` through to query results.
 * - **Timestamps are always `withTimezone`**, so that no row's meaning depends on the time zone
 *   of whichever process happened to write it.
 */

/**
 * The probe table belonging to the database scaffolding ticket. It has no domain meaning: its
 * only job is to prove that migrations really run and that a row can be written and read back
 * through the test harness. It is also what the cross-file isolation guard in
 * `tests/unit/db-harness-second.test.ts` writes to, so it outlives the first domain table.
 */
export const scaffoldProbe = pgTable('scaffold_probe', {
	id: uuid().primaryKey().defaultRandom(),
	description: text().notNull(),
	amount: bigint({ mode: 'number' }).$type<Rupiah>().notNull(),
	createdAt: timestamp({ withTimezone: true }).notNull().defaultNow()
});
