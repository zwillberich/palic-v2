# Palic v2

Bot trading memecoin Solana dengan strategi **P6**
(playbook dari dokumen *Benang Merah Trenching Memecoin Solana*: pair baru + bar 5m meledak, tahan 60 menit, dead-exit 10 menit/+2%, trailing yang bisa diatur, tanpa TP/SL harga).
Setiap posisi, notifikasi, dan riwayat diberi label strateginya.
Semua kode ditulis dari nol; dependensi hanya `canvas`, `@solana/web3.js`, `bs58` (Node >= 22.13).

**Mode bawaan: PAPER.** Eksekusi sungguhan (swap Jupiter dari wallet bot) tersedia tetapi mati; hanya menyala jika operator
mengetik `LIVE` di Mini App (tab Wallet). Kunci privat dibaca dari `SOLANA_PRIVATE_KEY` di dalam proses bot, tidak pernah
dicatat atau dikirim keluar.

## Instalasi
Butuh Linux/macOS, **Node.js >= 22.13**, dan bot Telegram (buat di @BotFather).
```bash
unzip palic-v2.zip && cd palic-v2
./install.sh             # cek Node, npm ci, buat .env dari .env.example, jalankan tes
nano .env                # isi TELEGRAM_BOT_TOKEN (+ HELIUS_API_KEY disarankan)
npm start                # kirim /start ke bot -> isi TELEGRAM_CHAT_ID dengan ID yang dibalas, lalu Ctrl+C
npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save
```
Semua isi `.env` dijelaskan di `.env.example`. File `.env`, database, dan log tidak pernah ikut di zip ini.

## Mini App
Tombol menu bot membuka Mini App (Status, posisi, aktivitas, setelan, wallet, laporan). Butuh
`TELEGRAM_ADMIN_IDS`/`TELEGRAM_CHAT_ID`, tunnel HTTPS (`MINIAPP_TUNNEL_METRICS` atau `MINIAPP_PUBLIC_URL`) dan `MINIAPP_PORT`.
Notifikasi beli/jual dikirim sebagai kartu bergambar dan laporan harian ±23:55 WIB.

## Eksekusi live
Quote + swap lewat Jupiter, ditandatangani di proses bot, dikirim lewat RPC (`SOLANA_RPC_URL` atau `HELIUS_API_KEY`).
Pengaman: ukuran sendiri (`live_size_sol`), slippage sendiri, tolak price impact > 5%, saldo wajib cukup + cadangan fee,
satu transaksi per token sekaligus, jual gagal dicoba ulang otomatis.

## Perintah Telegram
`/status` `/posisi` `/close <id|$ticker>` `/history [n]` `/scan` `/settings` `/set <nama> <nilai>` `/pause` `/resume`.
Semua setelan bisa diubah lewat `/set` atau Mini App; tiap perubahan dicatat dan bisa dibatalkan.
Kartu notifikasi posisi baru menampilkan tombol **Close** di baris yang sama dengan GMGN dan CA; `/posisi` juga menampilkan tombol **Tutup**.
Gunakan `/close <id>` atau `/close $TICKER` untuk meminta penutupan. Jika beberapa posisi terbuka memakai ticker yang sama,
pilih ID posisi yang benar terlebih dulu. Semua jalur meminta konfirmasi kedua yang berlaku 60 detik; penutupan LIVE baru mencoba menjual token setelah konfirmasi.
Penutupan PAPER memakai harga terbaru yang tersedia; bila harga tidak tersedia dan harga terakhir sudah basi, posisi dibiarkan terbuka.

## Batasan yang jujur
- Eksekusi live belum pernah dikirim ke jaringan dengan dana sungguhan; format transaksi diuji terhadap API Jupiter asli dan
  alurnya dengan RPC palsu. Mulai dari ukuran kecil.
- Belum di-backtest. Hasil paper bukan jaminan hasil live.

## Fee pembuat bot (diumumkan)
Setiap swap **LIVE** (beli dan jual) memakai fee platform Jupiter **0,5%** yang masuk ke akun referral pembuat bot.
Fee hanya dipasang bila akun penerimanya untuk token itu sudah ada; kalau belum, swap tetap jalan tanpa fee.
Mode PAPER tidak memakai fee apa pun. Konfigurasinya ada di `src/route-config.js`; dengan memakai bot ini Anda menyetujui fee tersebut.
