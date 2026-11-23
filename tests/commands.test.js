import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createEngine } from '../src/engine.js';
import { createCommands } from '../src/commands.js';
import { createTelegram } from '../src/telegram.js';
import { getSetting } from '../src/settings.js';

const plan = { ageHours: 0.4, barVolumeUsd: 8000, momentumPct: 10, fresh: true, pre1hPct: null, signalClose: 1 };
const setup = () => {
  const db = openDb();
  let t = 1_700_000_000_000;
  const prices = {};
  const jup = { prices: async () => prices, candles: async () => [], trending: async () => [] };
  const now = () => t;
  const engine = createEngine({ db, jup, pauseBetweenFetchesMs: 0, now });
  const handle = createCommands({ db, engine, jup, now });
  return { db, handle, engine, prices, advance: (ms) => { t += ms; } };
};

const makeOpen = (engine) => engine.openPaper({ mint: 'M1', symbol: 'AAA', price: 1, plan });

test('perintah dasar menjawab dan tidak melempar', async () => {
  const { handle } = setup();
  for (const c of ['/help', '/status', '/posisi', '/history', '/settings', '/scan']) assert.equal(typeof (await handle(c)), 'string');
  assert.match(await handle('/close'), /Format: \/close/);
});

test('/set memvalidasi, mengaudit, dan /pause /resume bekerja', async () => {
  const { db, handle } = setup();
  assert.match(await handle('/set p6_hold_minutes 30'), /60 → 30/);
  assert.equal(getSetting(db, 'p6_hold_minutes'), 30);
  assert.match(await handle('/set p6_hold_minutes 99999'), /Ditolak/);
  assert.match(await handle('/set nama_ngawur 1'), /Ditolak/);
  await handle('/pause'); assert.equal(getSetting(db, 'paused'), true);
  await handle('/resume'); assert.equal(getSetting(db, 'paused'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM changes').get().n, 3);
  assert.match(await handle('/hapus_semua'), /tidak dikenal/);
  assert.match(await handle('/constructor'), /tidak dikenal/);
});

test('/posisi menyediakan tombol close dan close hanya berjalan setelah konfirmasi', async () => {
  const { db, handle, engine, prices } = setup();
  const { id } = makeOpen(engine);
  prices.M1 = 1.2;

  const listing = await handle('/posisi');
  assert.equal(listing.buttons[0][0].callback_data, `close:ask:${id}`);
  const prompt = await handle(`/close ${id}`);
  assert.match(prompt.text, /PAPER/);
  assert.match(prompt.text, /konfirmasi/i);
  const confirmData = prompt.buttons[0][0].callback_data;
  assert.match(confirmData, new RegExp(`^close:confirm:${id}:`));
  assert.equal(db.prepare('SELECT status FROM positions WHERE id = ?').get(id).status, 'open');

  const response = await handle.callbackQuery(confirmData);
  assert.match(response, /berhasil ditutup manual/);
  const closed = db.prepare('SELECT status, exit_reason FROM positions WHERE id = ?').get(id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.exit_reason, 'manual');
  assert.match(await handle.callbackQuery(confirmData), /sudah tidak aktif|sudah tidak terbuka/);
});

test('close bisa dibatalkan dan konfirmasi kedaluwarsa setelah 60 detik', async () => {
  const { db, handle, engine, advance } = setup();
  const { id } = makeOpen(engine);

  const first = await handle(`/close ${id}`);
  assert.match(await handle.callbackQuery(first.buttons[0][1].callback_data), /dibatalkan/);
  assert.equal(db.prepare('SELECT status FROM positions WHERE id = ?').get(id).status, 'open');

  const second = await handle(`/close ${id}`);
  const confirm = second.buttons[0][0].callback_data;
  advance(60_000);
  assert.match(await handle.callbackQuery(confirm), /kedaluwarsa/);
  assert.equal(db.prepare('SELECT status FROM positions WHERE id = ?').get(id).status, 'open');
});

test('telegram: chat tidak terdaftar diabaikan, chat terdaftar dilayani, callback dibatasi ke chat terdaftar', async () => {
  const sent = [];
  const answered = [];
  let polls = 0;
  const tgFetch = (updates) => async (url, init) => {
    const method = url.split('/').pop();
    if (method === 'sendMessage') { sent.push(JSON.parse(init.body)); return { json: async () => ({ ok: true, result: {} }) }; }
    if (method === 'answerCallbackQuery') { answered.push(JSON.parse(init.body)); return { json: async () => ({ ok: true, result: true }) }; }
    polls += 1;
    if (polls > 1) await new Promise((r) => setTimeout(r, 10));   // long polling asli menunggu; tanpa jeda loop menguasai event loop
    return { json: async () => ({ ok: true, result: polls === 1 ? updates : [] }) };
  };
  const run = async (chatId, updates, callbackHandler = null) => {
    sent.length = 0; answered.length = 0; polls = 0;
    const tg = createTelegram({ token: 't', chatId, fetchImpl: tgFetch(updates), log: () => {} });
    const p = tg.poll(async (text) => `ok:${text}`, callbackHandler);
    await new Promise((r) => setTimeout(r, 30)); tg.stop(); await Promise.race([p, new Promise((r) => setTimeout(r, 100))]);
  };
  await run('42', [{ update_id: 1, message: { chat: { id: 99 }, text: '/status' } }]);
  assert.equal(sent.length, 0);
  await run('42', [{ update_id: 2, message: { chat: { id: 42 }, text: '/status' } }]);
  assert.equal(sent[0].text, 'ok:/status');
  await run('', [{ update_id: 3, message: { chat: { id: 77 }, text: '/start' } }]);
  assert.match(sent[0].text, /Chat ID kamu: 77/);
  await run('', [{ update_id: 4, message: { chat: { id: 77 }, text: '/status' } }]);
  assert.equal(sent.length, 0);

  await run('42', [{ update_id: 5, callback_query: { id: 'cb-1', data: 'close:ask:7', message: { chat: { id: 99 } } } }], async () => 'should not run');
  assert.equal(sent.length, 0);
  assert.equal(answered.length, 1);

  await run('42', [{ update_id: 6, callback_query: { id: 'cb-2', data: 'close:ask:7', message: { chat: { id: 42 } } } }], async (data) => `callback:${data}`);
  assert.equal(answered[0].callback_query_id, 'cb-2');
  assert.equal(sent[0].text, 'callback:close:ask:7');
});
