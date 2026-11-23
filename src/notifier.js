// Mengirim notifikasi ke Telegram: kartu bergambar untuk posisi dibuka/ditutup dan laporan harian, teks untuk lainnya.
// Kalau kartu gagal digambar, teks tetap terkirim.
import { generateEntryCard } from './visuals/entryCard.js';
import { generateExitCard } from './visuals/exitCard.js';
import { generateDailyCard } from './visuals/dailyCard.js';
import { currentPublicUrl } from './miniapp/publicUrl.js';
import { strategyName } from './strategies.js';
import { getSetting } from './settings.js';
import { tokenButtons } from './tokenlinks.js';

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const EXIT_TEXT = { tp: 'take profit (target)', sl: 'stop loss', breakeven: 'breakeven', time: 'max hold', manual: 'manual', dead: 'dead-exit', time: 'hold selesai', trail: 'trailing', no_price: 'harga hilang / pool kering', liquidity: 'likuiditas anjlok' };

export function createNotifier({ tg, db, solUsd = async () => null, log = console.log }) {
  let lastSol = null;
  const money = (sol, signed = false) => {
    const v = Number(sol);
    if (!Number.isFinite(v)) return '?';
    const sign = signed ? (v >= 0 ? '+' : '-') : (v < 0 ? '-' : '');
    if (!lastSol) return `${sign}${Math.abs(v).toFixed(4)} SOL`;
    const usd = Math.abs(v * lastSol);
    return `${sign}$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)}`;
  };
  // Satu baris: Mini App (jika tersedia), GMGN, CA, lalu Close hanya untuk notifikasi posisi baru dibuka.
  const keyboard = (mint, view = null, closePositionId = null) => {
    const row = [];
    const url = view ? currentPublicUrl() : '';
    if (url) row.push({ text: 'Buka di Palic', web_app: { url: `${url}/?view=${view}` } });
    if (mint) row.push(...tokenButtons(mint));
    if (Number.isSafeInteger(Number(closePositionId)) && Number(closePositionId) > 0) {
      row.push({ text: `Close #${closePositionId}`, callback_data: `close:ask:${closePositionId}` });
    }
    return row.length ? { reply_markup: { inline_keyboard: [row] } } : {};
  };
  const position = (id) => db.prepare('SELECT * FROM positions WHERE id = ?').get(id);

  const entryRow = (p) => ({
    id: p.id, mint: p.mint, symbol: p.symbol, execution_mode: p.execution_mode, opened_at_ms: p.entry_ms, size_sol: p.size_sol,
    entry_price: p.entry_price, entry_mcap: p.entry_mcap, snapshot_json: p.snapshot_json,
    tp_percent: p.strategy === 'p6' ? null : (p.tp_price / p.entry_price - 1) * 100, sl_percent: p.strategy === 'p6' ? null : (p.sl_price / p.entry_price - 1) * 100,
  });
  const exitRow = (p) => ({
    mint: p.mint, symbol: p.symbol, execution_mode: p.execution_mode, size_sol: p.size_sol, pnl_sol: p.pnl_sol, pnl_percent: p.pnl_pct, exit_reason: p.exit_reason,
    opened_at_ms: p.entry_ms, closed_at_ms: p.exit_ms, exit_valuation: 'quote',
  });

  async function notify(text, meta = {}) {
    if (!tg.enabled) return;
    try {
      if (meta.kind === 'opened' || meta.kind === 'closed') {
        const p = position(meta.positionId);
        if (p) {
          lastSol = (await solUsd().catch(() => null)) || lastSol;
          const live = p.execution_mode === 'live';
          const link = `<a href="https://gmgn.ai/sol/token/${esc(p.mint)}">${esc(p.symbol)}</a>`;
          let buffer, caption;
          if (meta.kind === 'opened') {
            buffer = await generateEntryCard(entryRow(p));
            const tp = (p.tp_price / p.entry_price - 1) * 100;
            const sl = (p.sl_price / p.entry_price - 1) * 100;
            const rules = p.strategy === 'p6' ? [`hold ${Math.round((p.hold_ms || 0) / 60000)}m`, `dead-exit ${Math.round((p.dead_exit_ms || 0) / 60000)}m/+${p.dead_exit_pct}%`, ...(getSetting(db, 'p6_trail_enabled') ? [`trailing ${getSetting(db, 'p6_trail_pct')}% setelah +${getSetting(db, 'p6_trail_arm_pct')}%`] : [])] : [`TP +${tp.toFixed(1)}%`, `SL −${Math.abs(sl).toFixed(1)}%`];
            caption = [`<b>Position opened</b> · ${link}`, `<b>Strategi: ${esc(strategyName(p.strategy))}</b>`, [live ? 'Live' : 'Paper', `size ${money(p.size_sol)}`, ...rules].join(' · ')].join('\n');
          } else {
            buffer = await generateExitCard(exitRow(p), { solUsd: lastSol });
            const pct = Number(p.pnl_pct);
            caption = [`<b>${pct > 0.05 ? 'PROFIT' : pct < -0.05 ? 'LOSS' : 'EVEN'}</b> · ${link} ${live ? 'sold' : 'closed (paper)'} · ${esc(EXIT_TEXT[p.exit_reason] || p.exit_reason)}`, `<b>Strategi: ${esc(strategyName(p.strategy))}</b>`, `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% · ${money(p.pnl_sol, true)}`].join('\n');
          }
          const closeId = meta.kind === 'opened' ? p.id : null;
          await tg.sendPhoto(buffer, caption, { parse_mode: 'HTML', ...keyboard(p.mint, `positions/${p.id}`, closeId) });
          return;
        }
      }
    } catch (err) { log(`[notifier] kartu gagal, kirim teks: ${err.message}`); }
    // Pesan teks (dan cadangan bila kartu gagal): tetap beri tombol GMGN/CA untuk token yang disebut.
    const related = (meta.kind === 'opened' || meta.kind === 'closed') ? position(meta.positionId) : null;
    const mint = meta.mint || related?.mint || null;
    const closeId = meta.kind === 'opened' ? meta.positionId : null;
    await tg.send(text, keyboard(mint, meta.positionId ? `positions/${meta.positionId}` : null, closeId));
  }

  notify.dailyReport = async (report) => {
    try { await tg.sendPhoto(await generateDailyCard(report), `Laporan harian · ${report.totalTrades} trade · PnL ${report.pnlSol >= 0 ? '+' : ''}${report.pnlSol.toFixed(4)} SOL`); }
    catch (err) { log(`[notifier] kartu harian gagal: ${err.message}`); await tg.send(`Laporan harian: ${report.totalTrades} trade, PnL ${report.pnlSol.toFixed(4)} SOL`); }
  };
  return notify;
}
