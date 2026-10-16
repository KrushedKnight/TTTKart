// Headless race simulation (SPEC §8): the real track, karts, AI, items and
// race rules, no rendering. Runs as fast as possible at dt = 1/120.
//
//   node tools/sim.mjs [--seed 3] [--laps 3] [--difficulty normal] [--player N]
//                      [--all] [--seeds 1-6] [--quiet]
//
//   --player N   use character N from the full roster as "the player" (still
//                AI-driven, skill 0.6), with rubber banding like in the game
//   --all        every seed in --seeds (default 1-6) x easy/normal/hard,
//                one summary row per race + totals, then the fairness check
//   --fairness   only the fairness check: like main.js, the player starts in
//                RACE.playerGridSlot at speedMult 1, driven by an AIDriver at
//                skill 0.85 (the __game.autopilot driver); every character in
//                turn. Normal must be clearly easier than Hard, and Hard must
//                stay winnable (win rate inside FAIR.hardWins).
// Exit code 1 if any kart fails to finish within 300 s, any NaN appears, any
// kart is stuck (speed < 2 m/s while able to drive) for more than 5 s, or the
// fairness check fails.

import { Track } from '../public/js/track.js';
import { Kart, resolveKartCollisions } from '../public/js/kart.js';
import { CHARACTERS } from '../public/js/characters.js';
import { AIDriver, createAIDrivers } from '../public/js/ai.js';
import { ItemSystem } from '../public/js/items.js';
import { Race } from '../public/js/race.js';
import { bus } from '../public/js/bus.js';
import { makeRng } from '../public/js/utils.js';
import { ITEM_IDS, DIFFICULTY, RACE } from '../public/js/config.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);

const DT = 1 / 120;
const MAX_TIME = 400;
const FINISH_LIMIT = 300;
const STUCK_LIMIT = 5;
// fairness check (an AI-quality player vs the CPU field, items on)
const FAIR = {
  seeds: 48,                // races per difficulty, cycling through the full roster
  skill: 0.85,              // player AIDriver skill (= __game.autopilot)
  hardWins: [0.10, 0.40],   // Hard win-rate band: beatable, but not Normal
  normalOverHard: 0.2,      // Normal win rate must beat Hard's by this much
};

const track = new Track();

const f1 = (x) => (x == null || !isFinite(x) ? '  -  ' : x.toFixed(1));
const f2 = (x) => (x == null || !isFinite(x) ? '   -   ' : x.toFixed(2));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

/** Run one race; returns a result record (does not print). */
export function simulate({ seed = 1, laps = 3, difficulty = 'normal', playerIndex = -1, playerSkill = 0.6, playerSlot = -1, playerPersonality = {} } = {}) {
  const rng = makeRng(seed);
  const playerDef = playerIndex >= 0 ? CHARACTERS[playerIndex] : null;
  if (playerIndex >= 0 && !playerDef) throw new RangeError(`Unknown player roster index: ${playerIndex}`);
  // Match main.js: choose a race-sized subset of the full roster, always
  // including the selected player. Seeded shuffling varies the CPU field
  // between races while keeping each seed reproducible.
  const field = shuffle(CHARACTERS.filter((c) => c !== playerDef), rng)
    .slice(0, RACE.racers - (playerDef ? 1 : 0));
  if (playerDef) {
    const slot = playerSlot >= 0
      ? Math.min(playerSlot, RACE.racers - 1)
      : Math.floor(rng() * RACE.racers);
    field.splice(slot, 0, playerDef);
  }
  const karts = field.map((c) => new Kart({ id: c.id, character: c, track, isPlayer: c === playerDef }));
  const player = playerDef ? karts.find((k) => k.character === playerDef) : null;
  karts.forEach((k, slot) => k.placeOnGrid(track.gridSlot(slot)));

  const drivers = createAIDrivers(karts, { track, difficulty, rng: makeRng(seed * 31 + 7), player });
  if (player) drivers.push(new AIDriver(player, { track, difficulty, skill: playerSkill, rng: makeRng(seed * 17 + 3), personality: playerPersonality }));
  const driverOf = new Map(drivers.map((d) => [d.kart, d]));
  const items = new ItemSystem({ track, karts, scene: null, rng: makeRng(seed * 101 + 13) });
  const race = new Race({ track, karts, laps, player });
  const ctx = { karts, items, race, player };

  // ---- stats via the event bus
  const S = new Map(karts.map((k) => [k, {
    items: 0, used: {}, hitsBy: {}, hits: 0, walls: 0, drifts: 0, mt: [0, 0, 0, 0], boxes: 0,
    stuck: 0, maxStuck: 0, respawns: 0, bumps: 0, startBoost: false, stall: false,
  }]));
  const usedTotal = Object.fromEntries(ITEM_IDS.map((id) => [id, 0]));
  const hitTotal = {};
  let leadChanges = 0, overtakes = 0, blocked = 0, explode = 0, zaps = 0;
  const offs = [
    bus.on('item:use', (e) => { const s = S.get(e.kart); s.items++; s.used[e.item] = (s.used[e.item] || 0) + 1; usedTotal[e.item]++; }),
    bus.on('kart:spin', (e) => { const s = S.get(e.kart); s.hits++; s.hitsBy[e.cause] = (s.hitsBy[e.cause] || 0) + 1; hitTotal[e.cause] = (hitTotal[e.cause] || 0) + 1; }),
    bus.on('kart:tumble', (e) => { const s = S.get(e.kart); s.hits++; s.hitsBy[e.cause] = (s.hitsBy[e.cause] || 0) + 1; hitTotal[e.cause] = (hitTotal[e.cause] || 0) + 1; }),
    bus.on('kart:wallHit', (e) => { S.get(e.kart).walls++; }),
    bus.on('kart:driftStart', (e) => { S.get(e.kart).drifts++; }),
    bus.on('kart:driftEnd', (e) => { if (e.tier > 0) S.get(e.kart).mt[e.tier]++; }),
    bus.on('kart:respawn', (e) => { S.get(e.kart).respawns++; }),
    bus.on('kart:bump', (e) => { S.get(e.a).bumps++; }),
    bus.on('item:boxHit', (e) => { S.get(e.kart).boxes++; }),
    bus.on('item:blocked', () => { blocked++; }),
    bus.on('item:explode', (e) => { if (e.hit) explode++; }),
    bus.on('item:zap', () => { zaps++; }),
    bus.on('race:startBoost', (e) => { S.get(e.kart).startBoost = true; }),
    bus.on('race:stall', (e) => { S.get(e.kart).stall = true; }),
  ];

  race.skipIntro();
  let t = 0, nan = false, nanWhat = '';
  let prevLeader = null;
  const prevPlace = new Map();
  const t0 = performance.now();
  // run until every kart is home (with a player, race:over fires resultsDelay
  // after the player finishes; the others keep racing for the table)
  const allHome = () => karts.every((k) => k.finished);
  while (t < MAX_TIME && !(race.over && allHome())) {
    for (const d of drivers) d.update(DT, ctx);
    items.update(DT, race);
    for (const k of karts) k.update(DT);
    resolveKartCollisions(karts);
    race.update(DT);
    t += DT;
    for (const k of karts) {
      const p = k.position, v = k.velocity;
      if (!(isFinite(p.x) && isFinite(p.y) && isFinite(p.z) && isFinite(v.x) && isFinite(v.y) && isFinite(v.z) && isFinite(k.yaw) && isFinite(k.distance))) {
        nan = true; nanWhat = `${k.id} @${t.toFixed(2)}s`;
      }
      const s = S.get(k);
      const able = race.state === 'racing' && !k.frozen && !k.finished && !k.isDisabled();
      if (able && Math.hypot(v.x, v.z) < 2) { s.stuck += DT; if (s.stuck > s.maxStuck) s.maxStuck = s.stuck; }
      else s.stuck = 0;
      if (race.state === 'racing' && !k.finished) {
        const pp = prevPlace.get(k);
        if (pp !== undefined && k.place < pp) overtakes += pp - k.place;
        prevPlace.set(k, k.place);
      }
    }
    if (race.state === 'racing') {
      const leader = race.standings[0];
      if (prevLeader && leader !== prevLeader && !prevLeader.finished && race.time > 3) leadChanges++;
      prevLeader = leader;
    }
    if (nan) break;
  }
  const wall = performance.now() - t0;
  for (const off of offs) off();

  const results = race.getResults(true);
  const rows = results.map((r) => {
    const k = r.kart, s = S.get(k), d = driverOf.get(k);
    return {
      place: r.place, id: k.id, name: k.character.name, isPlayer: k === player, finished: r.finished,
      time: r.time, lapTimes: k.lapTimes.slice(), bestLap: r.bestLap, skill: d ? d.skill : null,
      ...s, maxStuck: Math.max(s.maxStuck, d ? d.maxStuck : 0), respawns: s.respawns,
    };
  });
  const finished = rows.filter((r) => r.finished);
  const allLaps = finished.flatMap((r) => r.lapTimes);
  const flying = finished.flatMap((r) => r.lapTimes.slice(1));
  const avgLap = allLaps.length ? allLaps.reduce((a, b) => a + b, 0) / allLaps.length : NaN;
  const avgFlying = flying.length ? flying.reduce((a, b) => a + b, 0) / flying.length : NaN;
  const spread = finished.length > 1 ? finished[finished.length - 1].time - finished[0].time : NaN;
  const totalWalls = rows.reduce((a, r) => a + r.walls, 0);
  const totalDrifts = rows.reduce((a, r) => a + r.drifts, 0);
  const totalMT = rows.reduce((a, r) => a + r.mt[1] + r.mt[2] + r.mt[3], 0);
  const maxStuck = Math.max(...rows.map((r) => r.maxStuck));
  const failures = [];
  if (nan) failures.push(`NaN (${nanWhat})`);
  for (const r of rows) {
    if (!r.finished || r.time > FINISH_LIMIT) failures.push(`${r.id} did not finish within ${FINISH_LIMIT}s`);
    if (r.maxStuck > STUCK_LIMIT) failures.push(`${r.id} stuck ${r.maxStuck.toFixed(2)}s`);
  }
  items.dispose();
  race.dispose();
  return {
    seed, laps, difficulty, rows, avgLap, avgFlying, spread, usedTotal, hitTotal, leadChanges, overtakes,
    blocked, explode, zaps, totalWalls, wallsPerLap: totalWalls / (karts.length * laps), totalDrifts, totalMT,
    maxStuck, simTime: t, wallMs: wall, failures, ok: failures.length === 0,
  };
}

function hitsStr(h) {
  const keys = ['banana', 'stink', 'bouncer', 'rocket', 'zap', 'star'];
  const abbr = { banana: 'ba', stink: 'st', bouncer: 'bo', rocket: 'ro', zap: 'za', star: 'sr' };
  const parts = keys.filter((k) => h[k]).map((k) => `${abbr[k]}${h[k]}`);
  return parts.join(' ') || '-';
}

function printRace(R) {
  console.log(`\n=== TOOT KART sim: seed ${R.seed}, ${R.laps} laps, ${R.difficulty} — ${R.simTime.toFixed(1)} s simulated in ${(R.wallMs / 1000).toFixed(2)} s ===`);
  const lapHdr = Array.from({ length: R.laps }, (_, i) => lpad(`Lap${i + 1}`, 6)).join(' ');
  console.log(`${pad('Pos', 4)}${pad('Kart', 8)}${lpad('Skill', 5)} ${lpad('Time', 8)} ${lapHdr} ${lpad('Best', 6)}  ${pad('Start', 5)} ${lpad('Box', 3)} ${lpad('Itm', 3)} ${pad('Hits', 24)} ${lpad('Dr', 3)} ${pad('MT 1/2/3', 9)} ${lpad('Wall', 4)} ${lpad('Bump', 4)} ${lpad('Stuck', 5)} ${lpad('Resp', 4)}`);
  for (const r of R.rows) {
    const laps = Array.from({ length: R.laps }, (_, i) => lpad(f2(r.lapTimes[i]), 6)).join(' ');
    const name = r.isPlayer ? `${r.id}*` : r.id;
    const time = r.finished ? f2(r.time) : `~${f1(r.time)}`;
    console.log(`${pad(r.place, 4)}${pad(name, 8)}${lpad(r.skill == null ? '-' : r.skill.toFixed(2), 5)} ${lpad(time, 8)} ${laps} ${lpad(f2(r.bestLap), 6)}  ${pad(r.startBoost ? 'BOOST' : r.stall ? 'STALL' : '-', 5)} ${lpad(r.boxes, 3)} ${lpad(r.items, 3)} ${pad(hitsStr(r.hitsBy), 24)} ${lpad(r.drifts, 3)} ${pad(`${r.mt[1]}/${r.mt[2]}/${r.mt[3]}`, 9)} ${lpad(r.walls, 4)} ${lpad(r.bumps, 4)} ${lpad(r.maxStuck.toFixed(2), 5)} ${lpad(r.respawns, 4)}`);
  }
  console.log(`avg lap ${f2(R.avgLap)} s (flying ${f2(R.avgFlying)} s) | spread winner->last ${f2(R.spread)} s | lead changes ${R.leadChanges} | overtakes ${R.overtakes}`);
  console.log(`items used: ${ITEM_IDS.map((id) => `${id} ${R.usedTotal[id]}`).join(', ')} | blocked ${R.blocked} | rocket hits ${R.explode} | zaps ${R.zaps}`);
  console.log(`hits by cause: ${Object.entries(R.hitTotal).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  console.log(`drifts ${R.totalDrifts}, mini-turbos ${R.totalMT} | wall hits ${R.totalWalls} (${R.wallsPerLap.toFixed(2)} per kart-lap) | max stuck ${R.maxStuck.toFixed(2)} s`);
  console.log(R.ok ? 'RESULT: PASS' : `RESULT: FAIL — ${R.failures.join('; ')}`);
}

/**
 * Player-vs-CPU fairness: `n` races per difficulty, the player (every
 * character in turn) driven by an AIDriver at FAIR.skill from the back of the
 * grid. Returns { ok, lines, stats: { [difficulty]: { wins, n, meanPlace } } }.
 */
export function fairness({ difficulties = ['normal', 'hard'], n = FAIR.seeds, laps = 3 } = {}) {
  const stats = {};
  const lines = [];
  let ok = true;
  for (const difficulty of difficulties) {
    const st = stats[difficulty] = { wins: 0, n: 0, places: 0, meanPlace: 0, hist: new Array(RACE.racers + 1).fill(0), failures: 0 };
    for (let seed = 1; seed <= n; seed++) {
      const R = simulate({
        seed: 1000 + seed, laps, difficulty, playerIndex: (seed - 1) % CHARACTERS.length,
        playerSkill: FAIR.skill, playerSlot: RACE.playerGridSlot, playerPersonality: { aggression: 0.5 },
      });
      if (!R.ok) { st.failures++; ok = false; lines.push(`  ${difficulty} seed ${1000 + seed}: FAIL ${R.failures.join('; ')}`); }
      const me = R.rows.find((r) => r.isPlayer);
      st.n++; st.places += me.place; st.hist[me.place]++;
      if (me.place === 1) st.wins++;
    }
    st.meanPlace = st.places / st.n;
    lines.push(`  ${pad(difficulty, 7)} player wins ${st.wins}/${st.n} (${((100 * st.wins) / st.n).toFixed(0)}%) | mean place ${st.meanPlace.toFixed(2)} | places ${st.hist.slice(1).map((c, i) => `${i + 1}:${c}`).join(' ')}`);
  }
  const rate = (d) => (stats[d] ? stats[d].wins / stats[d].n : NaN);
  if (stats.hard) {
    const r = rate('hard'), [lo, hi] = FAIR.hardWins;
    if (!(r >= lo && r <= hi)) { ok = false; lines.push(`  FAIL: Hard win rate ${(100 * r).toFixed(0)}% outside ${100 * lo}-${100 * hi}% (CPUs too fast / too slow for an AI-quality player)`); }
  }
  if (stats.hard && stats.normal && !(rate('normal') >= rate('hard') + FAIR.normalOverHard)) {
    ok = false;
    lines.push(`  FAIL: Normal win rate ${(100 * rate('normal')).toFixed(0)}% not clearly above Hard's ${(100 * rate('hard')).toFixed(0)}%`);
  }
  return { ok, lines, stats };
}

function printFairness(F) {
  console.log(`
fairness (player = AIDriver skill ${FAIR.skill} from grid slot ${RACE.playerGridSlot}, speedMult 1, items on):`);
  for (const l of F.lines) console.log(l);
  console.log(F.ok ? 'FAIRNESS: PASS' : 'FAIRNESS: FAIL');
}

function parseSeeds(spec) {
  const m = /^(\d+)-(\d+)$/.exec(spec);
  if (m) { const a = +m[1], b = +m[2]; return Array.from({ length: b - a + 1 }, (_, i) => a + i); }
  return spec.split(',').map(Number).filter((x) => x > 0);
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sim.mjs');
if (isMain) {
  const laps = Number(opt('laps', 3));
  const playerIndex = args.includes('--player') ? Number(opt('player', 0)) : -1;
  if (flag('all')) {
    const seeds = parseSeeds(opt('seeds', '1-6'));
    const diffs = opt('difficulty', null) ? [opt('difficulty')] : Object.keys(DIFFICULTY);
    let failed = 0;
    const agg = {};
    console.log(`${pad('diff', 7)}${lpad('seed', 4)} ${lpad('avgLap', 7)} ${lpad('flying', 7)} ${lpad('spread', 7)} ${lpad('lead', 4)} ${lpad('ovtk', 4)} ${lpad('items', 5)} ${lpad('hits', 4)} ${lpad('MT', 4)} ${lpad('wall/l', 6)} ${lpad('stuck', 5)} ${lpad('resp', 4)}  result`);
    for (const difficulty of diffs) {
      const a = agg[difficulty] = { lap: [], spread: [], used: Object.fromEntries(ITEM_IDS.map((id) => [id, 0])), hits: {}, mt: 0, drifts: 0, walls: [], stuck: 0, lead: 0, ovt: 0, n: 0 };
      for (const seed of seeds) {
        const R = simulate({ seed, laps, difficulty, playerIndex });
        if (!R.ok) failed++;
        if (flag('verbose')) printRace(R);
        const itemsUsed = Object.values(R.usedTotal).reduce((x, y) => x + y, 0);
        const hits = Object.values(R.hitTotal).reduce((x, y) => x + y, 0);
        const resp = R.rows.reduce((x, r) => x + r.respawns, 0);
        console.log(`${pad(difficulty, 7)}${lpad(seed, 4)} ${lpad(f2(R.avgLap), 7)} ${lpad(f2(R.avgFlying), 7)} ${lpad(f2(R.spread), 7)} ${lpad(R.leadChanges, 4)} ${lpad(R.overtakes, 4)} ${lpad(itemsUsed, 5)} ${lpad(hits, 4)} ${lpad(R.totalMT, 4)} ${lpad(R.wallsPerLap.toFixed(2), 6)} ${lpad(R.maxStuck.toFixed(2), 5)} ${lpad(resp, 4)}  ${R.ok ? 'PASS' : 'FAIL ' + R.failures.join('; ')}`);
        a.lap.push(R.avgLap); a.spread.push(R.spread); a.mt += R.totalMT; a.drifts += R.totalDrifts; a.walls.push(R.wallsPerLap);
        a.stuck = Math.max(a.stuck, R.maxStuck); a.lead += R.leadChanges; a.ovt += R.overtakes; a.n++;
        for (const id of ITEM_IDS) a.used[id] += R.usedTotal[id];
        for (const [c, v] of Object.entries(R.hitTotal)) a.hits[c] = (a.hits[c] || 0) + v;
      }
    }
    const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
    console.log('\nper difficulty (means over seeds):');
    for (const [d, a] of Object.entries(agg)) {
      console.log(`  ${pad(d, 7)} lap ${f2(mean(a.lap))} s | spread ${f2(mean(a.spread))} s (min ${f2(Math.min(...a.spread))}, max ${f2(Math.max(...a.spread))}) | lead changes ${(a.lead / a.n).toFixed(1)} | overtakes ${(a.ovt / a.n).toFixed(1)} | drifts ${(a.drifts / a.n).toFixed(1)}, MTs ${(a.mt / a.n).toFixed(1)} | wall hits/kart-lap ${mean(a.walls).toFixed(2)} | max stuck ${a.stuck.toFixed(2)} s`);
      console.log(`          items/race: ${ITEM_IDS.map((id) => `${id} ${(a.used[id] / a.n).toFixed(1)}`).join(', ')}`);
      console.log(`          hits/race:  ${Object.entries(a.hits).map(([c, v]) => `${c} ${(v / a.n).toFixed(1)}`).join(', ')}`);
    }
    const F = fairness({ laps });
    printFairness(F);
    if (!F.ok) failed++;
    console.log(failed ? `\nOVERALL: FAIL (${failed} race(s) / check(s))` : '\nOVERALL: PASS');
    process.exit(failed ? 1 : 0);
  } else if (flag('fairness')) {
    const F = fairness({ laps, n: Number(opt('seeds-per', FAIR.seeds)) });
    printFairness(F);
    process.exit(F.ok ? 0 : 1);
  } else {
    const R = simulate({ seed: Number(opt('seed', 1)), laps, difficulty: opt('difficulty', 'normal'), playerIndex });
    if (!flag('quiet')) printRace(R);
    process.exit(R.ok ? 0 : 1);
  }
}
