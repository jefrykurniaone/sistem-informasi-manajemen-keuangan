import { redirect } from '@sveltejs/kit';
import type { Pathname } from '$app/types';
import { MENU } from '$lib/components/app-shell/menu';
import { formatRupiah } from '$lib/money';
import * as m from '$lib/paraglide/messages';
import { AUTH_PATHS } from '$lib/server/auth';
import { isAllowed, rolesOf } from '$lib/server/authz';
import { database } from '$lib/server/db';
import type { Role } from '$lib/server/db/schema/authz';
import type { JobRunStatus } from '$lib/server/db/schema/scheduler';
import { systemClock } from '$lib/server/ports/clock';
import {
	adminDashboard,
	residentDashboard,
	type AdminDashboard,
	type CashSummary,
	type DashboardInvoiceSummary,
	type JobStatusSummary,
	type LatestPost,
	type OpenComplaintCounts,
	type PendingPaymentsSummary,
	type ResidentDashboard,
	type ResidentUnitSummary
} from '$lib/server/services/dashboard';
import { residentProfileForUser } from '$lib/server/services/resident/profile';
import { COMPLEX_TIME_ZONE, formatDateTime } from '$lib/time';
import type { PageServerLoad } from './$types';

/**
 * The Beranda: one route, two loads — `docs/spec-shell-beranda-v1.md`'s "Beranda adalah satu rute
 * dengan dua muatan". Nobody without a session reaches either one, and every figure on the page is
 * formatted here, never in `+page.svelte`, so the component only ever renders text it was handed.
 *
 * **Admin or resident is decided the same way the sidebar decides what to show**, not by a role
 * name: `holdsAnyGatedMenuAction` reads `MENU` and calls `isAllowed` exactly as `visibleMenu` in
 * `$lib/components/app-shell/menu.ts` does, because "pemegang izin mengelola apa pun" is the same
 * question the sidebar already answers for every gated item at once.
 *
 * **The figures come from `$lib/server/services/dashboard`, never recomputed here.** That module's
 * own doc comment settles why: "Beranda harus memakai definisi yang sama, bukan menghitung ulang di
 * rute." One consequence worth naming: `AdminDashboard.invoices.overdueCount` is this WIB month's
 * overdue Tagihan, the same figure `monthInvoiceSummary` computes for "Tagihan terbit, lunas,
 * menunggak" — it is not the all-time, all-period count `listOverdueUnits` totals for
 * `/admin/overdue` (a house can be overdue on a Tagihan from an earlier month that this month's
 * figure never sees). The ticket's card uses the month figure, because that is the one the
 * dashboard service exposes and the one the spec's Tagihan bullet describes; the two numbers agree
 * only when every currently-overdue Tagihan happens to have been issued this month.
 */

/** One Beranda card, already formatted — `stat-card.svelte` only ever renders these fields. */
interface StatCard {
	readonly key: string;
	readonly value: string;
	readonly label: string;
	readonly detail?: string;
	readonly href: Pathname;
	readonly variant?: 'warning';
}

/** One Warga's house: its two cards, and the label above them when there is more than one house. */
interface ResidentUnitCards {
	readonly unitId: string;
	readonly unitLabel: string | null;
	readonly invoiceCard: StatCard;
	readonly creditCard: StatCard;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, AUTH_PATHS.login);
	}

	const db = database();
	const roles = await rolesOf(db, locals.user.id);

	if (holdsAnyGatedMenuAction(roles)) {
		const dashboard = await adminDashboard(db, systemClock, locals.user.id);
		const month = monthLabel(dashboard.month);
		return {
			role: 'admin' as const,
			pageTitle: m.dashboard_adminPageTitle({ month }),
			heading: m.dashboard_adminHeading(),
			subheading: m.dashboard_adminSubheading({ month }),
			cards: adminCards(dashboard)
		};
	}

	const profile = await residentProfileForUser(db, locals.user.id);
	// A signed-in account with no `residents` row cannot reach this branch in practice — the `(app)`
	// group's own layout load already sends an account that is neither admin/superuser nor a
	// resident to `/pending-approval` before this ever runs — but the fallback here still answers
	// the empty Beranda the dashboard service itself defines for `hasUnit: false`, rather than
	// asking `residentDashboard` to look up a `residents.id` this account does not have.
	const dashboard: ResidentDashboard = profile
		? await residentDashboard(db, systemClock, profile.residentId)
		: { units: [], hasUnit: false, complaints: [], latestPosts: [] };

	return {
		role: 'resident' as const,
		pageTitle: m.dashboard_residentPageTitle(),
		heading: m.dashboard_residentHeading(),
		subheading: m.dashboard_residentSubheading(),
		hasUnit: dashboard.hasUnit,
		units: dashboard.units.map((unit) => residentUnitCards(unit, dashboard.units.length > 1)),
		complaints: dashboard.complaints,
		postsCard: postsCard(dashboard.latestPosts, '/posts')
	};
};

/**
 * Whether `roles` may open at least one gated menu item — `docs/spec-shell-beranda-v1.md`'s
 * "pemegang izin mengelola apa pun mendapat ringkasan pengurus, selainnya ringkasan warga". `MENU`
 * and `isAllowed` are the exact two pieces `visibleMenu` in `menu.ts` already combines for the
 * sidebar; this reads them the same way instead of writing a second rule that could drift from it.
 */
function holdsAnyGatedMenuAction(roles: ReadonlySet<Role>): boolean {
	return MENU.some((group) =>
		group.items.some((item) => item.action !== null && isAllowed(roles, item.action))
	);
}

const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat('id-ID', {
	month: 'long',
	year: 'numeric',
	timeZone: COMPLEX_TIME_ZONE
});

/** `"2026-09"` read as `"September 2026"` — the WIB month `adminDashboard` already picked. */
function monthLabel(month: string): string {
	const [year, monthNumber] = month.split('-').map(Number);
	// Day 15: never near a month boundary, whatever the zone's own offset, so the formatted month
	// can never slip to the one before or after.
	return MONTH_LABEL_FORMAT.format(new Date(Date.UTC(year, monthNumber - 1, 15)));
}

/** The pengurus Beranda's cards, in the order `spec-shell-beranda-v1.md`'s Rancangan lists them. */
function adminCards(dashboard: AdminDashboard): readonly StatCard[] {
	const cards: StatCard[] = [
		invoicesCard(dashboard.invoices),
		pendingPaymentsCard(dashboard.pendingPayments)
	];
	if (dashboard.cash) {
		cards.push(cashCard(dashboard.cash));
	}
	cards.push(complaintsCard(dashboard.complaints));
	cards.push(postsCard(dashboard.latestPosts, '/admin/posts'));
	if (dashboard.jobs) {
		cards.push(jobsCard(dashboard.jobs));
	}
	return cards;
}

function invoicesCard(invoices: DashboardInvoiceSummary): StatCard {
	return {
		key: 'invoices',
		value: formatRupiah(invoices.overdueAmount),
		label: m.dashboard_adminInvoicesLabel(),
		detail: m.dashboard_adminInvoicesDetail({
			issuedCount: invoices.issuedCount,
			issuedAmount: formatRupiah(invoices.issuedAmount),
			paidCount: invoices.paidCount,
			paidAmount: formatRupiah(invoices.paidAmount)
		}),
		href: '/admin/overdue',
		variant: invoices.overdueCount > 0 ? 'warning' : undefined
	};
}

function pendingPaymentsCard(pending: PendingPaymentsSummary): StatCard {
	return {
		key: 'pendingPayments',
		value: formatRupiah(pending.amount),
		label: m.dashboard_adminPendingLabel(),
		detail: m.dashboard_adminPendingDetail({ count: pending.count }),
		href: '/admin/payments',
		variant: pending.count > 0 ? 'warning' : undefined
	};
}

function cashCard(cash: CashSummary): StatCard {
	return {
		key: 'cash',
		value: formatRupiah(cash.balance),
		label: m.dashboard_adminCashLabel(),
		detail: m.dashboard_adminCashDetail({
			income: formatRupiah(cash.incomeThisMonth),
			expense: formatRupiah(cash.expenseThisMonth)
		}),
		href: '/admin/cash'
	};
}

function complaintsCard(complaints: OpenComplaintCounts): StatCard {
	const total = complaints.new + complaints.reviewing + complaints.working;
	return {
		key: 'complaints',
		value: String(total),
		label: m.dashboard_adminComplaintsLabel(),
		detail: m.dashboard_adminComplaintsDetail({
			newCount: complaints.new,
			reviewingCount: complaints.reviewing,
			workingCount: complaints.working
		}),
		href: '/admin/complaints'
	};
}

/** The "3 Post terbaru" card, shared by both roles — only the destination link differs. */
function postsCard(posts: readonly LatestPost[], href: Pathname): StatCard {
	const [latest, ...rest] = posts;
	return {
		key: 'posts',
		value: latest ? latest.title : m.dashboard_postsEmpty(),
		label: m.dashboard_postsLabel(),
		detail: rest.length > 0 ? rest.map((post) => post.title).join(' · ') : undefined,
		href
	};
}

const JOB_STATUS_LABEL: Readonly<Record<JobRunStatus, () => string>> = {
	running: m.dashboard_jobStatus_running,
	succeeded: m.dashboard_jobStatus_succeeded,
	failed: m.dashboard_jobStatus_failed
};

/**
 * The "job terakhir" card. `jobs` is never `null` here — the caller only pushes this card when
 * `AdminDashboard.jobs` is not `null` — but it can be `[]` (nothing registered yet) or hold jobs
 * that have never run, and both read as their own state rather than a bare empty card.
 */
function jobsCard(jobs: readonly JobStatusSummary[]): StatCard {
	if (jobs.length === 0) {
		return {
			key: 'jobs',
			value: m.dashboard_adminJobsEmptyValue(),
			label: m.dashboard_adminJobsEmptyLabel(),
			href: '/admin/jobs'
		};
	}

	const latest = mostRecentlyRunJob(jobs);
	if (!latest || latest.lastRunAt === null) {
		return {
			key: 'jobs',
			value: m.dashboard_adminJobsNeverRun(),
			label: m.dashboard_adminJobsEmptyLabel(),
			href: '/admin/jobs'
		};
	}

	return {
		key: 'jobs',
		value: formatDateTime(latest.lastRunAt),
		label: m.dashboard_adminJobsLabel({ name: latest.name }),
		detail: latest.status ? JOB_STATUS_LABEL[latest.status]() : undefined,
		href: '/admin/jobs'
	};
}

/** The job whose `lastRunAt` is latest, or `undefined` when none of them has ever run. */
function mostRecentlyRunJob(jobs: readonly JobStatusSummary[]): JobStatusSummary | undefined {
	let latest: JobStatusSummary | undefined;
	for (const job of jobs) {
		if (job.lastRunAt === null) {
			continue;
		}
		if (!latest || latest.lastRunAt === null || job.lastRunAt > latest.lastRunAt) {
			latest = job;
		}
	}
	return latest;
}

/**
 * One house's two cards. `showLabel` is `false` for a Warga recorded on exactly one house, the same
 * `showUnit` reading `(app)/invoices/+page.svelte` already gives — repeating a label that names the
 * only house on the page adds nothing.
 */
function residentUnitCards(unit: ResidentUnitSummary, showLabel: boolean): ResidentUnitCards {
	return {
		unitId: unit.unitId,
		unitLabel: showLabel ? unit.label : null,
		invoiceCard: {
			key: `${unit.unitId}-invoices`,
			value: formatRupiah(unit.openInvoices.amount),
			label: m.dashboard_residentInvoicesLabel(),
			detail: m.dashboard_residentInvoicesDetail({ count: unit.openInvoices.count }),
			href: '/invoices',
			variant: unit.openInvoices.overdueCount > 0 ? 'warning' : undefined
		},
		creditCard: {
			key: `${unit.unitId}-credit`,
			value: formatRupiah(unit.creditBalance),
			label: m.dashboard_residentCreditLabel(),
			// No dedicated Saldo Titipan screen exists yet, so this points at the one resident-facing
			// finance screen there is — the same house's Tagihan.
			href: '/invoices'
		}
	};
}
