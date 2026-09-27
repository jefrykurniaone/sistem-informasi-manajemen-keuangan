# Penanggung Jawab berpindah, bukan periode bertanggal

Penanggung Jawab adalah penanda pada satu Masa Huni yang sedang berjalan per Unit, dan artinya
"penerima email tagihan rumah ini sekarang". Menandai Masa Huni lain memindahkan penanda itu dan
berlaku sejak saat itu; pemegang lama tetap menghuni rumahnya kalau Masa Huninya belum selesai. Siapa
yang pernah memegangnya dicatat di Audit Log, bukan pada Masa Huni. Keputusan ini membatalkan janji
`docs/spec-warga-unit-v1.md` bahwa model data bisa menjawab "Penanggung Jawab sebuah Unit pada suatu
tanggal": penanda yang tersimpan pada Masa Huni yang sudah selesai tidak lagi bermakna sejarah dan
tidak dibaca apa pun. Alasannya, penanda yang menempel pada seluruh rentang satu Masa Huni membuat
penghuni serumah tidak pernah bisa dijadikan Penanggung Jawab (rentangnya pasti bertabrakan dengan masa
lalu pemegang lama), dan satu-satunya pembaca penanda itu adalah penerima email tagihan hari ini.

## Considered Options

- **Penanda per Masa Huni dengan pemeriksaan bentrok tanggal** (model lama), hanya dilonggarkan supaya
  hari terakhir dan hari pertama boleh sama. Ditolak: kasus penghuni serumah tetap mustahil, dan
  satu-satunya jalan keluarnya, mengakhiri lalu mencatat ulang Masa Huni, mengotori riwayat.
- **Periode Penanggung Jawab bertanggal** sebagai tabel dan istilah tersendiri. Ditolak: menambah tabel,
  istilah di `CONTEXT.md`, dan aturan sinkron dengan Masa Huni, padahal tidak ada fitur yang bertanya
  tentang Penanggung Jawab pada tanggal lampau. Kalau fitur seperti itu kelak dibutuhkan, Audit Log
  adalah sumbernya, dan pilihan ini dibuka kembali lewat ADR baru.

## Consequences

- Indeks unik parsial pada penanda (tanggal selesai kosong) tidak lagi cukup sendirian: baris
  Penanggung Jawab yang hari terakhirnya sudah diisi tetapi belum lewat berada di luar indeks. Invarian
  "paling banyak satu penanda di antara Masa Huni yang belum lewat per Unit" dijaga layanan di bawah
  kunci baris Unit, dan setiap jalur yang memasang penanda wajib mengambil kunci itu.
- Penanda hanya boleh dipasang pada Masa Huni yang sudah mulai, supaya Unit tidak kehilangan penerima
  email sampai penghuni baru masuk.
- Spec: `docs/spec-penghuni-v1.md` (#238).
