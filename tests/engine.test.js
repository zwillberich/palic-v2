import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { createEngine } from '../src/engine.js';
import { canOpen } from '../src/risk.js';

// Rencana masuk P6 (yang dihasilkan evaluateP6); dipakai untuk membuka posisi paper langsung.
const plan = { ageHours: 0.4, barVolumeUsd: 8000, momentumPct: 10, fresh: true, pre1hPct: null, signalClose: 50 };
const make = (prices = {}) => {
  const db = openDb();
  setSetting(db, 'paper_slippage_pct', 0); setSetting(db, 'paper_fee_pct', 0);
  setSetting(db, 'p6_dead_exit_minutes', 10); setSetting(db, 'p6_dead_exit_pct', 2); setSetting(db, 'p6_hold_minutes', 60);
  setSetting(db, 'p6_trail_arm_pct', 30); setSetting(db, 'p6_trail_pct', 20);
  const messages = [];
  const jup = { prices: async () => prices, candles: async () => [], trending: async () => [] };
  let t = 1_000_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const engine = createEngine({ db, jup, notify: async (m) => messages.push(m), now: clock.now, pauseBetweenFetchesMs: 0 });
  return { db, engine, prices, messages, clock };
};
const open = (e, mint, price = 50) => e.engine.openPaper({ mint, symbol: mint, price, plan, strategy: 'p6' });
const row = (db) => db.prepare('SELECT * FROM positions ORDER BY id DESC').get();

test('posisi P6 tanpa TP/SL harga: naik/turun biasa tidak menutup posisi', async () => {
  const e = make();
  open(e, 'A');
  e.prices.A = 58; await e.engine.tick();            // +16%: belum arm trailing
  e.prices.A = 47; await e.engine.tick();            // -6%: tidak ada SL harga
  assert.equal(row(e.db).status, 'open');
  assert.equal(row(e.db).strategy, 'p6');
});

test('dead-exit: tidak pernah menyentuh +2% dalam 10 menit pertama -> keluar', async () => {
  const e = make();
  open(e, 'A');
  e.prices.A = 50.5; await e.engine.tick();
  e.clock.advance(10 * 60_000); await e.engine.tick();
  assert.equal(row(e.db).exit_reason, 'dead');
});

test('trailing: aktif setelah +30%, jual saat turun 20% dari puncak (untung tercatat)', async () => {
  const e = make();
  open(e, 'A');
  e.prices.A = 60; await e.engine.tick();            // +20%: lolos dead-exit, belum arm
  e.clock.advance(11 * 60_000);
  e.prices.A = 80; await e.engine.tick();            // +60%: arm
  assert.equal(row(e.db).status, 'open');
  e.prices.A = 63; await e.engine.tick();            // 80 -> 63 = -21%: trailing kena
  const p = row(e.db);
  assert.equal(p.exit_reason, 'trail'); assert.ok(p.pnl_sol > 0);
  assert.ok(e.messages.some((m) => /JUAL/.test(m)));
});

test('waktu tahan selesai menutup posisi', async () => {
  const e = make();
  open(e, 'A');
  e.prices.A = 55; await e.engine.tick();
  e.clock.advance(61 * 60_000); await e.engine.tick();
  assert.equal(row(e.db).exit_reason, 'time');
});

test('manual close PAPER memakai harga terbaru dan mencatat alasan manual', async () => {
  const e = make();
  const opened = open(e, 'A');
  e.prices.A = 60;
  assert.deepEqual(await e.engine.closeManually(opened.id), { ok: true });
  assert.equal(row(e.db).exit_reason, 'manual');
  assert.equal(row(e.db).exit_price, 60);
});

test('manual close PAPER menolak harga terakhir yang basi', async () => {
  const e = make();
  const opened = open(e, 'A');
  e.clock.advance(120_001);
  const result = await e.engine.closeManually(opened.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /harga terbaru tidak tersedia/i);
  assert.equal(row(e.db).status, 'open');
});

test('risk: maks posisi, duplikat mint, cooldown, jeda rugi beruntun', async () => {
  const e = make();
  setSetting(e.db, 'p6_max_open', 2); setSetting(e.db, 'daily_loss_limit_sol', 0);
  open(e, 'A');
  assert.equal(canOpen(e.db, 'A', e.clock.now()).ok, false);                       // duplikat
  open(e, 'B');
  assert.match(canOpen(e.db, 'C', e.clock.now()).reason, /posisi terbuka/);         // penuh
  setSetting(e.db, 'loss_streak_pause', 2);
  e.prices.A = 40; e.prices.B = 40;
  e.clock.advance(10 * 60_000); await e.engine.tick();                             // dua dead-exit rugi
  assert.match(canOpen(e.db, 'Z', e.clock.now()).reason, /jeda rugi beruntun/);
  setSetting(e.db, 'loss_streak_pause', 0); setSetting(e.db, 'p6_cooldown_minutes', 120);
  e.clock.advance(61 * 60_000);
  assert.match(canOpen(e.db, 'A', e.clock.now()).reason, /cooldown/);
});

test('jeda manual menolak entry', () => {
  const e = make();
  setSetting(e.db, 'paused', 'true');
  assert.equal(open(e, 'A').opened, false);
});
