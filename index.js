import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './src/config.js';
import { openDb } from './src/db.js';
import { createJupiter } from './src/jupiter.js';
import { createEngine } from './src/engine.js';
import { createTelegram } from './src/telegram.js';
import { createCommands } from './src/commands.js';
import { getSetting } from './src/settings.js';
import { getState, setState } from './src/db.js';
import { createActions } from './src/actions.js';
import { createNotifier } from './src/notifier.js';
import { startMiniApp } from './src/miniapp/index.js';
import { createLive } from './src/live.js';
import { createChain } from './src/chain.js';
import { createRugcheck } from './src/rugcheck.js';
import { dailyReportData, wibMidnight } from './src/reports.js';

const root = dirname(fileURLToPath(import.meta.url));
loadEnv(join(root, '.env'));
// Env tambahan dari file lain hanya bila dinyatakan eksplisit (mis. PALIC_ENV_FILE=/jalur/ke/.env).
if (process.env.PALIC_ENV_FILE) loadEnv(process.env.PALIC_ENV_FILE);
const pollingOn = process.env.TELEGRAM_POLL !== 'false';

// Galat yang lolos tidak boleh mematikan bot diam-diam: dicatat, lalu proses lanjut (pemantau pm2 tetap mengawasi).
process.on('unhandledRejection', (reason) => console.log(`[fatal?] unhandledRejection: ${reason?.message || reason}`));
process.on('uncaughtException', (err) => console.log(`[fatal?] uncaughtException: ${err?.message || err}`));

const db = openDb(process.env.DB_PATH || join(root, 'data', 'palic2.sqlite'));
const jup = createJupiter();
const tg = createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID });
let solCache = { at: 0, price: null };
const solUsd = async () => {
  if (Date.now() - solCache.at < 60_000) return solCache.price;
  const price = (await jup.prices(['So11111111111111111111111111111111111111112']).catch(() => ({})))['So11111111111111111111111111111111111111112'] ?? solCache.price;
  solCache = { at: Date.now(), price };
  return price;
};
const notify = createNotifier({ tg, db, solUsd });
const live = createLive({ db, solUsd });
const chain = createChain();
const rugcheck = createRugcheck();
const engine = createEngine({ db, jup, notify, live, chain, rugcheck });
const handle = createCommands({ db, engine, jup });
const actions = createActions({ db, engine, jup, notifier: notify, live });

const single = (name, fn) => {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (err) { console.log(`[${name}] ${err.message}`); } finally { running = false; }
  };
};

const runTick = single('tick', () => engine.tick());
const runP6 = single('p6', async () => {
  const s = await engine.scanP6();
  console.log(`[p6] ${s.fetched} pair → ${s.screened} kandidat → ${s.analysed} dianalisis · masuk ${s.entries}${s.error ? ` · ${s.error}` : ''}${s.sourceErrors ? ` · sumber gagal: ${s.sourceErrors.join('; ')}` : ''}`);
});

console.log(`Palic v2 mulai · mode ${live.mode() === 'live' ? 'LIVE' : 'PAPER'} · wallet ${live.configured() ? 'terpasang' : 'tidak ada'} · Telegram ${tg.enabled ? (pollingOn ? '' : 'hanya notifikasi, ') +  (process.env.TELEGRAM_CHAT_ID ? 'aktif' : 'aktif (menunggu TELEGRAM_CHAT_ID)') : 'mati (tanpa TELEGRAM_BOT_TOKEN)'}`);
setInterval(runTick, 10_000);
(function loopScan() {
  runP6().finally(() => setTimeout(loopScan, getSetting(db, 'scan_interval_s') * 1000));
})();
if (pollingOn) tg.poll(handle, handle.callbackQuery);
startMiniApp({ actions, tg });

// Laporan harian (kartu) tiap hari sekitar 23:55 WIB.
setInterval(async () => {
  try {
    const wib = new Date(Date.now() + 7 * 3_600_000);
    const day = wib.toISOString().slice(0, 10);
    if (wib.getUTCHours() * 60 + wib.getUTCMinutes() < 23 * 60 + 55 || getState(db, 'last_daily') === day) return;
    setState(db, 'last_daily', day);
    await notify.dailyReport(dailyReportData(db, wibMidnight(Date.now()), { dateLabel: `${day} WIB` }));
  } catch (err) { console.log(`[daily] ${err.message}`); }
}, 60_000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { tg.stop(); db.close(); process.exit(0); });
