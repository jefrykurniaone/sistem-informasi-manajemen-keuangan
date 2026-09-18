import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	createInvitationToken,
	hashInvitationToken,
	INVITATION_TOKEN_BYTES
} from '$lib/server/services/invitation/token';

/**
 * The invitation token itself: enough entropy, URL-safe, and stored only as a digest. No database —
 * both functions are pure, and what they promise is exactly what a token is worth.
 */

/** 32 random bytes in base64url: ceil(32 * 8 / 6) characters, no padding. */
const EXPECTED_TOKEN_LENGTH = Math.ceil((INVITATION_TOKEN_BYTES * 8) / 6);

/** How many tokens the uniqueness check draws. Collisions at 256 bits would mean a broken source. */
const DRAWS = 1000;

describe('createInvitationToken', () => {
	it('draws 256 bits and encodes them URL-safe, so the link survives an email client', () => {
		const token = createInvitationToken();

		expect(token).toHaveLength(EXPECTED_TOKEN_LENGTH);
		// base64url only: no `+`, `/` or `=` for a proxy or a mail client to mangle, and nothing
		// that needs percent-encoding in a path segment.
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('never draws the same token twice', () => {
		const tokens = new Set<string>();
		for (let draw = 0; draw < DRAWS; draw += 1) {
			tokens.add(createInvitationToken());
		}

		expect(tokens.size).toBe(DRAWS);
	});
});

describe('hashInvitationToken', () => {
	it('is the SHA-256 hex digest, deterministic, so a lookup finds the row it stored', () => {
		const token = createInvitationToken();

		const digest = hashInvitationToken(token);

		expect(digest).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(hashInvitationToken(token)).toBe(digest);
	});

	it('does not contain the token, and two tokens never share a digest', () => {
		const one = createInvitationToken();
		const two = createInvitationToken();

		expect(hashInvitationToken(one)).not.toContain(one);
		expect(hashInvitationToken(one)).not.toBe(hashInvitationToken(two));
	});
});
