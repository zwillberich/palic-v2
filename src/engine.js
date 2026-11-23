import { getSetting } from './settings.js';
import { getState, setState, logEvent } from './db.js';
import { canOpen, afterClose, openPositions } from './risk.js';
import { scoreToken, marketRegime } from './scoring.js';
import { evaluateP6, pairAgeHours } from './p6.js';
import { strategyName } from './strategies.js';
import { sellabilityCheck } from './safety.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;
const BLIND_GRACE_MS = 5 * 60_000;      // tanpa harga selama ini + likuiditas 0 -> pool dianggap mati
const BLIND_MIN_LIQUIDITY_USD = 100;    // di bawah ini pool dianggap kosong (nilai residu 0,002 USD bukan likuiditas)
const BLIND_MAX_MS = 30 * 60_000;       // tanpa harga selama ini (apa pun alasannya) -> dihapus buku sebagai rugi total
const MANUAL_PRICE_MAX_AGE_MS = 120_000;

export function createEngine({ db, jup, notify = async () => {}, now = () => Date.now(), pauseBetweenFetchesMs = 300, live = null, chain = null, rugcheck = null }) {
  const busy = new Set();   // mint/posisi yang sedang beli/jual on-chain: mencegah transaksi ganda
  const isLive = () => Boolean(live) && live.mode() === 'live';

  // Catatan keputusan yang sama untuk token yang sama tidak diulang tiap pemindaian.
  function logOnce(kind, mint, detail, windowMs = 30 * 60_000) {
    const text = JSON.stringify(detail);
    const dup = db.prepare('SELECT 1 FROM events WHERE kind = ? AND mint = ? AND detail = ? AND ts > ? LIMIT 1').get(kind, mint, text.slice(0, 2000), now() - windowMs);
    if (!dup) logEvent(db, kind, mint, detail, now());
  }

  function openPaper({ mint, symbol, price, plan, token = null, strategy = 'p6' }, fill = null) {
    const gate = fill ? { ok: true } : canOpen(db, mint, now(), { strategy });
    if (!gate.ok) return { opened: false, reason: gate.reason };
    const slip = getSetting(db, 'paper_slippage_pct') / 100;
    const entryPrice = fill ? (fill.entryPrice ?? price) : price * (1 + slip);
    const t = now();
    const label = strategyName(strategy);
    const snapshot = { candidate: { token: { symbol }, metrics: { marketCapUsd: token?.mcap ?? null, liquidityUsd: token?.liquidity ?? null, holderCount: token?.holderCount ?? null, priceUsd: price }, signals: { route: label } }, intel: token?.__score ?? null };
    // P6 tidak punya TP/SL harga: tp diisi sentinel yang tidak pernah dicek, sl 0. Keluar hanya lewat hold/dead-exit.
    const tp = entryPrice * 1e6;
    const sl = 0;
    const size = fill ? fill.sizeSol : getSetting(db, 'p6_size_sol');
    const holdMs = getSetting(db, 'p6_hold_minutes') * 60_000;
    const deadMs = getSetting(db, 'p6_dead_exit_minutes') * 60_000;
    const deadPct = getSetting(db, 'p6_dead_exit_pct');
    const res = db.prepare(`INSERT INTO positions (mint, symbol, entry_ms, entry_price, size_sol, tp_price, sl_price, sl_initial, zona, target, rr, peak_price, trough_price, last_price, last_price_ms, entry_mcap, snapshot_json, execution_mode, entry_signature, token_amount, strategy, hold_ms, dead_exit_ms, dead_exit_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      mint, symbol, t, entryPrice, size, tp, sl, sl, null, null, null, entryPrice, entryPrice, price, t, token?.mcap ?? null,
      JSON.stringify(snapshot), fill?.mode ?? 'dry_run', fill?.signature ?? null, fill?.tokenAmount ?? null, strategy, holdMs, deadMs, deadPct);
    const id = Number(res.lastInsertRowid);
    const mode = fill ? 'LIVE' : 'paper';
    const reasons = [`umur pair ${plan.ageHours} jam`, `volume bar 5m $${plan.barVolumeUsd}`, `momentum bar +${plan.momentumPct}%`, plan.fresh ? 'pair baru (belum ada histori 1 jam)' : `harga 1 jam sebelumnya ${plan.pre1hPct}%`, `tahan ${Math.round(holdMs / 60000)} mnt · dead-exit ${Math.round(deadMs / 60000)} mnt/+${deadPct}%${getSetting(db, 'p6_trail_enabled') ? ` · trailing ${getSetting(db, 'p6_trail_pct')}% setelah +${getSetting(db, 'p6_trail_arm_pct')}%` : ''}`];
    logEvent(db, 'open', mint, { positionId: id, symbol, strategy, reasons }, t);
    const text = `BELI (${mode}) ${symbol} · ${label}\nMasuk ${fmt(entryPrice)} · tahan ${Math.round(holdMs / 60000)} mnt · dead-exit ${Math.round(deadMs / 60000)} mnt/+${deadPct}%\n${reasons.slice(0, 4).join(' · ')}`;
    notify(text, { kind: 'opened', positionId: id }).catch(() => {});
    return { opened: true, id };
  }

  function closePaper(position, price, reason, fill = null) {
    const slip = getSetting(db, 'paper_slippage_pct') / 100;
    const fee = getSetting(db, 'paper_fee_pct');
    const exitPrice = fill ? price : price * (1 - slip);
    const total = !fill && !(price > 0);                         // tanpa harga sama sekali: rugi total, tanpa fee/slippage
    const pnlSol = fill ? fill.proceedsSol - position.size_sol : (total ? -position.size_sol : position.size_sol * (((exitPrice / position.entry_price - 1) * 100 - 2 * fee) / 100));
    const pnlPct = fill ? (pnlSol / position.size_sol) * 100 : (total ? -100 : (exitPrice / position.entry_price - 1) * 100 - 2 * fee);
    const t = now();
    db.prepare("UPDATE positions SET status = 'closed', exit_ms = ?, exit_price = ?, exit_reason = ?, pnl_pct = ?, pnl_sol = ?, exit_signature = ? WHERE id = ?").run(t, exitPrice, reason, pnlPct, pnlSol, fill?.signature ?? null, position.id);
    logEvent(db, 'close', position.mint, { positionId: position.id, symbol: position.symbol, strategy: position.strategy || 'p6', reasons: [`${LABEL[reason] || reason}`, `PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL)`] }, t);
    const pausedUntil = afterClose(db, t, position.strategy || 'p6');
    notify(`JUAL (${fill ? 'LIVE' : 'paper'}) ${position.symbol} · ${strategyName(position.strategy)} — ${LABEL[reason] || reason}\nKeluar ${fmt(exitPrice)} · ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL)${pausedUntil ? '\nJeda masuk baru diaktifkan: rugi beruntun.' : ''}`, { kind: 'closed', positionId: position.id }).catch(() => {});
    return { pnlPct, pnlSol };
  }

  // Uji bisa-dijual (hasilnya disimpan 2 menit supaya beberapa jalur tidak mengulang quote yang sama).
  const sellableCache = new Map();
  async function sellable(args) {
    if (!getSetting(db, 'honeypot_check') || typeof jup.quote !== 'function') return { ok: true, skipped: true };
    const hit = sellableCache.get(args.mint);
    if (hit && now() - hit.at < 120_000) return hit.res;
    const strategy = args.strategy || 'p6';
    const sizeSol = isLive() ? getSetting(db, 'live_size_sol') : getSetting(db, 'p6_size_sol');
    const res = await sellabilityCheck({ jup, mint: args.mint, token: args.token, sizeSol, maxLossPct: getSetting(db, 'honeypot_max_loss_pct'), rejectToken2022: getSetting(db, 'reject_token2022'), chain, maxFeeBps: getSetting(db, 'token2022_max_fee_bps'), rugcheck, requireLpLock: getSetting(db, 'lp_lock_required'), lpLockMinUsd: getSetting(db, 'lp_lock_min_usd') });
    sellableCache.set(args.mint, { at: now(), res });
    return res;
  }

  // Beli: paper (sinkron) atau live (swap on-chain, hanya bila mode live dinyalakan operator).
  // Semua jalur masuk lewat sini, jadi uji bisa-dijual cukup dipasang di satu tempat.
  async function openAny(args) {
    const pre = canOpen(db, args.mint, now(), { strategy: args.strategy || 'p6' });
    if (!pre.ok) return { opened: false, reason: pre.reason };
    const safe = await sellable(args);
    if (!safe.ok) {
      logOnce('skip', args.mint, { symbol: args.symbol, strategy: args.strategy || 'p6', stage: 'keamanan', reasons: [safe.reason] }, 10 * 60_000);
      return { opened: false, reason: `ditolak uji bisa-dijual: ${safe.reason}`, unsafe: true };
    }
    if (!isLive()) return openPaper(args);
    const { mint, symbol, price, plan, token } = args;
    if (busy.has(mint)) return { opened: false, reason: 'transaksi token ini sedang berjalan' };
    const gate = canOpen(db, mint, now(), { strategy: args.strategy || 'p6' });
    if (!gate.ok) return { opened: false, reason: gate.reason };
    busy.add(mint);
    try {
      const f = await live.buy({ mint, decimals: token?.decimals });
      return openPaper(args, { entryPrice: f.entryPriceUsd, sizeSol: f.sizeSol, mode: 'live', signature: f.signature, tokenAmount: f.tokenAmountRaw });
    } catch (err) {
      logEvent(db, 'skip', mint, { symbol, stage: 'eksekusi', reasons: [`beli live gagal: ${err.message}`] }, now());
      notify(`BELI LIVE GAGAL ${symbol}: ${err.message}`, { mint }).catch(() => {});
      return { opened: false, reason: `beli live gagal: ${err.message}` };
    } finally { busy.delete(mint); }
  }

  async function closeAny(position, price, reason) {
    if (position.execution_mode !== 'live') return closePaper(position, price, reason);
    const key = `p${position.id}`;
    if (busy.has(key)) return null;
    busy.add(key);
    try {
      const f = await live.sell({ mint: position.mint });
      return closePaper(position, price, reason, { proceedsSol: f.proceedsSol, signature: f.signature });
    } catch (err) {
      logEvent(db, 'skip', position.mint, { symbol: position.symbol, stage: 'eksekusi', reasons: [`jual live gagal: ${err.message}`] }, now());
      const last = Number(getState(db, `sellfail_${position.id}`, 0));
      if (now() - last > 10 * 60_000) { setState(db, `sellfail_${position.id}`, now()); notify(`JUAL LIVE GAGAL ${position.symbol} (${LABEL[reason] || reason}): ${err.message}. Dicoba lagi otomatis.`, { mint: position.mint }).catch(() => {}); }
      return null;
    } finally { busy.delete(key); }
  }

  async function managePosition(position, price) {
    const peak = Math.max(position.peak_price || 0, price);
    const trough = Math.min(position.trough_price || price, price);
    db.prepare('UPDATE positions SET last_price = ?, last_price_ms = ?, trough_price = ?, peak_price = ? WHERE id = ?').run(price, now(), trough, peak, position.id);
    // Tanpa TP/SL harga. Dead-exit: belum pernah menyentuh +X% dalam N menit pertama -> keluar. Selain itu tahan sampai hold selesai.
    const age = now() - position.entry_ms;
    if (position.dead_exit_ms > 0 && age >= position.dead_exit_ms && peak < position.entry_price * (1 + position.dead_exit_pct / 100)) return closeAny(position, price, 'dead');
    // Trailing: aktif setelah naik >= arm% dari harga masuk, lalu jual bila turun trail% dari puncak.
    if (getSetting(db, 'p6_trail_enabled') && peak >= position.entry_price * (1 + getSetting(db, 'p6_trail_arm_pct') / 100)
      && price <= peak * (1 - getSetting(db, 'p6_trail_pct') / 100)) return closeAny(position, price, 'trail');
    if (age >= (position.hold_ms || 3_600_000)) return closeAny(position, price, 'time');
    return null;
  }

  // Harga cadangan dari candle 1 menit, hanya bila bar terakhirnya masih segar (<= 3 menit). Dibatasi 1x/menit per posisi.
  async function chartPrice(position) {
    const key = `fb_${position.id}`;
    if (now() - Number(getState(db, key, 0)) < 60_000) return null;
    setState(db, key, now());
    try {
      const c = await jup.candles(position.mint, { interval: '1_MINUTE', count: 3 });
      const last = c.at(-1);
      return last && now() / 1000 - last.time <= 180 && last.close > 0 ? last.close : null;
    } catch { return null; }
  }

  function clearBlind(position) {
    if (Number(getState(db, `blind_${position.id}`, 0)) > 0) setState(db, `blind_${position.id}`, 0);
  }

  // Posisi tanpa harga tidak boleh menggantung selamanya dengan untung palsu: bila likuiditas 0 (pool ditarik) atau terlalu lama buta,
  // dinilai rugi total. Di mode live penjualan tetap dicoba (biasanya gagal karena tidak ada likuiditas).
  async function handleBlind(position) {
    const since = Number(getState(db, `blind_${position.id}`, 0)) || now();
    if (!Number(getState(db, `blind_${position.id}`, 0))) {
      setState(db, `blind_${position.id}`, since);
      logEvent(db, 'skip', position.mint, { symbol: position.symbol, strategy: position.strategy, stage: 'eksekusi', reasons: ['harga token hilang dari API dan chart (kemungkinan pool kering)'] }, now());
      notify(`HARGA HILANG ${position.symbol} · ${strategyName(position.strategy)}: tidak ada harga dari API maupun chart. Nilai terakhir tidak bisa dipercaya; dicek likuiditasnya dan ditutup bila pool kering.`, { mint: position.mint }).catch(() => {});
    }
    const blindFor = now() - since;
    if (blindFor < BLIND_GRACE_MS) return null;
    let dead = blindFor >= BLIND_MAX_MS;
    if (!dead) {
      try { const t = await jup.token(position.mint); dead = !t || !(Number(t.liquidity) >= BLIND_MIN_LIQUIDITY_USD); } catch { /* tidak bisa memastikan: tunggu */ }
    }
    return dead ? closeAny(position, 0, 'no_price') : null;
  }

  // Pemantau likuiditas: satu permintaan (semua posisi terbuka) tiap 30 detik. Posisi dianggap bahaya bila likuiditasnya
  // turun >= liq_guard_drop_pct dari saat masuk atau di bawah liq_guard_min_usd. Penarikan pool dalam satu transaksi tetap tidak
  // bisa dikalahkan; ini menangkap pengurasan bertahap dan keruntuhan harga besar (TVL ikut turun).
  let lastLiquidityCheck = 0;
  async function liquidityAlarms(open) {
    if (!open.length || !getSetting(db, 'liq_guard_enabled') || typeof jup.tokens !== 'function') return [];
    if (now() - lastLiquidityCheck < 30_000) return [];
    lastLiquidityCheck = now();
    let rows;
    try { rows = await jup.tokens(open.map((p) => p.mint)); } catch { return []; }
    const byMint = new Map(rows.map((t) => [t.id, t]));
    const dropPct = getSetting(db, 'liq_guard_drop_pct');
    const floor = getSetting(db, 'liq_guard_min_usd');
    const alarms = [];
    for (const position of open) {
      const t = byMint.get(position.mint);
      const liquidity = Number(t?.liquidity);
      if (!t || !Number.isFinite(liquidity)) continue;                 // tidak ditemukan: dikelola jalur posisi buta
      const entryLiquidity = Number(parse(position.snapshot_json)?.candidate?.metrics?.liquidityUsd) || 0;
      const limit = Math.max(floor, entryLiquidity > 0 ? entryLiquidity * (1 - dropPct / 100) : 0);
      if (liquidity < limit) alarms.push({ position, liquidity, limit, entryLiquidity });
    }
    return alarms;
  }

  async function tick() {
    const open = openPositions(db);
    const mints = [...new Set(open.map((p) => p.mint))];
    if (!mints.length) return { open: 0 };
    const prices = await jup.prices(mints);
    const exited = new Set();
    for (const a of await liquidityAlarms(open)) {
      const price = prices[a.position.mint] || a.position.last_price;
      if (!(price > 0)) continue;                                      // tanpa harga sama sekali: jalur posisi buta
      logEvent(db, 'skip', a.position.mint, { symbol: a.position.symbol, strategy: a.position.strategy, stage: 'keamanan', reasons: [`likuiditas anjlok: ${Math.round(a.entryLiquidity)} → ${Math.round(a.liquidity)} USD (batas ${Math.round(a.limit)} USD)`] }, now());
      notify(`LIKUIDITAS ANJLOK ${a.position.symbol} · ${strategyName(a.position.strategy)}: ${Math.round(a.entryLiquidity)} → ${Math.round(a.liquidity)} USD (batas ${Math.round(a.limit)}). Keluar sekarang.`, { mint: a.position.mint }).catch(() => {});
      await closeAny(a.position, price, 'liquidity');
      exited.add(a.position.id);
    }
    for (const position of open) {
      if (exited.has(position.id)) continue;
      let price = prices[position.mint];
      if (!price) price = await chartPrice(position);          // API harga kadang tak punya token tipis: coba chart 1 menit
      if (price) { clearBlind(position); await managePosition(position, price); } else await handleBlind(position);
    }
    return { open: open.length };
  }

  // Kondisi pasar (dipakai scorecard): dihitung dari daftar trending Jupiter, sama seperti sebelumnya.
  async function refreshRegime() {
    const lists = await Promise.all(['1h', '6h', '24h'].map((i) => jup.trending(i).catch(() => [])));
    const byMint = new Map();
    for (const token of lists.flat()) if (token?.id && !byMint.has(token.id)) byMint.set(token.id, token);
    if (!byMint.size) return;
    const history = JSON.parse(getState(db, 'regime_history', '[]'));
    const { snapshot, regime } = marketRegime([...byMint.values()], history, { nowMs: now() });
    setState(db, 'regime', JSON.stringify(regime));
    setState(db, 'regime_history', JSON.stringify([...history, snapshot].slice(-24)));
  }

  async function scanP6() {
    db.prepare('DELETE FROM events WHERE ts < ?').run(now() - 7 * 24 * HOUR);
    const summary = { fetched: 0, screened: 0, analysed: 0, entries: 0, reasons: {}, error: null };
    try { await refreshRegime(); } catch { /* kondisi pasar lama dipakai */ }
    if (!getSetting(db, 'p6_enabled')) { summary.error = 'P6 nonaktif'; return summary; }
    try {
      const failures = [];
      const lists = await Promise.all([jup.recent(100), jup.toptraded('5m', 100)].map((p) => p.catch((err) => { failures.push(err.message); return []; })));
      if (failures.length === 2) throw new Error(`daftar pair baru gagal diambil (${failures[0]})`);
      if (failures.length) { summary.reasons.source_error = failures.length; summary.sourceErrors = failures; }
      const byMint = new Map();
      for (const token of lists.flat()) if (token?.id && !byMint.has(token.id)) byMint.set(token.id, token);
      summary.fetched = byMint.size;

      const t = now();
      const cfg = {
        minBarVolumeUsd: getSetting(db, 'p6_min_bar_volume_usd'), minMomentumPct: getSetting(db, 'p6_min_momentum_pct'), maxAgeHours: getSetting(db, 'p6_max_age_hours'),
        freshAgeHours: getSetting(db, 'p6_fresh_age_hours'), maxPre1hPct: getSetting(db, 'p6_max_pre1h_pct'), entryWindowMs: getSetting(db, 'p6_entry_window_s') * 1000,
      };
      const v5 = (tok) => (tok.stats5m?.buyVolume || 0) + (tok.stats5m?.sellVolume || 0);
      const held = new Set(openPositions(db).map((p) => p.mint));
      const candidates = [...byMint.values()].filter((tok) => {
        if (held.has(tok.id) || Number(getState(db, `ignore_${tok.id}`, 0)) > t) return false;
        const age = pairAgeHours(tok, t);
        return age != null && age < cfg.maxAgeHours && v5(tok) >= cfg.minBarVolumeUsd * 0.5 && Number(tok.usdPrice) > 0;
      }).sort((a, b) => v5(b) - v5(a));
      summary.screened = candidates.length;

      const minLiquidity = getSetting(db, 'p6_min_liquidity_usd');
      const minHolders = getSetting(db, 'p6_min_holders');
      const regime = parse(getState(db, 'regime', 'null'));
      for (const token of candidates.slice(0, getSetting(db, 'p6_scan_max_tokens'))) {
        if (minLiquidity > 0 && !(Number(token.liquidity) >= minLiquidity)) { summary.reasons.low_liquidity = (summary.reasons.low_liquidity || 0) + 1; continue; }
        if (minHolders > 0 && !(Number(token.holderCount) >= minHolders)) { summary.reasons.low_holders = (summary.reasons.low_holders || 0) + 1; continue; }
        const score = scoreToken(token, { regime, nowMs: t, sizeSol: getSetting(db, 'p6_size_sol') });
        if (getSetting(db, 'intel_hard_gates') && !score.hardGates.passed) { summary.reasons.intel_gate = (summary.reasons.intel_gate || 0) + 1; continue; }
        token.__score = score;
        let candles;
        try { candles = await jup.candles(token.id, { interval: '5_MINUTE', count: 40 }); } catch { summary.reasons.fetch_error = (summary.reasons.fetch_error || 0) + 1; continue; }
        const result = evaluateP6(candles, token, now(), cfg);
        summary.analysed += 1;
        summary.reasons[result.status] = (summary.reasons[result.status] || 0) + 1;
        if (result.ok) {
          const live = (await jup.prices([token.id]).catch(() => ({})))[token.id];
          const maxMove = getSetting(db, 'p6_max_move_pct');
          const moved = live > 0 && result.signalClose > 0 ? Math.abs(live / result.signalClose - 1) * 100 : null;
          if (!(live > 0)) { summary.reasons.no_price = (summary.reasons.no_price || 0) + 1; continue; }
          if (maxMove > 0 && moved != null && moved > maxMove) {
            summary.reasons.price_moved = (summary.reasons.price_moved || 0) + 1;
            logOnce('skip', token.id, { symbol: token.symbol, strategy: 'p6', stage: 'eksekusi', reasons: [`harga real-time sudah bergeser ${moved.toFixed(1)}% dari close bar sinyal (batas ${maxMove}%)`] }, 10 * 60_000);
            continue;
          }
          const r = await openAny({ mint: token.id, symbol: token.symbol, price: live, plan: result, token, strategy: 'p6' });
          if (r.opened) summary.entries += 1; else logOnce('skip', token.id, { symbol: token.symbol, strategy: 'p6', stage: 'eksekusi', reasons: [r.reason] });
        } else if (['pumped_1h', 'low_momentum'].includes(result.status)) {
          logOnce('skip', token.id, { symbol: token.symbol, strategy: 'p6', stage: 'screening', reasons: [result.reason] }, 10 * 60_000);
        }
        await sleep(pauseBetweenFetchesMs);
      }
    } catch (err) {
      summary.error = err.message;
    }
    setState(db, 'last_scan_p6', JSON.stringify({ ...summary, at: now() }));
    return summary;
  }

  async function closeManually(positionId) {
    const position = db.prepare("SELECT * FROM positions WHERE id = ? AND status = 'open'").get(positionId);
    if (!position) return { ok: false, error: 'Posisi terbuka tidak ditemukan.' };
    const prices = await jup.prices([position.mint]).catch(() => ({}));
    const current = db.prepare("SELECT * FROM positions WHERE id = ? AND status = 'open'").get(positionId);
    if (!current) return { ok: false, error: 'Posisi sudah tidak terbuka.' };
    const quotedPrice = Number(prices?.[current.mint]);
    const lastPrice = Number(current.last_price);
    const lastPriceAt = Number(current.last_price_ms || 0);
    const recentLastPrice = Number.isFinite(lastPrice) && lastPrice > 0 && lastPriceAt > 0
      && now() >= lastPriceAt && now() - lastPriceAt <= MANUAL_PRICE_MAX_AGE_MS;
    if (current.execution_mode !== 'live' && !(Number.isFinite(quotedPrice) && quotedPrice > 0) && !recentLastPrice) {
      return { ok: false, error: 'Harga terbaru tidak tersedia; posisi PAPER tetap terbuka agar PnL tidak dihitung dari harga basi.' };
    }
    const price = Number.isFinite(quotedPrice) && quotedPrice > 0 ? quotedPrice : (lastPrice > 0 ? lastPrice : current.entry_price);
    const done = await closeAny(current, price, 'manual');
    return done ? { ok: true } : { ok: false, error: 'Penjualan gagal atau sedang berjalan; coba lagi sebentar lagi.' };
  }

  return { scanP6, lastScanP6: () => JSON.parse(getState(db, 'last_scan_p6', 'null')), tick, openPaper, closePaper, openAny, closeAny, managePosition, closeManually };
}

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const LABEL = { tp: 'target tercapai', sl: 'stop loss', breakeven: 'kembali ke harga masuk', time: 'waktu tahan selesai', manual: 'ditutup manual', dead: 'dead-exit (tidak naik cukup di awal)', trail: 'trailing dari puncak (setelah moonshot)', no_price: 'harga hilang / pool kering (rugi total)', liquidity: 'likuiditas anjlok (pengaman)' };

export function fmt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  if (v >= 1) return v.toFixed(4);
  return v.toPrecision(4);
}
