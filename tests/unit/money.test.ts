import { describe, expect, it } from 'vitest';
import { formatRupiah, rupiah, uraiRupiah, type Rupiah } from '$lib/money';

describe('rupiah', () => {
	it.each([
		{ nama: 'nol', masukan: 0 },
		{ nama: 'satu rupiah', masukan: 1 },
		{ nama: 'iuran sebulan', masukan: 150_000 },
		{ nama: 'nilai negatif untuk koreksi kas', masukan: -25_000 },
		{ nama: 'batas aman number', masukan: Number.MAX_SAFE_INTEGER }
	])('menerima $nama', ({ masukan }) => {
		expect(rupiah(masukan)).toBe(masukan);
	});

	it.each([
		{ nama: 'pecahan setengah rupiah', masukan: 150.5 },
		{ nama: 'pecahan sepersen', masukan: 1.01 },
		{ nama: 'pecahan sangat kecil', masukan: 1.000000001 },
		{ nama: 'bukan bilangan', masukan: Number.NaN },
		{ nama: 'tak hingga', masukan: Number.POSITIVE_INFINITY }
	])('menolak $nama tanpa membulatkannya', ({ masukan }) => {
		expect(() => rupiah(masukan)).toThrow(TypeError);
	});

	it.each([
		{ nama: 'di atas batas aman', masukan: Number.MAX_SAFE_INTEGER + 2 },
		{ nama: 'di bawah batas aman', masukan: Number.MIN_SAFE_INTEGER - 2 }
	])('menolak nilai $nama', ({ masukan }) => {
		expect(() => rupiah(masukan)).toThrow(RangeError);
	});
});

describe('formatRupiah', () => {
	it.each([
		{ masukan: 0, hasil: 'Rp 0' },
		{ masukan: 1, hasil: 'Rp 1' },
		{ masukan: 999, hasil: 'Rp 999' },
		{ masukan: 1_000, hasil: 'Rp 1.000' },
		{ masukan: 150_000, hasil: 'Rp 150.000' },
		{ masukan: 1_234_567, hasil: 'Rp 1.234.567' },
		{ masukan: 1_000_000_000, hasil: 'Rp 1.000.000.000' },
		{ masukan: -25_000, hasil: '-Rp 25.000' }
	])('memformat $masukan menjadi $hasil', ({ masukan, hasil }) => {
		expect(formatRupiah(rupiah(masukan))).toBe(hasil);
	});

	it('tidak pernah menampilkan satuan pecahan, karena rupiah tidak punya', () => {
		// Kesalahan yang dicegah di sini: memperlakukan nilai sebagai sen lalu membaginya 100,
		// yang akan mengubah satu rupiah menjadi "Rp 0,01".
		expect(formatRupiah(rupiah(1))).toBe('Rp 1');
	});
});

describe('uraiRupiah', () => {
	it.each([
		{ masukan: '0', hasil: 0 },
		{ masukan: '150000', hasil: 150_000 },
		{ masukan: '150.000', hasil: 150_000 },
		{ masukan: '1.234.567', hasil: 1_234_567 },
		{ masukan: 'Rp 150.000', hasil: 150_000 },
		{ masukan: 'Rp150.000', hasil: 150_000 },
		{ masukan: '  Rp 150.000  ', hasil: 150_000 },
		{ masukan: '-Rp 25.000', hasil: -25_000 },
		{ masukan: '-150.000', hasil: -150_000 }
	])('mengurai "$masukan" menjadi $hasil', ({ masukan, hasil }) => {
		expect(uraiRupiah(masukan)).toBe(hasil);
	});

	it.each([
		{ nama: 'pecahan dengan koma desimal Indonesia', masukan: '150.000,50' },
		{ nama: 'pecahan tanpa pemisah ribuan', masukan: '1500,5' },
		{ nama: 'pecahan bergaya Inggris', masukan: '1500.50' },
		{ nama: 'pengelompokan ribuan yang salah', masukan: '1234.567' },
		{ nama: 'teks kosong', masukan: '' },
		{ nama: 'bukan angka', masukan: 'seratus ribu' },
		{ nama: 'mata uang lain', masukan: 'USD 150' }
	])('menolak $nama tanpa membulatkannya', ({ masukan }) => {
		expect(() => uraiRupiah(masukan)).toThrow(TypeError);
	});

	it('menolak nilai di luar rentang aman alih-alih memotongnya', () => {
		expect(() => uraiRupiah('9007199254740993')).toThrow(RangeError);
	});
});

describe('perjalanan pulang pergi', () => {
	const nilai = [0, 1, 999, 1_000, 150_000, 1_234_567, 987_654_321_098, -25_000, -1_000_000];

	it.each(nilai)('mengurai kembali format dari %i tanpa kehilangan satu rupiah pun', (angka) => {
		expect(uraiRupiah(formatRupiah(rupiah(angka)))).toBe(angka);
	});

	it('menjumlahkan seribu tagihan tanpa galat pembulatan', () => {
		// Nilai yang dipilih supaya jumlahnya akan meleset kalau ada tahap pecahan di antaranya:
		// 1000 x 150.001 = 150.001.000 persis.
		const sebulan = rupiah(150_001);
		let total = 0;
		for (let i = 0; i < 1000; i += 1) {
			total += sebulan;
		}
		expect(rupiah(total)).toBe(150_001_000);
	});

	it('menjaga tipe bermerek melewati format dan urai', () => {
		const sebelum: Rupiah = rupiah(150_000);
		const sesudah: Rupiah = uraiRupiah(formatRupiah(sebelum));
		expect(sesudah).toBe(sebelum);
	});
});
