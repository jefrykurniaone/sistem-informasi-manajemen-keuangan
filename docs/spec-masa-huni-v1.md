# Spec: masa-huni v1 - Modul Masa Huni memegang sendiri kunci Unit dan satu jawaban untuk Penanggung Jawab hari ini

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#307](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/307) |
| Run | `perdalam-v1` |
| Peta eksekusi | [#334](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/334) |
| Disalin pada | 2026-11-15, dari `main` @ `0cf7be0` |
| Lintasan penutup | 2026-11-16, sesudah Gelombang 6 (`feat/perdalam-v1` @ `cac5bf0`): dibuat ulang dari item, yang kini memuat bagian "Catatan penyerahan" dengan klaim yang dibalik ditandai; tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang; item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---

## Problem statement

Per 2026-11-15, aturan "pegang kunci baris Unit, periksa bentrok, lalu tulis" untuk Masa Huni adalah kewajiban pemanggil, bukan bagian dari interface modul Masa Huni.

- Fungsi kunci Unit dan fungsi pemeriksa bentrok diekspor, dan aturan "hanya benar selama kunci dipegang" hanya hidup di komentar.
- Undangan dan Pendaftaran masing-masing membawa salinan hampir sama dari langkah "pasang Masa Huni kalau belum ada".
- Komentar modul Masa Huni mendaftar lima jalur tulis dengan tangan.
- Riwayatnya: #246 harus mengubah modul Masa Huni, Undangan, dan Pendaftaran bersamaan, dan #258 adalah jalur kelima (mengakhiri Masa Huni) yang terlewat.
- Tes kunci dengan koneksi kedua hanya ada untuk mencatat Masa Huni dan memindahkan Penanggung Jawab. Undangan dan Pendaftaran tidak punya tes kunci sama sekali.
- Impor Warga menulis Masa Huni lewat jalurnya sendiri. Impor selalu membuat Unit baru dan Warga baru, jadi tidak bisa bentrok, tetapi ia tetap jalur tulis keenam di luar modul.

Pertanyaan "siapa Penanggung Jawab Unit U hari ini" juga dijawab tiga kali dengan urutan pilih yang disalin: penerima email Tagihan, ringkasan Unit, dan pencarian pemegang sebelumnya untuk Audit Log, yang memakai kunci urut pertama berbeda. Layar Penghuni dan "Rumah saya" merender penanda mentah dari baris Masa Huni. Dengan baris sisa model lama sebelum ADR-0001, dua lencana Penanggung Jawab bisa tampil sementara email hanya menyebut satu orang. #244 harus menyentuh ketiga turunan itu sekaligus, 14 berkas.

## Solution

- Untuk data yang normal, tidak ada perubahan yang terlihat.
- Untuk Unit dengan baris sisa model lama, layar Penghuni, "Rumah saya", ringkasan Unit, email Tagihan, dan Audit Log menyebut Penanggung Jawab yang sama.
- Alur superuser (mencatat, mengakhiri, menandai Penanggung Jawab), Undangan, Pendaftaran, dan Impor tetap seperti sekarang.

## Goals and non-goals

**Goals**

- Modul Masa Huni memegang setiap penulisan Masa Huni, dan mengambil kunci baris Unit di dalam interfacenya.
- Satu bacaan "Penanggung Jawab hari ini" untuk satu atau banyak Unit, dengan satu urutan pilih.

**Non-goals**

- ADR-0001 tidak dibuka kembali. Penanda tetap berpindah.
- Rancangan Impor (satu baris, satu rumah baru, satu orang baru) tidak berubah.
- Kunci Unit milik Pembebasan, yang menjaga Pembebasan dan bukan Masa Huni, tidak berubah.
- Tidak ada migrasi data untuk penanda sisa model lama.

## User stories

1. Sebagai superuser, saya ingin mencatat, mengakhiri, dan menandai Masa Huni berperilaku persis seperti sekarang, supaya pekerjaan saya tidak terganggu.
2. Sebagai Warga yang menerima Undangan, saya ingin Masa Huni saya tetap terpasang saat saya menetapkan kata sandi, dan tidak terpasang dua kali kalau saya mengulang langkahnya.
3. Sebagai Warga yang Pendaftarannya disetujui, saya ingin hal yang sama.
4. Sebagai superuser yang mengimpor Warga, saya ingin hasil impor tidak berubah.
5. Sebagai superuser, saya ingin dua penulisan Masa Huni yang bersamaan pada satu Unit tidak pernah menghasilkan Masa Huni ganda, dari jalur mana pun.
6. Sebagai Warga di "Rumah saya", saya ingin lencana Penanggung Jawab hanya ada pada satu orang, orang yang sama yang menerima email Tagihan.
7. Sebagai superuser di layar Penghuni, saya ingin lencana dan tombol "Jadikan penanggung jawab" mengikuti jawaban yang sama dengan ringkasan Unit.
8. Sebagai superuser yang membaca Audit Log, saya ingin pemegang sebelumnya pada perpindahan Penanggung Jawab dipilih dengan aturan yang sama dengan penerima email.
9. Sebagai pengembang, saya ingin tidak bisa menulis Masa Huni tanpa kunci Unit, supaya jalur ketujuh tidak bisa lupa.
10. Sebagai pengembang, saya ingin satu tes kunci mencakup setiap penulis Masa Huni.

## Implementation decisions

**1. Satu pintu untuk memasang seorang Warga ke sebuah Unit.**

- Modul Masa Huni mendapat satu pintu: pasang Warga ini ke Unit ini mulai hari D, dengan peran yang diberikan dan tanpa penanda Penanggung Jawab. Pintu ini mengambil kunci baris Unit sendiri, lalu melewati diam-diam kalau Warga itu sudah punya Masa Huni di Unit itu yang hari terakhirnya belum lewat. Perilaku melewati diam-diam itu adalah perilaku Undangan dan Pendaftaran hari ini, dan sengaja dipertahankan supaya langkahnya tetap aman diulang.
- Undangan dan Pendaftaran memanggil pintu ini, dan salinan mereka dihapus.
- Impor menulis Masa Huninya lewat jalur tulis modul Masa Huni yang sama. Unitnya baru dibuat di transaksi yang sama, jadi kuncinya tidak pernah menunggu. Hasil impor tidak berubah.
- Fungsi kunci Unit dan pemeriksa bentrok menjadi bagian dalam modul dan tidak lagi diekspor.
- Setiap penulis yang ada (mencatat, mengakhiri, menandai Penanggung Jawab, dan pintu baru ini) mengambil kunci di dalam modul. Daftar penulis di komentar modul diganti oleh struktur: hanya modul ini yang menulis Masa Huni, dan tes memaku permukaan tulis yang diekspornya.
- _Mengapa:_ invarian yang dijaga oleh disiplin pemanggil sudah gagal dua kali (#246, #258).

**2. Satu bacaan Penanggung Jawab hari ini.**

- Modul Masa Huni menjawab "Penanggung Jawab hari ini" untuk satu atau banyak Unit pada satu hari WIB.
- Urutan pilihnya satu: tanggal mulai terbaru, lalu waktu dicatat terbaru, lalu id. Urutan ini dipakai juga untuk pemegang sebelumnya di Audit Log, sehingga kunci urut pertama yang berbeda di sana hilang. Perubahan itu hanya terlihat pada data sisa model lama.
- Pemakainya: penerima email Tagihan, ringkasan Unit, layar Penghuni, "Rumah saya", dan pencarian pemegang sebelumnya.
- Model tampilan membawa "Penanggung Jawab hari ini" dari bacaan ini, bukan penanda mentah dari baris Masa Huni.
- _Mengapa:_ tiga salinan satu pertanyaan hanya diselaraskan oleh komentar yang saling menunjuk.

**3. Tanpa perubahan skema.** Tidak ada migrasi. Indeks unik parsial pada penanda tetap menjadi pengaman terakhir, seperti kata ADR-0001.

## Testing decisions

- **Seam:** interface modul Masa Huni, diuji terhadap PostgreSQL nyata.
- **Tes kunci:** koneksi kedua memegang kunci baris Unit (`for no key update`, sesuai cara tes kunci di repo ini), lalu pintu pasang Warga dari jalur Undangan dan Pendaftaran harus menunggu. `Promise.allSettled` tidak dipakai sebagai bukti race.
- **Tes Penanggung Jawab:** satu Unit dengan dua baris ber-penanda yang sama-sama berjalan (data sisa model lama). Semua pemakai menyebut orang yang sama.
- **Tes perilaku tetap:** Undangan dan Pendaftaran yang diulang tidak membuat Masa Huni kedua. Impor menghasilkan baris yang sama dengan hari ini.
- **Ganti, jangan tumpuk:** tes berpasangan di tes ringkasan Unit dan tes notifikasi iuran yang menjaga keselarasan urutan pilih digabung menjadi satu tes di seam baru.
- **Walk browser:** layar Penghuni sebuah Unit dan "Rumah saya" menampilkan satu lencana Penanggung Jawab, sama dengan sebelum run.

## Success criteria

- Undangan, Pendaftaran, dan Impor tidak lagi berisi kunci Unit atau pemeriksaan bentrok Masa Huni milik mereka sendiri.
- Modul Masa Huni tidak mengekspor fungsi kunci Unit atau pemeriksa bentrok.
- Satu tes kunci dengan koneksi kedua mencakup pintu pasang Warga.
- Dengan dua baris ber-penanda yang berjalan, email Tagihan, ringkasan Unit, layar Penghuni, "Rumah saya", dan Audit Log menyebut Penanggung Jawab yang sama.
- Gate repo hijau dan walk browser lulus.

## Out of scope

- ADR-0001 dan model penanda.
- Kunci Unit milik Pembebasan.
- Membersihkan penanda sisa model lama di basis data.
- Tampilan Tagihan sisi Warga (spec `tagihan-warga`).
- Modul pengumuman email (spec `pemberitahuan`). Spec ini hanya mengganti cara penerima email Tagihan dipilih.

## Further notes

- Sumber: tinjauan arsitektur 2026-11-15, kandidat 03 dan 07, serta fakta dari scout tentang Impor: setiap baris Impor membuat Unit baru dan Warga baru, dan berkas yang menyebut Unit atau email yang sudah ada ditolak seluruhnya.
- ADR-0001: tidak ada konflik. Penanda tetap berpindah, hanya bacaannya yang dipusatkan.


## Catatan penyerahan (run perdalam-v1, 2026-11-16)

**1. Yang masuk.** Semua di `feat/perdalam-v1`, belum di `main` (PR run dibuka di tail, #334).

- #314 Pintu pasang Warga ke Unit dengan kunci Unit di dalam modul: merge `88cfdff` ke feat/perdalam-v1. `ensureOccupancy(transaction, { unitId, residentId, role, startedOn, createdAt }): Promise<boolean>` di `src/lib/server/services/occupancy/index.ts`; dipakai Undangan, Pendaftaran, dan Impor.
- #321 Satu bacaan Penanggung Jawab hari ini: merge `7b9a0a7` ke feat/perdalam-v1. `primaryOccupantsOn(db, day, unitIds)` di `occupancy/index.ts`; urutan pilih mulai terbaru, dicatat terbaru, id terbesar.

**2. Klaim spec yang dibalik atau digeser run ini.** Tidak ada yang dihapus dari badan spec di atas.

- "tes memaku permukaan tulis yang diekspornya": tes `the Masa Huni module surface` memaku seluruh daftar ekspor runtime modul, termasuk bacaan. Karena itu #321 harus menambahkan `primaryOccupantsOn` ke daftar itu (#314, #321).
- "Model tampilan membawa 'Penanggung Jawab hari ini' dari bacaan ini": field model tampilan tetap bernama `isPrimaryOccupant`; yang berubah hanya sumbernya, kini `primaryOccupantsOn` (#321).
- "Perubahan itu hanya terlihat pada data sisa model lama": bentuk persisnya, pemegang sebelumnya di Audit Log untuk data sisa model lama kini `before: null` kalau tidak ada penanda yang berjalan (#321).

**3. Cacat dan tindak lanjut yang diajukan.**

- Tidak ada cacat yang diajukan untuk spec ini, dan tidak ada yang diserahkan ke tail atau pemilik dari #314 dan #321. Satu temuan #321 (komentar `currentDay` di `occupancy/visibility.ts`) diteruskan ke #337 dan sudah diperbaiki di sana.
- #338 (Masa Huni Data Contoh mulai pada hari semai) menyentuh Masa Huni tetapi dicatat di spec #306.

**4. Verifikasi.**

- Tidak ada tiket high-consequence di spec ini, jadi tidak ada verifikasi kedua. Bukti kunci #314: tes koneksi kedua dengan `for no key update` untuk pintu sendiri, jalur Undangan, dan jalur Pendaftaran; ketiganya gagal ketika `lockUnit` dilepas sementara. Walk #321: satu lencana Penanggung Jawab di layar Penghuni, ringkasan Unit, dan "Rumah saya".
