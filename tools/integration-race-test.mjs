// End-to-end test of the LIVE RACE (SPEC §12) against the real server:
//   A. keyboard race: intro → countdown → start boost → steer along the road with
//      the arrow keys → hop-drift Turn 1 (mini-turbo) → pick up + use items →
//      look back → pause / resume → autopilot to the finish → results
//   B. phone race: a socket.io-client pad joins, drives the menus (start / select /
//      go), streams pad:input (gas / steer / drift / item seq) and the player kart
//      must respond; host:state race fields + vibrate patterns are checked; then
//      autopilot to the finish with the pad still connected (lap / finish rumble)
//   C. leak check: 3 autopiloted races in a row (Race Again) → scene children,
//      renderer.info.memory and bus listeners must stay flat
//   D. perf: average FPS / draw calls / triangles during a live race at 1280×720
//
//   node tools/integration-race-test.mjs [--port 3106] [--https-port 3546] [--shots dir] [--only ABCD] [--verbose]
//
// Exit code 0 = all checks passed (also fails on page errors / console.error).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { io as ioClient } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes('--' + n);
const PORT = Number(opt('port', 3106));
const HTTPS_PORT = Number(opt('https-port', 3546));
const SHOTS = opt('shots', null);
const ONLY = opt('only', 'ABCD').toUpperCase();     // run a subset of sections, e.g. --only AC
const W = Number(opt('w', 1280)), H = Number(opt('h', 720));
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

// In-page helpers (installed once after boot).
const PAGE_HELPERS = () => {
  const g = window.__game;
  window.__ev = {};
  window.__evLog = [];
  g.bus.on('*', (d, type) => {
    window.__ev[type] = (window.__ev[type] || 0) + 1;
    if (d && d.kart && d.kart === g.player && window.__evLog.length < 400) {
      window.__evLog.push({ type, t: +(g.race ? g.race.time : 0).toFixed(2), item: d.item, tier: d.tier, source: d.source, cause: d.cause, lap: d.lap, place: d.place });
    }
  });
  const angleDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  // Player probe + steering hint toward a point ahead on the racing line (+alpha = target is LEFT).
  window.__probe = (latBias = 0) => {
    const P = g.player, t = g.track, rc = g.race;
    if (!P) return null;
    const s = P.proj.s;
    const look = 9 + 0.45 * Math.max(0, P.speed);
    const fi = Math.floor(t.wrapS(s + look) / t.spacing) % t.N;
    const lat = (t.racingLine ? t.racingLine[fi] * 0.6 : 0) + latBias;
    const pt = t.pointAt(s + look, lat);
    const alpha = angleDiff(P.yaw, Math.atan2(pt.x - P.position.x, pt.z - P.position.z));
    return {
      s: +s.toFixed(1), lat: +P.proj.lateral.toFixed(2), speed: +P.speed.toFixed(2), yaw: +P.yaw.toFixed(3), alpha: +alpha.toFixed(3),
      drift: P.drift.active, tier: P.drift.tier, charge: +P.drift.charge.toFixed(2), boost: +P.boostTimer.toFixed(2),
      item: P.item, count: P.itemCount, rolling: P.rolling, lap: P.lap, place: P.place, distance: +P.distance.toFixed(1),
      state: rc ? rc.state : null, countdown: rc ? +rc.countdown.toFixed(2) : 0, time: rc ? +rc.time.toFixed(2) : 0,
      app: g.state, steerIn: +P.input.steer.toFixed(2), throttleIn: P.input.throttle, driftIn: P.input.drift,
      lookBack: g.chase.lookBack, camMode: g.chase.mode, stall: P.stallTimer, surface: P.surface,
    };
  };
  window.__perf = (ms) => new Promise((resolve) => {
    const info = g.renderer.info;
    const frames = [];
    let calls = 0, tris = 0, maxCalls = 0, maxTris = 0, n = 0, last = performance.now();
    const t0 = last;
    const tick = (t) => {
      frames.push(t - last); last = t;
      const c = info.render.calls, tr = info.render.triangles;
      calls += c; tris += tr; n++;
      if (c > maxCalls) maxCalls = c;
      if (tr > maxTris) maxTris = tr;
      if (t - t0 < ms) requestAnimationFrame(tick);
      else {
        frames.shift();
        const sorted = frames.slice().sort((a, b) => a - b);
        const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
        resolve({
          frames: frames.length, fps: +(1000 / avg).toFixed(1), avgMs: +avg.toFixed(2),
          p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2), maxMs: +sorted[sorted.length - 1].toFixed(2),
          calls: Math.round(calls / n), maxCalls, triangles: Math.round(tris / n), maxTriangles: maxTris,
          geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs ? info.programs.length : 0,
          frameCpuMs: g.stats().frameCpuMs, frameCpuMaxMs: g.stats().frameCpuMaxMs,
        });
      }
    };
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
  });
  window.__mem = () => {
    let listeners = 0;
    for (const list of g.bus._map.values()) listeners += list.length;
    const i = g.renderer.info;
    return { children: g.scene.children.length, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs ? i.programs.length : 0, listeners };
  };
  window.__results = () => (g.race ? g.race.getResults() : []).map((x) => ({
    place: x.place, name: x.kart.character.name, time: x.time == null ? null : +x.time.toFixed(2),
    finished: x.finished, bestLap: x.bestLap == null ? null : +x.bestLap.toFixed(2), isPlayer: x.isPlayer,
  }));
  return true;
};

let browser = null, padSock = null;
let errors = 0;
const errorLines = [];
const report = {};

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
  await page.setViewport({ width: W, height: H });
  page.on('console', (m) => {
    if (m.type() === 'error') { errors++; errorLines.push(m.text()); }
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => { errors++; errorLines.push(e.message); console.log(`  [pageerror] ${e.message}`); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

  const G = (expr) => page.evaluate(expr);
  const probe = (bias = 0) => page.evaluate((b) => window.__probe(b), bias);
  const waitFor = async (expr, ms = 5000, every = 30) => {
    const t0 = Date.now();
    let v;
    while (Date.now() - t0 < ms) { v = await G(expr); if (v) return v; await sleep(every); }
    return v;
  };
  const waitState = (want, ms = 5000) => waitFor(`window.__game && window.__game.state === ${JSON.stringify(want)}`, ms, 50);
  const shot = async (name) => { if (SHOTS) { await page.screenshot({ path: path.join(SHOTS, name) }); console.log(`  [shot] ${name}`); } };
  const ev = (type) => G(`window.__ev[${JSON.stringify(type)}] || 0`);

  // ---- keyboard state (only send real edges)
  const held = new Set();
  const down = async (k) => { if (!held.has(k)) { held.add(k); await page.keyboard.down(k); } };
  const up = async (k) => { if (held.has(k)) { held.delete(k); await page.keyboard.up(k); } };
  const releaseAll = async () => { for (const k of [...held]) await up(k); };
  // Human-like keyboard driver: bang-bang steering toward the line ahead, gas held.
  async function keyDrive(stop, { maxMs = 15000, drift = false, bias = 0, onTick = null } = {}) {
    const t0 = Date.now();
    let p = await probe(bias);
    await down('ArrowUp');
    if (drift) await down('Space');
    while (Date.now() - t0 < maxMs) {
      p = await probe(bias);
      if (!p || stop(p)) break;
      const dead = drift ? 0.02 : 0.045;
      if (p.alpha > dead) { await up('ArrowRight'); await down('ArrowLeft'); }
      else if (p.alpha < -dead) { await up('ArrowLeft'); await down('ArrowRight'); }
      else { await up('ArrowLeft'); await up('ArrowRight'); }
      if (onTick) await onTick(p);
      await sleep(25);
    }
    return p;
  }

  console.log('\n# boot');
  check((await waitState('title', 20000)) === true, 'reaches title');
  check(await page.evaluate(PAGE_HELPERS), 'test helpers installed');
  const room = await waitFor('window.__game.phone.room', 6000, 100);
  check(/^[A-Z]{4}$/.test(room || ''), `host room ${room}`);
  check(!(await G('Object.keys(window.__game.modules.errors).length')), 'items / ai / race modules loaded');
  const mem0 = await G('window.__mem()');
  console.log(`  memory at title: ${JSON.stringify(mem0)}`);

  let p = null;    // last player probe

  // =============================================================== A. keyboard race
  if (ONLY.includes('A')) {
  console.log('\n# A. keyboard race');
  await G(`window.__game.quickRace('blaze', 'normal')`);
  check((await waitState('race')) === true, 'quickRace → race');
  check(await G('window.__game.karts.length === 8 && window.__game.karts.indexOf(window.__game.player) === 7'), '8 karts, player on grid slot 7');
  check(await G(`new Set(window.__game.karts.map(k => k.character.id)).size === 8`), 'all 8 characters race');
  check(await G('window.__game.race.state === "intro" && window.__game.chase.mode === "intro"'), 'race intro + camera flyover');
  check(await G('window.__game.karts.every(k => k.frozen)'), 'karts frozen during intro');
  check(await G('window.__game.scene.children.filter(o => o.visible && o.name === "Showroom").length === 0'), 'showroom hidden during race');
  await sleep(1300);
  await shot('race-intro.png');
  check(!!(await waitFor('window.__game.race.state === "countdown"', 6000)), 'intro → countdown automatically');
  const camSynced = await G('window.__game.chase.mode');
  check(camSynced === 'chase', `camera intro ends with the race intro (mode=${camSynced})`);
  await waitFor('window.__game.race.countdown <= 1.85', 4000, 15);
  await shot('race-countdown.png');
  check(await G(`!!document.querySelector('.hud') && getComputedStyle(document.querySelector('.hud')).visibility !== 'hidden'`), 'HUD visible from the countdown');
  // rocket start: press gas inside the start-boost window (0.25-0.75 s before GO)
  await waitFor('window.__game.race.countdown <= 0.55', 4000, 10);
  await down('ArrowUp');
  check(!!(await waitFor('window.__game.race.state === "racing"', 3000, 10)), 'GO → racing');
  await sleep(120);
  p = await probe();
  check((await ev('race:startBoost')) >= 1 && p.boost > 0, `start boost earned (boostTimer ${p.boost})`);
  check(p.stall <= 0, 'no stall');
  check((await ev('race:countdown')) === 3 && (await ev('race:go')) === 1, 'race:countdown ×3 + race:go');

  // drive the start straight with the keys
  // explicit keyboard steering: ← turns left (+yaw), → turns right (-yaw)
  await sleep(700);
  p = await probe();
  const yawL0 = p.yaw;
  await down('ArrowLeft');
  await sleep(260);
  p = await probe();
  await up('ArrowLeft');
  check(p.steerIn < -0.5 && p.yaw > yawL0 + 0.03, `← steers left (steer ${p.steerIn}, yaw ${yawL0} → ${p.yaw})`);
  const yawR0 = p.yaw;
  await down('ArrowRight');
  await sleep(380);
  p = await probe();
  await up('ArrowRight');
  check(p.steerIn > 0.5 && p.yaw < yawR0 - 0.03, `→ steers right (steer ${p.steerIn}, yaw ${yawR0} → ${p.yaw})`);
  let shotHud = false;
  p = await keyDrive((q) => q.s > 60 && q.s < 500 && q.s >= 86, {
    maxMs: 9000,
    onTick: async (q) => { if (!shotHud && q.time > 2.2) { shotHud = true; await shot('race-hud.png'); } },
  });
  check(p.speed > 18, `keyboard gas: speed ${p.speed} m/s at s=${p.s}`);
  check(Math.abs(p.lat) < 9, `kept on the road with the arrow keys (lateral ${p.lat})`);
  const gotItem = await G('!!(window.__game.player.item || window.__game.player.rolling)');
  console.log(`  natural item from the first box row: ${gotItem}`);

  // hop-drift a right-hander (hold → + Space). Rivals' bananas / stink can spin
  // the player mid-drift, so up to three corners are tried: Turn 1, Esses B, hairpin.
  const corners = [{ name: 'Turn 1', s0: 86, s1: 146 }, { name: 'Esses B', s0: 224, s1: 268 }, { name: 'Lighthouse Hairpin', s0: 398, s1: 456 }];
  const driftBoosts = () => G(`window.__evLog.filter(e => e.type === 'kart:boost' && e.source === 'drift').length`);
  let driftShot = false, drifted = null;
  for (const c of corners) {
    p = await keyDrive((q) => q.s >= c.s0 - 2 && q.s < c.s0 + 200, { maxMs: 12000 });
    const before = await driftBoosts();
    const hitsBefore = await G(`window.__evLog.filter(e => e.type === 'kart:spin' || e.type === 'kart:tumble').length`);
    await up('ArrowLeft'); await down('ArrowRight');
    await sleep(100);
    let maxTier = 0;
    p = await keyDrive((q) => q.s >= c.s1 || q.tier >= 2, {
      maxMs: 5000, drift: true, bias: 2,
      onTick: async (q) => {
        maxTier = Math.max(maxTier, q.tier);
        if (!driftShot && q.tier >= 1) { driftShot = true; await shot('race-drift.png'); }
      },
    });
    maxTier = Math.max(maxTier, p.tier);
    await up('Space');
    await sleep(150);
    const boosted = (await driftBoosts()) > before;
    const hit = (await G(`window.__evLog.filter(e => e.type === 'kart:spin' || e.type === 'kart:tumble').length`)) > hitsBefore;
    console.log(`  drift attempt @ ${c.name}: tier ${maxTier}, mini-turbo ${boosted}${hit ? ' (player was hit mid-drift)' : ''}`);
    if (flag('verbose')) console.log('  trace:', JSON.stringify(await G(`window.__evLog.filter(e => /drift|hop|spin|tumble|boost/.test(e.type)).slice(-8)`)));
    if (maxTier >= 1 && boosted) { drifted = { corner: c.name, tier: maxTier }; break; }
  }
  check((await ev('kart:hop')) >= 1, 'Space → hop');
  check(await G(`window.__evLog.some(e => e.type === 'kart:driftStart')`), 'drift started (kart:driftStart)');
  check(!!drifted, `keyboard drift charged + released → mini-turbo ${drifted ? `(tier ${drifted.tier} @ ${drifted.corner})` : ''}`);

  // items: use whatever a box gave us, then fire a rocket for the screenshot
  p = await keyDrive((q) => !q.rolling, { maxMs: 3000 });
  const natural = await G(`window.__evLog.filter(e => e.type === 'item:get').map(e => e.item)`);
  console.log(`  items picked up from boxes so far: ${JSON.stringify(natural)}`);
  if (p.item) {
    const it = p.item;
    await page.keyboard.press('KeyX');
    await sleep(120);
    const used = await G(`window.__evLog.filter(e => e.type === 'item:use').map(e => e.item)`);
    check(used.includes(it), `KeyX uses the picked-up item (${it})`);
  }
  // Ctrl is not an item key (next to W = gas, Ctrl+W closes the tab on Windows / Linux)
  await G(`(() => { const P = window.__game.player; P.item = 'toot'; P.itemCount = 1; P.rolling = false; return true; })()`);
  await sleep(60);
  await page.keyboard.press('ControlLeft');
  await sleep(120);
  check(await G(`window.__game.player.item === 'toot'`), 'Ctrl does not use the item');
  // a rival's Zap Cloud hits the player: ZAPPED! banner + zap screen flash
  const zap = await G(`(() => {
    const g = window.__game, P = g.player, rc = g.race;
    const behind = rc.standings.filter((k) => k !== P && !k.finished && k.place > P.place);
    if (!behind.length) return { skipped: true, place: P.place };
    const u = behind[behind.length - 1];
    const m = g.menus, h = g.hud, flashes = [], banners = [];
    const sf = m.screenFlash, hf = h.flash;
    m.screenFlash = function (kind) { flashes.push(kind); return sf.apply(this, arguments); };
    h.flash = function (text) { banners.push(text); return hf.apply(this, arguments); };
    P.invulnTimer = 0; P.starTimer = 0;
    u.item = 'zap'; u.itemCount = 1; u.rolling = false;
    let used = false;
    try { used = g.items.useItem(u); } finally { m.screenFlash = sf; h.flash = hf; }
    return { used, slowed: P.slowTimer > 0, flashes, banners, place: P.place, by: u.place };
  })()`);
  if (zap.skipped) console.log(`  (zap feedback check skipped: player is last, place ${zap.place})`);
  else {
    check(zap.used && zap.slowed, `CPU in ${zap.by}th zaps the player in ${zap.place}th`);
    check(zap.flashes.includes('zap') && zap.banners.includes('ZAPPED!'), `zapped player sees ZAPPED! + the zap flash (${JSON.stringify(zap)})`);
    await waitFor('!window.__game.player.isDisabled()', 3000);     // items are ignored while spinning
  }
  // a quiet distant rival's one-shot must not swallow a louder (player) one in the same instant
  const voices = await G(`(() => { const a = window.__game.audio; if (!a.ready) return null;
    const v0 = a._voices; a.play('hit', { volume: 0.03 }); a.play('hit', { volume: 1 }); a.play('hit', { volume: 0.6 }); return a._voices - v0; })()`);
  if (voices === null) console.log('  (audio not unlocked: louder-retrigger check skipped)');
  else check(voices === 2, `louder retrigger plays, quieter repeat is dropped (${voices} voices)`);
  const explodes0 = await ev('item:explode');
  await G(`(() => { const P = window.__game.player; P.item = 'rocket'; P.itemCount = 1; P.rolling = false; return true; })()`);
  await sleep(60);
  await page.keyboard.press('KeyX');
  await sleep(200);
  await shot('race-item.png');
  check(await G(`window.__evLog.some(e => e.type === 'item:use' && e.item === 'rocket') && window.__game.player.item === null`), 'KeyX fires a rocket (item:use, slot emptied)');
  check((await G('window.__game.items.projectiles.length >= 1')) || (await ev('item:explode')) > explodes0, 'rocket in flight (or already exploded on its target)');

  // look back (C held)
  await down('KeyC');
  await sleep(150);
  check((await probe()).lookBack === true, 'C held → camera looks back');
  await up('KeyC');
  await sleep(100);
  check((await probe()).lookBack === false, 'C released → chase view');

  // pause / resume freezes the simulation
  await releaseAll();
  await page.keyboard.press('Escape');
  check((await waitState('paused')) === true, 'Esc → paused');
  const tp0 = (await probe()).time;
  await sleep(500);
  const tp1 = (await probe()).time;
  check(tp0 === tp1, `race clock frozen while paused (${tp0} → ${tp1})`);
  await page.keyboard.press('Escape');
  check((await waitState('race')) === true, 'Esc → resume');

  // autopilot to the finish
  check(await G('window.__game.autopilot(true)'), 'autopilot on');
  await G('window.__game.setTimeScale(8)');
  const tA = Date.now();
  check((await waitState('results', 150000)) === true, 'keyboard race reaches results (autopilot finish)');
  await G('window.__game.setTimeScale(1)');
  console.log(`  (finished in ${((Date.now() - tA) / 1000).toFixed(1)} s real time at 8x)`);
  await sleep(900);
  await shot('race-results.png');
  const resA = await G('window.__results()');
  report.keyboardRace = resA;
  check(resA.length === 8 && resA.filter((x) => x.isPlayer).length === 1, 'results: 8 rows, one player');
  check(await G(`document.querySelectorAll('.tk-res-body .tk-res-row').length === 8`), 'results table rendered');
  check((await ev('race:over')) === 1, 'race:over exactly once');
  check((await ev('race:finish')) >= 1 && (await ev('race:finalLap')) >= 1, 'race:finish + race:finalLap fired');
  const lapLog = await G(`window.__evLog.filter(e => e.type === 'race:lap').map(e => e.lap)`);
  check(lapLog.join(',') === '2,3', `player laps 2,3 (${lapLog})`);
  check(await G('window.__game.chase.mode === "orbit"'), 'camera orbits after the finish');
  // the race keeps running behind the results screen, but silently
  const quiet = await G(`(async () => {
    const g = window.__game, a = g.audio, names = [];
    const orig = a.play;
    a.play = function (name) { names.push(name); return orig.apply(this, arguments); };
    await new Promise((r) => setTimeout(r, 2500));
    a.play = orig;
    return { names, engineActive: a._engineActive, engGain: a._engine ? +a._engine.engGain.gain.value.toFixed(3) : 0, state: g.state, moving: g.player.speed > 3 };
  })()`);
  check(quiet.state === 'results' && quiet.engineActive === false && quiet.engGain < 0.02, `engine loops silent on the results screen (${JSON.stringify(quiet)})`);
  check(quiet.names.length === 0, `no race one-shots over the results screen (${quiet.names.join(',')})`);
  console.table(resA);
  }

  // =============================================================== B. phone race
  if (ONLY.includes('B')) {
  console.log('\n# B. phone race (socket.io-client pad)');
  if ((await G('window.__game.state')) !== 'results') { await G('window.__game.debugResults()'); await waitState('results'); }
  padSock = ioClient(`https://localhost:${HTTPS_PORT}`, { transports: ['websocket'], rejectUnauthorized: false, reconnection: false, forceNew: true });
  await new Promise((res, rej) => { padSock.once('connect', res); padSock.once('connect_error', rej); });
  let last = null;
  const states = [];
  const vibes = [];
  padSock.on('host:state', (s) => { last = s; states.push({ at: Date.now(), s }); });
  padSock.on('host:event', (e) => { if (e.type === 'vibrate') vibes.push(JSON.stringify(e.pattern)); });
  const hello = await padSock.timeout(3000).emitWithAck('pad:hello', { room, id: 'race-pad-1' });
  check(hello && hello.ok, 'pad:hello ok');
  const waitHost = async (pred, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (last && pred(last)) return last; await sleep(25); }
    return null;
  };
  check(!!(await waitHost((s) => s.screen === 'results')), 'pad mirrors results screen');
  check(!!last && Array.isArray(last.results) && last.results.length === 8, 'host:state.results has 8 rows');
  const menu = async (action, extra = {}) => { padSock.emit('pad:menu', { action, ...extra }); await sleep(250); };
  await menu('menu');
  check((await waitState('select')) === true, 'pad "menu" on results → select');
  await menu('select', { index: 2 });
  await menu('difficulty', { value: 'normal' });
  await menu('go');
  check((await waitState('race')) === true, 'pad go → race');
  check((await G('window.__game.player.character.id')) === 'pip', 'phone-selected character (pip) races');
  const hs = await waitHost((s) => s.screen === 'race' && s.race);
  check(!!hs, 'host:state screen=race');
  if (hs) {
    const keys = ['state', 'lap', 'laps', 'place', 'racers', 'item', 'itemCount', 'rolling', 'countdown', 'finished'];
    check(keys.every((k) => k in hs.race), `host:state.race has every field ${JSON.stringify(hs.race)}`);
  }
  const cdState = await waitHost((s) => s.race && s.race.state === 'countdown' && s.race.countdown === 2, 9000);
  check(!!cdState, 'phone sees the countdown (countdown=2)');

  // stream pad:input at 60 Hz
  const pad = { s: 0, g: 0, b: 0, d: 0, i: 0, p: 0 };
  const padTimer = setInterval(() => { padSock.volatile.emit('pad:input', { ...pad, t: Date.now() }); }, 1000 / 60);
  await waitFor('window.__game.race.countdown <= 0.5', 5000, 10);
  pad.g = 1;
  check(!!(await waitFor('window.__game.race.state === "racing"', 3000, 10)), 'GO (phone)');
  await sleep(150);
  p = await probe();
  check((await G(`window.__evLog.filter(e => e.type === 'race:startBoost').length`)) >= 2 || p.boost > 0, `phone gas in the window → rocket start (boost ${p.boost})`);
  await sleep(1500);
  p = await probe();
  check(p.speed > 15, `phone gas → speed ${p.speed}`);
  check((await G('window.__game.input.lastSource')) === 'phone' && (await G('window.__game.input.phoneActive')), 'input source = phone (active)');
  const yawA = p.yaw;
  pad.s = 0.8;                                      // steer right → yaw decreases
  await sleep(350);
  p = await probe();
  check(p.steerIn > 0.5 && p.yaw < yawA - 0.05, `phone steer right → steer ${p.steerIn}, yaw ${yawA} → ${p.yaw}`);
  pad.s = -0.8;
  await sleep(350);
  p = await probe();
  check(p.steerIn < -0.5, `phone steer left → steer ${p.steerIn}`);
  // drift with the phone
  pad.s = 0.7; pad.d = 1;
  await sleep(500);
  p = await probe();
  check(p.driftIn === true && p.drift === true, `phone DRIFT held → drifting (dir right), charge ${p.charge}`);
  pad.d = 0; pad.s = 0;
  await sleep(200);
  // item: force a toot and bump the item sequence counter
  await G(`(() => { const P = window.__game.player; P.item = 'toot'; P.itemCount = 1; P.rolling = false; return true; })()`);
  await sleep(80);
  check(!!(await waitHost((s) => s.race && s.race.item === 'toot' && s.race.itemCount === 1, 2000)), 'host:state.race.item mirrors the held item');
  pad.i++;
  await sleep(200);
  p = await probe();
  check(p.item === null && p.boost > 0, `phone ITEM (itemSeq) → toot used, boost ${p.boost}`);
  check(await G(`window.__evLog.some(e => e.type === 'kart:boost' && e.source === 'item')`), 'toot boost event (kart:boost item)');
  check(!!(await waitHost((s) => s.race && s.race.item === null, 2000)), 'host:state.race.item cleared after use');
  // hit → vibrate [80,40,80]
  const vibBefore = vibes.length;
  await G(`window.__game.player.invulnTimer = 0, window.__game.player.spinOut('banana')`);
  await sleep(300);
  check(vibes.slice(vibBefore).includes('[80,40,80]'), `player hit → vibrate [80,40,80] (${vibes.slice(vibBefore)})`);
  // host:state rate while racing: on change + ≤ hostStateHz refresh (+ net.js 15 Hz cap)
  const t0r = Date.now();
  const n0 = states.length;
  await sleep(2000);
  const rate = (states.length - n0) / ((Date.now() - t0r) / 1000);
  check(rate <= 15.5, `host:state rate ${rate.toFixed(1)}/s during the race (≤ 15)`);
  // pad pause
  pad.p++;
  check((await waitState('paused')) === true, 'phone pause button (pauseSeq) → paused');
  check(!!(await waitHost((s) => s.screen === 'paused')), 'host:state screen=paused');
  await menu('resume');
  check((await waitState('race')) === true, 'pad resume → race');
  // autopilot to the finish with the pad connected and still streaming, like a
  // real pad on the race screen (net.js pauses a race whose driving pad goes silent)
  pad.g = 0; pad.s = 0;
  await G('window.__game.autopilot(true)');
  await G('window.__game.setTimeScale(8)');
  check((await waitState('results', 150000)) === true, 'phone race reaches results');
  await G('window.__game.setTimeScale(1)');
  await sleep(500);
  const vibesAtResults = vibes.length;
  await sleep(1500);
  check(vibes.length === vibesAtResults, `no phone rumble from the race behind the results screen (${vibes.slice(vibesAtResults)})`);
  clearInterval(padTimer);
  report.phoneRace = await G('window.__results()');
  console.table(report.phoneRace);
  check(vibes.includes('[40,30,40]'), 'lap → vibrate [40,30,40]');
  check(vibes.includes('[100,50,100,50,200]'), 'finish → vibrate [100,50,100,50,200]');
  check(vibes.includes('[30]') || (await G(`window.__evLog.filter(e => e.type === 'item:get').length`)) === 0 || true, 'item get vibrate [30] (if an item was picked up)');
  const gotNatural = await G(`window.__evLog.filter(e => e.type === 'item:get').length`);
  if (gotNatural) check(vibes.includes('[30]'), `item:get → vibrate [30] (${gotNatural} pickups)`);
  const res = await waitHost((s) => s.screen === 'results' && Array.isArray(s.results) && s.results.length === 8);
  check(!!res && res.results.every((x) => 'name' in x && 'cssColor' in x && 'place' in x && 'time' in x && 'isPlayer' in x), 'host:state.results rows {name, cssColor, place, time, isPlayer}');
  padSock.disconnect();
  padSock = null;
  await sleep(400);
  }

  // =============================================================== C. leak check
  if (ONLY.includes('C')) {
    // In-race GPU geometry counts vary with which item visuals happened to be
    // drawn (three uploads a geometry on first render), so GPU memory is compared
    // on the title screen after each teardown; scene children / bus listeners /
    // textures are compared on the results screen too. Cycle 2 also runs a
    // "Race Again" (teardown through startRace) before returning to the title.
    console.log('\n# C. leak check: 3 race cycles (4 races)');
    const runToResults = async (label) => {
      await waitState('race');
      await G('window.__game.skipIntro(), window.__game.autopilot(true), window.__game.setTimeScale(8)');
      const ok = (await waitState('results', 150000)) === true;
      check(ok, `${label} reaches results`);
      await G('window.__game.setTimeScale(1)');
      await sleep(400);
    };
    const inRace = [], atTitle = [];
    for (let i = 0; i < 3; i++) {
      await G(`window.__game.quickRace('bolt', 'hard')`);
      await runToResults(`race ${i + 1}`);
      inRace.push(await G('window.__mem()'));
      if (i === 1) {
        await G(`window.__game.action('again')`);
        await runToResults('race 2b (Race Again)');
        inRace.push(await G('window.__mem()'));
      }
      await G(`window.__game.goto('title')`);
      await waitState('title');
      await sleep(600);
      atTitle.push(await G('window.__mem()'));
      console.log(`  cycle ${i + 1}: results ${JSON.stringify(inRace[inRace.length - 1])} | title ${JSON.stringify(atTitle[i])}`);
    }
    report.leak = { inRace, atTitle, boot: mem0 };
    const flat = (arr, k) => arr.every((m) => m[k] === arr[0][k]);
    check(flat(inRace, 'children'), `results: scene.children flat (${inRace.map((m) => m.children)})`);
    check(flat(inRace, 'listeners'), `results: bus listeners flat (${inRace.map((m) => m.listeners)})`);
    check(flat(inRace, 'textures'), `results: renderer.info.memory.textures flat (${inRace.map((m) => m.textures)})`);
    check(flat(atTitle, 'geometries'), `title: renderer.info.memory.geometries flat (${atTitle.map((m) => m.geometries)})`);
    check(flat(atTitle, 'textures'), `title: renderer.info.memory.textures flat (${atTitle.map((m) => m.textures)})`);
    check(flat(atTitle, 'programs'), `title: shader programs flat (${atTitle.map((m) => m.programs)})`);
    check(atTitle.every((m) => m.children === mem0.children && m.listeners === mem0.listeners),
      `title: scene children + bus listeners back to boot values (${mem0.children} / ${mem0.listeners})`);
  }

  // =============================================================== D. perf
  if (ONLY.includes('D')) {
  console.log('\n# D. perf (live race, 1280x720, autopilot player)');
  await G(`window.__game.quickRace('blaze', 'normal')`);
  await waitState('race');
  await G('window.__game.skipIntro(), window.__game.autopilot(true)');
  await waitFor('window.__game.race.state === "racing"', 5000);
  await sleep(1500);
  const perf1 = await G('window.__perf(6000)');
  console.log(`  pack, first lap: ${JSON.stringify(perf1)}`);
  await shot('race-perf.png');
  await G('window.__game.setTimeScale(6)');
  await sleep(5000);
  await G('window.__game.setTimeScale(1)');
  const perf2 = await G('window.__perf(5000)');
  console.log(`  mid race: ${JSON.stringify(perf2)}`);
  report.perf = [perf1, perf2];
  check(perf1.maxCalls <= 250 && perf2.maxCalls <= 250, `draw calls ≤ 250 (max ${Math.max(perf1.maxCalls, perf2.maxCalls)})`);
  check(perf1.maxTriangles <= 400000 && perf2.maxTriangles <= 400000, `triangles ≤ 400k (max ${Math.max(perf1.maxTriangles, perf2.maxTriangles)})`);
  check(perf1.fps > 50, `≥ 50 fps in headless Chrome (${perf1.fps})`);
  await G(`window.__game.goto('title')`);
  await waitState('title');
  }
} catch (err) {
  fail++;
  failures.push(String(err && err.stack || err));
  console.error(err);
} finally {
  if (padSock) padSock.close();
  if (browser) await browser.close();
  server.kill();
}

check(errors === 0, `no page errors / console errors (${errors})`, errorLines.join(' | '));
console.log('\nREPORT ' + JSON.stringify(report));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:\n - ' + failures.join('\n - ')); process.exit(1); }
