<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * What one CSV import would do, and every row of it that cannot be imported — the whole of the
	 * first step of `src/routes/(app)/admin/import/+page.svelte`.
	 *
	 * The component receives problems as `{ code, value }` rather than as finished sentences, because
	 * the service layer may not build a sentence a superuser reads: every one of those words is
	 * Indonesian and lives in `messages/id.json`. `REASON_MESSAGE` below is where a code becomes one.
	 * A code this screen does not know about is shown as itself rather than skipped — a reason nobody
	 * can read is bad, and a refused row with no reason at all is worse.
	 */
	interface ProblemReason {
		/** One of `IMPORT_PROBLEM` in `$lib/server/services/import/validation`. */
		readonly code: string;
		/** The block and number, the address, or the word the row carried. May be empty. */
		readonly value: string;
	}

	interface RowProblem {
		/** The line of the file, counting the header as line 1. */
		readonly rowNumber: number;
		readonly reasons: readonly ProblemReason[];
	}

	interface Props {
		/** The name of the uploaded file. */
		readonly fileName: string;
		readonly validRowCount: number;
		readonly newUnitCount: number;
		readonly newResidentCount: number;
		readonly problems: readonly RowProblem[];
	}

	let { fileName, validRowCount, newUnitCount, newResidentCount, problems }: Readonly<Props> =
		$props();

	/** One message per reason code. The `value` is whatever of the row the message quotes back. */
	const REASON_MESSAGE: Record<string, (value: string) => string> = {
		malformedRow: () => m.adminImport_problemMalformedRow(),
		missingBlock: () => m.adminImport_problemMissingBlock(),
		missingNumber: () => m.adminImport_problemMissingNumber(),
		missingName: () => m.adminImport_problemMissingName(),
		missingEmail: () => m.adminImport_problemMissingEmail(),
		invalidEmail: (value) => m.adminImport_problemInvalidEmail({ value }),
		missingRole: () => m.adminImport_problemMissingRole(),
		unknownRole: (value) => m.adminImport_problemUnknownRole({ value }),
		duplicateUnitInFile: (value) => m.adminImport_problemDuplicateUnitInFile({ value }),
		duplicateEmailInFile: (value) => m.adminImport_problemDuplicateEmailInFile({ value }),
		unitAlreadyExists: (value) => m.adminImport_problemUnitAlreadyExists({ value }),
		emailAlreadyRegistered: (value) => m.adminImport_problemEmailAlreadyRegistered({ value })
	};

	/** The sentence for one reason, or the bare code when this screen does not know it. */
	function reasonText(reason: ProblemReason): string {
		return REASON_MESSAGE[reason.code]?.(reason.value) ?? reason.code;
	}
</script>

<section class="flex flex-col gap-4 rounded-lg border border-border p-4">
	<header class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold">{m.adminImport_previewHeading()}</h2>
		<p class="text-sm break-all text-muted-foreground">{m.adminImport_previewFile({ fileName })}</p>
	</header>

	<ul class="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
		<li class="rounded-md border border-border px-3 py-2">
			{m.adminImport_previewValidRows({ count: validRowCount })}
		</li>
		<li class="rounded-md border border-border px-3 py-2">
			{m.adminImport_previewNewUnits({ count: newUnitCount })}
		</li>
		<li class="rounded-md border border-border px-3 py-2">
			{m.adminImport_previewNewResidents({ count: newResidentCount })}
		</li>
	</ul>

	<p class="text-sm text-muted-foreground">{m.adminImport_previewNothingSaved()}</p>

	<h3 class="text-base font-semibold">
		{m.adminImport_problemsHeading({ count: problems.length })}
	</h3>

	{#if problems.length === 0}
		<p class="text-sm text-muted-foreground">{m.adminImport_problemsEmpty()}</p>
	{:else}
		<!-- The scroll lives on this wrapper, never on the page, but only when the page container has
		     a definite width: at 390px the reasons column wraps and only a very long address pushes
		     the table sideways. -->
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-left text-sm">
				<thead>
					<tr class="border-b border-border">
						<th scope="col" class="py-2 pr-3 font-medium whitespace-nowrap">
							{m.adminImport_tableRowNumber()}
						</th>
						<th scope="col" class="py-2 font-medium">{m.adminImport_tableReasons()}</th>
					</tr>
				</thead>
				<tbody>
					<!-- Keyed by position, not by row number: two records can share a line number, and a
				     repeated key is a runtime error rather than a rendering quirk. -->
					{#each problems as problem, position (position)}
						<tr class="border-b border-border last:border-0">
							<th scope="row" class="py-2 pr-3 align-top font-medium whitespace-nowrap">
								{problem.rowNumber}
							</th>
							<td class="py-2 align-top">
								<ul class="flex flex-col gap-1">
									{#each problem.reasons as reason, reasonPosition (reasonPosition)}
										<li class="break-words text-destructive">{reasonText(reason)}</li>
									{/each}
								</ul>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>
