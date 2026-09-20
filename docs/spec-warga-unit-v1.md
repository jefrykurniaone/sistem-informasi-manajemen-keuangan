# Spec: warga-unit - unit, warga, masa huni, impor dan undangan

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#2](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/2) |
| Run | `komplek-v1` |
| Peta eksekusi | [#47](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/47) |
| Disalin pada | 2026-09-16 |
| Lintasan penutup | 2026-09-20 — klaim yang dibalik run ini ditandai di badan, tidak ada yang dihapus |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

---
## Problem statement

Daftar rumah dan warga komplek saat ini hidup di spreadsheet dan grup WhatsApp. Tidak ada satu pun
sumber yang bisa menjawab dengan pasti: rumah mana saja yang ada, siapa yang tinggal di sana
sekarang, siapa yang bertanggung jawab atas iuran rumah itu, dan ke mana surat elektronik untuk
rumah itu harus dikirim.

Tanpa jawaban itu, tidak ada tagihan yang bisa diterbitkan dan tidak ada laporan yang bisa
dipercaya. Ini juga bagian yang paling mudah salah dimodelkan: iuran komplek melekat pada rumah,
sementara akun dan email melekat pada orang, dan orang berpindah rumah.

## Solution

Sebuah daftar rumah yang tetap, dan sebuah catatan siapa menghuni rumah mana selama periode berapa.
Rumah tidak pernah dihapus; penghuni berganti. Satu penghuni per rumah ditandai sebagai penanggung
jawab, dan dialah yang menerima email tagihan.

Superuser mengisi daftar awal dengan mengunggah berkas CSV, lalu mengirim undangan ke alamat email
warga. Warga yang menerima undangan menetapkan kata sandinya sendiri. Warga yang tidak terdaftar
bisa mendaftar sendiri dan menunggu persetujuan superuser, yang mengaitkannya ke rumah.

## Goals and non-goals

**Goals**

- Satu daftar rumah yang menjadi sumber kebenaran, dengan identitas blok dan nomor.
- Riwayat huni berperiode, sehingga pertanyaan "siapa yang tinggal di C-12 pada Maret lalu" punya
  jawaban.
- Tepat satu penanggung jawab tagihan per rumah pada satu waktu.
- Pengisian awal ratusan baris tanpa mengetik satu per satu, dan tanpa merusak data kalau berkasnya
  salah.
- Jalan masuk yang terkendali: undangan sebagai jalur utama, pendaftaran mandiri yang butuh
  persetujuan sebagai cadangan.
- Warga bisa mengatur email apa saja yang ingin diterimanya.

**Non-goals**

- Tidak ada tagihan, pembayaran, atau angka uang apa pun di sini.
- Tidak ada penagihan per orang untuk rumah kontrakan mahasiswa; semuanya per rumah.
- Tidak ada impor riwayat keuangan lama.

## User stories

1. Sebagai superuser, saya ingin mengunggah berkas CSV berisi daftar rumah dan penghuninya, supaya
   saya tidak mengetik seratus baris.
2. Sebagai superuser, saya ingin melihat pratinjau hasil impor beserta barisnya yang bermasalah
   sebelum apa pun disimpan, supaya kesalahan ketik tidak menjadi data.
3. Sebagai superuser, saya ingin impor yang gagal di tengah tidak meninggalkan setengah data,
   supaya saya bisa memperbaiki berkas dan mengulang tanpa menebak apa yang sudah masuk.
4. Sebagai superuser, saya ingin menambah satu rumah baru, supaya rumah yang baru dibangun bisa
   ikut ditagih.
5. Sebagai superuser, saya ingin menonaktifkan rumah yang tidak lagi ada, tanpa menghapus
   riwayatnya.
6. Sebagai superuser, saya ingin mencatat bahwa seorang warga mulai menghuni sebuah rumah pada
   tanggal tertentu, supaya tagihan dan tampilan mengikuti kenyataan.
7. Sebagai superuser, saya ingin mengakhiri masa huni seseorang pada tanggal tertentu, supaya
   penghuni lama berhenti menerima email rumah itu.
8. Sebagai superuser, saya ingin menandai siapa penanggung jawab tagihan sebuah rumah, supaya email
   tagihan punya satu alamat tujuan yang jelas.
9. Sebagai superuser, saya ingin sistem menolak dua penanggung jawab aktif pada satu rumah, supaya
   tidak ada tagihan yang dikirim dua kali atau tidak sama sekali.
10. Sebagai superuser, saya ingin mengirim undangan ke alamat email warga, supaya mereka bisa
    membuat akun tanpa saya membuatkan kata sandinya.
11. Sebagai warga, saya ingin menerima email undangan berisi tautan untuk menetapkan kata sandi
    saya sendiri, supaya kata sandi saya tidak pernah diketahui pengurus.
12. Sebagai warga, saya ingin tautan undangan yang sudah lewat masa berlakunya menolak saya dengan
    jelas dan memberi tahu cara meminta yang baru.
13. Sebagai superuser, saya ingin mengirim ulang undangan yang belum dipakai, supaya warga yang
    kehilangan emailnya tidak macet.
14. Sebagai warga baru, saya ingin mendaftar sendiri dengan menyebut blok dan nomor rumah saya,
    supaya saya tidak perlu menunggu pengurus memasukkan data saya.
15. Sebagai superuser, saya ingin melihat daftar pendaftaran yang menunggu persetujuan, menyetujui
    atau menolaknya, dan mengaitkan yang disetujui ke rumah yang benar.
16. Sebagai warga, saya ingin melihat dan memperbaiki data diri saya sendiri — nama dan nomor
    telepon — tanpa menghubungi pengurus.
17. Sebagai warga, saya ingin memilih email mana yang saya terima, supaya kotak masuk saya tidak
    penuh.
18. Sebagai warga, saya ingin berlangganan laporan keuangan bulanan lewat satu saklar.
19. Sebagai admin, saya ingin mencari rumah atau warga dengan cepat, supaya saya tidak menggulir
    seratus baris.
20. Sebagai warga, saya ingin melihat rumah saya beserta siapa saja yang tercatat menghuninya,
    supaya saya bisa melapor kalau datanya salah.

## Implementation decisions

**Rumah adalah entitas yang tetap.** Sebuah Unit diidentifikasi oleh kombinasi blok dan nomor,
unik di seluruh komplek, dan tidak pernah dihapus — hanya bisa dinonaktifkan. Alasannya: tagihan
dan transaksi kas akan menunjuk ke Unit selamanya, dan penghapusan akan memutus riwayat keuangan.

**Masa huni adalah hubungan berperiode.** Sebuah Masa Huni menghubungkan satu Warga ke satu Unit,
dengan peran huni (pemilik atau penyewa), tanggal mulai, dan tanggal selesai yang boleh kosong
untuk yang masih berjalan. Satu Unit boleh punya beberapa Masa Huni aktif — suami dan istri di
rumah yang sama. Satu Warga boleh punya Masa Huni di lebih dari satu Unit, karena pemilik yang
mengontrakkan rumahnya tetap terkait dengan rumah itu.

**Penanggung jawab adalah penanda pada Masa Huni, bukan entitas baru.** Tepat satu Masa Huni aktif
per Unit boleh ditandai sebagai penanggung jawab tagihan, dan aturan itu dipaksakan oleh basis
data, bukan hanya oleh kode. Alasannya: dua penanggung jawab berarti email tagihan ganda dan
kebingungan tentang siapa yang menunggak; nol penanggung jawab berarti tagihan terbit tanpa ada
yang diberi tahu — kedua-duanya baru ketahuan berbulan-bulan kemudian.

> [!note] Dibalik oleh run `komplek-v1`
> Aturannya berakhir di lapisan service, bukan di basis data. `occupancies_primary_occupant_unique`
> (#16, `7b96d75`) membaca "masih berjalan" sebagai `ended_on is null`, jadi `ended_on` bertanggal
> masa depan membebaskan slotnya lebih awal dan PostgreSQL menerima penanggung jawab kedua —
> direproduksi langsung pada gelombang 7. Jalan keluar di basis data adalah exclusion constraint atas
> `daterange` yang menuntut `btree_gist`, dan penolakannya tertulis di
> `src/lib/server/db/schema/occupancy.ts`; #18 (`892cb18`) yang menutup celahnya di
> `src/lib/server/services/occupancy/`.

**Penyaringan tampilan menurut masa huni.** Warga hanya melihat data rumahnya untuk rentang waktu
ia menghuninya. Ini keputusan yang diambil di lapisan service dan disediakan sebagai satu fungsi
yang dipakai spec keuangan, bukan diulang di setiap layar. Admin melihat seluruh riwayat Unit.

**Impor CSV berjalan dua langkah.** Unggah menghasilkan pratinjau: baris yang valid, baris yang
ditolak beserta alasannya per baris dan nomor barisnya, dan ringkasan berapa Unit serta Warga baru
akan dibuat. Baru setelah dikonfirmasi, seluruh impor dijalankan dalam satu transaksi — semuanya
masuk atau tidak sama sekali. Alasannya: impor sebagian dari berkas ratusan baris hampir mustahil
dibersihkan dengan tangan, dan orang yang mengimpornya adalah orang yang paling tidak siap
membersihkannya.

**Undangan adalah token berbatas waktu.** Sebuah Undangan menunjuk ke satu alamat email dan satu
Unit, punya masa berlaku tujuh hari, dan hanya bisa dipakai satu kali. Token disimpan sebagai
nilai teracak, bukan dalam bentuk aslinya. Menerima undangan berarti akun dibuat dengan peran
`warga`, Masa Huni dibuat, dan email dianggap terverifikasi — karena undangan dikirim ke alamat itu
dan hanya pemiliknya yang bisa membukanya.

> [!note] Dibalik oleh run `komplek-v1`
> Menerima undangan **melengkapi** akun yang sudah ada, bukan membuatnya: impor #19 (`08adc8a`)
> sudah menulis baris `user` tanpa kredensial beserta `residents` dan Masa Huninya, dan #20
> (`98b6515`) menulis kredensialnya lewat `passwordHasherOf(auth)` langsung ke `account` di dalam
> transaksi — bukan lewat `auth.api.signUpEmail` — tanpa menggandakan Masa Huni itu. Peran yang
> diberikan bernama `resident`, bukan `warga` (lihat `docs/spec-fondasi-v1.md`), dan peran huninya
> selalu `owner` karena `invitations` tidak punya kolom peran. Masa berlaku tujuh hari mendarat apa
> adanya sebagai `INVITATION_LIFETIME_DAYS` di `src/lib/server/services/invitation/index.ts`.

**Pendaftaran mandiri tidak memberi akses.** Pendaftar memasukkan nama, email, dan blok serta nomor
rumah yang diklaimnya, lalu berstatus menunggu persetujuan: ia bisa masuk, tetapi hanya melihat
halaman yang mengatakan pendaftarannya sedang ditinjau. Superuser menyetujui, menolak dengan
alasan, atau mengaitkannya ke Unit yang berbeda dari yang diklaim. Alasannya: klaim rumah yang
tidak diperiksa memberi orang asing akses ke laporan keuangan dan daftar warga.

> [!note] Dibalik oleh run `komplek-v1`
> Pendaftar sudah punya kredensial sebelum ditinjau: `/register` memanggil `signUpEmail` better-auth
> **lebih dulu**, lalu menulis baris `registrations`, dan persetujuan superuser **tidak pernah**
> membuat akun — ia hanya membuat `residents`, langganan bawaan, dan `occupancies`, dan menolak
> dengan `RegistrationAccountMissingError` kalau akunnya tidak ada (#21, `8d1759e`,
> `src/lib/server/services/registration/index.ts`). Peran huni yang dibuat persetujuan selalu
> `owner`. Pengalihan ke halaman "sedang ditinjau" ada di
> `src/routes/(app)/+layout.server.ts` dan **mengecualikan pemegang `admin` atau `superuser`**, tanpa
> itu pengurus yang tidak punya rumah terkunci dari seluruh `/admin/*`.

**Preferensi notifikasi adalah data, bukan kolom boolean yang bertambah.** Satu baris per Warga per
jenis notifikasi, dengan nilai bawaan yang ditetapkan saat akun dibuat. Jenis notifikasi yang
dikenal ditetapkan di sini; spec lain menambah jenisnya sendiri. Laporan bulanan dan post baru
bersifat opt-in; email yang menyangkut uang milik warga sendiri — tagihan terbit dan pembayaran
diverifikasi — tidak bisa dimatikan.

**Kontrak untuk spec lain.** Spec ini menerbitkan tiga hal yang dipakai spec berikutnya: cara
mendapatkan daftar Unit yang aktif pada sebuah tanggal, cara mendapatkan penanggung jawab sebuah
Unit pada sebuah tanggal, dan cara menyaring apa yang boleh dilihat seorang Warga menurut masa
huninya.

## Testing decisions

Perilaku yang diuji adalah apa yang tampak dari luar lapisan service: memanggil service masa huni
dengan data yang melanggar aturan menghasilkan penolakan bernama, bukan pengecualian basis data
mentah.

- **Aturan penanggung jawab tunggal** diuji dari dua sisi: mencoba menandai penanggung jawab kedua
  ditolak, dan mengakhiri masa huni penanggung jawab meninggalkan Unit tanpa penanggung jawab yang
  terlihat di daftar admin sebagai hal yang perlu dibereskan.
- **Penyaringan menurut masa huni** diuji dengan skenario pergantian penghuni: penghuni lama
  menunggak, penghuni baru masuk, dan pengujian membuktikan penghuni baru tidak melihat tagihan
  sebelum tanggal ia masuk sementara admin melihat semuanya.
- **Impor CSV** diuji dengan berkas yang sengaja rusak — blok kosong, nomor ganda, email tidak
  valid, rumah yang sudah ada — dan pengujian membuktikan tidak ada satu baris pun yang tersimpan.
- **Undangan** diuji untuk token kedaluwarsa, token yang sudah dipakai, dan token yang tidak
  dikenal; ketiganya harus ditolak dengan alasan berbeda yang bisa dibedakan.
- **Preferensi notifikasi** diuji sebagai tabel kasus antara jenis notifikasi dan nilai preferensi,
  termasuk pembuktian bahwa jenis yang wajib tidak bisa dimatikan.
- Playwright dipakai untuk satu alur: superuser mengundang, warga membuka tautan dari Mailpit,
  menetapkan kata sandi, dan mendarat di halaman rumahnya.

## Success criteria

- Mengunggah berkas CSV berisi seratus rumah menghasilkan pratinjau yang menyebut jumlah baris valid
  dan menyebut nomor baris setiap kesalahan, dan tidak ada data tersimpan sebelum dikonfirmasi.
- Mengunggah berkas dengan satu baris rusak dan mengonfirmasinya tidak menyimpan apa pun.
- Seorang warga yang diundang dapat menetapkan kata sandi lewat tautan dari email dan langsung
  melihat rumahnya.
- Tautan undangan yang sama tidak bisa dipakai kedua kali.
- Sistem menolak penandaan penanggung jawab kedua pada satu rumah.
- Setelah masa huni penghuni lama diakhiri dan penghuni baru dicatat, penghuni baru tidak melihat
  apa pun dari periode sebelum ia masuk, sementara admin melihat seluruh riwayat rumah itu.
- Pendaftar mandiri tidak bisa membuka halaman warga mana pun sebelum disetujui.
- Warga dapat mematikan email post baru, dan tidak dapat mematikan email tagihan.

## Out of scope

Tagihan dan uang dalam bentuk apa pun, penagihan per orang, impor riwayat keuangan, penghapusan
rumah, penggabungan dua akun warga, unggah foto profil, verifikasi nomor telepon.

## Further notes

Diblokir oleh spec fondasi. Memblokir spec iuran, yang tidak bisa menerbitkan tagihan tanpa daftar
Unit dan penanggung jawabnya.
