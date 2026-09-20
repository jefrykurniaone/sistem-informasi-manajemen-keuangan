import { database } from '$lib/server/db';
import { ACTION, isAllowed, rolesOf } from '$lib/server/authz';
import type { LayoutServerLoad } from './$types';

/**
 * What the app shell in `+layout.svelte` needs to decide which menu items to render.
 *
 * **This never decides what a request is allowed to do.** `isAllowed` is the same pure table
 * `src/lib/server/authz.ts` uses inside `requirePermission`, consulted here read-only to choose
 * what a link *shows*; the guard on each page — see `src/routes/(app)/admin/roles/+page.server.ts`
 * — remains the only place a request is actually let through or refused. Hiding a menu item is a
 * convenience for someone who could not use it anyway, never the reason it was refused.
 *
 * One `rolesOf` read still answers every flag below, `isAllowed` decides each one against
 * `PERMISSIONS` — never by comparing a role's name — so an action held by more than one role
 * (`ACTION.readPeriods`, `ACTION.readAllComplaints`) is answered correctly with no special case.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	const { user } = locals;
	if (!user) {
		return {
			signedIn: false,
			canManageRoles: false,
			canManageUnits: false,
			canManageJobs: false,
			canManagePosts: false,
			canImportResidents: false,
			canManageInvitations: false,
			canManageRegistrations: false,
			canManageDuesRates: false,
			canManageCashCategories: false,
			canRecordOpeningBalance: false,
			canManageExemptions: false,
			canRecordCashTransactions: false,
			canReadPeriods: false,
			canReadAllComplaints: false,
			canReadOverdue: false,
			canVerifyPayments: false,
			canPublishReports: false
		};
	}

	const roles = await rolesOf(database(), user.id);
	return {
		signedIn: true,
		canManageRoles: isAllowed(roles, ACTION.manageRoles),
		canManageUnits: isAllowed(roles, ACTION.manageUnits),
		canManageJobs: isAllowed(roles, ACTION.manageJobs),
		canManagePosts: isAllowed(roles, ACTION.managePosts),
		canImportResidents: isAllowed(roles, ACTION.importResidents),
		canManageInvitations: isAllowed(roles, ACTION.manageInvitations),
		canManageRegistrations: isAllowed(roles, ACTION.manageRegistrations),
		canManageDuesRates: isAllowed(roles, ACTION.manageDuesRates),
		canManageCashCategories: isAllowed(roles, ACTION.manageCashCategories),
		canRecordOpeningBalance: isAllowed(roles, ACTION.recordOpeningBalance),
		canManageExemptions: isAllowed(roles, ACTION.manageExemptions),
		canRecordCashTransactions: isAllowed(roles, ACTION.recordCashTransactions),
		canReadPeriods: isAllowed(roles, ACTION.readPeriods),
		canReadAllComplaints: isAllowed(roles, ACTION.readAllComplaints),
		canReadOverdue: isAllowed(roles, ACTION.readOverdue),
		canVerifyPayments: isAllowed(roles, ACTION.verifyPayments),
		canPublishReports: isAllowed(roles, ACTION.publishReports)
	};
};
