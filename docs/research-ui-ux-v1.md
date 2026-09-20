# Riset UI/UX v1 — Sidebar, Dashboard, Input, dan Rendering Lokal

Riset ini disusun 2026-09-20 untuk menopang keputusan UI/UX yang sudah diambil pada sistem informasi
keuangan komplek (~100 rumah): sidebar kiri berbasis shadcn-svelte Sidebar dengan `collapsible="icon"`
plus flyout saat hover di mode ikon; grup akordeon yang membuka saat hover di desktop dan toggle saat
klik/tap, satu grup terbuka pada satu waktu; dashboard berbasis peran di `/`; template impor XLSX
lewat `exceljs`; WYSIWYG Tiptap yang menyimpan HTML tersanitasi; input jam terpisah `type=date` +
teks `HH:mm` untuk memaksa format 24 jam; input Rupiah dengan pemisah ribuan langsung (`1.000.000`);
dan seluruh waktu ditampilkan dalam Asia/Jakarta berlabel WIB.

Tujuannya bukan membuka kembali keputusan tersebut, melainkan memberi dasar sumber primer, angka
konkret, dan catatan risiko implementasi. Fakta stack diverifikasi langsung dari `package.json`,
`components.json`, dan `src/app.css` di repositori ini.

Stack terkonfirmasi: SvelteKit `^2.63.0`, Svelte `^5.56.1`, Tailwind CSS `^4.3.0`,
`shadcn-svelte` `^1.6.1` (style `vega`, icon library `lucide`), `@inlang/paraglide-js` `2.25.4`,
`marked` `18.0.13` + `sanitize-html` `2.17.7`, runtime Bun 1.3.14 / Node v24.18.0.
Belum terpasang: `exceljs`, paket `@tiptap/*`, dan `@tailwindcss/typography`.

---

## 1. Navigasi sidebar: akordeon vs flyout hover

- Konten yang muncul karena hover harus diberi jeda: NN/g merekomendasikan menunggu **0,3–0,5 detik**
  sebelum menampilkan konten tersembunyi, dan mempertahankannya sampai kursor meninggalkan target
  maupun konten yang terbuka selama lebih dari **0,5 detik**. Umpan balik visual biasa (perubahan
  warna/hover state) tetap harus muncul dalam **0,1 detik**. — https://www.nngroup.com/articles/timing-exposing-content/
- Untuk menu besar yang dipicu hover, NN/g memberi angka yang konsisten: tunggu 0,5 detik sebelum
  menampilkan apa pun yang bergantung hover, gambar menunya dalam 0,1 detik setelah keputusan itu,
  dan tutup hanya setelah pointer berada di luar trigger *dan* di luar dropdown selama 0,5 detik.
  NN/g juga menyebut "diagonal problem": kursor yang bergerak menyerong menuju item dropdown tidak
  boleh dianggap keluar. — https://www.nngroup.com/articles/mega-menus-work-well/
- Pola yang tepat secara aksesibilitas untuk navigasi situs adalah **Disclosure Navigation Menu**,
  bukan `role="menu"`. APG menyatakan contoh ini sengaja tidak memakai menu role karena navigasi
  biasa tidak menyediakan keyboard behaviour yang dijanjikan widget menu ARIA. Tombol grup memakai
  `aria-expanded` dan `aria-controls`; Tab/Shift+Tab berpindah antar tombol dan tautan; Space/Enter
  men-toggle; Escape menutup dropdown dan mengembalikan fokus ke tombol. Arrow keys dan Home/End
  bersifat opsional. — https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-navigation/
- Escape bukan sekadar kenyamanan: APG menyebutnya dibutuhkan untuk memenuhi WCAG 1.4.13.
  SC 1.4.13 "Content on Hover or Focus" menuntut tiga hal — **Dismissible** (ada cara menutup tanpa
  memindahkan pointer/fokus), **Hoverable** (pointer bisa masuk ke konten tambahan tanpa konten itu
  hilang), dan **Persistent** (tetap terlihat sampai trigger dilepas, pengguna menutupnya, atau
  informasinya tidak lagi valid). — https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html
- Ukuran target pointer minimum pada WCAG 2.2 SC 2.5.8 (AA) adalah **24 × 24 piksel CSS**, dengan
  pengecualian antara lain "Spacing" (lingkaran diameter 24 px berpusat di target tidak bersinggungan
  dengan target lain) dan "Inline". — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- Soal berapa banyak item per grup: Material 3 menyatakan navigation rail dipakai untuk berpindah
  antara **tiga sampai tujuh** destinasi utama, dan jangan dipakai bila destinasi kurang dari tiga.
  Rail cocok untuk lebar jendela medium (600–839 dp) ke atas; di M3 Expressive, rail versi expanded
  menggantikan navigation drawer. — https://m3.material.io/components/navigation-rail/guidelines
- NN/g soal mega menu menyarankan granularitas menengah: kelompokkan opsi ke dalam set terkait dari
  hasil card sorting, hindari grup raksasa yang menuntut pemindaian panjang maupun pecahan grup yang
  terlalu halus, urutkan berdasarkan alur kerja atau kepentingan, dan tampilkan setiap pilihan hanya
  sekali. — https://www.nngroup.com/articles/mega-menus-work-well/
- Catatan jujur yang bertentangan sebagian dengan keputusan "satu terbuka sekaligus": untuk akordeon
  **konten halaman**, NN/g justru menulis agar pengguna diberi kemampuan membuka beberapa seksi
  sekaligus, dan menekankan bahwa akordeon menaikkan interaction cost karena pengguna
  memperlakukan klik seperti mata uang. Artikel itu berbicara tentang konten panjang di badan
  halaman, bukan tentang daftar tautan navigasi di kolom sempit. — https://www.nngroup.com/articles/accordions-complex-content/
- Progressive disclosure memberi kerangka yang lebih pas untuk navigasi: tampilkan lebih dulu sedikit
  opsi terpenting, tawarkan set khusus yang lebih besar bila diminta; lebih dari dua sampai tiga
  tingkat pengungkapan biasanya merusak usability. — https://www.nngroup.com/articles/progressive-disclosure/

**Implikasi untuk aplikasi ini**

- Pakai satu konstanta waktu, bukan angka ad hoc: `HOVER_OPEN_DELAY = 300`–`500` ms dan
  `HOVER_CLOSE_DELAY = 500` ms, dengan timer close yang dibatalkan saat pointer masuk ke panel
  flyout — itu sekaligus yang memenuhi syarat *Hoverable* SC 1.4.13.
- Hover hanya boleh menjadi jalan pintas, tidak pernah satu-satunya jalan. Setiap grup tetap
  tombol `aria-expanded` + `aria-controls` yang bisa di-toggle dengan klik, Enter, dan Space; Escape
  menutup dan mengembalikan fokus. Itu sekaligus jalur touch, karena tap = klik.
- Aktifkan hover-open hanya di bawah `@media (hover: hover) and (pointer: fine)`. Di perangkat sentuh
  hover tidak ada, dan perilaku hover yang "bocor" ke tap menghasilkan menu yang terbuka dua kali.
- Jangan pakai `role="menu"`/`menuitem` pada sidebar. Struktur `<nav>` + daftar + tombol disclosure
  sudah benar dan tidak menjanjikan keyboard behaviour yang tidak diimplementasikan.
- Batasi jumlah grup di level atas pada kisaran 3–7, dan jumlah item per grup pada kisaran yang sama.
  Bila satu grup melewati ~7 item, itu sinyal grup perlu dipecah atau dipindah ke halaman indeks,
  bukan di-scroll di dalam sidebar.
- "Satu grup terbuka sekaligus" dapat dipertahankan dengan argumen kolom sempit dan mobile-first
  (390 px), tetapi konsekuensinya harus dibayar: tandai item aktif dengan jelas dan pastikan grup
  yang memuat rute aktif selalu ikut terbuka saat halaman dimuat, supaya menutup-otomatis tidak
  pernah menyembunyikan posisi pengguna saat ini.
- Penanda item aktif: gunakan `aria-current="page"` pada tautan rute aktif (bukan sekadar kelas
  warna), karena warna saja tidak terbaca oleh screen reader dan kontrasnya rapuh.
- Target tap di mode ikon dan di submenu minimal 24 × 24 px CSS; untuk mobile-first sebaiknya
  diberi padding sampai sekitar 44–48 px tinggi baris, karena 24 px adalah batas minimum AA,
  bukan target kenyamanan.

---

## 2. Komponen Sidebar shadcn-svelte

- Perintah pemasangan untuk Bun: `bun x shadcn-svelte@latest add sidebar` (dokumentasi resmi
  menampilkan `pnpm dlx shadcn-svelte@latest add sidebar` pada tab pnpm). Flag `add` yang tersedia:
  `--cwd <path>`, `--no-deps-install`, `--skip-preflight`, `-a, --all`, `-y, --yes`,
  `-o, --overwrite`, `--proxy <proxy>`, `-h, --help`. `bunx` adalah alias `bun x`, jadi
  `bunx shadcn-svelte@latest add sidebar` setara. — https://www.shadcn-svelte.com/docs/cli
- `Sidebar.Provider` menerima `open` (boolean, bindable) dan `onOpenChange: (open: boolean) => void`.
  Layout dasarnya membungkus `AppSidebar` dan konten utama, dengan `Sidebar.Trigger` di dalam:

  ```svelte
  <Sidebar.Provider>
    <AppSidebar />
    <main>
      <Sidebar.Trigger />
      {@render children?.()}
    </main>
  </Sidebar.Provider>
  ```

  — https://www.shadcn-svelte.com/docs/components/sidebar
- `Sidebar.Root` menerima `side` (`left` | `right`), `variant` (`sidebar` | `floating` | `inset`),
  dan `collapsible` (`offcanvas` | `icon` | `none`). `offcanvas` menggeser sidebar keluar layar,
  `icon` menciutkannya menjadi ikon, `none` menonaktifkan penciutan. Bila memakai `variant="inset"`,
  konten utama harus dibungkus `Sidebar.Inset`. — https://www.shadcn-svelte.com/docs/components/sidebar
- Sub-komponen menu: `Sidebar.Menu`, `Sidebar.MenuItem`, `Sidebar.MenuButton`, `Sidebar.MenuSub`,
  `Sidebar.MenuSubItem`, `Sidebar.MenuSubButton`. — https://www.shadcn-svelte.com/docs/components/sidebar
- `useSidebar()` mengembalikan instance reaktif dengan `state` (`"expanded"` | `"collapsed"`),
  `open` (boolean), `setOpen(open)`, `isMobile` (boolean), dan `toggle()`:

  ```svelte
  <script lang="ts">
    import { useSidebar } from "$lib/components/ui/sidebar/index.js";
    const sidebar = useSidebar();
  </script>
  <button onclick={() => sidebar.toggle()}>Toggle Sidebar</button>
  ```

  — https://www.shadcn-svelte.com/docs/components/sidebar
- Integrasi Collapsible untuk submenu memakai pola `child` snippet Svelte 5 agar `Collapsible.Trigger`
  merender `Sidebar.MenuButton`:

  ```svelte
  <Sidebar.Menu>
    <Collapsible.Root open class="group/collapsible">
      <Sidebar.MenuItem>
        <Collapsible.Trigger>
          {#snippet child({ props })}
            <Sidebar.MenuButton {...props} />
          {/snippet}
        </Collapsible.Trigger>
        <Collapsible.Content>
          <Sidebar.MenuSub>
            <Sidebar.MenuSubItem />
          </Sidebar.MenuSub>
        </Collapsible.Content>
      </Sidebar.MenuItem>
    </Collapsible.Root>
  </Sidebar.Menu>
  ```

  — https://www.shadcn-svelte.com/docs/components/sidebar
- Persistensi state: cookie bernama `"sidebar_state"` dengan max-age `60 * 60 * 24 * 7` (7 hari).
  Shortcut keyboard default adalah `export const SIDEBAR_KEYBOARD_SHORTCUT = "b"`, yaitu `cmd+b` di
  Mac dan `ctrl+b` di Windows. — https://www.shadcn-svelte.com/docs/components/sidebar
- Di mode ikon, elemen yang tidak muat disembunyikan lewat data-attribute, misalnya
  `class="group-data-[collapsible=icon]:hidden"` untuk menyembunyikan `Sidebar.Group`.
  — https://www.shadcn-svelte.com/docs/components/sidebar
- Keterbatasan yang sudah dikonfirmasi upstream: ketika sidebar diciutkan ke tampilan ikon,
  collapsible menu tidak dapat membuka atau menampilkan sub-item. Isu shadcn-ui/ui #5874 berstatus
  **closed as not planned**, artinya ini perilaku yang diterima, bukan bug yang akan diperbaiki.
  Solusi yang beredar adalah merender `DropdownMenu` (atau `HoverCard`) saat sidebar collapsed dan
  non-mobile, menggantikan `Collapsible` — pola yang sama dipakai dokumentasi untuk
  `Sidebar.MenuAction` yang merender DropdownMenu. — https://github.com/shadcn-ui/ui/issues/5874
- Repositori ini sudah siap: `src/app.css` memuat token `--sidebar`, `--sidebar-foreground`,
  `--sidebar-primary`, `--sidebar-accent`, `--sidebar-border`, `--sidebar-ring`, dan mengimpor
  `shadcn-svelte/tailwind.css`. `components.json` memakai alias `ui: "$lib/components/ui"` dan
  `hooks: "$lib/hooks"`; saat ini hanya `button` yang sudah ter-generate di `src/lib/components/ui`.

**Implikasi untuk aplikasi ini**

- Pasang dengan `bunx shadcn-svelte@latest add sidebar collapsible dropdown-menu tooltip sheet`
  dalam satu perintah — Sidebar butuh Sheet (mode mobile), dan flyout mode ikon butuh
  DropdownMenu/Tooltip. Jangan jalankan instalasi sekarang; ini catatan untuk tiket implementasi.
- Rancang satu komponen `NavGroup` yang memilih rendering berdasarkan `useSidebar()`:
  `state === "collapsed" && !isMobile` → `DropdownMenu` flyout; selain itu → `Collapsible` akordeon.
  Ini adalah satu-satunya cara submenu tetap terjangkau di mode ikon, dan sekaligus menjadikan
  keputusan "hover flyout di mode ikon" sebagai implementasi dari workaround resmi, bukan improvisasi.
- Cookie `sidebar_state` dibaca di server (`+layout.server.ts`) dan diteruskan sebagai `open` awal
  ke `Sidebar.Provider`, supaya tidak ada kedipan lebar sidebar pada render pertama SSR.
- `isMobile` dari `useSidebar()` adalah sumber kebenaran untuk memutuskan Sheet vs rail. Jangan
  menduplikasi media query sendiri di komponen navigasi; gunakan nilai itu agar hanya ada satu
  breakpoint yang menentukan perilaku.
- Shortcut `ctrl+b` berpotensi bertabrakan dengan bold di editor Tiptap. Sediakan penonaktifan
  shortcut sidebar saat fokus berada di dalam editor, atau ganti `SIDEBAR_KEYBOARD_SHORTCUT`.
- Tooltip pada `Sidebar.MenuButton` wajib di mode ikon agar label tetap terbaca; perlakukan
  tooltip itu sebagai konten hover yang tunduk pada SC 1.4.13 (bisa ditutup dengan Escape).

---

## 3. Dashboard berbasis peran di `/`

- NN/g menekankan pemrosesan preattentive: **panjang dan posisi 2D** paling akurat untuk nilai
  kuantitatif, sementara **warna dan bentuk** lebih cocok untuk pengelompokan kategori karena orang
  tidak mempersepsi warna sebagai berurutan. — https://www.nngroup.com/articles/dashboards-preattentive/
- Rekomendasi bentuk visual: gunakan bar chart dan line graph sebagai kendaraan utama; hindari pie
  dan donut (mengandalkan luas area yang sulit dinilai), tolak grafik 3D (mendistorsi bentuk dan
  perataan), hindari treemap untuk dashboard sederhana, dan batasi gauge karena memakan ruang
  besar untuk informasi sedikit. — https://www.nngroup.com/articles/dashboards-preattentive/
- Prinsip penyusunan isi: tampilkan lebih dulu sedikit opsi terpenting dan tawarkan set yang lebih
  besar bila diminta; tampilan utama harus memuat semua yang sering dibutuhkan tanpa menjadi begitu
  padat sehingga perhatian kehilangan fokus. — https://www.nngroup.com/articles/progressive-disclosure/
- Empty state harus mengomunikasikan tiga hal: status sistem (mis. "tidak ada catatan untuk rentang
  tanggal yang dipilih" menaikkan kepercayaan pengguna), petunjuk belajar tentang cara fitur bekerja,
  dan jalur langsung berupa tautan atau tombol untuk memulai tugas yang mengisi area kosong itu.
  — https://www.nngroup.com/articles/empty-state-interface-design/

**Implikasi untuk aplikasi ini**

- Kartu KPI (angka + label + delta + tautan) valid secara teori karena angka besar adalah bentuk
  posisi/ukuran yang terbaca cepat, tetapi delta harus punya **periode pembanding eksplisit**
  ("dibanding bulan lalu"), bukan panah tanpa acuan. Delta tanpa acuan adalah angka yang tidak bisa
  ditindaklanjuti.
- Tiap kartu KPI wajib punya tautan turun ke daftar terfilter yang menghasilkan angka itu — itulah
  penerapan progressive disclosure, dan sekaligus cara pengguna memverifikasi angka.
- Bendahara mendahulukan yang menuntut tindakan: iuran jatuh tempo/tertunggak, saldo kas per akun,
  transaksi menunggu verifikasi, dan selisih rekonsiliasi. Warga mendahulukan yang bersifat pribadi
  dan pengumuman: status tagihan rumahnya sendiri, tanggal jatuh tempo berikutnya, riwayat bayar
  terakhir, dan pengumuman terbaru.
- Hindari vanity metric pada skala ~100 rumah: "total warga terdaftar" atau "jumlah pengumuman"
  tidak mengubah keputusan siapa pun. Metrik hanya masuk dashboard bila ada tindakan yang jelas
  ketika nilainya buruk.
- Pada 390 px, kartu ditumpuk satu kolom; urutan DOM menentukan prioritas, jadi urutan kartu harus
  ditentukan per peran di server, bukan diatur ulang dengan CSS `order` (yang memisahkan urutan
  visual dari urutan fokus keyboard).
- Setiap kartu butuh empty state sendiri, bukan "0" telanjang: "Belum ada tunggakan bulan ini" plus
  tautan ke daftar iuran jauh lebih informatif daripada angka nol tanpa konteks.
- Grafik, bila ditambahkan, pakai bar/line. Token `--chart-1` sampai `--chart-5` sudah ada di
  `src/app.css` tetapi semuanya abu-abu netral; warna di situ harus dipakai untuk membedakan
  kategori, bukan untuk mengurutkan besaran.

---

## 4. Memaksa input jam 24 jam di web

- MDN menyatakan eksplisit bahwa tampilan dan nilai terpisah: "While the control's user interface
  appearance is based on the browser and operating system, the features are the same. The value is
  always a 24-hour `HH:mm` or `HH:mm:ss` formatted time, with leading zeros, regardless of the UI's
  input format." — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/time
- Dan lagi: "The `value` of the `time` input is always in 24-hour format that includes leading zeros:
  `HH:mm`, regardless of the input format, which is likely to be selected based on the user's locale
  (or by the user agent)." Tidak ada atribut yang mengendalikan tampilan 12 jam vs 24 jam.
  — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/time
- Atribut `step` pada `type=time` bernilai detik, default `60` (satu menit); `step="120"` berarti
  kelipatan dua menit. — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/time
- MDN tidak menyebut atribut `pattern` untuk `type=time` sama sekali; `pattern` hanya berlaku pada
  input berbasis teks. — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/time
- Untuk nilai yang hanya terdiri dari angka tetapi bukan bilangan, MDN merekomendasikan
  `<input type="text" inputmode="numeric" pattern="\d*" />` alih-alih `type=number`.
  — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/number

**Implikasi untuk aplikasi ini**

- Keputusan memakai `type=date` terpisah + input teks `HH:mm` memang satu-satunya cara memastikan
  semua pengguna melihat 24 jam, karena tampilan `type=time` dan `datetime-local` tidak dapat
  dipaksa oleh author. Harga yang dibayar adalah hilangnya picker jam native, termasuk di mobile.
- Gunakan `inputmode="numeric"` (bukan `type=number`) pada input jam, dan `pattern` yang benar.
  Catatan: `pattern="[0-2][0-9]:[0-5][0-9]"` menerima `29:59` — pola yang benar-benar 00:00–23:59
  adalah `pattern="([01][0-9]|2[0-3]):[0-5][0-9]"`. Validasi server tetap wajib; `pattern` hanya
  lapisan pertama.
- Sertakan `placeholder="HH:mm"`, `maxlength="5"`, dan `autocomplete="off"`. `placeholder` tidak
  boleh menggantikan `<label>` — label tetap terlihat, karena placeholder hilang saat mengetik.
- Sediakan pesan galat yang ditulis manusia lewat `setCustomValidity` atau elemen pesan yang
  dirujuk `aria-describedby`; pesan default "Please match the requested format" tidak menjelaskan
  apa pun kepada warga.
- Alternatif dua `<select>` (jam dan menit) menjamin format dan valid secara keyboard, tetapi 24 + 60
  opsi terasa berat di mobile dan lebih lambat daripada mengetik empat digit. Untuk input yang sering
  diisi bendahara, teks + `inputmode="numeric"` lebih baik; dua select hanya dipertimbangkan bila
  menit dibatasi ke kelipatan (mis. 00/15/30/45).
- Karena `type=date` tetap dipakai, formatnya juga mengikuti locale user agent. Tampilkan hasil
  yang sudah diparsing kembali dalam format id-ID di dekat input (mis. "20 Sep 2026, 10.30 WIB")
  agar pengguna dapat memverifikasi bahwa yang tersimpan sama dengan yang dimaksud.

---

## 5. Input mata uang dengan pemisah ribuan

- `Intl.NumberFormat('id-ID')` menghasilkan pemisah ribuan titik dan desimal koma. Diverifikasi
  langsung pada Node v24.18.0 di mesin ini: `new Intl.NumberFormat('id-ID').format(1000000)` →
  `1.000.000`, dan `format(1234567.89)` → `1.234.567,89`. Dengan
  `{ style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }` → `Rp 1.000.000`.
  — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat/NumberFormat
- Opsi `useGrouping` menerima `"always"`, `"auto"`, `"min2"`, `true` (= `"always"`), dan `false`.
  Defaultnya `"min2"` bila `notation` adalah `"compact"`, dan `"auto"` selain itu. Artinya pada
  notasi biasa, `1000` tetap dikelompokkan menjadi `1.000` di id-ID.
  — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat/NumberFormat
- `maximumFractionDigits` untuk `style: "decimal"` default-nya nilai terbesar antara
  `minimumFractionDigits` dan `3`; untuk `style: "currency"` mengikuti jumlah digit minor unit dari
  daftar ISO 4217 (2 bila tidak tersedia). IDR pada praktiknya perlu di-override ke 0.
  — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat/NumberFormat
- MDN memperingatkan soal `type=number`: "Logically, you should not be able to enter characters
  inside a number input other than numbers. Some browsers allow invalid characters, others do not."
  Karena titik ribuan bukan angka, nilai berpemisah tidak dapat diandalkan di `type=number`.
  — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/number
- MDN juga menyarankan menghindari `type=number` bila spinbutton bukan fitur penting: "If spinbutton
  is not an important feature for your form control, consider _not_ using `type="number"`. Instead,
  use `inputmode="numeric"` along with a `pattern` attribute... With `<input type="number">`, there
  is a risk of users accidentally incrementing a number when they're trying to do something else."
  — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/number
- Penjaga caret secara teknis hanya mungkin pada input berbasis teks: `setSelectionRange()` hanya
  bekerja pada `type` `text`, `password`, `search`, `tel`, dan `url`; memanggilnya pada tipe lain,
  termasuk `type="number"`, melempar `InvalidStateError`. Properti `selectionStart`/`selectionEnd`
  mengikuti pembatasan yang sama.
  — https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/setSelectionRange

**Implikasi untuk aplikasi ini**

- Input Rupiah harus `type="text"` dengan `inputmode="numeric"`. Itu bukan preferensi gaya: tanpa
  `type="text"`, `setSelectionRange()` melempar dan penjagaan caret tidak dapat diimplementasikan
  sama sekali.
- Strategi penjaga caret yang stabil dan mudah diuji: sebelum memformat ulang, hitung berapa banyak
  **digit** yang ada di sebelah kiri caret; setelah menulis nilai terformat, geser caret ke posisi
  yang punya jumlah digit kiri yang sama. Menghitung selisih panjang string gagal begitu satu
  pemisah ditambahkan atau dihapus di tengah.
- Jangan format ulang saat pengguna sedang berada di tengah pengetikan yang belum stabil jika itu
  memindahkan caret secara tak terduga; format pada setiap `input` dapat diterima untuk bilangan
  bulat Rupiah (tanpa desimal), justru karena tidak ada koma desimal yang bisa "tertelan".
- Kirim bilangan bulat mentah, bukan string terformat. Dua pilihan: `<input type="hidden">` yang
  diperbarui bersamaan dengan input tampilan, atau parsing di server. Yang paling aman adalah
  **keduanya** — hidden input untuk jalur normal, dan parsing defensif di server yang membuang
  semua karakter non-digit — karena form dapat dikirim tanpa JavaScript aktif dan nilai apa pun dari
  klien tidak boleh dipercaya.
- Simpan uang sebagai bilangan bulat rupiah (atau tipe presisi tetap di database), tidak pernah
  sebagai float. Pemformatan hanya lapisan tampilan.
- Untuk tampilan (bukan input), pakai
  `new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })`
  yang menghasilkan `Rp 1.000.000`, sehingga label mata uang konsisten di seluruh aplikasi dan tidak
  dirakit manual dengan penggabungan string.
- Hindari `type="number"`: scroll roda mouse di atas field dapat mengubah nominal uang tanpa
  disadari, dan risiko itu tidak sepadan pada aplikasi keuangan.

---

## 6. Tiptap dengan Svelte 5

- Paket yang dipasang menurut panduan resmi Svelte:
  `npm install @tiptap/core @tiptap/pm @tiptap/starter-kit @tiptap/extension-bubble-menu`.
  `@tiptap/pm` wajib — itu bundel ProseMirror yang dipakai core.
  — https://tiptap.dev/docs/editor/getting-started/install/svelte
- Per 2026-09-20 panduan resmi **sudah memakai Svelte 5 runes**, bukan Svelte 4. Contohnya memakai
  `$state()`, `onMount`, `onDestroy`, dan callback `onTransaction` untuk memicu render ulang:

  ```svelte
  <script>
    import { onMount, onDestroy } from 'svelte'
    import { Editor } from '@tiptap/core'
    import { StarterKit } from '@tiptap/starter-kit'

    let element = $state()
    let editorState = $state({editor: null})

    onMount(() => {
      editorState.editor = new Editor({
        element: element,
        extensions: [StarterKit],
        content: `<p>…</p>`,
        onTransaction: ({ editor }) => {
          // Update the state signal to force a re-render
          editorState = { editor }
        },
      })
    })
    onDestroy(() => {
      editorState.editor?.destroy()
    })
  </script>

  <div bind:this={element}></div>
  ```

  — https://tiptap.dev/docs/editor/getting-started/install/svelte
- Isu ueberdosis/tiptap#6025 (masih **open**) mencatat bahwa panduan lama memakai idiom Svelte 4 di
  mana `editor = editor` memicu pembaruan, yang tidak lagi berlaku di runes mode. Pelapor mengusulkan
  pembungkus berbasis `createSubscriber()` yang berlangganan pada `editor.on("transaction", update)`,
  dengan dua varian: proxy yang berlangganan otomatis saat properti diakses, dan getter `current`
  yang lebih sederhana. — https://github.com/ueberdosis/tiptap/issues/6025
- StarterKit v3 sudah menyertakan mark `Link` dan `Underline` sebagai tambahan baru, di samping
  `Bold`, `Code`, `Italic`, `Strike`, node dasar (`Blockquote`, `BulletList`, `CodeBlock`,
  `Document`, `HardBreak`, `Heading`, `HorizontalRule`, `ListItem`, `OrderedList`, `Paragraph`,
  `Text`), serta `Dropcursor`, `Gapcursor`, `Undo/Redo`, `ListKeymap`, dan `TrailingNode`.
  Panduan upgrade v2→v3 secara eksplisit meminta menghapus
  `import Link from '@tiptap/extension-link'` karena sudah termuat.
  — https://tiptap.dev/docs/editor/extensions/functionality/starterkit
- Opsi Link yang relevan untuk keamanan: `defaultProtocol` (default `'http'`), `openOnClick`
  (default `true`), `autolink` (default `true`), `protocols`, dan `isAllowedUri(url, ctx)` untuk
  validasi kustom. — https://tiptap.dev/docs/editor/extensions/marks/link
- Konfigurasi dilakukan lewat `StarterKit.configure({ ... })`, yang juga bisa menonaktifkan
  ekstensi bawaan (`undoRedo: false`) atau membatasi `heading.levels`.
  — https://tiptap.dev/docs/editor/extensions/functionality/starterkit
- Repositori ini sudah punya jalur sanitasi server yang matang: `src/lib/server/services/post/markdown.ts`
  memakai `marked` untuk mengubah Markdown menjadi HTML lalu `sanitize-html` untuk membangun ulang
  HTML dari allowlist, dengan komentar yang secara eksplisit mencatat bahwa `marked` bukan sanitizer
  dan meneruskan raw HTML apa adanya, serta bahwa `data:text/html` diperlakukan sebagai script
  same-origin.
- `@tailwindcss/typography` **tidak** terpasang di repositori ini: `package.json` tidak memuatnya dan
  `src/app.css` tidak memuat `@plugin "@tailwindcss/typography"` — hanya `tailwindcss`,
  `tw-animate-css`, `shadcn-svelte/tailwind.css`, dan `@fontsource-variable/inter`. Karena itu kelas
  `prose` tidak akan menghasilkan apa pun sampai plugin ditambahkan.

**Implikasi untuk aplikasi ini**

- Ikuti panduan resmi apa adanya: `$state` + `onMount` + `onDestroy` + `onTransaction`. Pola
  `createSubscriber()` dari isu #6025 baru diperlukan bila ada banyak turunan reaktif dari state
  editor (misalnya toolbar besar); untuk toolbar kecil, `onTransaction` yang mengganti objek state
  sudah cukup dan jauh lebih sedikit kode.
- `onMount`/`onDestroy` sekaligus menyelesaikan masalah SSR: `new Editor()` menyentuh DOM, jadi ia
  tidak boleh berjalan di server. Pastikan komponen editor tidak pernah dirender saat SSR tanpa
  penjaga.
- Jangan memasang `@tiptap/extension-link` terpisah bila memakai Tiptap 3 — Link sudah ada di
  StarterKit, dan memasang dua kali menimbulkan konflik nama ekstensi. Konfigurasikan lewat
  `StarterKit.configure({ link: { defaultProtocol: 'https', openOnClick: false } })`.
- Verifikasi versi mayor sebelum menulis kode: instruksi di atas berlaku untuk Tiptap 3. Bila yang
  terpasang v2, Link dan Underline harus diimpor terpisah.
- `editor.getHTML()` menghasilkan HTML klien yang **tidak tepercaya**. Alirkan melalui
  `sanitize-html` di server dengan allowlist yang sudah ada di `markdown.ts`, bukan dengan
  konfigurasi baru — satu allowlist untuk seluruh aplikasi jauh lebih mudah diaudit. Allowlist itu
  mungkin perlu ditambah tag yang dihasilkan Tiptap tetapi tidak dihasilkan `marked`.
- Sanitasi di klien tidak pernah menggantikan sanitasi di server. HTML yang disimpan harus sudah
  bersih saat masuk database, sehingga pembacaan berikutnya tidak bergantung pada sanitasi saat render.
- Untuk styling: tambahkan `@tailwindcss/typography` dan `@plugin "@tailwindcss/typography";` di
  `src/app.css` bila ingin memakai `prose`, atau tulis sendiri aturan untuk daftar tag yang ada di
  allowlist. Pilihan kedua lebih kecil dan selaras dengan allowlist, tetapi berarti menulis CSS
  manual untuk heading, list, blockquote, dan tabel.
- Gunakan `prose` yang sama untuk area edit dan area tampilan, supaya WYSIWYG benar-benar "what you
  see is what you get".

---

## 7. `exceljs` untuk impor dan template XLSX

- Membaca dari buffer: `await workbook.xlsx.load(data)`; dari file: `await workbook.xlsx.readFile(filename)`;
  dari stream: `await workbook.xlsx.read(stream)`. — https://github.com/exceljs/exceljs
- Menulis: `const buffer = await workbook.xlsx.writeBuffer();`, atau
  `await workbook.xlsx.writeFile(filename)`, atau `await workbook.xlsx.write(stream)`.
  — https://github.com/exceljs/exceljs
- Data validation tipe daftar dipasang per sel:

  ```javascript
  worksheet.getCell('A1').dataValidation = {
    type: 'list',
    allowBlank: true,
    formulae: ['"One,Two,Three,Four"']
  };
  ```

  Perhatikan tanda kutip ganda di dalam string: daftar literal harus dibungkus `"` di dalam formula.
  — https://github.com/exceljs/exceljs
- Validasi dengan pesan galat kustom:

  ```javascript
  worksheet.getCell('A1').dataValidation = {
    type: 'whole',
    operator: 'notEqual',
    showErrorMessage: true,
    formulae: [5],
    errorStyle: 'error',
    errorTitle: 'Five',
    error: 'The value must not be Five'
  };
  ```

  — https://github.com/exceljs/exceljs
- Tipe validasi yang tersedia mencakup `list` (himpunan nilai diskrit sebagai dropdown), `whole`,
  `decimal`, `textLength`, dan `custom`. — https://github.com/exceljs/exceljs

**Implikasi untuk aplikasi ini**

- Kolom status hunian dibuat dengan
  `dataValidation: { type: 'list', allowBlank: false, showErrorMessage: true, formulae: ['"pemilik,penyewa"'] }`.
  Terapkan ke rentang baris yang diantisipasi (mis. `A2:A200`), bukan hanya ke satu sel, jika tidak
  dropdown hanya muncul di baris pertama.
- Nilai di `formulae` harus persis nilai yang diterima parser impor. Ambil daftar itu dari satu
  konstanta TypeScript yang sama-sama dipakai oleh penulis template dan validator impor, supaya
  dropdown tidak pernah menawarkan nilai yang ditolak server.
- Batas panjang daftar inline di Excel adalah sekitar 255 karakter. Bila daftar nilai bertambah
  panjang, pindahkan ke sheet referensi tersembunyi dan rujuk dengan `formulae: ['=Ref!$A$1:$A$20']`.
  Untuk dua nilai (`pemilik`, `penyewa`) ini belum menjadi masalah.
- `showErrorMessage: true` dengan `errorStyle: 'error'` menolak nilai tak sah di Excel; tanpanya
  dropdown hanya sugesti dan pengguna tetap bisa mengetik apa saja. Tetap validasi ulang di server —
  data validation adalah kenyamanan pengisian, bukan kontrol keamanan.
- Di SvelteKit, `request.formData()` memberi `File`; ubah dengan
  `Buffer.from(await file.arrayBuffer())` lalu `workbook.xlsx.load(buffer)`. `load()` menerima buffer
  dan itulah jalur untuk file yang diunggah.
- MIME type XLSX adalah
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. Gunakan pada header
  `Content-Type` saat mengunduh template, bersama
  `Content-Disposition: attachment; filename="template-warga.xlsx"`. Jangan mengandalkan MIME dari
  klien untuk memvalidasi unggahan — periksa ekstensi dan, lebih baik, biarkan `xlsx.load()` gagal
  dan tangani galatnya.
- Batasi ukuran unggahan sebelum parsing. Untuk ~100 rumah, file wajar berukuran puluhan kilobyte;
  batas beberapa megabyte sudah sangat longgar dan mencegah unggahan yang menghabiskan memori.

---

## 8. Rendering zona waktu WIB

- Diverifikasi langsung pada mesin ini (Node v24.18.0 dan Bun 1.3.14), tanggal uji
  `2026-09-20T03:30:00Z`:

  | Opsi | Keluaran |
  |---|---|
  | `{ timeZone: 'Asia/Jakarta', day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', timeZoneName:'short' }` | `20 Sep 2026, 10.30 WIB` |
  | `{ timeZone: 'Asia/Jakarta', hour:'2-digit', minute:'2-digit', timeZoneName:'long' }` | `10.30 Waktu Indonesia Barat` |
  | `{ timeZone: 'Asia/Jakarta', hour:'2-digit', minute:'2-digit', timeZoneName:'shortGeneric' }` | `10.30 WIB` |
  | `{ timeZone: 'Asia/Jakarta', timeStyle:'long' }` | `10.30.00 WIB` |
  | `{ timeZone: 'Asia/Jakarta', timeStyle:'full' }` | `10.30.00 Waktu Indonesia Barat` |
  | locale `en-US`, `timeZoneName:'short'` | `10:30 AM GMT+7` |

  Jadi ya: `Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', timeZoneName: 'short' })`
  mencetak `WIB`, tetapi hanya karena locale-nya `id-ID`. Locale `en-US` menghasilkan `GMT+7`.
  — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat
- Dua temuan lain dari verifikasi yang sama:
  - `resolvedOptions().hourCycle` untuk `id-ID` adalah `h23`, jadi jam 24 sudah menjadi default
    locale ini dan tidak perlu `hour12: false` eksplisit.
  - id-ID memakai **titik** sebagai pemisah jam-menit (`10.30`), bukan titik dua. Ini benar secara
    lokal tetapi berbeda dari `HH:mm` yang diketik pengguna di form.
- Menggabungkan `dateStyle`/`timeStyle` dengan komponen individual ditolak: Node melempar
  `TypeError: Invalid option : option` ketika `dateStyle` dan `timeZoneName` diberikan bersamaan.
  Pilih salah satu gaya — seluruhnya `dateStyle`/`timeStyle`, atau seluruhnya komponen individual.
  — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat
- Cakupan ICU: Node v24.18.0 dan Bun 1.3.14 di mesin ini keduanya mengembalikan nama zona
  terlokalisasi bahasa Indonesia, jadi keduanya dibangun dengan full ICU. Node modern memaketkan
  full ICU secara default; build `small-icu` hanya memuat data `en-US` dan akan mencetak `GMT+7`
  alih-alih `WIB`. — https://nodejs.org/api/intl.html

**Implikasi untuk aplikasi ini**

- Bungkus pemformatan tanggal/waktu dalam satu modul helper dengan `timeZone: 'Asia/Jakarta'`
  sebagai konstanta. Jangan sebar opsi `Intl` di komponen; satu titik kegagalan lebih mudah diuji
  daripada dua puluh.
- Jangan merakit label "WIB" dengan penggabungan string. `timeZoneName: 'short'` pada locale `id-ID`
  sudah menghasilkannya, dan itu tetap benar bila kelak ada zona lain.
- Waspadai interaksi dengan paraglide: bila locale aktif berubah ke `en`, `timeZoneName: 'short'`
  akan menghasilkan `GMT+7`, bukan `WIB`. Bila label WIB harus muncul di semua locale, kunci locale
  pemformatan waktu ke `'id-ID'` secara eksplisit dan perlakukan itu sebagai keputusan sadar —
  bahasa antarmuka dan locale pemformatan waktu tidak harus sama.
- Tambahkan tes unit yang mengunci keluaran persis (`20 Sep 2026, 10.30 WIB`) untuk satu tanggal
  tetap. Tes itu akan gagal bila runtime pindah ke build small-ICU atau data CLDR berubah — tepat
  saat kegagalan itu perlu diketahui.
- Pastikan `TZ` server tidak memengaruhi hasil: dengan `timeZone` eksplisit, zona sistem tidak
  relevan untuk pemformatan. Tetap simpan semua timestamp di database sebagai UTC dan konversi
  hanya di lapisan tampilan.
- Perbedaan pemisah (`10.30` untuk tampilan vs `10:30` untuk input) bukan bug, tetapi perlu
  konsistensi: input memakai `HH:mm` karena itu yang standar dan yang dikenali pengguna saat
  mengetik; tampilan memakai format locale. Jelaskan ini di label input agar tidak dianggap
  tidak konsisten.
- `hourCycle` `h23` bawaan id-ID berarti tampilan waktu di aplikasi ini sudah 24 jam tanpa usaha
  tambahan — yang "sulit" hanya sisi input, sesuai bagian 4.

---

## Sumber

- https://www.nngroup.com/articles/timing-exposing-content/
- https://www.nngroup.com/articles/mega-menus-work-well/
- https://www.nngroup.com/articles/accordions-complex-content/
- https://www.nngroup.com/articles/progressive-disclosure/
- https://www.nngroup.com/articles/dashboards-preattentive/
- https://www.nngroup.com/articles/empty-state-interface-design/
- https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-navigation/
- https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- https://m3.material.io/components/navigation-rail/guidelines
- https://www.shadcn-svelte.com/docs/components/sidebar
- https://www.shadcn-svelte.com/docs/cli
- https://github.com/shadcn-ui/ui/issues/5874
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/time
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/number
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/setSelectionRange
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat/NumberFormat
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat
- https://tiptap.dev/docs/editor/getting-started/install/svelte
- https://tiptap.dev/docs/editor/extensions/functionality/starterkit
- https://tiptap.dev/docs/editor/extensions/marks/link
- https://github.com/ueberdosis/tiptap/issues/6025
- https://github.com/exceljs/exceljs
- https://nodejs.org/api/intl.html
