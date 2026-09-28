import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MINIMUM_PASSWORD_LENGTH } from '$lib/server/auth';
import { COMMON_PASSWORDS, isCommonPassword } from '$lib/server/common-passwords';
import { SEED_PASSWORD } from '../../scripts/seed-data';

/**
 * The list of common passwords (#249, `docs/spec-kata-sandi-v1.md` decision 3): what it holds, and
 * that it does not quietly break anything that already exists.
 *
 * The second half is the reason this file exists. A password written into a test or into the Data
 * Contoh seeder is set through the same rules as a resident's, so a fixed password that happened to
 * be on the list would turn a green suite red, or a seeder that runs into one that throws, with a
 * refusal that says nothing about what the test was for. Every one of them is checked here instead,
 * found by reading the test files rather than by a hand-kept copy that would fall behind them.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LIST_MODULE = join(ROOT, 'src', 'lib', 'server', 'common-passwords.ts');
const SCANNED_DIRECTORIES = [join(ROOT, 'tests', 'unit'), join(ROOT, 'tests', 'e2e')];

/**
 * The passwords the tests use precisely because they are on the list, to prove that it is refused.
 * Every other fixed password found below has to be off it.
 */
const DELIBERATELY_COMMON = new Set(['password123', 'PassWord123', 'PASSWORD123']);

/**
 * A single-quoted string literal assigned to a name or given as a key: `const PASSWORD = '...'`,
 * `newPassword: '...'`. Only the ones whose name mentions a password are kept, below; Prettier
 * writes every string in single quotes, so no other quoting needs to be read.
 */
const ASSIGNED_STRING = /([A-Za-z_$][\w$]*)\s*[:=]\s*'([^'\n]*)'/g;

/** Every `.ts` file under `directory`, at any depth. */
function typeScriptFilesUnder(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			found.push(...typeScriptFilesUnder(path));
		} else if (entry.name.endsWith('.ts')) {
			found.push(path);
		}
	}
	return found;
}

/** Every fixed password in the test files, each with the file it was found in. */
function fixedPasswordsInTests(): { password: string; file: string }[] {
	const found: { password: string; file: string }[] = [];
	for (const directory of SCANNED_DIRECTORIES) {
		for (const file of typeScriptFilesUnder(directory)) {
			for (const [, name, value] of readFileSync(file, 'utf8').matchAll(ASSIGNED_STRING)) {
				if (/password/i.test(name)) {
					found.push({ password: value, file: relative(ROOT, file) });
				}
			}
		}
	}
	return found;
}

describe('the list of common passwords', () => {
	it('holds entries, every one of them at least the minimum length', () => {
		expect(COMMON_PASSWORDS.length).toBeGreaterThan(1000);
		expect(MINIMUM_PASSWORD_LENGTH).toBe(8);
		expect(COMMON_PASSWORDS.filter((entry) => entry.length < MINIMUM_PASSWORD_LENGTH)).toEqual([]);
	});

	it("carries SecLists' attribution and MIT licence in the module that holds it", () => {
		const text = readFileSync(LIST_MODULE, 'utf8');

		expect(text).toContain('https://github.com/danielmiessler/SecLists/');
		expect(text).toContain('> MIT License');
		expect(text).toContain('> Copyright (c) 2018 Daniel Miessler');
	});

	it.each([
		{ password: 'password123', common: true },
		{ password: 'PassWord123', common: true },
		{ password: 'PASSWORD123', common: true },
		// Nothing is trimmed: a space is part of a password, so this is a different one.
		{ password: ' password123', common: false },
		{ password: 'kopi-teh', common: false }
	])('says $password is common: $common', ({ password, common }) => {
		expect(isCommonPassword(password)).toBe(common);
	});
});

describe('the fixed passwords that already exist', () => {
	const fixed = fixedPasswordsInTests();

	it('were found, so that the check below is not vacuous', () => {
		const passwords = fixed.map(({ password }) => password);

		expect(passwords).toContain('kata sandi yang panjang');
		expect(passwords).toContain('kata sandi ujung ke ujung');
		expect(passwords).toContain(SEED_PASSWORD);
	});

	it('in tests/unit and tests/e2e are not on the list', () => {
		const onTheList = fixed.filter(
			({ password }) => !DELIBERATELY_COMMON.has(password) && isCommonPassword(password)
		);

		expect(onTheList).toEqual([]);
	});

	it('of the Data Contoh is not on the list', () => {
		expect(isCommonPassword(SEED_PASSWORD)).toBe(false);
	});
});
