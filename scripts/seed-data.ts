/**
 * The Data Contoh, as tables. Every name, nominal, day and outcome the seeder writes is here;
 * `scripts/seed-dev.ts` holds the order it writes them in and the service calls that do it.
 *
 * ## Why the data is a separate module
 *
 * Two reasons, and the second is the one that matters.
 *
 * The first is cognitive complexity: a seeder that inlines twenty-five names, thirty-one payments
 * and twenty-six cash lines is one function nobody can read, and splitting the *data* out is what
 * lets the *steps* in `seed-dev.ts` stay short enough to follow.
 *
 * The second is that a table is checkable. Every count the acceptance criteria names — twenty
 * units, twenty-seven residents, thirty-one payments, five of them pending, three units left
 * owing — is a property of the tables below rather than of loop bounds scattered through the
 * seeder, so `tests/unit/seed-dev.test.ts` asserts the shape of these arrays directly and a
 * miscounted row fails before anything touches a database.
 *
 * ## Determinism
 *
 * **There is no `Math.random` here and there must never be one.** Running the seeder twice has to
 * produce the same counts, and a random nominal would make the money invariants the test checks
 * pass or fail by luck. Every value below is written out.
 *
 * Dates are the one thing that is *not* written out, because the whole point of the Data Contoh is
 * that it fills the current WIB month. What the tables carry is a **day of the month** — a small
 * integer — and `seed-dev.ts` turns each one into a calendar day of the month the injected clock is
 * in, clamping it to today so that nothing is ever dated into the future. A payment dated tomorrow
 * is refused by `assertReceiptDay` in `src/lib/server/services/dues/payment.ts`, and a cash row
 * dated forward would make a running balance that has not happened yet.
 *
 * ## Language
 *
 * The values are data a resident reads on a screen — names, keterangan, judul, kategori — so they
 * are Indonesian, the same rule `OPENING_BALANCE_DESCRIPTION` in
 * `src/lib/server/services/cash/opening-balance.ts` states for its own text. The identifiers around
 * them are English, like every other module here.
 */

/**
 * The password every Data Contoh account signs in with.
 *
 * Twenty-two characters, so it clears `MINIMUM_PASSWORD_LENGTH` (12) in
 * `src/lib/server/auth.ts`. It is deliberately a sentence that reads as a placeholder: this seeder
 * refuses to run against anything but a local database (see `assertSeedAllowed`), and a password
 * that looked real would eventually be typed into something that is.
 */
export const SEED_PASSWORD = 'kata-sandi-dummy-123';

/** The superuser account. Holds `superuser` and `admin` — see `seed-dev.ts` for why both. */
export const SUPERUSER_EMAIL = 'superuser@komplek.local';

/** The admin account. Holds `admin`, which is what verifies a Pembayaran and records the buku kas. */
export const ADMIN_EMAIL = 'admin@komplek.local';

/** How many Warga accounts the Data Contoh creates: `warga01@` through `warga25@`. */
export const RESIDENT_COUNT = 25;

/** The monthly Tarif, in whole rupiah. */
export const DUES_AMOUNT = 150_000;

/** The Saldo Awal, in whole rupiah, dated the first of the current month. */
export const OPENING_BALANCE_AMOUNT = 12_500_000;

/** The two blocks the complex is laid out in. */
const BLOCKS = ['A', 'B'] as const;

/** How many houses each block has, giving `A-01`…`A-10` and `B-01`…`B-10`. */
const HOUSES_PER_BLOCK = 10;

/** One house in the register. */
export interface SeedUnit {
	readonly block: string;
	readonly number: string;
	/** `A-01` — how every other table below names this house. */
	readonly label: string;
}

/**
 * The twenty houses, in the order a street sign reads. Built rather than written out because the
 * numbering is genuinely a rule (two blocks of ten, zero-padded) and twenty hand-written rows would
 * be twenty chances to typo one.
 */
export const SEED_UNITS: readonly SeedUnit[] = BLOCKS.flatMap((block) =>
	Array.from({ length: HOUSES_PER_BLOCK }, (_unused, index) => {
		const number = String(index + 1).padStart(2, '0');
		return { block, number, label: `${block}-${number}` };
	})
);

/**
 * The twenty-five Warga, by name, in account order: the first is `warga01@komplek.local`, the last
 * is `warga25@komplek.local`.
 */
export const RESIDENT_NAMES: readonly string[] = [
	'Budi Santoso',
	'Siti Rahayu',
	'Agus Setiawan',
	'Dewi Lestari',
	'Eko Prasetyo',
	'Rina Wulandari',
	'Joko Susilo',
	'Maya Anggraini',
	'Hendra Gunawan',
	'Fitri Handayani',
	'Bambang Wijaya',
	'Ratna Sari',
	'Dian Permata',
	'Yusuf Maulana',
	'Lina Marlina',
	'Rizki Ramadhan',
	'Sri Mulyani',
	'Andi Nugroho',
	'Nurul Aini',
	'Teguh Hariyanto',
	'Indah Puspita',
	'Arif Hidayat',
	'Wulan Sari',
	'Doni Kurniawan',
	'Mega Puspitasari'
];

/**
 * Which house each Warga lives in, by index into `RESIDENT_NAMES`.
 *
 * The first twenty take one house each, in register order. The last five move in as a second
 * occupant of `B-06` through `B-10`, which is the "5 Unit berpenghuni dua" the spec asks for: a
 * household of two is the ordinary case, and a Data Contoh with one person per house would never
 * exercise the screens that list a unit's occupants.
 *
 * `A-01` and `A-02` end up with two occupants as well, because the superuser and the admin are
 * attached to them — see `PENGURUS_UNITS`. They are not counted among the five: those two are
 * pengurus with a `residents` row, not a second Warga household.
 */
export const RESIDENT_UNIT_LABELS: readonly string[] = [
	...SEED_UNITS.map((unit) => unit.label),
	'B-06',
	'B-07',
	'B-08',
	'B-09',
	'B-10'
];

/**
 * The houses the two pengurus accounts are attached to, superuser first.
 *
 * They are Warga of a house because several services attribute an action to a `residents` row
 * rather than to an account: `payments.verifiedBy` and `payments.recordedBy` both reference
 * `residents.id`, and `verifyPayment` refuses an admin without one by name
 * (`VERIFICATION_RULE.actorNotRegistered`). Giving them a house is what makes the Data Contoh's
 * verifications possible at all.
 */
export const PENGURUS_UNITS = ['A-01', 'A-02'] as const;

/** One Kategori Kas the Data Contoh adds on top of the two the migration seeds. */
export interface SeedCashCategory {
	readonly name: string;
	/** `income` or `expense`, as `CASH_CATEGORY_TYPE` spells them. */
	readonly type: string;
}

/**
 * The ordinary Kategori Kas, added through `createCashCategory`.
 *
 * The two system categories — "Iuran warga" and "Saldo awal" — are **not** here: they are seeded by
 * `drizzle/0009_cash_report.sql`, nothing may create one (`createCashCategory` never writes
 * `systemKey`), and the reset step deliberately leaves them alone. See `resetDatabase` in
 * `seed-dev.ts`.
 */
export const SEED_CASH_CATEGORIES: readonly SeedCashCategory[] = [
	{ name: 'Kebersihan', type: 'expense' },
	{ name: 'Keamanan', type: 'expense' },
	{ name: 'Listrik fasilitas', type: 'expense' },
	{ name: 'Perbaikan', type: 'expense' },
	{ name: 'Sumbangan', type: 'income' }
];

/** What one seeded Pembayaran comes to once an admin has looked at it. */
export const PAYMENT_OUTCOME = {
	/** Verified, so its money is allocated and lands in the buku kas. */
	verified: 'verified',
	/** Left waiting on `/admin/payments`, with its proof stored. */
	pending: 'pending',
	/** Turned down with a reason the Warga reads. */
	rejected: 'rejected'
} as const;

/** One of the three outcomes above. */
export type PaymentOutcome = (typeof PAYMENT_OUTCOME)[keyof typeof PAYMENT_OUTCOME];

/** One Pembayaran the Data Contoh records. */
export interface SeedPayment {
	/** The house it is for, as `SeedUnit.label`. */
	readonly unit: string;
	/** Who records it: an index into `RESIDENT_NAMES`. Must be someone living in `unit`. */
	readonly payer: number;
	readonly amount: number;
	/** The day of the current month the money changed hands, clamped to today by the seeder. */
	readonly day: number;
	readonly outcome: PaymentOutcome;
	/** Why it was turned down. Present exactly on a `rejected` row. */
	readonly reason?: string;
}

/** The reason every rejected Data Contoh payment carries, so the wording is written once. */
const REJECTION_REASON =
	'Bukti transfer tidak terbaca. Mohon unggah ulang tangkapan layar yang memuat nominal dan tanggal.';

/**
 * Every Pembayaran, in the order the seeder records and decides them. **The order is load-bearing**
 * for the last two rows: an overpayment only becomes Saldo Titipan if the Tagihan it would
 * otherwise have paid is already covered, so `A-01` and `A-02` must have been paid in full first.
 *
 * ## The shape this table is built to produce
 *
 * | Group | Rows | Effect |
 * |---|---|---|
 * | `A-01`…`A-10`, three of them in two instalments | 13 | ten houses lunas |
 * | `B-01`…`B-04` paying 90.000 of 150.000 | 4 | four houses part-paid, 60.000 outstanding each |
 * | `B-05`…`B-07` paid in full | 3 | three houses lunas |
 * | `A-01`, `A-02` overpaying | 2 | Saldo Titipan of 50.000 each |
 * | `B-05`…`B-07` refused | 3 | a rejection a Warga can read |
 * | five left waiting | 5 | what `/admin/payments` shows |
 *
 * Thirty Pembayaran: twenty-two `verified`, five `pending`, three `rejected`.
 *
 * `B-08`, `B-09` and `B-10` appear nowhere — the three houses that never paid at all, which is the
 * "3 Unit menunggak tanpa Pembayaran" the spec names.
 *
 * ## The four part-paid houses are the point of the pending rows
 *
 * A `pending` Pembayaran allocates nothing — `./credit-balance.ts` counts only `verified` money — so
 * a house whose Tagihan is already covered gains nothing by having one waiting, and
 * `/admin/payments` can only say that the whole amount would become saldo titipan. That is the
 * unusual case, not the ordinary one, and an earlier version of this table produced it five times
 * over because every part-paid house was topped up by a second *verified* payment.
 *
 * So `B-01`…`B-04` are left genuinely short, and the remainder of each is one of the five rows still
 * waiting. Four of the five therefore settle a real Tagihan when an admin verifies them, which is
 * what the verify/reject screen exists for; the fifth (`B-05`) keeps one example of the saldo
 * titipan case on the screen.
 *
 * **The consequence is that `/admin/overdue` lists seven houses, not three** — see
 * `OVERDUE_UNIT_LABELS`. A Tagihan falls due on the fifth, and a house that has paid 90.000 of
 * 150.000 is past due and still owing exactly like one that has paid nothing. The two cannot be
 * separated: any house with a pending remainder is a house that owes money today.
 */
export const SEED_PAYMENTS: readonly SeedPayment[] = [
	// Ten houses that end the month lunas. Three of them paid in two instalments, which is what a
	// household that pays the bulk on payday and the rest later really does.
	{ unit: 'A-01', payer: 0, amount: 100_000, day: 2, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-02', payer: 1, amount: 100_000, day: 2, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-03', payer: 2, amount: 100_000, day: 3, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-04', payer: 3, amount: DUES_AMOUNT, day: 3, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-05', payer: 4, amount: DUES_AMOUNT, day: 4, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-06', payer: 5, amount: DUES_AMOUNT, day: 4, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-07', payer: 6, amount: DUES_AMOUNT, day: 5, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-08', payer: 7, amount: DUES_AMOUNT, day: 5, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-09', payer: 8, amount: DUES_AMOUNT, day: 6, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-10', payer: 9, amount: DUES_AMOUNT, day: 6, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-01', payer: 0, amount: 50_000, day: 7, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-02', payer: 1, amount: 50_000, day: 7, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-03', payer: 2, amount: 50_000, day: 8, outcome: PAYMENT_OUTCOME.verified },

	// Four houses that have paid part of their month. The remainder of each is one of the five
	// Pembayaran still waiting below, so those four give `/admin/payments` a Tagihan to settle.
	{ unit: 'B-01', payer: 10, amount: 90_000, day: 3, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'B-02', payer: 11, amount: 90_000, day: 3, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'B-03', payer: 12, amount: 90_000, day: 4, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'B-04', payer: 13, amount: 90_000, day: 4, outcome: PAYMENT_OUTCOME.verified },

	// Three houses that paid in full after a first attempt was refused, below.
	{ unit: 'B-05', payer: 14, amount: DUES_AMOUNT, day: 10, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'B-06', payer: 15, amount: DUES_AMOUNT, day: 10, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'B-07', payer: 16, amount: DUES_AMOUNT, day: 11, outcome: PAYMENT_OUTCOME.verified },

	// Two overpayments. Their houses are already lunas above, so every rupiah becomes Saldo Titipan.
	{ unit: 'A-01', payer: 0, amount: 50_000, day: 12, outcome: PAYMENT_OUTCOME.verified },
	{ unit: 'A-02', payer: 1, amount: 50_000, day: 12, outcome: PAYMENT_OUTCOME.verified },

	// Three refused, each with the reason the Warga reads on their own payment list.
	{
		unit: 'B-05',
		payer: 14,
		amount: DUES_AMOUNT,
		day: 7,
		outcome: PAYMENT_OUTCOME.rejected,
		reason: REJECTION_REASON
	},
	{
		unit: 'B-06',
		payer: 15,
		amount: DUES_AMOUNT,
		day: 7,
		outcome: PAYMENT_OUTCOME.rejected,
		reason: REJECTION_REASON
	},
	{
		unit: 'B-07',
		payer: 16,
		amount: DUES_AMOUNT,
		day: 8,
		outcome: PAYMENT_OUTCOME.rejected,
		reason: REJECTION_REASON
	},

	// Five still waiting — what an admin opens `/admin/payments` to decide. Four of them are the
	// remainder of a house that has paid part of its month, so the deciding screen shows a real
	// Tagihan to settle; the fifth is for a house that is already lunas, which is the other case that
	// screen has to explain ("seluruh nominal menjadi saldo titipan").
	{ unit: 'B-01', payer: 10, amount: 60_000, day: 13, outcome: PAYMENT_OUTCOME.pending },
	{ unit: 'B-02', payer: 11, amount: 60_000, day: 13, outcome: PAYMENT_OUTCOME.pending },
	{ unit: 'B-03', payer: 12, amount: 60_000, day: 14, outcome: PAYMENT_OUTCOME.pending },
	{ unit: 'B-04', payer: 13, amount: 60_000, day: 14, outcome: PAYMENT_OUTCOME.pending },
	{ unit: 'B-05', payer: 14, amount: DUES_AMOUNT, day: 15, outcome: PAYMENT_OUTCOME.pending }
];

/** The houses the table above leaves without a single Pembayaran. */
export const UNPAID_UNIT_LABELS = ['B-08', 'B-09', 'B-10'] as const;

/**
 * Every house `/admin/overdue` lists, which is **not** the same set as `UNPAID_UNIT_LABELS`.
 *
 * `listOverdueUnits` in `src/lib/server/services/dues/queries.ts` calls a house menunggak when a
 * Tagihan of its own is past its due date and still owes money — whether or not anybody has paid
 * anything towards it. So the four houses that have paid 90.000 of 150.000 are on that list beside
 * the three that have paid nothing: they owe 60.000 each until the Pembayaran waiting on
 * `/admin/payments` is verified, which is exactly the state that makes those pending rows worth
 * deciding.
 *
 * Seven rather than three is a deliberate change from the first version of this table, where the
 * four part-paid houses were topped up by a second *verified* payment. That left every pending
 * Pembayaran belonging to a house with nothing outstanding, so `/admin/payments` explained five
 * times over that the whole amount would become saldo titipan and never once showed the ordinary
 * case the verify screen exists for.
 */
export const OVERDUE_UNIT_LABELS = [
	'B-01',
	'B-02',
	'B-03',
	'B-04',
	'B-08',
	'B-09',
	'B-10'
] as const;

/** What the verified Pembayaran above add up to, and therefore what reaches the buku kas as iuran. */
export const TOTAL_VERIFIED_PAYMENTS = 2_410_000;

/** One Transaksi Kas keluar the Data Contoh records. */
export interface SeedCashExpense {
	/** The Kategori Kas it is filed under, by `SeedCashCategory.name`. */
	readonly category: string;
	readonly amount: number;
	readonly description: string;
	/** The day of the current month the money moved, clamped to today by the seeder. */
	readonly day: number;
}

/** The four ordinary expense categories, named once so the table below cannot misspell one. */
const CLEANING = 'Kebersihan';
const SECURITY = 'Keamanan';
const ELECTRICITY = 'Listrik fasilitas';
const REPAIRS = 'Perbaikan';

/**
 * Twenty-six Transaksi Kas keluar spread across the current month — a komplek's ordinary outgoings,
 * so that the buku kas, the running balance and the per-category figures on a Laporan Bulanan all
 * have something real to show.
 *
 * Twenty-six rather than the twenty-five the spec asks for: the seeder corrects one of them (see
 * `CORRECTED_EXPENSE_INDEX`), and a reader counting expense lines should still find at least
 * twenty-five that were not a mistake. The corrected row itself stays — the buku kas is append-only
 * — and its Koreksi is an `income` row, so the expense count is unaffected either way.
 */
export const SEED_CASH_EXPENSES: readonly SeedCashExpense[] = [
	{ category: CLEANING, amount: 600_000, description: 'Honor petugas kebersihan pekan 1', day: 2 },
	{ category: SECURITY, amount: 750_000, description: 'Honor satpam pekan 1', day: 2 },
	{ category: ELECTRICITY, amount: 420_000, description: 'Listrik lampu jalan blok A', day: 3 },
	{ category: REPAIRS, amount: 260_000, description: 'Perbaikan engsel gerbang depan', day: 3 },
	{ category: CLEANING, amount: 185_000, description: 'Pembelian kantong sampah besar', day: 4 },
	{ category: SECURITY, amount: 120_000, description: 'Penggantian senter pos jaga', day: 4 },
	{ category: ELECTRICITY, amount: 280_000, description: 'Listrik pompa air taman', day: 5 },
	{ category: REPAIRS, amount: 500_000, description: 'Pengecatan pos satpam', day: 5 },
	{ category: CLEANING, amount: 600_000, description: 'Honor petugas kebersihan pekan 2', day: 6 },
	{ category: SECURITY, amount: 750_000, description: 'Honor satpam pekan 2', day: 6 },
	{ category: REPAIRS, amount: 190_000, description: 'Perbaikan keran taman bermain', day: 7 },
	{ category: CLEANING, amount: 145_000, description: 'Sewa gerobak sampah tambahan', day: 7 },
	{ category: ELECTRICITY, amount: 210_000, description: 'Listrik balai warga', day: 8 },
	{ category: SECURITY, amount: 75_000, description: 'Buku tamu dan alat tulis pos jaga', day: 8 },
	{ category: CLEANING, amount: 600_000, description: 'Honor petugas kebersihan pekan 3', day: 9 },
	{ category: REPAIRS, amount: 850_000, description: 'Perbaikan saluran air blok B', day: 10 },
	{ category: SECURITY, amount: 750_000, description: 'Honor satpam pekan 3', day: 10 },
	{
		category: ELECTRICITY,
		amount: 185_000,
		description: 'Penggantian lampu jalan blok B',
		day: 11
	},
	{ category: CLEANING, amount: 210_000, description: 'Pembelian sapu dan pengki', day: 12 },
	{ category: REPAIRS, amount: 380_000, description: 'Perbaikan atap pos ronda', day: 12 },
	{ category: SECURITY, amount: 170_000, description: 'Servis palang pintu masuk', day: 13 },
	{ category: CLEANING, amount: 600_000, description: 'Honor petugas kebersihan pekan 4', day: 14 },
	{ category: ELECTRICITY, amount: 320_000, description: 'Listrik lampu taman bermain', day: 15 },
	{ category: SECURITY, amount: 750_000, description: 'Honor satpam pekan 4', day: 16 },
	{ category: REPAIRS, amount: 95_000, description: 'Pembelian gembok pagar samping', day: 17 },
	{
		category: CLEANING,
		amount: 175_000,
		description: 'Pembelian cairan pembersih saluran',
		day: 18
	}
];

/**
 * What the twenty-six rows above add up to: 10.170.000.
 *
 * Written down rather than left implicit because it is half of the arithmetic that keeps the buku
 * kas solvent, and `tests/unit/seed-dev.test.ts` checks the table still sums to it. The other half
 * is the money coming in: 12.500.000 Saldo Awal, 2.410.000 of verified iuran (see `SEED_PAYMENTS`)
 * and the 260.000 the Koreksi puts back — 15.170.000 in all, leaving a closing Saldo kas of
 * 5.000.000 and a running balance that never drops below about 7.000.000 mid-month.
 *
 * ## Why these amounts, and why the fix is here rather than on the Saldo Awal
 *
 * The first version of this table paid a twenty-house komplek 1.800.000 a week for satpam and
 * 1.200.000 a week for kebersihan, which came to 19.250.000 of expenses against 15.150.000 of
 * income: the running balance went negative around the fifteenth and the month closed at
 * -3.750.000. A komplek cannot pay out cash it does not hold, so `/admin/cash` showed a negative
 * "Saldo akhir" and the Beranda card a negative Saldo kas — which is not a cash book anybody can
 * learn the screens from, and not the "saldo berjalan masuk akal" `docs/spec-data-contoh-v1.md`
 * story 7 asks for.
 *
 * Raising `OPENING_BALANCE_AMOUNT` would have hidden the real problem rather than fixed it: the
 * outgoings were about six times a twenty-house complex's monthly iuran income, and the Saldo Awal
 * is a figure the spec fixes at 12.500.000. So the weekly honor and the two largest repairs carry
 * most of the reduction instead. Every row keeps its category, its keterangan and its day.
 */
export const TOTAL_CASH_EXPENSES = 10_170_000;

/**
 * Which row of `SEED_CASH_EXPENSES` the Data Contoh corrects, and the alasan the Koreksi carries.
 *
 * One Koreksi, because a buku kas with no correction in it never shows the screen that explains how
 * a mistake is put right — and because `recordCashCorrection` refuses a second one on the same row,
 * so the example has to point somewhere specific.
 */
export const CORRECTED_EXPENSE_INDEX = 3;

/** The alasan the one seeded Koreksi carries. */
export const CORRECTION_REASON =
	'Nominal keliru: perbaikan engsel gerbang dibayar tunai oleh warga, bukan dari kas komplek.';

/** One Post the Data Contoh writes. */
export interface SeedPost {
	/** `event` or `announcement`, as `POST_TYPE` spells them. */
	readonly type: string;
	readonly title: string;
	readonly summary: string;
	readonly bodyHtml: string;
	/** One of `POST_CATEGORIES` in `src/lib/server/services/post/index.ts`. */
	readonly category: string;
	/** The day of the current month an event starts. Absent on an announcement. */
	readonly startDay?: number;
	/** `HH:mm` in WIB. Present exactly when `startDay` is. */
	readonly startTime?: string;
	/** `HH:mm` in WIB, when the event has an end. */
	readonly endTime?: string;
	readonly location?: string;
	/** What the seeder leaves the Post as: `draft`, `published` or `archived`. */
	readonly status: string;
	/** Whether a small PNG is attached as the Sampul. */
	readonly cover?: boolean;
}

/**
 * Six Posts: four terbit, one draf and one arsip, with three of them kegiatan that start inside the
 * current month.
 *
 * `createPost` always writes a `draft` — status is never a field a caller sends — so the seeder
 * reaches the other two states the way an admin does, through `publishPost` and then `archivePost`.
 * The `status` below is therefore the state the seeder *leaves* each Post in, not something handed
 * to the service.
 */
export const SEED_POSTS: readonly SeedPost[] = [
	{
		type: 'event',
		title: 'Kerja bakti bulanan',
		summary: 'Membersihkan saluran air dan taman bermain bersama-sama.',
		bodyHtml:
			'<p>Warga diharapkan berkumpul di balai warga dengan membawa alat kebersihan seadanya. Konsumsi disediakan panitia.</p>',
		category: 'kerja-bakti',
		startDay: 21,
		startTime: '07:00',
		endTime: '10:00',
		location: 'Balai warga',
		status: 'published',
		cover: true
	},
	{
		type: 'event',
		title: 'Posyandu balita',
		summary: 'Penimbangan, imunisasi, dan pemberian vitamin A untuk balita.',
		bodyHtml:
			'<p>Membawa buku KIA. Pendaftaran dibuka pukul 08.00 dan pelayanan dimulai pukul 08.30.</p>',
		category: 'posyandu',
		startDay: 23,
		startTime: '08:00',
		endTime: '11:00',
		location: 'Pos RW',
		status: 'published',
		cover: true
	},
	{
		type: 'event',
		title: 'Rapat warga triwulan',
		summary: 'Membahas laporan keuangan dan rencana perbaikan jalan lingkungan.',
		bodyHtml:
			'<p>Agenda: laporan kas, usulan perbaikan jalan, dan pemilihan panitia perayaan. Setiap rumah diwakili satu orang.</p>',
		category: 'rapat',
		startDay: 26,
		startTime: '19:30',
		endTime: '21:00',
		location: 'Balai warga',
		status: 'published'
	},
	{
		type: 'announcement',
		title: 'Jadwal pengangkutan sampah berubah',
		summary: 'Mulai pekan depan pengangkutan dilakukan Selasa dan Jumat pagi.',
		bodyHtml:
			'<p>Mohon meletakkan sampah di depan rumah sebelum pukul 06.00 pada hari pengangkutan.</p>',
		category: 'umum',
		status: 'published'
	},
	{
		type: 'announcement',
		title: 'Rencana pemasangan CCTV di pintu masuk',
		summary: 'Usulan masih dibahas pengurus dan belum final.',
		bodyHtml:
			'<p>Perkiraan biaya dan lokasi pemasangan akan disampaikan pada rapat warga berikutnya.</p>',
		category: 'umum',
		status: 'draft'
	},
	{
		type: 'announcement',
		title: 'Perayaan tujuh belasan tahun lalu',
		summary: 'Dokumentasi dan laporan panitia perayaan kemerdekaan.',
		bodyHtml:
			'<p>Terima kasih kepada seluruh warga yang telah berpartisipasi. Laporan panitia sudah dibagikan.</p>',
		category: 'perayaan',
		status: 'archived'
	}
];

/** One Keluhan the Data Contoh files. */
export interface SeedComplaint {
	/** Who reports it: an index into `RESIDENT_NAMES`. */
	readonly reporter: number;
	readonly title: string;
	readonly category: string;
	readonly description: string;
	/** `private` or `public`, as `COMPLAINT_VISIBILITY` spells them. */
	readonly visibility: string;
	/** The status the seeder leaves it in, reached through the legal transitions. */
	readonly status: string;
	/** Whether a small PNG is attached to it. */
	readonly attachment?: boolean;
	/** A Tanggapan from the pengurus, when the seeder adds one. */
	readonly reply?: string;
}

/** The alasan the one rejected Keluhan carries. Rejecting without one is refused by the service. */
export const COMPLAINT_REJECTION_REASON =
	'Tiang listrik di luar pagar komplek merupakan kewenangan PLN, bukan pengurus komplek.';

/**
 * Ten Keluhan covering every one of the six statuses, four of them `public`.
 *
 * `createComplaint` always writes `new`, and `src/lib/server/services/complaint/state-machine.ts`
 * allows only `new → reviewing → working → resolved`, `→ rejected` from any open status, and
 * `→ withdrawn` from `new` by the reporter alone. The seeder walks each row to its `status` through
 * those edges, so nothing here can ask for a move the application itself would refuse.
 *
 * `visibility` is set at creation because `setComplaintVisibility` only ever *lowers* it —
 * `COMPLAINT_RULE.visibilityOnlyLowers` — so a Keluhan that should be readable by every Warga has to
 * be born that way.
 */
export const SEED_COMPLAINTS: readonly SeedComplaint[] = [
	{
		reporter: 0,
		title: 'Lampu jalan depan A-03 mati',
		category: 'Fasilitas umum',
		description: 'Sudah tiga malam gelap total, rawan untuk yang pulang larut.',
		visibility: 'public',
		status: 'new',
		attachment: true
	},
	{
		reporter: 3,
		title: 'Sampah menumpuk di ujung blok B',
		category: 'Kebersihan',
		description: 'Pengangkutan terlewat pekan ini dan baunya sudah tercium sampai rumah.',
		visibility: 'public',
		status: 'new'
	},
	{
		reporter: 5,
		title: 'Saluran air tersumbat di B-04',
		category: 'Saluran air',
		description: 'Air meluap ke jalan setiap hujan deras lebih dari sepuluh menit.',
		visibility: 'public',
		status: 'reviewing',
		reply: 'Terima kasih laporannya. Pengurus akan meninjau lokasi akhir pekan ini.'
	},
	{
		reporter: 8,
		title: 'Portal masuk sulit dibuka',
		category: 'Keamanan',
		description: 'Palang tersangkut dan harus diangkat manual oleh petugas.',
		visibility: 'private',
		status: 'reviewing'
	},
	{
		reporter: 10,
		title: 'Cat pos ronda mengelupas',
		category: 'Fasilitas umum',
		description: 'Kayu mulai lapuk di bagian bawah, sebaiknya dicat ulang sebelum musim hujan.',
		visibility: 'public',
		status: 'working',
		reply: 'Sudah dijadwalkan bersamaan dengan kerja bakti bulan ini.'
	},
	{
		reporter: 12,
		title: 'Keran taman bermain bocor',
		category: 'Fasilitas umum',
		description: 'Air terus menetes sepanjang hari dan menggenang di bawah ayunan.',
		visibility: 'private',
		status: 'working'
	},
	{
		reporter: 14,
		title: 'Pagar samping tidak terkunci semalam',
		category: 'Keamanan',
		description: 'Gembok hilang dan pagar terbuka sampai pagi.',
		visibility: 'private',
		status: 'resolved',
		reply: 'Gembok baru sudah dipasang dan kuncinya dipegang petugas jaga.'
	},
	{
		reporter: 16,
		title: 'Rumput taman terlalu tinggi',
		category: 'Kebersihan',
		description: 'Sudah setinggi lutut dan mulai banyak nyamuk di sore hari.',
		visibility: 'private',
		status: 'resolved'
	},
	{
		reporter: 18,
		title: 'Tiang listrik miring di luar pagar',
		category: 'Keamanan',
		description: 'Tiang di seberang gerbang terlihat miring setelah angin kencang.',
		visibility: 'private',
		status: 'rejected',
		reply: 'Laporan diteruskan ke PLN melalui pengurus RW.'
	},
	{
		reporter: 20,
		title: 'Salah kirim laporan',
		category: 'Lainnya',
		description: 'Laporan ini dikirim dua kali karena salah tekan.',
		visibility: 'private',
		status: 'withdrawn'
	}
];

/** One optional Langganan the Data Contoh switches on for a Warga. */
export interface SeedSubscriptionOptIn {
	/** Who: an index into `RESIDENT_NAMES`. */
	readonly resident: number;
	/** The kind, as `SUBSCRIPTION_KIND` spells it. Only a non-mandatory one belongs here. */
	readonly kind: string;
}

/**
 * The optional Langganan a handful of Warga opt into.
 *
 * Only the three non-mandatory kinds can appear: `ensureDefaultSubscriptions` already switches the
 * mandatory ones on for every Warga when their `residents` row is created, and
 * `setSubscriptionPreference` refuses to turn one of those off.
 */
export const SEED_SUBSCRIPTION_OPT_INS: readonly SeedSubscriptionOptIn[] = [
	{ resident: 0, kind: 'monthly-report' },
	{ resident: 0, kind: 'new-post' },
	{ resident: 2, kind: 'monthly-report' },
	{ resident: 4, kind: 'new-post' },
	{ resident: 6, kind: 'monthly-report' },
	{ resident: 8, kind: 'new-post' },
	{ resident: 10, kind: 'monthly-report' }
];

/**
 * A 1×1 PNG, base64.
 *
 * Every image the Data Contoh stores is this one. It is a real PNG rather than arbitrary bytes
 * because three services check the magic number before they accept an upload — `proofKeyFor` in
 * `dues/payment.ts`, `assertAcceptableCoverImage` in `post/index.ts` and
 * `storeComplaintAttachments` in `complaint/attachment.ts` all compare the first eight bytes against
 * `89 50 4E 47 0D 0A 1A 0A` — and a seeder that fed them a placeholder would be refused by name.
 *
 * Seventy bytes, so a seeded database carries a few kilobytes of images rather than a few megabytes.
 */
const SMALL_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** The content type every seeded image is uploaded as. */
export const SMALL_PNG_CONTENT_TYPE = 'image/png';

/**
 * The bytes of `SMALL_PNG_BASE64`.
 *
 * A fresh `Uint8Array` on every read, so that a caller handing it to a `FileStore` — which may keep
 * the array it is given — cannot be reached through it by the next caller.
 */
export function smallPngBytes(): Uint8Array {
	return Uint8Array.from(Buffer.from(SMALL_PNG_BASE64, 'base64'));
}
