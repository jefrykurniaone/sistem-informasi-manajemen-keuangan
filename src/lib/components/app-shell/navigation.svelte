<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages.js';

	/**
	 * The primary navigation. It only ever renders what `+layout.server.ts` already decided a
	 * visitor may see — every `can*` flag below comes from `isAllowed()` against the same
	 * `PERMISSIONS` table `requirePermission` uses, so a link never claims a right the guard would
	 * refuse. Showing a link is not authorization: each page behind it still checks for itself.
	 *
	 * Two disclosures keep this readable past twenty entries at 390px: "Saya" for the pages every
	 * signed-in Warga reaches, "Kelola" for the admin/superuser screens gated by a `can*` flag.
	 * `<details>`/`<summary>` needs no JavaScript to open, unlike a JS-driven dropdown.
	 */
	interface Props {
		readonly signedIn: boolean;
		readonly canManageRoles: boolean;
		readonly canManageUnits: boolean;
		readonly canManageJobs: boolean;
		readonly canManagePosts: boolean;
		readonly canImportResidents: boolean;
		readonly canManageInvitations: boolean;
		readonly canManageRegistrations: boolean;
		readonly canManageDuesRates: boolean;
		readonly canManageCashCategories: boolean;
		readonly canRecordOpeningBalance: boolean;
		readonly canManageExemptions: boolean;
		readonly canRecordCashTransactions: boolean;
		readonly canReadPeriods: boolean;
		readonly canReadAllComplaints: boolean;
		readonly canReadOverdue: boolean;
		readonly canVerifyPayments: boolean;
		readonly canPublishReports: boolean;
	}

	let {
		signedIn,
		canManageRoles,
		canManageUnits,
		canManageJobs,
		canManagePosts,
		canImportResidents,
		canManageInvitations,
		canManageRegistrations,
		canManageDuesRates,
		canManageCashCategories,
		canRecordOpeningBalance,
		canManageExemptions,
		canRecordCashTransactions,
		canReadPeriods,
		canReadAllComplaints,
		canReadOverdue,
		canVerifyPayments,
		canPublishReports
	}: Readonly<Props> = $props();

	/** Whether the "Kelola" disclosure has anything to show — a display decision, not a permission one. */
	const canManageAnything = $derived(
		canManageRoles ||
			canManageUnits ||
			canManageJobs ||
			canManagePosts ||
			canImportResidents ||
			canManageInvitations ||
			canManageRegistrations ||
			canManageDuesRates ||
			canManageCashCategories ||
			canRecordOpeningBalance ||
			canManageExemptions ||
			canRecordCashTransactions ||
			canReadPeriods ||
			canReadAllComplaints ||
			canReadOverdue ||
			canVerifyPayments ||
			canPublishReports
	);

	const LINK_CLASS =
		'inline-flex min-h-11 items-center self-start rounded-sm px-1 underline-offset-4 hover:underline';
	const SUMMARY_CLASS =
		'inline-flex min-h-11 cursor-pointer list-none items-center self-start rounded-sm px-1 underline-offset-4 hover:underline';
	const GROUP_LIST_CLASS = 'flex flex-col items-start gap-1 py-1 pl-3';
</script>

<nav
	aria-label={m.appShell_navLabel()}
	class="flex flex-col items-start gap-1 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-2"
>
	<a class={LINK_CLASS} href={resolve('/')}>
		{m.appShell_navHome()}
	</a>
	<a class={LINK_CLASS} href={resolve('/posts')}>
		{m.appShell_navPosts()}
	</a>

	{#if signedIn}
		<details>
			<summary class={SUMMARY_CLASS}>{m.appShell_navGroupMine()}</summary>
			<div class={GROUP_LIST_CLASS}>
				<a class={LINK_CLASS} href={resolve('/profile')}>{m.appShell_navProfile()}</a>
				<a class={LINK_CLASS} href={resolve('/profile/notifications')}>
					{m.appShell_navProfileNotifications()}
				</a>
				<a class={LINK_CLASS} href={resolve('/my-unit')}>{m.appShell_navMyUnit()}</a>
				<a class={LINK_CLASS} href={resolve('/invoices')}>{m.appShell_navInvoices()}</a>
				<a class={LINK_CLASS} href={resolve('/payments')}>{m.appShell_navPayments()}</a>
				<a class={LINK_CLASS} href={resolve('/reports')}>{m.appShell_navReports()}</a>
				<a class={LINK_CLASS} href={resolve('/complaints')}>{m.appShell_navComplaints()}</a>
			</div>
		</details>

		{#if canManageAnything}
			<details>
				<summary class={SUMMARY_CLASS}>{m.appShell_navGroupManage()}</summary>
				<div class={GROUP_LIST_CLASS}>
					{#if canManageRoles}
						<a class={LINK_CLASS} href={resolve('/admin/roles')}>
							{m.appShell_navManageRoles()}
						</a>
					{/if}
					{#if canManageUnits}
						<a class={LINK_CLASS} href={resolve('/admin/units')}>
							{m.appShell_navManageUnits()}
						</a>
					{/if}
					{#if canManageJobs}
						<a class={LINK_CLASS} href={resolve('/admin/jobs')}>
							{m.appShell_navManageJobs()}
						</a>
					{/if}
					{#if canManagePosts}
						<a class={LINK_CLASS} href={resolve('/admin/posts')}>
							{m.appShell_navManagePosts()}
						</a>
					{/if}
					{#if canImportResidents}
						<a class={LINK_CLASS} href={resolve('/admin/import')}>
							{m.appShell_navImportResidents()}
						</a>
					{/if}
					{#if canManageInvitations}
						<a class={LINK_CLASS} href={resolve('/admin/invitations')}>
							{m.appShell_navManageInvitations()}
						</a>
					{/if}
					{#if canManageRegistrations}
						<a class={LINK_CLASS} href={resolve('/admin/registrations')}>
							{m.appShell_navManageRegistrations()}
						</a>
					{/if}
					{#if canManageDuesRates}
						<a class={LINK_CLASS} href={resolve('/admin/dues-rates')}>
							{m.appShell_navManageDuesRates()}
						</a>
					{/if}
					{#if canManageCashCategories}
						<a class={LINK_CLASS} href={resolve('/admin/cash-categories')}>
							{m.appShell_navManageCashCategories()}
						</a>
					{/if}
					{#if canRecordOpeningBalance}
						<a class={LINK_CLASS} href={resolve('/admin/opening-balance')}>
							{m.appShell_navRecordOpeningBalance()}
						</a>
					{/if}
					{#if canManageExemptions}
						<a class={LINK_CLASS} href={resolve('/admin/exemptions')}>
							{m.appShell_navManageExemptions()}
						</a>
					{/if}
					{#if canRecordCashTransactions}
						<a class={LINK_CLASS} href={resolve('/admin/cash')}>
							{m.appShell_navRecordCash()}
						</a>
					{/if}
					{#if canReadPeriods}
						<a class={LINK_CLASS} href={resolve('/admin/periods')}>
							{m.appShell_navReadPeriods()}
						</a>
					{/if}
					{#if canReadAllComplaints}
						<a class={LINK_CLASS} href={resolve('/admin/complaints')}>
							{m.appShell_navReadAllComplaints()}
						</a>
					{/if}
					{#if canReadOverdue}
						<a class={LINK_CLASS} href={resolve('/admin/overdue')}>
							{m.appShell_navReadOverdue()}
						</a>
					{/if}
					{#if canVerifyPayments}
						<a class={LINK_CLASS} href={resolve('/admin/payments')}>
							{m.appShell_navVerifyPayments()}
						</a>
					{/if}
					{#if canPublishReports}
						<a class={LINK_CLASS} href={resolve('/admin/reports')}>
							{m.appShell_navPublishReports()}
						</a>
					{/if}
				</div>
			</details>
		{/if}

		<form method="POST" action={resolve('/logout')}>
			<button type="submit" class={LINK_CLASS}>
				{m.appShell_navLogout()}
			</button>
		</form>
	{:else}
		<a class={LINK_CLASS} href={resolve('/login')}>
			{m.appShell_navLogin()}
		</a>
		<a class={LINK_CLASS} href={resolve('/register')}>
			{m.appShell_navRegister()}
		</a>
	{/if}
</nav>
