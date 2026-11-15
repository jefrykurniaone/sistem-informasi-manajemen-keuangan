import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * No route writes its own error translator (#333, spec #310). Every route under `src/routes` turns a
 * service's error into its answer through `src/lib/server/route-action.ts`: `throwRouteError` in a
 * `load` or a throw-only `catch`, `return failOrThrow(...)` in an action. A private
 * `throwAsRouteError` or `failAsRejectedForm`, or a hand-written `instanceof PermissionDeniedError`,
 * would answer a refusal in a way the shared module's mapping and its tests never see.
 *
 * The source is parsed rather than searched, so a comment that names `PermissionDeniedError` (many
 * do) is not a finding. The second half proves the lint rule that rejects a discarded `failOrThrow`
 * fires on one and stays quiet on `return failOrThrow(...)`.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ROUTES = join(ROOT, 'src', 'routes');
const FORBIDDEN_NAMES = new Set(['throwAsRouteError', 'failAsRejectedForm', 'refusalOrThrow']);

function sourceFilesUnder(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			found.push(...sourceFilesUnder(path));
		} else if (entry.name.endsWith('.ts')) {
			found.push(path);
		}
	}
	return found;
}

/** What one source text defines or does that a route must leave to `route-action.ts`. */
function translatorFindings(text: string): string[] {
	const source = ts.createSourceFile('route.ts', text, ts.ScriptTarget.Latest, true);
	const findings: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
			node.name !== undefined &&
			ts.isIdentifier(node.name) &&
			FORBIDDEN_NAMES.has(node.name.text)
		) {
			findings.push(`defines ${node.name.text}`);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
			ts.isIdentifier(node.right) &&
			node.right.text === 'PermissionDeniedError'
		) {
			findings.push('tests instanceof PermissionDeniedError');
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return findings;
}

describe('no route defines its own error translator', () => {
	it('finds no private translator under src/routes', () => {
		const offenders = sourceFilesUnder(ROUTES).flatMap((file) =>
			translatorFindings(readFileSync(file, 'utf8')).map(
				(finding) => `${relative(ROOT, file)}: ${finding}`
			)
		);
		expect(offenders).toEqual([]);
	});

	it('flags a route that defines throwAsRouteError or catches PermissionDeniedError by hand', () => {
		const own = `
			function throwAsRouteError(caught: unknown): never { throw caught; }
			try {} catch (caught) { if (caught instanceof PermissionDeniedError) throw caught; }
		`;
		expect(translatorFindings(own)).toEqual([
			'defines throwAsRouteError',
			'tests instanceof PermissionDeniedError'
		]);
		expect(translatorFindings('// caught instanceof PermissionDeniedError\n')).toEqual([]);
	});
});

describe('the lint rule on failOrThrow', () => {
	const lint = async (code: string) => {
		const eslint = new ESLint({ cwd: ROOT });
		const [result] = await eslint.lintText(code, {
			filePath: join(ROUTES, '(app)', 'fixture', '+page.server.ts')
		});
		return result.messages.filter((message) => message.ruleId === 'no-restricted-syntax');
	};

	it('rejects a failOrThrow whose result is discarded', async () => {
		const findings = await lint(
			'export function f(caught: unknown) {\n\tfailOrThrow(caught, {} as never);\n}\n'
		);
		expect(findings).toHaveLength(1);
	});

	it('accepts return failOrThrow(...)', async () => {
		const findings = await lint(
			'export function f(caught: unknown) {\n\treturn failOrThrow(caught, {} as never);\n}\n'
		);
		expect(findings).toEqual([]);
	});
});
