import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	UNSUBSCRIBE_BASE_PATH,
	buildUnsubscribeToken,
	unsubscribeLink,
	verifyUnsubscribeToken
} from '$lib/server/services/subscription/unsubscribe-token';
import { SUBSCRIPTION_KIND } from '$lib/server/services/subscription/kinds';

/**
 * The unsubscribe token on its own — the acceptance criterion "tautan berhenti berlangganan tidak
 * dapat ditebak dan tidak dapat dipakai mematikan langganan orang lain".
 *
 * This file touches no database on purpose. A token is a pure function of a resident id, a kind and
 * a secret, and everything worth proving about it — that a signature cannot be forged, that the
 * resident and the kind cannot be swapped, that the raw secret never signs anything directly — is
 * decided before any row is read. What the token then authorizes is proved against a real
 * PostgreSQL in `tests/unit/subscription-service.test.ts`, where `disableSubscriptionByToken` lives.
 *
 * Both secrets below are test values written here in full: nothing in this file reads the
 * environment, so a machine whose `BETTER_AUTH_SECRET` differs from another's cannot change what
 * these tests assert.
 */

/** The secret every token in this file is signed with. Long enough to be a real one. */
const SECRET = 'test-unsubscribe-secret-that-is-long-enough';

/** A different installation's secret, for the tokens that must be worthless here. */
const OTHER_SECRET = 'another-installation-secret-long-enough-too';

/** A resident id shaped the way a real one is. */
const RESIDENT = '0f0b6a1e-9a4e-4a1d-9f1a-2b3c4d5e6f70';

/** Another one, for the "cannot switch somebody else off" case. */
const OTHER_RESIDENT = '11112222-3333-4444-5555-666677778888';

/** The kind every real unsubscribe link carries. */
const KIND = SUBSCRIPTION_KIND.monthlyReport;

/** The subject half of a token, which is everything before the separator. */
function subjectOf(token: string): string {
	return token.split('.')[0];
}

/** The signature half. */
function signatureOf(token: string): string {
	return token.split('.')[1];
}

describe('buildUnsubscribeToken', () => {
	it('round-trips the resident and the kind it was built for', () => {
		const token = buildUnsubscribeToken({ residentId: RESIDENT, kind: KIND }, SECRET);

		expect(verifyUnsubscribeToken(token, SECRET)).toEqual({
			valid: true,
			residentId: RESIDENT,
			kind: KIND
		});
	});

	it('is url-safe, so it survives being a path segment', () => {
		const token = buildUnsubscribeToken({ residentId: RESIDENT, kind: KIND }, SECRET);

		expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		expect(encodeURIComponent(token)).toBe(token);
	});

	it('signs with a derived key, never with the secret itself', () => {
		// Domain separation, decision 2 in the module: a signature made with the raw secret — which is
		// also what every other part of this application signs with — must not be accepted here.
		const token = buildUnsubscribeToken({ residentId: RESIDENT, kind: KIND }, SECRET);
		const rawSecretSignature = createHmac('sha256', SECRET)
			.update(subjectOf(token))
			.digest('base64url');

		expect(signatureOf(token)).not.toBe(rawSecretSignature);
		expect(verifyUnsubscribeToken(`${subjectOf(token)}.${rawSecretSignature}`, SECRET)).toEqual({
			valid: false,
			reason: 'signature'
		});
	});

	it.each([
		['a blank residentId', { residentId: '   ', kind: KIND }],
		['a blank kind', { residentId: RESIDENT, kind: '' }],
		['a residentId carrying the separator', { residentId: `${RESIDENT}\nx`, kind: KIND }],
		['a kind carrying the separator', { residentId: RESIDENT, kind: `${KIND}\nx` }]
	])('refuses %s, because two different pairs must never sign one message', (_name, subject) => {
		expect(() => buildUnsubscribeToken(subject, SECRET)).toThrow(TypeError);
	});
});

describe('verifyUnsubscribeToken', () => {
	it('refuses a token whose signature was tampered with', () => {
		const token = buildUnsubscribeToken({ residentId: RESIDENT, kind: KIND }, SECRET);
		const signature = signatureOf(token);
		const tampered = `${subjectOf(token)}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

		expect(verifyUnsubscribeToken(tampered, SECRET)).toEqual({
			valid: false,
			reason: 'signature'
		});
	});

	it('refuses a token repointed at another resident, keeping the signature it came with', () => {
		// The attack the acceptance criterion names: hold your own valid link, and edit whose it is.
		const own = buildUnsubscribeToken({ residentId: RESIDENT, kind: KIND }, SECRET);
		const someoneElse = buildUnsubscribeToken({ residentId: OTHER_RESIDENT, kind: KIND }, SECRET);
		const forged = `${subjectOf(someoneElse)}.${signatureOf(own)}`;

		expect(verifyUnsubscribeToken(forged, SECRET)).toEqual({ valid: false, reason: 'signature' });
	});

	it('refuses a token repointed at another kind, keeping the signature it came with', () => {
		const own = buildUnsubscribeToken({ residentId: RESIDENT, kind: KIND }, SECRET);
		const otherKind = buildUnsubscribeToken(
			{ residentId: RESIDENT, kind: SUBSCRIPTION_KIND.invoiceIssued },
			SECRET
		);
		const forged = `${subjectOf(otherKind)}.${signatureOf(own)}`;

		expect(verifyUnsubscribeToken(forged, SECRET)).toEqual({ valid: false, reason: 'signature' });
	});

	it('refuses a token minted by another installation', () => {
		const foreign = buildUnsubscribeToken({ residentId: RESIDENT, kind: KIND }, OTHER_SECRET);

		expect(verifyUnsubscribeToken(foreign, SECRET)).toEqual({ valid: false, reason: 'signature' });
	});

	it('refuses a re-encoded subject that would decode to the same resident', () => {
		// Base64url has more than one spelling of the same bytes. Signing the text that travels rather
		// than the values it decodes to is what makes a padded variant a different token, not a second
		// valid one for the same person.
		const token = buildUnsubscribeToken({ residentId: RESIDENT, kind: KIND }, SECRET);
		const padded = `${subjectOf(token)}=.${signatureOf(token)}`;

		expect(verifyUnsubscribeToken(padded, SECRET)).toEqual({ valid: false, reason: 'signature' });
	});

	it.each([
		['nothing at all', ''],
		['no separator', 'justoneblob'],
		['two separators', 'a.b.c'],
		['an empty subject', '.signature'],
		['an empty signature', 'c3ViamVjdA.'],
		['a path traversal attempt', '../../admin']
	])('refuses %s as malformed', (_name, token) => {
		expect(verifyUnsubscribeToken(token, SECRET)).toMatchObject({ valid: false });
	});

	it('is not guessable: the signature is a full 256-bit HMAC', () => {
		const token = buildUnsubscribeToken({ residentId: RESIDENT, kind: KIND }, SECRET);

		// 32 bytes in base64url, with no padding.
		expect(signatureOf(token)).toHaveLength(43);
		expect(Buffer.from(signatureOf(token), 'base64url')).toHaveLength(32);
	});
});

describe('unsubscribeLink', () => {
	it('is the unsubscribe page addressed absolutely, carrying a token that verifies', () => {
		const link = unsubscribeLink(
			'https://komplek.local',
			{ residentId: RESIDENT, kind: KIND },
			SECRET
		);

		const prefix = `https://komplek.local${UNSUBSCRIBE_BASE_PATH}/`;
		expect(link.startsWith(prefix)).toBe(true);
		expect(verifyUnsubscribeToken(link.slice(prefix.length), SECRET)).toMatchObject({
			valid: true,
			residentId: RESIDENT,
			kind: KIND
		});
	});

	it('never doubles the slash when the origin carries a trailing one', () => {
		const link = unsubscribeLink(
			'https://komplek.local/',
			{ residentId: RESIDENT, kind: KIND },
			SECRET
		);

		expect(link.startsWith(`https://komplek.local${UNSUBSCRIBE_BASE_PATH}/`)).toBe(true);
	});
});
