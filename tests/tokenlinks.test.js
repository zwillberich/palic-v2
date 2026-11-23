import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { createEngine } from '../src/engine.js';
import { createNotifier } from '../src/notifier.js';
import { createCommands } from '../src/commands.js';
import { createTelegram } from '../src/telegram.js';
import { gmgnUrl, tokenButtons, tokenRows } from '../src/tokenlinks.js';

const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('tokenButtons: GMGN membuka halaman token, CA menyalin alamat kontrak', () => {
  assert.equal(gmgnUrl(MINT_A), `https://gmgn.ai/sol/token/${MINT_A}`);
  assert.deepEqual(tokenButtons(MINT_A), [{ text: 'GMGN', url: gmgnUrl(MINT_A) }, { text: 'CA', copy_text: { text: MINT_A } }]);
});

test('tokenRows: satu baris per token, tanpa duplikat dan tanpa mint kosong, dibatasi jumlahnya', () => {
  const rows = tokenRows([{ mint: MINT_A, symbol: 'AAA' }, { mint: MINT_A, symbol: 'AAA' }, { mint: '', symbol: 'X' }, { symbol: 'Y' }, { mint: MINT_B, symbol: 'NAMA-TOKEN-YANG-SANGAT-PANJANG' }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0].text, 'GMGN AAA'); assert.equal(rows[0][1].copy_text.text, MINT_A);
  assert.ok(rows[1][0].text.length <= 'GMGN '.length + 14);                   // nama panjang dipotong
  assert.equal(tokenRows(Array.from({ length: 50 }, (_, i) => ({ mint: `M${i}`, symbol: 'S' })), 20).length, 20);
});

const plan = { ageHours: 0.3, barVolumeUsd: 9000, momentumPct: 12, fresh: true };
const make = () => {
  const db = openDb();
  setSetting(db, 'paper_slippage_pct', 0); setSetting(db, 'honeypot_check', 'false');
  const prices = {}; const msgs = [];
  const jup = { prices: async () => prices, candles: async () => [], trending: async () => [], recent: async () => [], toptraded: async () => [] };
  const sent = [];
  const tg = { enabled: true, send: async (text, extra) => sent.push({ kind: 'text', text, extra }), sendPhoto: async (buf, caption, extra) => sent.push({ kind: 'photo', caption, extra, ok: buf.length > 1000 }) };
  const notify = createNotifier({ tg, db, solUsd: async () => 75 });
  const engine = createEngine({ db, jup, notify, pauseBetweenFetchesMs: 0 });
  return { db, engine, prices, sent, notify };
};
const buttonsOf = (item) => item.extra?.reply_markup?.inline_keyboard?.flat() ?? [];

test('kartu posisi dibuka/ditutup membawa tombol GMGN dan CA untuk token itu', async () => {
  const e = make();
  await e.engine.openAny({ mint: MINT_A, symbol: 'AAA', price: 1, plan, token: { mcap: 1e5, liquidity: 20000 }, strategy: 'p6' });
  await new Promise((r) => setTimeout(r, 400));                              // notifikasi kartu dikirim tanpa menunggu
  e.prices[MINT_A] = 1.05; await e.engine.closeManually(1);
  await new Promise((r) => setTimeout(r, 400));
  const photos = e.sent.filter((s) => s.kind === 'photo');
  assert.equal(photos.length, 2);
  for (const p of photos) {
    assert.ok(p.ok);
    const b = buttonsOf(p);
    assert.ok(b.some((x) => x.text === 'GMGN' && x.url === gmgnUrl(MINT_A)), 'tombol GMGN');
    assert.ok(b.some((x) => x.text === 'CA' && x.copy_text?.text === MINT_A), 'tombol CA');
  }
  const opened = photos.find((p) => p.caption.includes('Position opened'));
  const closed = photos.find((p) => !p.caption.includes('Position opened'));
  assert.equal(opened.extra.reply_markup.inline_keyboard.length, 1);
  const openedRow = opened.extra.reply_markup.inline_keyboard[0];
  assert.ok(openedRow.some((x) => x.text === 'GMGN'));
  assert.ok(openedRow.some((x) => x.text === 'CA'));
  assert.ok(openedRow.some((x) => x.callback_data === 'close:ask:1'));
  assert.ok(!buttonsOf(closed).some((x) => String(x.callback_data || '').startsWith('close:ask:')));
});

test('notifikasi teks yang menyebut token (peringatan, dipantau, gagal beli/jual) juga bertombol; yang tanpa token tidak', async () => {
  const e = make();
  await e.notify('HARGA HILANG TTT', { mint: MINT_B });
  await e.notify('Laporan umum tanpa token');
  const [withToken, without] = e.sent;
  assert.ok(buttonsOf(withToken).some((x) => x.text === 'GMGN' && x.url === gmgnUrl(MINT_B)));
  assert.ok(buttonsOf(withToken).some((x) => x.text === 'CA' && x.copy_text.text === MINT_B));
  assert.equal(buttonsOf(without).length, 0);
});

test('perintah /posisi /history mengembalikan teks + baris tombol per token; kosong tetap teks biasa', async () => {
  const e = make();
  const jup = { prices: async () => ({ [MINT_A]: 1.1 }), candles: async () => [], trending: async () => [] };
  const handle = createCommands({ db: e.db, engine: e.engine, jup });
  assert.equal(typeof (await handle('/posisi')), 'string');
  assert.match(await handle('/watch'), /tidak dikenal/);                  // /watch (pantauan S1) sudah dihapus
  assert.equal(typeof (await handle('/history')), 'string');
  await e.engine.openAny({ mint: MINT_A, symbol: 'AAA', price: 1, plan, token: { mcap: 1e5, liquidity: 20000 }, strategy: 'p6' });
  const pos = await handle('/posisi');
  assert.equal(typeof pos, 'object'); assert.match(pos.text, /AAA \[P6\]/); assert.match(pos.text, /tahan 60m/);
  assert.doesNotMatch(pos.text, /TP |SL /);                                   // P6 tidak punya TP/SL harga
  assert.equal(pos.buttons.length, 1); assert.equal(pos.buttons[0][1].copy_text.text, MINT_A);
  assert.equal(pos.buttons[0][2].callback_data, 'close:ask:1');
  await e.engine.closeManually(1);
  assert.equal((await handle('/history')).buttons[0][0].text, 'GMGN AAA');
});

test('telegram: handler yang mengembalikan { text, buttons } mengirim tombol inline; string tetap teks biasa', async () => {
  const sent = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    if (method === 'sendMessage') { sent.push(JSON.parse(init.body)); return { json: async () => ({ ok: true, result: {} }) }; }
    polls += 1;
    if (polls > 1) await new Promise((r) => setTimeout(r, 10));
    return { json: async () => ({ ok: true, result: polls === 1 ? [{ update_id: 1, message: { chat: { id: 42 }, text: '/posisi' } }, { update_id: 2, message: { chat: { id: 42 }, text: '/status' } }] : [] }) };
  };
  const tg = createTelegram({ token: 't', chatId: '42', fetchImpl, log: () => {} });
  const rows = tokenRows([{ mint: MINT_A, symbol: 'AAA' }]);
  const p = tg.poll(async (text) => (text === '/posisi' ? { text: 'daftar', buttons: rows } : 'biasa'));
  await new Promise((r) => setTimeout(r, 60)); tg.stop(); await Promise.race([p, new Promise((r) => setTimeout(r, 100))]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].reply_markup.inline_keyboard, rows);
  assert.equal(sent[0].text, 'daftar');
  assert.equal(sent[1].reply_markup, undefined); assert.equal(sent[1].text, 'biasa');
});
