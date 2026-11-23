import { SPEC, allSettings, setSetting } from './settings.js';
import { realizedPnlSince, openPositions } from './risk.js';
import { fmt } from './engine.js';
import { getState } from './db.js';
import { tokenButtons, tokenRows } from './tokenlinks.js';
import { strategyName } from './strategies.js';

const DAY = 86_400_000;
const CLOSE_CONFIRM_MS = 60_000;
const sign = (n, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;
const ago = (ms) => { const m = Math.round(ms / 60_000); return m < 90 ? `${m}m` : `${(m / 60).toFixed(1)}j`; };

export function createCommands({ db, engine, jup, now = () => Date.now() }) {
  const pendingCloses = new Map();

  async function requestClose(rawId) {
    const text = String(rawId || '').trim();
    if (!/^\d{1,12}$/.test(text)) return 'Format: /close <id>. Lihat /posisi untuk ID posisi.';
    const id = Number(text);
    if (!Number.isSafeInteger(id) || id <= 0) return 'ID posisi tidak valid.';
    const position = db.prepare("SELECT id, mint, symbol, execution_mode, entry_price, last_price, last_price_ms FROM positions WHERE id = ? AND status = 'open'").get(id);
    if (!position) return `Posisi terbuka #${id} tidak ditemukan. Lihat /posisi.`;

    const prices = await jup.prices([position.mint]).catch(() => ({}));
    const quotedPrice = Number(prices?.[position.mint]);
    const lastPrice = Number(position.last_price);
    const lastPriceAt = Number(position.last_price_ms || 0);
    const requestedAt = now();
    for (const [pendingId, expiry] of pendingCloses) if (expiry <= requestedAt) pendingCloses.delete(pendingId);
    const expiresAt = requestedAt + CLOSE_CONFIRM_MS;
    pendingCloses.set(id, expiresAt);
    const recentLastPrice = Number.isFinite(lastPrice) && lastPrice > 0 && lastPriceAt > 0
      && requestedAt >= lastPriceAt && requestedAt - lastPriceAt <= 120_000;
    const markPrice = Number.isFinite(quotedPrice) && quotedPrice > 0 ? quotedPrice : (recentLastPrice ? lastPrice : null);
    const live = position.execution_mode === 'live';
    if (!live && !markPrice) {
      pendingCloses.delete(id);
      return 'Harga terbaru tidak tersedia; posisi PAPER tetap terbuka. Coba lagi saat feed harga pulih.';
    }
    const markText = markPrice && Number(position.entry_price) > 0
      ? `Harga indikatif saat permintaan: ${fmt(markPrice)} (${sign((markPrice / position.entry_price - 1) * 100)}% sebelum biaya; bukan hasil fill).\n`
      : 'Harga feed tidak tersedia; hasil jual LIVE ditentukan quote eksekusi.\n';
    return {
      text: `Konfirmasi tutup posisi #${id} ${position.symbol || ''} (${live ? 'LIVE' : 'PAPER'}).\n${markText}${live ? 'LIVE: konfirmasi akan mencoba menjual token sungguhan di chain; harga dan hasil fill tidak dijamin.' : 'PAPER: konfirmasi akan menutup simulasi memakai harga yang tersedia, slippage, dan fee paper.'}\nKonfirmasi berlaku 60 detik.`,
      buttons: [[
        { text: `Konfirmasi tutup #${id}`, callback_data: `close:confirm:${id}:${expiresAt}` },
        { text: 'Batal', callback_data: `close:cancel:${id}:${expiresAt}` },
      ]],
    };
  }

  async function handleCallback(data) {
    const match = /^close:(ask|confirm|cancel):(\d{1,12})(?::(\d{10,16}))?$/.exec(String(data || ''));
    if (!match) return 'Tombol tidak dikenal.';
    const [, action, rawId, rawExpiry] = match;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) return 'ID posisi tidak valid.';
    if (action === 'ask') return requestClose(rawId);

    const expiresAt = Number(rawExpiry);
    const pendingExpiry = pendingCloses.get(id);
    if (!rawExpiry || pendingExpiry !== expiresAt) return 'Permintaan konfirmasi sudah tidak aktif. Jalankan /close <id> lagi.';
    if (now() >= expiresAt) {
      pendingCloses.delete(id);
      return 'Konfirmasi kedaluwarsa. Jalankan /close <id> lagi jika masih ingin menutup posisi.';
    }
    pendingCloses.delete(id);
    if (action === 'cancel') return `Penutupan posisi #${id} dibatalkan.`;

    const position = db.prepare("SELECT symbol, execution_mode FROM positions WHERE id = ? AND status = 'open'").get(id);
    if (!position) return `Posisi #${id} sudah tidak terbuka.`;
    const result = await engine.closeManually(id);
    if (result?.ok) return `Posisi #${id} ${position.symbol || ''} berhasil ditutup manual (${position.execution_mode === 'live' ? 'LIVE' : 'PAPER'}).`;
    return `Posisi #${id} belum berhasil ditutup: ${result?.error || 'gagal atau sedang diproses'}. Cek /posisi sebelum mencoba lagi.`;
  }

  const handlers = {
    help: () => [
      'Palic v2 · strategi P6. Kontrol penuh di Mini App (tombol menu).',
      '/status ringkasan · /posisi posisi terbuka',
      '/close <id> minta konfirmasi tutup · /history [n] transaksi tertutup',
      '/scan pindai sekarang · /settings daftar setelan · /set <nama> <nilai>',
      '/pause · /resume jeda entry baru',
      'Tutup LIVE baru dilakukan setelah tombol konfirmasi kedua ditekan.',
    ].join('\n'),
    start: () => handlers.help(),

    status() {
      const open = openPositions(db);
      const total = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(pnl_sol),0) AS pnl, COALESCE(SUM(pnl_sol > 0),0) AS wins FROM positions WHERE status='closed'").get();
      const lines = [
        `${getState(db, 'trading_mode', 'dry_run') === 'live' ? 'LIVE' : 'PAPER'} · ${open.length} posisi terbuka`,
        `PnL 24j: ${sign(realizedPnlSince(db, now() - DAY), 4)} SOL · total: ${sign(Number(total.pnl), 4)} SOL (${total.n} tutup, menang ${total.wins})`,
      ];
      const p6 = engine.lastScanP6?.();
      if (!p6) lines.push('Belum ada pemindaian.');
      if (p6) lines.push(`P6 ${ago(now() - p6.at)} lalu: ${p6.fetched} pair → ${p6.screened} kandidat → ${p6.analysed} dianalisis, ${p6.entries} masuk${p6.error ? ` · ${p6.error}` : ''}`);
      return lines.join('\n');
    },

    async posisi() {
      const open = openPositions(db);
      if (!open.length) return 'Tidak ada posisi terbuka.';
      const prices = await jup.prices(open.map((p) => p.mint)).catch(() => ({}));
      const text = open.map((p) => {
        const px = prices[p.mint];
        const pnl = px ? (px / p.entry_price - 1) * 100 : null;
        const rules = p.strategy === 'p6'
          ? `tahan ${Math.round((p.hold_ms || 0) / 60000)}m · dead-exit ${Math.round((p.dead_exit_ms || 0) / 60000)}m/+${p.dead_exit_pct}%`
          : `TP ${fmt(p.tp_price)} · SL ${fmt(p.sl_price)}${p.breakeven_done ? ' (breakeven)' : ''}`;
        return `#${p.id} ${p.symbol} [${strategyName(p.strategy)}] · masuk ${fmt(p.entry_price)} · kini ${px ? fmt(px) : '?'}${pnl == null ? '' : ` (${sign(pnl)}%)`}\n   ${rules} · ${ago(now() - p.entry_ms)}`;
      }).join('\n');
      const buttons = open.slice(0, 20).map((p) => [
        { text: `Tutup #${p.id}`, callback_data: `close:ask:${p.id}` },
        ...tokenButtons(p.mint),
      ]);
      return { text, buttons };
    },

    close(arg) { return requestClose(arg); },

    history(arg) {
      const n = Math.min(30, Math.max(1, Number(arg) || 10));
      const rows = db.prepare("SELECT * FROM positions WHERE status='closed' ORDER BY exit_ms DESC LIMIT ?").all(n);
      if (!rows.length) return 'Belum ada transaksi tertutup.';
      const text = rows.map((p) => `#${p.id} ${p.symbol} [${strategyName(p.strategy)}] ${sign(p.pnl_pct)}% (${sign(p.pnl_sol, 4)} SOL) · ${p.exit_reason} · ${ago(p.exit_ms - p.entry_ms)}`).join('\n');
      return { text, buttons: tokenRows(rows) };
    },

    async scan() {
      const s = await engine.scanP6();
      return `Scan P6 selesai: ${s.fetched} pair → ${s.screened} kandidat → ${s.analysed} dianalisis. Masuk ${s.entries}.${s.error ? ` Error: ${s.error}` : ''}`;
    },

    settings() {
      return allSettings(db).map((s) => `${s.key} = ${s.value}${s.value === s.def ? '' : ` (bawaan ${s.def})`}`).join('\n');
    },

    set(arg) {
      const [key, ...rest] = String(arg || '').split(/\s+/);
      if (!key || !rest.length) return 'Format: /set <nama> <nilai>. Lihat /settings.';
      const r = setSetting(db, key, rest.join(' '), 'telegram', now());
      return r.ok ? `${key}: ${r.before} → ${r.value}` : `Ditolak: ${r.error}`;
    },

    pause: () => handlers.set('paused true'),
    resume: () => handlers.set('paused false'),
  };

  async function handle(text) {
    const [head, ...rest] = text.trim().split(/\s+/);
    const name = head.replace(/^\//, '').replace(/@.*$/, '').toLowerCase();
    const fn = handlers[name];
    if (!fn || !Object.prototype.hasOwnProperty.call(handlers, name)) return 'Perintah tidak dikenal. /help';
    return await fn(rest.join(' '));
  }

  handle.callbackQuery = handleCallback;
  return handle;
}

export { SPEC };
