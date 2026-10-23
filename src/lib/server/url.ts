/**
 * `value` with every trailing `/` removed, so that a path can be appended to an origin written with
 * or without one. A loop rather than `value.replace(/\/+$/, '')`: that pattern backtracks
 * quadratically on a long run of slashes followed by anything else (typescript:S8786).
 */
export function withoutTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === '/') {
		end -= 1;
	}
	return value.slice(0, end);
}
