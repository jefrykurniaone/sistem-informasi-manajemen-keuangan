import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readOrigin } from '#lib/server/auth.ts';
import { user } from '#lib/server/db/schema/auth.ts';
import { emailQueue } from '#lib/server/db/schema/email.ts';
import { residents } from '#lib/server/db/schema/resident.ts';
import { subscriptions } from '#lib/server/db/schema/subscription.ts';
import { testDatabase } from '#lib/server/db/test-helpers.ts';
import {
	announce,
	announceAfterCommit,
	AnnounceError,
	everyResident
} from '#lib/server/email/announce.ts';
import { applicationEmailTemplates } from '#lib/server/email/jobs.ts';
import { FakeClock } from '#lib/server/ports/fakes.ts';
import {
	disableSubscriptionByToken,
	setSubscriptionPreference
} from '#lib/server/services/subscription/index.ts';
import {
	governingSubscriptionKind,
	isOptInEmailKind,
	NOTIFICATION_EMAIL_KIND,
	SUBSCRIPTION_KIND,
	type NotificationEmailKind
} from '#lib/server/services/subscription/kinds.ts';
import {
	UNSUBSCRIBE_BASE_PATH,
	verifyUnsubscribeToken
} from '#lib/server/services/subscription/unsubscribe-token.ts';
import { withoutTrailingSlashes } from '#lib/server/url.ts';

/**
 * `src/lib/server/email/announce.ts`, the module every email about a saved change goes through
 * (#316). Observed the way #309 decides it is observed: through the `email_queue` rows it writes, in
 * a real PostgreSQL. The Langganan rule, the unsubscribe link and the never-fail rule are proven here
 * once, for every kind, instead of once per notification module; a domain module's own test only
 * proves its payload and who it addresses.
 */

const testDb = testDatabase();

const START = '2026-05-01T00:00:00.000Z';

/** Every email kind the module can send. */
const EMAIL_KINDS: readonly NotificationEmailKind[] = Object.values(NOTIFICATION_EMAIL_KIND);

/** The kinds a resident may switch off. */
const OPT_IN_KINDS = EMAIL_KINDS.filter(isOptInEmailKind);

/** The kinds every addressed resident receives. */
const ALWAYS_SENT_KINDS = EMAIL_KINDS.filter((kind) => !isOptInEmailKind(kind));

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let clock: FakeClock;
let sequence = 0;

beforeEach(async () => {
	// Every assertion below reads the whole queue, so each test starts from an empty one, and from no
	// residents and no Langganan, because `everyResident` and `residentsSubscribedTo` read them all.
	await testDb.db.delete(emailQueue);
	await testDb.db.delete(subscriptions);
	await testDb.db.delete(residents);
	clock = new FakeClock(START);
});

/** One resident, as the tests below need them. */
interface TestResident {
	readonly residentId: string;
	readonly userId: string;
	readonly email: string;
}

/** Inserts an account and its `residents` row. */
async function insertResident(prefix: string): Promise<TestResident> {
	sequence += 1;
	const userId = randomUUID();
	const email = `${userId}@komplek.local`;
	await testDb.db.insert(user).values({
		id: userId,
		name: `${prefix} ${sequence}`,
		email,
		emailVerified: true,
		createdAt: new Date(START),
		updatedAt: new Date(START)
	});
	const [row] = await testDb.db
		.insert(residents)
		.values({ userId, createdAt: new Date(START) })
		.returning({ id: residents.id });
	return { residentId: row.id, userId, email };
}

/** Sets a resident's own answer for one Langganan, the way the preferences screen does. */
async function answer(resident: TestResident, kind: string, enabled: boolean): Promise<void> {
	await setSubscriptionPreference(testDb.db, clock, {
		callerUserId: resident.userId,
		residentId: resident.residentId,
		kind,
		enabled
	});
}

/**
 * Every queue row, in no particular order: they share the fake clock's instant and a random id, so
 * a test that cares about order reads `AnnounceOutcome.queued` instead.
 */
async function queuedRows() {
	return testDb.db.select().from(emailQueue);
}

/** Every address the queue holds a row for, sorted. */
async function queuedRecipients(): Promise<readonly string[]> {
	return (await queuedRows()).map((row) => row.recipient).sort();
}

/** `addresses`, sorted, to compare with `queuedRecipients`. */
function sorted(...addresses: string[]): readonly string[] {
	return addresses.sort();
}

/** The token at the end of an unsubscribe address built from `ORIGIN`. */
function tokenOf(unsubscribeUrl: unknown): string {
	const prefix = `${withoutTrailingSlashes(readOrigin())}${UNSUBSCRIBE_BASE_PATH}/`;
	expect(typeof unsubscribeUrl).toBe('string');
	expect(String(unsubscribeUrl).startsWith(prefix)).toBe(true);
	return String(unsubscribeUrl).slice(prefix.length);
}

describe('the email kinds', () => {
	it('names every email it sends from the Langganan list, plus the two that are not a Langganan', () => {
		expect([...EMAIL_KINDS].sort()).toEqual(
			[...Object.values(SUBSCRIPTION_KIND), 'payment-rejected', 'monthly-report-revised'].sort()
		);
	});

	it('has a template the worker can render for every kind it sends', () => {
		for (const kind of EMAIL_KINDS) {
			expect(applicationEmailTemplates[kind], kind).toBeTypeOf('function');
		}
	});

	it('is opt-in for the kinds an opt-in Langganan governs, and for no other', () => {
		expect([...OPT_IN_KINDS].sort()).toEqual(
			['monthly-report', 'monthly-report-revised', 'new-complaint', 'new-post'].sort()
		);
		expect(governingSubscriptionKind(NOTIFICATION_EMAIL_KIND.monthlyReportRevised)).toBe(
			SUBSCRIPTION_KIND.monthlyReport
		);
		expect(governingSubscriptionKind(NOTIFICATION_EMAIL_KIND.paymentRejected)).toBeNull();
	});
});

describe('announce: who receives an opt-in kind', () => {
	it('reaches only the residents subscribed to it, never one who never answered or switched it off', async () => {
		const subscribed = await insertResident('Warga Berlangganan');
		await insertResident('Warga Tidak Menjawab');
		const switchedOff = await insertResident('Warga Berhenti');
		await answer(subscribed, SUBSCRIPTION_KIND.newPost, true);
		await answer(switchedOff, SUBSCRIPTION_KIND.newPost, true);
		await answer(switchedOff, SUBSCRIPTION_KIND.newPost, false);

		await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.newPost,
			recipients: everyResident,
			payload: () => ({ marker: 'opt-in' })
		});

		expect(await queuedRecipients()).toEqual([subscribed.email]);
	});

	it('stays inside the residents the caller addressed, even when others are subscribed', async () => {
		const addressed = await insertResident('Warga Dituju');
		const notAddressed = await insertResident('Warga Tidak Dituju');
		await answer(addressed, SUBSCRIPTION_KIND.newComplaint, true);
		await answer(notAddressed, SUBSCRIPTION_KIND.newComplaint, true);

		await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.newComplaint,
			recipients: [addressed.residentId],
			payload: () => ({ marker: 'addressed' })
		});

		expect(await queuedRecipients()).toEqual([addressed.email]);
	});

	it('reads the Langganan that governs a kind which is not a Langganan itself', async () => {
		const subscribed = await insertResident('Warga Laporan');
		const otherwise = await insertResident('Warga Tanpa Laporan');
		await answer(subscribed, SUBSCRIPTION_KIND.monthlyReport, true);
		await answer(otherwise, SUBSCRIPTION_KIND.newPost, true);

		await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.monthlyReportRevised,
			recipients: everyResident,
			payload: () => ({ marker: 'revised' })
		});

		expect(await queuedRecipients()).toEqual([subscribed.email]);
	});
});

describe('announce: who receives every other kind', () => {
	it.each(ALWAYS_SENT_KINDS)(
		'sends %s to every addressed resident, whatever their Langganan row says, with no unsubscribe link',
		async (kind) => {
			const noRow = await insertResident('Warga Tanpa Baris');
			const staleRow = await insertResident('Warga Baris Mati');
			const governing = governingSubscriptionKind(kind);
			if (governing !== null) {
				// `setSubscriptionPreference` refuses to switch a mandatory kind off, so a row like this
				// can only come from outside the service; the email must still arrive.
				await testDb.db.insert(subscriptions).values({
					residentId: staleRow.residentId,
					kind: governing,
					enabled: false,
					createdAt: clock.now()
				});
			}
			const handed: unknown[] = [];

			await announce(testDb.db, clock, {
				kind,
				recipients: [noRow.residentId, staleRow.residentId],
				payload: ({ unsubscribeUrl }) => {
					handed.push(unsubscribeUrl);
					return { marker: kind };
				}
			});

			const rows = await queuedRows();
			expect(await queuedRecipients()).toEqual(sorted(noRow.email, staleRow.email));
			expect(rows.every((row) => row.kind === kind)).toBe(true);
			expect(rows.every((row) => !('unsubscribeUrl' in row.payload))).toBe(true);
			expect(handed).toEqual([null, null]);
		}
	);
});

describe('announce: the unsubscribe link', () => {
	it.each(OPT_IN_KINDS)(
		'gives every %s email a signed link that switches off the Langganan governing it',
		async (kind) => {
			const resident = await insertResident('Warga Tautan');
			const governing = governingSubscriptionKind(kind);
			if (governing === null) {
				throw new Error(`An opt-in kind is governed by a Langganan; ${kind} is not.`);
			}
			await answer(resident, governing, true);

			await announce(testDb.db, clock, {
				kind,
				recipients: [resident.residentId],
				payload: () => ({ marker: kind })
			});

			const [row] = await queuedRows();
			const token = tokenOf(row.payload.unsubscribeUrl);
			expect(verifyUnsubscribeToken(token)).toEqual({
				valid: true,
				residentId: resident.residentId,
				kind: governing
			});

			// The link works: following it switches that Langganan off, and the next email of the
			// same kind reaches nobody.
			await disableSubscriptionByToken(testDb.db, clock, token);
			await testDb.db.delete(emailQueue);
			await announce(testDb.db, clock, {
				kind,
				recipients: [resident.residentId],
				payload: () => ({ marker: kind })
			});
			expect(await queuedRows()).toEqual([]);
		}
	);

	it('hands the builder the same link it writes, and writes it over whatever the builder put there', async () => {
		const resident = await insertResident('Warga Tautan Sendiri');
		await answer(resident, SUBSCRIPTION_KIND.monthlyReport, true);
		let handed: string | undefined;

		await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.monthlyReport,
			recipients: [resident.residentId],
			payload: ({ unsubscribeUrl }) => {
				handed = unsubscribeUrl;
				return { unsubscribeUrl: 'https://elsewhere.example/unsubscribe/forged' };
			}
		});

		const [row] = await queuedRows();
		expect(row.payload.unsubscribeUrl).toBe(handed);
		tokenOf(row.payload.unsubscribeUrl);
	});
});

describe('announce: links, language and rows', () => {
	it('builds links from ORIGIN and writes in id', async () => {
		const resident = await insertResident('Warga Bahasa');

		await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.paymentRejected,
			recipients: [resident.residentId],
			payload: ({ link, locale, recipient }) => ({
				url: link('/payments/abc'),
				locale,
				for: recipient.residentId
			})
		});

		const [row] = await queuedRows();
		expect(row.payload).toEqual({
			url: `${withoutTrailingSlashes(readOrigin())}/payments/abc`,
			locale: 'id',
			for: resident.residentId
		});
	});

	it('queues one row per resident, however often the resident is named', async () => {
		const resident = await insertResident('Warga Disebut Dua Kali');

		const outcome = await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.invoiceIssued,
			recipients: async () => [resident.residentId, resident.residentId],
			payload: () => ({ marker: 'once' })
		});

		expect(outcome.queued).toHaveLength(1);
		expect(await queuedRecipients()).toEqual([resident.email]);
	});

	it('queues in the order the caller named, skips a resident whose row is gone, and queues nothing for an empty list', async () => {
		const earlier = await insertResident('Warga Lebih Dulu');
		const later = await insertResident('Warga Belakangan');

		const outcome = await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.paymentVerified,
			recipients: [later.residentId, randomUUID(), earlier.residentId],
			payload: () => ({ marker: 'present' })
		});
		const empty = await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.paymentVerified,
			recipients: [],
			payload: () => ({ marker: 'nobody' })
		});

		expect(outcome.queued.map((row) => row.recipient)).toEqual([later.email, earlier.email]);
		expect(empty.queued).toEqual([]);
		expect(await queuedRecipients()).toEqual(sorted(later.email, earlier.email));
	});
});

describe('announce: a rule of the caller that leaves a resident out', () => {
	it('is applied after the Langganan, and counts the subscribed residents it left out as skipped', async () => {
		const sentBefore = await insertResident('Warga Sudah Dikirimi');
		const toSend = await insertResident('Warga Belum Dikirimi');
		const neverSubscribed = await insertResident('Warga Tidak Berlangganan');
		await answer(sentBefore, SUBSCRIPTION_KIND.monthlyReport, true);
		await answer(toSend, SUBSCRIPTION_KIND.monthlyReport, true);
		const asked: string[] = [];

		const outcome = await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.monthlyReport,
			recipients: everyResident,
			except: (recipient) => {
				asked.push(recipient.email);
				return recipient.email === sentBefore.email;
			},
			payload: () => ({ marker: 'except' })
		});

		// Asked only about the residents the Langganan let through, and never about one who never
		// subscribed: that resident is not "skipped", they were never going to be sent it.
		expect(asked.sort()).toEqual(sorted(sentBefore.email, toSend.email));
		expect(asked).not.toContain(neverSubscribed.email);
		expect(outcome.queued.map((row) => row.recipient)).toEqual([toSend.email]);
		expect(outcome.skipped).toBe(1);
		expect(await queuedRecipients()).toEqual([toSend.email]);
	});

	it('applies to a kind that is not opt-in as well, and reports nothing skipped without a rule', async () => {
		const left = await insertResident('Warga Dikecualikan');
		const kept = await insertResident('Warga Tetap');

		const withRule = await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.paymentVerified,
			recipients: [left.residentId, kept.residentId],
			except: (recipient) => recipient.residentId === left.residentId,
			payload: () => ({ marker: 'rule' })
		});
		const withoutRule = await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.paymentVerified,
			recipients: [kept.residentId],
			payload: () => ({ marker: 'no rule' })
		});

		expect(withRule.skipped).toBe(1);
		expect(withRule.queued.map((row) => row.recipient)).toEqual([kept.email]);
		expect(withoutRule.skipped).toBe(0);
	});

	it('reports every subscribed resident as skipped, and queues nothing, when the rule leaves all out', async () => {
		const only = await insertResident('Warga Satu-satunya');
		await answer(only, SUBSCRIPTION_KIND.monthlyReport, true);

		const outcome = await announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.monthlyReport,
			recipients: everyResident,
			except: () => true,
			payload: () => ({ marker: 'all out' })
		});

		expect(outcome).toEqual({ queued: [], skipped: 1 });
		expect(await queuedRows()).toEqual([]);
	});
});

describe('announce: the variant a job body calls throws', () => {
	it('still queues every other recipient, then throws naming how many were queued', async () => {
		const first = await insertResident('Warga Pertama');
		const failing = await insertResident('Warga Gagal');
		const last = await insertResident('Warga Terakhir');
		const failure = new Error('Payload tidak bisa dibangun.');

		const attempt = announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.ownComplaintStatusChanged,
			recipients: [first.residentId, failing.residentId, last.residentId],
			payload: ({ recipient }) => {
				if (recipient.residentId === failing.residentId) {
					throw failure;
				}
				return { marker: 'partial' };
			}
		});

		await expect(attempt).rejects.toBeInstanceOf(AnnounceError);
		await expect(attempt).rejects.toMatchObject({
			kind: NOTIFICATION_EMAIL_KIND.ownComplaintStatusChanged,
			queued: 2,
			errors: [failure]
		});
		expect(await queuedRecipients()).toEqual(sorted(first.email, last.email));
	});

	it('refuses a link that is not a path, as a failure of that recipient', async () => {
		const resident = await insertResident('Warga Tautan Salah');

		const attempt = announce(testDb.db, clock, {
			kind: NOTIFICATION_EMAIL_KIND.paymentRejected,
			recipients: [resident.residentId],
			payload: ({ link }) => ({ url: link('payments/abc') })
		});

		await expect(attempt).rejects.toMatchObject({ queued: 0, errors: [expect.any(TypeError)] });
		expect(await queuedRows()).toEqual([]);
	});

	it('throws before queuing anything when the recipients cannot be found', async () => {
		await insertResident('Warga Tidak Terjangkau');
		const failure = new Error('Penerima tidak bisa dicari.');

		await expect(
			announce(testDb.db, clock, {
				kind: NOTIFICATION_EMAIL_KIND.newPost,
				recipients: async () => {
					throw failure;
				},
				payload: () => ({ marker: 'never' })
			})
		).rejects.toBe(failure);
		expect(await queuedRows()).toEqual([]);
	});
});

describe('announce: after the commit, never inside a transaction', () => {
	it('refuses a transaction handle before running a statement, so the transaction still commits', async () => {
		const resident = await insertResident('Warga Dalam Transaksi');
		const changedName = 'Nama Sesudah Perubahan';

		await testDb.db.transaction(async (transaction) => {
			await expect(
				announce(transaction, clock, {
					kind: NOTIFICATION_EMAIL_KIND.paymentRejected,
					recipients: [resident.residentId],
					payload: () => ({ marker: 'inside' })
				})
			).rejects.toBeInstanceOf(TypeError);
			// A statement that failed inside PostgreSQL would have aborted the transaction, and this
			// update would then fail; it runs because the refusal never reached the database.
			await transaction.update(user).set({ name: changedName }).where(eq(user.id, resident.userId));
		});

		const [stored] = await testDb.db.select().from(user).where(eq(user.id, resident.userId));
		expect(stored.name).toBe(changedName);
		expect(await queuedRows()).toEqual([]);
	});
});

describe('announceAfterCommit: the never-fail rule at the call site', () => {
	it('leaves the saved change alone, logs the failure and answers undefined when the send throws', async () => {
		// The change, committed before the email is attempted, as every caller does it.
		const saved = await testDb.db.transaction(async (transaction) => {
			const [row] = await transaction
				.insert(user)
				.values({
					id: randomUUID(),
					name: 'Perubahan Tersimpan',
					email: `${randomUUID()}@komplek.local`,
					emailVerified: true,
					createdAt: new Date(START),
					updatedAt: new Date(START)
				})
				.returning();
			return row;
		});
		const failure = new Error('Antrean email tidak bisa ditulis.');
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		try {
			const answered = await announceAfterCommit('the "new-post" email for the test', async () => {
				throw failure;
			});

			expect(answered).toBeUndefined();
			expect(logged).toHaveBeenCalledWith(
				expect.stringContaining('the "new-post" email for the test'),
				failure
			);
		} finally {
			logged.mockRestore();
		}
		const [still] = await testDb.db.select().from(user).where(eq(user.id, saved.id));
		expect(still).toEqual(saved);
	});

	it('swallows an AnnounceError from the throwing variant, after the other recipients were queued', async () => {
		const reached = await insertResident('Warga Tetap Dikirimi');
		const failing = await insertResident('Warga Gagal Dikirimi');
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		try {
			const answered = await announceAfterCommit('the partial email', () =>
				announce(testDb.db, clock, {
					kind: NOTIFICATION_EMAIL_KIND.invoiceIssued,
					recipients: [failing.residentId, reached.residentId],
					payload: ({ recipient }) => {
						if (recipient.residentId === failing.residentId) {
							throw new Error('Payload tidak bisa dibangun.');
						}
						return { marker: 'reached' };
					}
				})
			);

			expect(answered).toBeUndefined();
			expect(logged).toHaveBeenCalledWith(
				expect.stringContaining('the partial email'),
				expect.any(AnnounceError)
			);
		} finally {
			logged.mockRestore();
		}
		expect(await queuedRecipients()).toEqual([reached.email]);
	});

	it('answers with what the send resolved to when nothing failed', async () => {
		const resident = await insertResident('Warga Berhasil');

		const outcome = await announceAfterCommit('the successful email', () =>
			announce(testDb.db, clock, {
				kind: NOTIFICATION_EMAIL_KIND.paymentVerified,
				recipients: [resident.residentId],
				payload: () => ({ marker: 'ok' })
			})
		);

		expect(outcome?.queued.map((row) => row.recipient)).toEqual([resident.email]);
	});
});

/**
 * The domain notification modules that have moved onto this module. Each one only names its email,
 * its recipients and its payload: it imports nothing that reads a Langganan, builds a link or writes
 * a queue row, and it catches nothing. A module joins this list when it moves (#325 brings dues,
 * Keluhan and Laporan Bulanan).
 */
const MOVED_NOTIFICATION_MODULES = ['src/lib/server/services/post/notification.ts'];

/** What a moved module must leave to the announce module. */
const LEFT_TO_ANNOUNCE = [
	'residentsSubscribedTo',
	'readOrigin',
	'unsubscribeLink',
	'buildUnsubscribeToken',
	'withoutTrailingSlashes',
	'enqueueEmail'
];

/** Every name `path` imports, and whether its code (never its comments) catches anything. */
function shapeOf(path: string): {
	readonly imported: readonly string[];
	readonly catches: boolean;
} {
	const source = ts.createSourceFile(
		path,
		readFileSync(path, 'utf8'),
		ts.ScriptTarget.Latest,
		true
	);
	const imported: string[] = [];
	let catches = false;
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			const bindings = node.importClause?.namedBindings;
			if (bindings && ts.isNamedImports(bindings)) {
				imported.push(
					...bindings.elements.map((element) => (element.propertyName ?? element.name).text)
				);
			}
		}
		if (
			ts.isTryStatement(node) ||
			(ts.isPropertyAccessExpression(node) && node.name.text === 'catch')
		) {
			catches = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { imported, catches };
}

describe('the domain notification modules that moved onto it', () => {
	it.each(MOVED_NOTIFICATION_MODULES)(
		'%s reads no Langganan, builds no link, writes no queue row and catches nothing itself',
		(module) => {
			const shape = shapeOf(join(ROOT, module));

			expect(shape.imported).toContain('announce');
			expect(shape.imported.filter((name) => LEFT_TO_ANNOUNCE.includes(name))).toEqual([]);
			expect(shape.catches).toBe(false);
		}
	);
});
