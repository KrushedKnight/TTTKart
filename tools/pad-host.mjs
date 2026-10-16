// Fake desktop "host" for testing the phone controller (public/pad.html)
// without the full game. It joins the TOOT KART server as a host, opens a room
// with a fixed code, runs a tiny game state machine driven by the pad's menu
// actions (title → select → race → results …, pause via the pad's pauseSeq),
// logs everything the pad sends, and exposes an HTTP control API so scripted
// browser tests can force screens and read back what the host received.
//
//   node tools/pad-host.mjs [--url http://localhost:3100] [--room PADS] [--control 3198]
//
// Control API (GET, JSON responses):
//   /state?screen=title|select|race|paused|results|loading
//          [&race=intro|countdown|racing|finished][&item=rocket][&rolling=1]
//          [&count=3][&place=2][&lap=2][&finished=1][&auto=0]   force a screen
//   /log                      { last, edges, menus, counts }
//   /clear                    clear the logs
//   /event?type=vibrate&pattern=40,30,40   |   /event?type=toast&text=Hi
//   /leave                    disconnect the host (pad shows "waiting for the game")
//   /join                     reconnect and reclaim the room
//
// Also importable: `const host = await startFakeHost({ url, room })`.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';

const FALLBACK_CHARACTERS = [
  ['blaze', 'Blaze', '#ff7a1f'], ['bolt', 'Bolt', '#2f6bff'], ['pip', 'Pip', '#e8344e'], ['duke', 'Duke', '#ffc21f'],
  ['nova', 'Nova', '#8b5cff'], ['gus', 'Gus', '#35c64a'], ['mochi', 'Mochi', '#ff7fc0'], ['ziggy', 'Ziggy', '#15c9b0'],
].map(([id, name, cssColor]) => ({ id, name, cssColor }));

async function loadCharacters() {
  try {
    const mod = await import('../public/js/characters.js');
    const list = mod.CHARACTERS.map((c) => ({ id: c.id, name: c.name, cssColor: c.cssColor }));
    if (list.length === 8 && list.every((c) => typeof c.cssColor === 'string')) return list;
  } catch { /* module mid-edit or missing — use the fallback */ }
  return FALLBACK_CHARACTERS;
}

const ITEMS = ['banana', 'bouncer', 'rocket', 'toot', 'triple_toot', 'stink', 'star', 'zap'];
const LAPS = 3;
const INTRO_S = 1.2;
const COUNTDOWN_S = 3;
const LAP_S = 14;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startFakeHost({ url = 'http://localhost:3100', room = 'PADS', quiet = false } = {}) {
  const characters = await loadCharacters();
  const log = (...a) => { if (!quiet) console.log(`[host ${new Date().toISOString().slice(11, 23)}]`, ...a); };

  const g = {
    screen: 'title', selected: 0, difficulty: 'normal',
    raceState: null, raceT0: 0, lap: 1, place: 8, item: null, itemCount: 0, rolling: false, rollEnd: 0,
    nextItemAt: 0, finished: false, finishedAt: 0, auto: true, paused: false, pausedAt: 0,
  };
  const logs = { last: null, edges: [], menus: [], counts: { input: 0, menu: 0, join: 0, leave: 0 } };
  let lastSeq = { i: null, p: null };
  let prevInput = null;
  let socket = null;
  let key = '';
  let info = null;

  const now = () => Date.now() / 1000;

  function raceElapsed() {
    return (g.paused ? g.pausedAt : now()) - g.raceT0;
  }

  function startRace() {
    g.screen = 'race';
    g.raceState = 'intro';
    g.raceT0 = now();
    g.lap = 1; g.place = 8; g.item = null; g.itemCount = 0; g.rolling = false;
    g.finished = false; g.paused = false;
    g.nextItemAt = INTRO_S + COUNTDOWN_S + 2.5;
  }

  function buildState() {
    let race = null;
    if (g.screen === 'race' || g.screen === 'paused') {
      const t = raceElapsed();
      let countdown = 0;
      if (g.auto) {
        if (!g.finished) {
          if (t < INTRO_S) g.raceState = 'intro';
          else if (t < INTRO_S + COUNTDOWN_S) { g.raceState = 'countdown'; countdown = INTRO_S + COUNTDOWN_S - t; }
          else g.raceState = 'racing';
        }
        if (g.raceState === 'racing' && !g.paused) {
          const rt = t - INTRO_S - COUNTDOWN_S;
          const lap = Math.min(LAPS, 1 + Math.floor(rt / LAP_S));
          g.lap = lap;
          g.place = Math.max(1, 8 - Math.floor(rt / 3.5));
          if (!g.item && !g.rolling && t >= g.nextItemAt) { g.rolling = true; g.rollEnd = t + 2; }
          if (g.rolling && t >= g.rollEnd) {
            g.rolling = false;
            g.item = ITEMS[Math.floor(Math.random() * ITEMS.length)];
            g.itemCount = g.item === 'triple_toot' ? 3 : 1;
          }
          if (rt >= LAPS * LAP_S && !g.finished) { g.finished = true; g.finishedAt = t; g.raceState = 'finished'; }
        }
        if (g.finished && g.screen === 'race' && t - g.finishedAt > 3) g.screen = 'results';
      } else if (g.raceState === 'countdown') {
        countdown = Math.max(0, INTRO_S + COUNTDOWN_S - t);
      }
      race = {
        state: g.raceState, lap: g.lap, laps: LAPS, place: g.place, racers: 8,
        item: g.item, itemCount: g.itemCount, rolling: g.rolling,
        countdown: Math.round(countdown * 100) / 100, finished: g.finished,
      };
    }
    let results = null;
    if (g.screen === 'results') {
      // The player finishes 3rd; the last racer did not finish (estimated time).
      const order = characters.map((_, i) => i).filter((i) => i !== g.selected);
      order.splice(2, 0, g.selected);
      results = order.map((ci, k) => ({
        name: characters[ci].name, cssColor: characters[ci].cssColor, place: k + 1,
        time: 98.512 + k * 1.731, isPlayer: ci === g.selected, finished: k < 7,
      }));
    }
    return { screen: g.screen, characters, selected: g.selected, difficulty: g.difficulty, race, results };
  }

  function sendState() {
    if (socket && socket.connected) socket.emit('host:state', buildState());
  }

  function onMenu(m) {
    logs.menus.push({ ...m, at: Date.now() });
    logs.counts.menu++;
    log('menu', JSON.stringify(m));
    switch (m.action) {
      case 'start': g.screen = 'select'; break;
      case 'select': g.selected = Math.max(0, Math.min(characters.length - 1, m.index | 0)); break;
      case 'difficulty': g.difficulty = m.value; break;
      case 'go': case 'again': case 'restart': g.auto = true; startRace(); break;
      case 'pause': if (g.screen === 'race') { g.screen = 'paused'; g.paused = true; g.pausedAt = now(); } break;
      case 'resume':
        if (g.screen === 'paused') { g.raceT0 += now() - g.pausedAt; g.paused = false; g.screen = 'race'; }
        break;
      case 'quit': g.screen = 'title'; g.raceState = null; break;
      case 'menu': g.screen = 'select'; g.raceState = null; break;
      default: break;
    }
    sendState();
  }

  function onInput(p) {
    logs.counts.input++;
    logs.last = { ...p, at: Date.now() };
    const prev = prevInput;
    prevInput = p;
    if (lastSeq.p !== null && p.p > lastSeq.p && g.screen === 'race') onMenu({ action: 'pause', via: 'pauseSeq' });
    if (lastSeq.i !== null && p.i > lastSeq.i && g.item) {
      g.itemCount--;
      if (g.itemCount <= 0) { g.item = null; g.itemCount = 0; g.nextItemAt = raceElapsed() + 4; }
    }
    lastSeq = { i: p.i, p: p.p };
    if (!prev || prev.g !== p.g || prev.b !== p.b || prev.d !== p.d || prev.i !== p.i || prev.p !== p.p) {
      logs.edges.push({ s: p.s, g: p.g, b: p.b, d: p.d, i: p.i, p: p.p, at: Date.now() });
      if (logs.edges.length > 500) logs.edges.splice(0, 100);
      log('input edge', JSON.stringify(p));
    }
  }

  function connect() {
    return new Promise((resolve, reject) => {
      socket = ioClient(url, { forceNew: true, reconnectionDelay: 300, transports: ['websocket'] });
      const t = setTimeout(() => reject(new Error('host connect timeout')), 8000);
      socket.on('connect', async () => {
        try {
          const res = await socket.timeout(4000).emitWithAck('host:create', { room, key });
          if (!res || !res.room) throw new Error(res?.error || 'host:create failed');
          key = res.key || key;
          info = res;
          log(`room ${res.room} ready (${res.reclaimed ? 'reclaimed' : 'new'}) — pad: ${res.padUrl}`);
          sendState();
          clearTimeout(t);
          resolve(res);
        } catch (err) { clearTimeout(t); reject(err); }
      });
      socket.on('pad:join', (p) => { logs.counts.join++; log('pad:join', p.padId); lastSeq = { i: null, p: null }; prevInput = null; sendState(); });
      socket.on('pad:leave', (p) => { logs.counts.leave++; log('pad:leave', p.padId); });
      socket.on('pad:input', onInput);
      socket.on('pad:menu', onMenu);
    });
  }

  await connect();
  const ticker = setInterval(sendState, 100);   // 10 Hz while running (countdown precision)

  return {
    get info() { return info; },
    logs,
    game: g,
    buildState,
    sendState,
    setScreen(q) {
      const screen = q.screen || g.screen;
      if (screen === 'race' || screen === 'paused') {
        if (!g.raceState || q.race) startRace();
        g.screen = screen;
        if (q.race) {
          g.auto = q.auto !== '0' && q.race === 'auto';
          if (q.race !== 'auto') {
            g.auto = false;
            g.raceState = q.race;
            g.raceT0 = now() - (q.race === 'countdown' ? INTRO_S + 0.2 : 0);
          }
        }
        if (q.auto === '0') g.auto = false;
        if (q.item !== undefined) { g.item = ITEMS.includes(q.item) ? q.item : null; g.itemCount = g.item ? Number(q.count) || (g.item === 'triple_toot' ? 3 : 1) : 0; }
        if (q.rolling !== undefined) g.rolling = q.rolling === '1';
        if (q.place !== undefined) g.place = Number(q.place);
        if (q.lap !== undefined) g.lap = Number(q.lap);
        if (q.finished !== undefined) { g.finished = q.finished === '1'; if (g.finished) g.raceState = 'finished'; }
        g.paused = screen === 'paused';
        if (g.paused) g.pausedAt = now();
      } else {
        g.screen = screen;
        if (screen !== 'results') g.raceState = null;
      }
      if (q.selected !== undefined) g.selected = Number(q.selected);
      if (q.difficulty) g.difficulty = q.difficulty;
      sendState();
      return buildState();
    },
    event(type, data) { socket?.emit('host:event', { type, ...data }); },
    clear() { logs.edges.length = 0; logs.menus.length = 0; logs.last = null; },
    async leave() { socket?.close(); await sleep(50); },
    async join() { socket?.close(); return connect(); },
    async close() { clearInterval(ticker); socket?.close(); },
  };
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
  const host = await startFakeHost({ url: arg('url', 'http://localhost:3100'), room: arg('room', 'PADS') });
  const port = Number(arg('control', 3198));
  http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    let body = { ok: true };
    try {
      if (u.pathname === '/state') body = host.setScreen(q);
      else if (u.pathname === '/log') body = host.logs;
      else if (u.pathname === '/clear') host.clear();
      else if (u.pathname === '/event') {
        if (q.type === 'vibrate') host.event('vibrate', { pattern: String(q.pattern || '40').split(',').map(Number) });
        else host.event(q.type, { text: q.text || '' });
      } else if (u.pathname === '/leave') await host.leave();
      else if (u.pathname === '/join') body = await host.join();
      else { res.writeHead(404); res.end(); return; }
    } catch (err) { body = { ok: false, error: String(err?.message || err) }; }
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  }).listen(port, () => console.log(`[host] control API on http://localhost:${port}`));
  const stop = async () => { await host.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
