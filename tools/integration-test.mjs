// End-to-end test of the desktop shell (index.html / main.js / menus.js) against
// the REAL server: spawns `node server.js` on test ports, opens the game in
// headless Chrome, connects a fake phone (socket.io-client) and drives every
// menu with pad:menu actions and with the keyboard, checking both the desktop
// state (window.__game) and the host:state the phone receives.
//
//   node tools/integration-test.mjs [--port 3105] [--https-port 3545] [--shots dir] [--keep]
//
// Exit code 0 = all checks passed, 1 = failures (also fails on page errors /
// console.error).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { io as ioClient } from 'socket.io-client';
import { CHARACTERS, SELECTABLE } from '../public/js/characters.js';
import { RACE } from '../public/js/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('port', 3105));
const HTTPS_PORT = Number(opt('https-port', 3545));
const SHOTS = opt('shots', null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label} ${extra}`); }
}

// ---------------------------------------------------------------- server
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (server.exitCode !== null) throw new Error(`server exited (${server.exitCode})\n${serverLog}`);
    try {
      const r = await fetch(`http://localhost:${PORT}/api/info`);
      if (r.ok) return r.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not start\n' + serverLog);
}

let browser = null, padSock = null, padStream = null;
let errors = 0;
const errorLines = [];

try {
  const info = await waitForServer();
  console.log(`server up: http ${PORT} / https ${HTTPS_PORT}, lanIps ${JSON.stringify(info.lanIps)}`);

  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    acceptInsecureCerts: true,
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('console', (m) => {
    if (m.type() === 'error') { errors++; errorLines.push(m.text()); }
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => { errors++; errorLines.push(e.message); console.log(`  [pageerror] ${e.message}`); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

  const G = (expr) => page.evaluate(expr);
  const waitState = async (want, ms = 4000) => {
    const t0 = Date.now();
    let st;
    while (Date.now() - t0 < ms) {
      st = await G('window.__game && window.__game.state');
      if (st === want) return true;
      await sleep(50);
    }
    return st;
  };
  const key = async (k, wait = 140) => { await page.keyboard.press(k); await sleep(wait); };
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); };

  console.log('\n# boot');
  check((await waitState('title', 15000)) === true, 'reaches title');
  let room = null;
  for (let i = 0; i < 60 && !room; i++) { room = await G('window.__game.phone.room'); if (!room) await sleep(100); }
  check(/^[A-Z]{4}$/.test(room || ''), `host room created (${room})`);
  check(await G(`!!document.querySelector('.tk-qr--title.is-online .tk-qr-svg svg')`), 'title QR panel shows the QR SVG');
  const url = await G(`document.querySelector('.tk-qr--title .tk-qr-url').textContent`);
  check(url.includes(`/pad?room=${room}`) && url.startsWith('https://'), `pad URL shown (${url})`);

  // ---------------------------------------------------------------- phone
  console.log('\n# phone connect');
  padSock = ioClient(`https://localhost:${HTTPS_PORT}`, { transports: ['websocket'], rejectUnauthorized: false, reconnection: false, forceNew: true });
  await new Promise((res, rej) => { padSock.once('connect', res); padSock.once('connect_error', rej); });
  let last = null;
  const states = [];
  padSock.on('host:state', (s) => { last = s; states.push(s); });
  const events = [];
  padSock.on('host:event', (e) => events.push(e));
  const hello = await padSock.timeout(3000).emitWithAck('pad:hello', { room, id: 'integration-pad-1' });
  check(hello && hello.ok, 'pad:hello ok');
  const waitHost = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (last && pred(last)) return last; await sleep(30); }
    return null;
  };
  check(!!(await waitHost((s) => s.screen === 'title')), 'pad receives host:state screen=title');
  check(last && Array.isArray(last.characters)
    && last.characters.length === CHARACTERS.length
    && last.characters.every((c, i) => c.id === CHARACTERS[i].id && c.name && /^#/.test(c.cssColor)),
  'host:state.characters contains the complete playable roster in order');
  await sleep(300);
  check(await G(`!!document.querySelector('.tk-qr--title.is-connected')`), 'desktop QR panel shows phone connected');
  check(await G(`document.querySelector('.tk-toast').classList.contains('on') && /Phone connected/.test(document.querySelector('.tk-toast').textContent)`), 'join toast visible');
  check(events.some((e) => e.type === 'vibrate'), 'welcome vibrate event sent to pad');
  await shot('it-title-connected.png');

  const menu = async (action, extra = {}) => { padSock.emit('pad:menu', { action, ...extra }); await sleep(250); };

  console.log('\n# phone menu actions');
  await menu('start');
  check((await waitState('select')) === true, 'pad start → select');
  check(!!(await waitHost((s) => s.screen === 'select')), 'host:state screen=select');
  await menu('select', { index: 3 });
  check((await G('window.__game.selected')) === 3, 'pad select{3} → desktop selected 3');
  check(await G(`document.querySelectorAll('.tk-card')[3].classList.contains('is-selected')`), 'card 3 highlighted');
  check(!!(await waitHost((s) => s.selected === 3)), 'host:state.selected = 3');
  await menu('select', { index: 99 });
  check((await G('window.__game.selected')) === 3, 'invalid select index ignored');
  await menu('difficulty', { value: 'hard' });
  check((await G('window.__game.difficulty')) === 'hard', 'pad difficulty{hard} → desktop');
  check(!!(await waitHost((s) => s.difficulty === 'hard')), 'host:state.difficulty = hard');
  await menu('difficulty', { value: 'insane' });
  check((await G('window.__game.difficulty')) === 'hard', 'invalid difficulty ignored');
  await shot('it-select.png');
  await menu('go');
  check((await waitState('race')) === true, 'pad go → race');
  const raceState = await waitHost((s) => s.screen === 'race' && s.race);
  check(!!raceState, 'host:state screen=race with race object');
  if (raceState) {
    const r = raceState.race;
    check(['intro', 'countdown', 'racing'].includes(r.state) && r.laps === RACE.laps && r.racers === RACE.racers && r.lap === 1, `race fields ${JSON.stringify(r)}`);
  }
  check((await G('window.__game.player.character.id')) === 'duke', 'player kart is the selected character (duke)');
  check((await G('window.__game.karts.length')) === RACE.racers, `${RACE.racers} karts`);
  check((await G('window.__game.karts.indexOf(window.__game.player)')) === RACE.playerGridSlot, `player in grid slot ${RACE.playerGridSlot}`);

  await menu('pause');
  check((await waitState('paused')) === true, 'pad pause → paused');
  check(!!(await waitHost((s) => s.screen === 'paused')), 'host:state screen=paused');
  await menu('resume');
  check((await waitState('race')) === true, 'pad resume → race');
  // pause via the pad's pauseSeq counter (the in-race pause button)
  padSock.emit('pad:input', { s: 0, g: 0, b: 0, d: 0, i: 0, p: 0, t: Date.now() });
  await sleep(100);
  padSock.emit('pad:input', { s: 0, g: 0, b: 0, d: 0, i: 0, p: 1, t: Date.now() });
  check((await waitState('paused')) === true, 'pad pauseSeq increment → paused');
  await menu('restart');
  check((await waitState('race')) === true, 'pad restart → race');
  check(await G('window.__game.race !== null'), 'race object exists after restart');
  // a nervous double tap on the phone's ⏸ (2nd tap before the pad has seen the
  // paused screen) must not pause and immediately resume
  padSock.emit('pad:input', { s: 0, g: 0, b: 0, d: 0, i: 0, p: 2, t: Date.now() });
  await sleep(60);
  padSock.emit('pad:input', { s: 0, g: 0, b: 0, d: 0, i: 0, p: 3, t: Date.now() });
  check((await waitState('paused')) === true, 'phone pause double tap → paused');
  await sleep(500);
  check((await G('window.__game.state')) === 'paused', 'phone pause double tap stays paused (phone ⏸ never resumes)');
  await menu('resume');
  check((await waitState('race')) === true, 'pad resume after the double tap → race');
  await menu('pause');
  await menu('quit');
  check((await waitState('title')) === true, 'pad quit → title');
  check((await G('window.__game.karts.length')) === 0, 'race torn down after quit');

  console.log('\n# controls overlay vs screen changes');
  const helpIs = (open) => G(`document.querySelector('.tk-help').classList.contains('is-open') === ${open} && window.__game.menus.helpOpen === ${open}`);
  // from here on the pad streams pad:input like a real one (net.js pauses a
  // race whose recently used pad goes silent for a second)
  padStream = setInterval(() => padSock.volatile.emit('pad:input', { s: 0, g: 0, b: 0, d: 0, i: 0, p: 3, t: Date.now() }), 1000 / 60);
  await key('KeyH');
  check(await helpIs(true), 'H opens controls help on the title');
  await menu('start');
  check((await waitState('select')) === true && (await helpIs(false)), 'pad start → select closes the help overlay');
  await key('KeyH');
  check(await helpIs(true), 'H opens controls help on select');
  await menu('go');
  check((await waitState('race')) === true, 'pad go with the help open → race');
  check(await helpIs(false), 'help overlay not left over the race');
  await key('KeyH');
  check(await helpIs(false), 'H does not open help mid-race');
  await menu('pause');
  check((await waitState('paused')) === true, 'pad pause → paused');
  await page.click('.tk-corner [data-action="help"]');
  await sleep(150);
  check(await helpIs(true), '? button opens help on the pause screen');
  await page.click('.tk-help-close');
  await sleep(150);
  check(await helpIs(false), '"Got it!" closes help on the pause screen');
  await key('KeyH');
  check(await helpIs(true), 'H opens help on the pause screen');
  await menu('restart');
  check((await waitState('race')) === true && (await helpIs(false)), 'pad restart from pause closes the help overlay');
  await menu('pause');
  await menu('quit');
  check((await waitState('title')) === true, 'pad quit → title');

  console.log('\n# results via debug hook');
  await G('window.__game.debugResults()');
  check((await waitState('results')) === true, 'debugResults → results');
  const res = await waitHost((s) => s.screen === 'results' && Array.isArray(s.results));
  check(!!res && res.results.length === CHARACTERS.length
    && res.results.filter((x) => x.isPlayer).length === 1
    && res.results.every((x, i) => x.place === i + 1 && CHARACTERS.some((c) => c.name === x.name)
      && Number.isFinite(x.time) && Number.isFinite(x.bestLap)),
  'debug host:state.results contains ranked roster rows and one player');
  check(await G(`document.querySelectorAll('.tk-res-body .tk-res-row').length === ${CHARACTERS.length} && document.querySelectorAll('.tk-res-row.is-player').length === 1`), 'debug results table rendered with one player highlight');
  await sleep(600);
  check(await G(`getComputedStyle(document.querySelector('.hud')).visibility === 'hidden'`), 'HUD hidden on results');
  await menu('again');
  check((await waitState('race')) === true, 'pad again → race');
  await G('window.__game.debugResults()');
  await waitState('results');
  await menu('menu');
  check((await waitState('select')) === true, 'pad menu → select');

  // ---------------------------------------------------------------- keyboard
  console.log('\n# keyboard');
  // V1 supports the preset roster. The custom card and garage UI are present,
  // but main.js does not wire their selection/customize actions yet. Do not
  // treat wrapping through that card or opening the garage as working flows.
  console.log('  NOTE custom-card wrapping / garage are unfinished and outside the supported v1 smoke checks');
  await G(`window.__game.goto('title')`);
  await waitState('title');
  await key('Enter');
  check((await waitState('select')) === true, 'Enter on title → select');
  check((await G(`document.querySelectorAll('.tk-card').length`)) === SELECTABLE.length, 'select screen renders every roster and custom card');
  const gridColumns = await G(`getComputedStyle(document.querySelector('.tk-cards')).gridTemplateColumns.split(' ').length`);
  check(gridColumns === 5, 'select screen uses the five-column layout');
  await G(`window.__game.action('select', { index: 0 })`);
  await sleep(100);
  await key('ArrowRight');
  check((await G('window.__game.selected')) === 1, 'ArrowRight → selected 1');
  await key('ArrowLeft');
  check((await G('window.__game.selected')) === 0, 'ArrowLeft → selected 0');
  const lastPreset = CHARACTERS.length - 1;
  await page.click(`.tk-card[data-index="${lastPreset}"]`);
  await sleep(150);
  check((await G('window.__game.selected')) === lastPreset, 'click the last preset card → selected preset');
  await key('ArrowUp');
  check((await G('window.__game.selected')) === lastPreset - gridColumns, 'ArrowUp → preset directly above in the five-column grid');
  await key('ArrowDown');
  check((await G('window.__game.selected')) === lastPreset, 'ArrowDown → same preset in the bottom row');
  await key('ArrowDown');
  check(await G(`document.querySelector('.tk-diff').classList.contains('is-focus')`), 'ArrowDown from bottom row → difficulty focus');
  await key('ArrowLeft');
  check((await G('window.__game.difficulty')) === 'normal', 'ArrowLeft on difficulty → normal');
  await key('ArrowLeft');
  check((await G('window.__game.difficulty')) === 'easy', 'ArrowLeft again → easy');
  await key('ArrowDown');
  check(await G(`document.querySelector('.tk-btn--go').classList.contains('is-focus')`), 'ArrowDown → RACE! focus');
  await key('Escape');
  check((await waitState('title')) === true, 'Esc on select → title');
  await key('Enter');
  await waitState('select');
  await key('Enter');
  check((await waitState('race')) === true, 'Enter on select → race');
  check((await G('window.__game.player.character.id')) === CHARACTERS[lastPreset].id, `selected preset (${CHARACTERS[lastPreset].id}) races`);
  await sleep(300);
  check((await G('window.__game.race && window.__game.race.state')) === 'intro', 'the Enter that started the race does not skip the intro');
  await key('Escape');
  check((await waitState('paused')) === true, 'Esc during the intro → paused');
  await key('Enter');   // "Resume" has the focus
  check((await waitState('race')) === true, 'Enter on Resume → race');
  await sleep(250);
  check((await G('window.__game.race && window.__game.race.state')) === 'intro', 'the Enter that pressed Resume does not skip the intro');
  check(await G(`document.querySelector('.tk-intro-hint').classList.contains('on')`), '"Enter skip intro" hint is back after resuming');
  await key('Enter');   // skip intro
  await sleep(200);
  check(['countdown', 'racing'].includes(await G('window.__game.race && window.__game.race.state')), 'Enter skips the intro');
  await key('Escape');
  check((await waitState('paused')) === true, 'Esc → paused');
  await shot('it-paused.png');
  await key('Escape');
  check((await waitState('race')) === true, 'Esc again → resume');
  await key('KeyP');
  check((await waitState('paused')) === true, 'P → paused');
  await key('ArrowDown');
  await key('Enter');
  check((await waitState('race')) === true, 'Pause → Restart (keyboard) → race');
  await key('Escape');
  await waitState('paused');
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter');
  check((await waitState('title')) === true, 'Pause → Quit (keyboard) → title');
  const muted0 = await G('window.__game.audio.muted');
  await key('KeyM');
  check((await G('window.__game.audio.muted')) === !muted0, 'M toggles mute');
  await key('KeyM');
  await key('KeyH');
  check(await G(`document.querySelector('.tk-help').classList.contains('is-open')`), 'H opens controls help');
  await shot('it-help.png');
  await key('Enter');
  check((await G('window.__game.state')) === 'title', 'Enter while help open does not start (closes help)');
  check(await G(`!document.querySelector('.tk-help').classList.contains('is-open')`), 'help closed');
  await G('window.__game.debugResults()');
  await waitState('results');
  await sleep(200);
  await key('ArrowRight');
  await key('Enter');
  check((await waitState('select')) === true, 'Results → Change Character (keyboard) → select');

  console.log('\n# phone leave');
  clearInterval(padStream);
  padSock.disconnect();
  await sleep(600);
  check(await G(`!document.querySelector('.tk-qr--compact.is-connected')`), 'desktop shows phone disconnected');

  const stats = await G('JSON.stringify(window.__game.stats())');
  console.log(`\nrenderer stats on select: ${stats}`);
} catch (err) {
  fail++;
  failures.push(String(err && err.stack || err));
  console.error(err);
} finally {
  clearInterval(padStream);
  if (padSock) padSock.close();
  if (browser) await browser.close();
  server.kill();
}

check(errors === 0, `no page errors / console errors (${errors})`, errorLines.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:\n - ' + failures.join('\n - ')); process.exit(1); }
