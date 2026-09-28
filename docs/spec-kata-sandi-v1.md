# Spec: kata-sandi - Kata sandi minimal 8 karakter tanpa aturan komposisi, dan kata sandi umum ditolak

| Keterangan | Nilai |
|---|---|
| Item spesifikasi | [#248](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/248) |
| Run | `huni-v1` |
| Peta eksekusi | [#247](https://github.com/jefrykurniaone/sistem-informasi-manajemen-keuangan/issues/247) |
| Disalin pada | 2026-09-28 |
| Lintasan penutup | 2026-09-28, sesudah Gelombang 7 (`d6cefff`) |

Salinan titik waktu dari item spesifikasi di atas. Isi di bawah garis adalah badan spesifikasi apa
adanya. Run yang menjalankan spesifikasi ini akan membuat sebagian klaim di bawah menjadi usang;
item di tracker adalah sumber kebenaran, dan salinan ini dibaca sebagai catatan sejarah.

Lintasan penutup menambahkan penanda *Sesudah run* di bawah garis pada setiap klaim yang dibalik
atau diubah bentuknya oleh tiket run ini. Tidak ada teks yang dihapus. Klaim yang ditandai:

- "minimal 12 karakter" di *Problem statement* (#249);
- angka 12 yang disebut ditulis di komentar konstanta (#249);
- sumber daftar SecLists dan cara daftar disimpan (#249);
- endpoint yang dijaga hook better-auth (#249);
- pesan per alur yang semula hanya "terlalu umum" (#260).

---

## Problem statement

Warga, dan siapa pun yang menerima Undangan atau mengajukan Pendaftaran, harus memilih kata sandi minimal 12 karakter (per 2026-09-28). Bagi warga komplek, itu terlalu panjang: mereka mengeluh, menyerah di tengah pendaftaran, atau menuliskannya di kertas.

> *Sesudah run (2026-09-28):* minimal 8 karakter sejak #249 (PR #259, `a13669b`).

Di sisi lain, satu-satunya aturan saat ini adalah panjang. Kalau batasnya diturunkan tanpa pengaman lain, kata sandi yang paling sering ditebak, seperti `12345678`, `password`, dan `qwertyui`, akan diterima.

## Solution

- Kata sandi cukup **8 karakter**.
- Tidak ada kewajiban angka, huruf besar, atau karakter spesial.
- Kata sandi yang termasuk daftar kata sandi paling umum ditolak dengan pesan yang jelas, di setiap jalan untuk menetapkan kata sandi:
  - pendaftaran;
  - atur ulang kata sandi;
  - menerima undangan;
  - panggilan langsung ke API autentikasi.
- Kata sandi yang sudah ada tetap berlaku.

## Goals and non-goals

**Goals**

- Panjang minimal kata sandi 8, di setiap jalur yang menetapkan kata sandi.
- Kata sandi dari daftar kata sandi umum ditolak di setiap jalur itu, termasuk yang tidak lewat formulir.
- Petunjuk di formulir menyebut angka yang benar tanpa perubahan teks tambahan.

**Non-goals**

- Aturan komposisi (wajib angka, huruf besar, atau simbol).
- Memeriksa kata sandi terhadap layanan eksternal kebocoran data.
- Memaksa pengguna lama mengganti kata sandinya.
- Kewajiban ganti kata sandi berkala.
- Autentikasi dua faktor.

## User stories

1. Sebagai warga yang menerima Undangan, saya ingin cukup memilih kata sandi 8 karakter, supaya saya bisa mengingatnya tanpa menuliskannya.
2. Sebagai orang yang mengajukan Pendaftaran, saya ingin petunjuk di formulir menyebut "minimal 8 karakter", supaya saya tahu aturannya sebelum mengirim.
3. Sebagai warga yang lupa kata sandi, saya ingin atur ulang kata sandi memakai aturan yang sama, supaya saya tidak bertemu aturan berbeda di tempat berbeda.
4. Sebagai warga, saya ingin tidak dipaksa memakai angka atau simbol, supaya saya bisa memakai frasa yang mudah saya ingat.
5. Sebagai warga yang mengetik kata sandi umum seperti `password123`, saya ingin ditolak dengan pesan bahwa kata sandi itu terlalu umum, supaya saya memilih yang lebih sulit ditebak.
6. Sebagai pemilik sistem, saya ingin kata sandi umum juga ditolak saat seseorang memanggil API autentikasi langsung tanpa formulir, supaya aturan itu tidak bisa dilewati.
7. Sebagai warga yang sudah punya akun, saya ingin kata sandi lama saya tetap berlaku, supaya perubahan aturan tidak mengunci saya.
8. Sebagai pengembang berikutnya, saya ingin alasan angka 8 dan penolakan aturan komposisi tertulis di kode, supaya keputusan ini tidak "diperbaiki" balik tanpa sadar.

## Implementation decisions

**1. Panjang.**
- Konstanta panjang minimal yang sudah ada di modul autentikasi diubah dari 12 menjadi **8**. Maksimal tetap 200.
- Per 2026-09-28 konstanta itu satu-satunya sumber angka. Konfigurasi better-auth, validasi server di ketiga alur, atribut `minlength` di ketiga formulir, dan teks petunjuk dengan parameter `{min}` semuanya membacanya. Karena itu tidak ada teks katalog yang perlu diubah untuk angka ini.

> *Sesudah run (2026-09-28):* `MINIMUM_PASSWORD_LENGTH` di `src/lib/server/auth.ts` bernilai 8 sejak #249.

**2. Alasan yang ditulis di komentar konstanta**, supaya tidak dibuka ulang tanpa sadar:
- **Tanpa aturan komposisi.** NIST SP 800-63B melarangnya, karena aturan itu mendorong pola yang mudah ditebak (`Password1!`) dan kebiasaan menulis kata sandi.
- **Angka 8 adalah kompromi kegunaan yang dipilih pemilik pada 2026-09-28.** 12 dianggap terlalu panjang bagi warga, dan usulan awal 6 ditolak.
- **Posisi terhadap standar:**
  - 8 adalah batas bawah NIST SP 800-63B revisi 2017.
  - Revisi 4 (2025) meminta 15 untuk kata sandi sebagai satu-satunya faktor, dan 8 hanya bila disertai faktor kedua.
  - Aplikasi ini satu faktor, jadi 8 berada di bawah revisi 4.
- **Yang menopang kompromi itu:**
  - pembatas laju login (5 percobaan per menit per email);
  - hash scrypt;
  - daftar kata sandi umum di keputusan 3.
- Dua komentar lain yang menyebut "12 karakter" (di pembatas laju login dan di Data Contoh) diperbarui.

> *Sesudah run (2026-09-28):* komentar konstanta memuat semua alasan di atas kecuali angka 12. Kriteria grep #249, yaitu tidak ada angka 12 di sekitar konstanta, bertabrakan dengan kutipan "12 dianggap terlalu panjang", jadi alasan itu ditulis tanpa menyebut angkanya.

**3. Daftar kata sandi umum.**
- **Sumbernya** daftar publik 10.000 kata sandi paling umum dari SecLists (lisensi MIT). Atribusi dan lisensinya disertakan bersama daftar di repo.
- **Isinya** hanya entri yang panjangnya 8 karakter atau lebih, karena yang lebih pendek sudah ditolak oleh aturan panjang.
- **Pencocokan** persis, tanpa membedakan huruf besar-kecil. Tidak ada pemotongan spasi, karena spasi adalah bagian sah dari kata sandi.
- **Letak aturan.** Daftar dimuat sekali di sisi server. Satu fungsi di modul autentikasi menjawab apakah sebuah kata sandi bermasalah (terlalu pendek, terlalu panjang, atau terlalu umum), dan fungsi itu dipakai oleh:
  - ketiga aksi formulir (pendaftaran, atur ulang kata sandi, menerima undangan);
  - layanan Undangan;
  - hook better-auth pada endpoint yang menetapkan kata sandi (pendaftaran email dan atur ulang kata sandi). Tanpa hook ini, pemanggilan `/api/auth/*` langsung melewati aturan, karena endpoint itu terbuka.
- **Pesan.** Setiap alur mendapat pesan "kata sandi ini terlalu umum" di katalog `id` dan `en`, mengikuti pola pesan per alur yang sudah ada, tanpa em dash.

> *Sesudah run (2026-09-28):*
> - **Berkas SecLists.** Yang dipakai adalah `xato-net-10-million-passwords-10000.txt` pada commit `c5a0525`, bukan `10k-most-common.txt`, karena berkas itu tidak memuat `password123`. Setelah disaring ke 8 karakter atau lebih, isinya 3336 entri (#249).
> - **Penyimpanan.** Daftar, beserta atribusi dan lisensi MIT-nya, disimpan sebagai string di `src/lib/server/common-passwords.ts`, bukan sebagai `.txt`, karena impor `?raw` gagal di `bun build`.
> - **Pemeriksa.** `checkPassword` mengembalikan `tooShort | tooLong | tooCommon | ok`.
> - **Hook.** `refuseCommonPasswords` juga menjaga `/change-password`, tidak hanya `/sign-up/email` dan `/reset-password`, karena endpoint itu terbuka bagi siapa pun yang sudah masuk. Hook menolak `tooCommon` dengan 400 `PASSWORD_TOO_COMMON`.
> - **Terlalu panjang.** Sejak #260 (PR #262), ketiga formulir juga memetakan `tooLong` ke pesan per alur "Kata sandi paling panjang {max} karakter". Pemilik memasukkan tiket itu ke run pada 2026-09-28. Sebelumnya halaman undangan berakhir 500, dan dua alur lain menampilkan pesan yang salah. Input kata sandi sengaja tanpa `maxlength`, karena atribut itu memotong kata sandi yang ditempel tanpa pemberitahuan.

**4. Kata sandi yang sudah ada tidak disentuh.** Aturan hanya berlaku saat kata sandi ditetapkan. Login tidak memeriksanya.

## Testing decisions

- Tes yang baik di sini memanggil alur dari luar dan memeriksa hasil yang terlihat, yaitu diterima atau ditolak beserta alasannya. Contoh yang sudah ada: tes autentikasi, yang sudah menguji batas panjang lewat konstanta, dan tes layanan Undangan.
- Kasus wajib:
  - 8 karakter diterima dan 7 ditolak;
  - kata sandi dari daftar (misalnya `password123`) ditolak lewat layanan Undangan dan lewat panggilan API autentikasi langsung (pendaftaran email dan atur ulang kata sandi);
  - pencocokan tidak membedakan huruf besar-kecil;
  - kata sandi 8 karakter yang tidak ada di daftar diterima.
- Sebuah tes memastikan setiap kata sandi tetap yang dipakai tes dan Data Contoh tidak ada di daftar, supaya daftar baru tidak diam-diam mematahkan tes atau semai.
- Formulir dibuktikan lewat walk orchestrator. Tidak ada e2e baru.

## Success criteria

- Formulir `/register`, atur ulang kata sandi, dan terima undangan menampilkan "minimal 8 karakter", dan input kata sandinya ber-`minlength` 8.
- Mengirim `password123` di formulir pendaftaran menampilkan pesan bahwa kata sandi terlalu umum.
- Memanggil endpoint pendaftaran email better-auth langsung dengan `password123` ditolak.
- Kata sandi 8 karakter yang tidak umum diterima di ketiga alur.
- Akun Data Contoh tetap bisa masuk dengan kata sandi lamanya.
- Gerbang mutu repo lulus.

## Out of scope

- Aturan komposisi.
- Pemeriksaan ke layanan kebocoran data eksternal (misalnya Have I Been Pwned).
- Autentikasi dua faktor, yang akan membuat 8 karakter sejalan dengan NIST revisi 4.
- Memaksa pengguna lama mengganti kata sandi.
- Halaman ubah kata sandi untuk pengguna yang sudah masuk. Per 2026-09-28 halaman itu belum ada.
- Mengubah pembatas laju login.

## Further notes

- Angka 12 tidak pernah ditetapkan oleh spec mana pun. Per 2026-09-28 satu-satunya alasan tertulis adalah komentar konstanta, dan komentar itu membela aturan "panjang saja", bukan angka 12.
- Spec ini adalah spec ketiga run `huni-v1`. Spec ini tidak berbagi perilaku dengan spec `penghuni` atau `readme-inggris`, tetapi tiketnya berbagi katalog pesan dan layanan Undangan dengan spec `penghuni`, jadi gelombangnya ditempatkan sesudah tiket-tiket itu.
