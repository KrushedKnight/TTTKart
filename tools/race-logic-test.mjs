// RACE LOGIC rule tests (node): race.js state machine / laps / places /
// start judge / wrong way / results, items.js rules for every item.
//   node tools/race-logic-test.mjs
import { Track } from '../public/js/track.js';
import { Kart } from '../public/js/kart.js';
import { CHARACTERS } from '../public/js/characters.js';
import { Race } from '../public/js/race.js';
import { ItemSystem, ITEM_TUNE } from '../public/js/items.js';
import { AIDriver } from '../public/js/ai.js';
import { damp, clamp } from '../public/js/utils.js';
import { bus } from '../public/js/bus.js';
import { makeRng } from '../public/js/utils.js';
import { RACE, ITEM, ITEM_IDS, ITEM_TABLE, BOOST, HIT } from '../public/js/config.js';

let fails = 0, passes = 0;
const ok = (c, msg) => { if (c) passes++; else { fails++; console.log('  FAIL:', msg); } };
const section = (t) => console.log(`\n== ${t}`);
const track = new Track();
const L = track.length;
const DT = 1 / 120;

const events = [];
bus.on('*', (data, type) => { if (type.startsWith('race:') || type.startsWith('item:')) events.push({ type, data }); });
const count = (type, pred = () => true) => events.filter((e) => e.type === type && pred(e.data)).length;

function makeKarts(n = 8) {
  const ks = CHARACTERS.slice(0, n).map((c) => new Kart({ id: c.id, character: c, track }));
  ks.forEach((k, i) => k.placeOnGrid(track.gridSlot(i)));
  return ks;
}
// Put a kart at (s, lateral) facing along the track (or backwards), moving at `speed`.
function placeAt(k, s, lat = 0, { back = false, speed = 0 } = {}) {
  track.pointAt(s, lat, k.position);
  const f = track.frameAt(s);
  k.yaw = back ? f.yaw + Math.PI : f.yaw;
  k.velocity.set(Math.sin(k.yaw) * speed, 0, Math.cos(k.yaw) * speed);
  k.hint = -1;
  track.project(k.position, -1, k.proj);
  k.hint = k.proj.index;
}
function step(race, n = 1) { for (let i = 0; i < n; i++) race.update(DT); }

// --------------------------------------------------------------- race
section('race: intro -> countdown -> GO');
{
  events.length = 0;
  const ks = makeKarts();
  const race = new Race({ track, karts: ks, laps: 3, player: ks[7] });
  ok(race.state === 'intro' && ks.every((k) => k.frozen), 'starts in intro with karts frozen');
  ok(ks[0].distance < 0 && ks[0].distance > -12, `pole distance negative (${ks[0].distance.toFixed(2)})`);
  ok(ks.map((k) => k.place).join() === '1,2,3,4,5,6,7,8', `grid places ${ks.map((k) => k.place)}`);
  step(race, 600);
  ok(race.state === 'intro', 'intro does not run until startIntro()');
  race.startIntro();
  ok(count('race:intro') === 1, 'race:intro emitted');
  step(race, Math.round(RACE.introSeconds * 120) + 1);
  ok(race.state === 'countdown', `countdown after intro (${race.state})`);
  // start judge inputs: k0 holds inside the window, k1 holds from the start (stall),
  // k2 presses at 1.0 s before GO (nothing), k3 presses 0.15 s before GO (nothing),
  // k4 presses early, releases, re-presses in the window (boost)
  const pressAt = (k, from, to = 99) => ({ k, from, to });
  const plan = [pressAt(ks[0], 0.6), pressAt(ks[1], 9), pressAt(ks[2], 1.0), pressAt(ks[3], 0.15)];
  let guard = 0;
  while (race.state === 'countdown' && guard++ < 1000) {
    const cd = race.countdown;
    for (const p of plan) p.k.input.throttle = cd <= p.from ? 1 : 0;
    ks[4].input.throttle = (cd <= 2.5 && cd > 1.9) || cd <= 0.5 ? 1 : 0;
    step(race);
  }
  const beats = events.filter((e) => e.type === 'race:countdown').map((e) => e.data.n).join();
  ok(beats === '3,2,1', `countdown beats ${beats}`);
  ok(race.state === 'racing' && count('race:go') === 1, 'GO -> racing');
  ok(ks.every((k) => !k.frozen), 'karts unfrozen at GO');
  ok(ks[0].boostTimer > 0 && count('race:startBoost', (d) => d.kart === ks[0]) === 1, 'start boost for a press inside the window');
  ok(ks[1].stallTimer > 0 && count('race:stall', (d) => d.kart === ks[1]) === 1, 'stall for holding since the countdown start');
  ok(ks[2].boostTimer === 0 && ks[2].stallTimer === 0, 'press 1.0 s before GO: nothing');
  ok(ks[3].boostTimer === 0 && ks[3].stallTimer === 0, 'press 0.15 s before GO: nothing');
  ok(ks[4].boostTimer > 0 && ks[4].stallTimer === 0, 'early tap released, re-pressed in window: boost');
  ok(race.time < 0.02, 'race.time starts at GO');
}

section('race: laps, places, finish, results, over');
{
  events.length = 0;
  const ks = makeKarts(4);
  const race = new Race({ track, karts: ks, laps: 2, player: ks[3] });
  race.skipIntro();
  step(race, 3 * 120 + 2);
  ok(race.state === 'racing', 'racing after skipIntro + 3 s');
  // drive karts forward by teleporting along the track at different speeds
  const sOf = ks.map((k) => k.proj.s);
  const speeds = [30, 29, 20, 28];
  let t = 0;
  let lapEvents = 0, finalLaps = 0;
  const off1 = bus.on('race:lap', () => lapEvents++), off2 = bus.on('race:finalLap', () => finalLaps++);
  while (t < 75 && !race.over) {
    for (let i = 0; i < ks.length; i++) {
      sOf[i] += speeds[i] * DT;
      placeAt(ks[i], sOf[i], 0, { speed: speeds[i] });
    }
    // the player wiggles backwards over the line once early in lap 2
    step(race);
    t += DT;
  }
  off1(); off2();
  const k0 = ks[0];
  ok(k0.finished && k0.lapTimes.length === 2, `leader finished 2 laps (${k0.lapTimes.length})`);
  const expect = (2 * L + 7) / 30;          // pole starts 7 m behind the line
  ok(Math.abs(k0.finishTime - expect) < 0.05, `finish time ${k0.finishTime?.toFixed(3)} ~ ${expect.toFixed(3)}`);
  ok(Math.abs(k0.lapTimes[1] - L / 30) < 0.05, `lap 2 time ${k0.lapTimes[1]?.toFixed(3)} ~ ${(L / 30).toFixed(3)}`);
  ok(lapEvents === 4 && finalLaps === 4, `race:lap x4 (${lapEvents}), finalLap x4 (${finalLaps})`);
  const order = race.finishOrder.map((k) => k.id).join();
  ok(order === `${ks[0].id},${ks[1].id},${ks[3].id}`, `finish order ${order}`);
  ok(race.playerFinished, 'player finished');
  ok(race.over && count('race:over') === 1, 'race:over once (resultsDelay after the player)');
  const res = race.getResults();
  ok(res.length === 4 && res[3].kart === ks[2] && !res[3].finished && res[3].estimated, 'slow kart last, estimated');
  ok(res[3].time > res[2].time, `estimate after the last finisher (${res[3].time.toFixed(2)} > ${res[2].time.toFixed(2)})`);
  ok(res[0].bestLap > 0 && res[0].place === 1, 'bestLap + place');
  ok(race.getResults() === res, 'results snapshot is stable after race:over');
  ok(count('race:finish') === 3, 'race:finish x3');
  step(race, 120);
  ok(count('race:over') === 1, 'race:over not repeated');
}

section('race: no lap credit for wiggling over the line; position change; wrong way');
{
  events.length = 0;
  const ks = makeKarts(2);
  const race = new Race({ track, karts: ks, laps: 3, player: ks[1] });
  race.skipIntro();
  step(race, 361);
  const p = ks[1], other = ks[0];
  let s = p.proj.s;
  // cross the line forward, then back and forth 3 times
  for (const target of [5, -5, 5, -5, 5]) {
    const dir = Math.sign(track.deltaS(s, target));
    while (Math.abs(track.deltaS(s, target)) > 0.3) { s += dir * 0.25; placeAt(p, s, 2, { speed: 10 }); placeAt(other, -2, -2); step(race); }
  }
  ok(p.lapTimes.length === 0 && p.lap === 1, `no lap credit (laps done ${p.lapTimes.length}, lap ${p.lap})`);
  // player overtakes the other kart -> race:positionChange
  placeAt(other, 40, -3); step(race);
  const toFirst = (d) => d.kart === p && d.to === 1 && d.from === 2;
  const before = count('race:positionChange', toFirst);
  ok(p.place === 2, `player 2nd before the pass (${p.place})`);
  placeAt(p, 60, 3); step(race);
  ok(count('race:positionChange', toFirst) === before + 1, 'positionChange emitted for the player');
  // wrong way: face backwards and move for > wrongWayDelay
  let ss = 60;
  for (let i = 0; i < 150; i++) { ss -= 8 * DT; placeAt(p, ss, 3, { back: true, speed: 8 }); step(race); }
  ok(p.wrongWay && count('race:wrongWay', (d) => d.on) === 1, 'wrong way ON after delay');
  for (let i = 0; i < 10; i++) { ss += 8 * DT; placeAt(p, ss, 3, { speed: 8 }); step(race); }
  ok(!p.wrongWay && count('race:wrongWay', (d) => !d.on) === 1, 'wrong way OFF when facing forward');
}

section('race: photo finish is decided by crossing time, not kart order');
{
  // ks[1] crosses 0.1 m (3.3 ms) before ks[0], inside the same 1/120 s substep
  events.length = 0;
  const ks = makeKarts(2);
  const race = new Race({ track, karts: ks, laps: 1, player: ks[1] });
  race.skipIntro();
  step(race, 361);
  const v = 30;
  let s1 = L - 20 + 0.22, s0 = s1 - 0.1;                      // 1-lap race, ~20 m to go
  ks[1].distance = s1; ks[0].distance = s0;
  race._st.get(ks[1]).prevS = track.wrapS(s1); race._st.get(ks[0]).prevS = track.wrapS(s0);
  placeAt(ks[1], s1, 2, { speed: v }); placeAt(ks[0], s0, -2, { speed: v });
  const steps = [];
  const off = bus.on('race:finish', (e) => steps.push({ kart: e.kart, place: e.place, time: e.time, at: race.elapsed }));
  for (let i = 0; i < 200 && steps.length < 2; i++) {
    s1 += v * DT; s0 += v * DT;
    placeAt(ks[1], s1, 2, { speed: v }); placeAt(ks[0], s0, -2, { speed: v });
    step(race);
  }
  off();
  ok(steps.length === 2 && steps[0].at === steps[1].at, 'both karts finish in the same substep (test setup)');
  ok(ks[1].place === 1 && ks[0].place === 2 && race.finishOrder[0] === ks[1], `earlier crossing wins (places ${ks[1].place}/${ks[0].place})`);
  ok(ks[1].finishTime < ks[0].finishTime && steps[0].kart === ks[1] && steps[0].place === 1, 'race:finish in crossing order with the faster time first');
  const res = race.getResults(true);
  ok(res[0].kart === ks[1] && res[0].time < res[1].time, 'results: 1st has the faster time');
}

// --------------------------------------------------------------- items
function itemSetup(n = 4) {
  const ks = makeKarts(n);
  const race = new Race({ track, karts: ks, laps: 3 });
  race.skipIntro();
  step(race, 361);
  const items = new ItemSystem({ track, karts: ks, scene: null, rng: makeRng(5) });
  return { ks, race, items };
}
// After teleporting karts with placeAt: make race distances = their s on lap 1.
function syncDistances(race, ks) { race.update(DT); for (const k of ks) k.distance = k.proj.s; race.update(DT); }
// Move every kart out of the way (500 m + 30 m each), keeping race distances valid.
function park(ks, race) { ks.forEach((k, i) => driveTo(race, k, 500 + i * 30, 0)); }
// Walk a kart to arc length s in small steps so race.js can follow its distance.
function driveTo(race, k, s, lat = 0) {
  let cur = k.proj.s;
  for (let g = 0; g < 100 && Math.abs(track.deltaS(cur, s)) > 0.01; g++) {
    const d = track.deltaS(cur, s);
    cur += Math.sign(d) * Math.min(Math.abs(d), 40);
    placeAt(k, cur, lat);
    race.update(DT);
  }
}
// one full substep the way main.js does it (no AI)
function tick(items, race, ks, n = 1) {
  for (let i = 0; i < n; i++) { items.update(DT, race); for (const k of ks) k.update(DT); race.update(DT); }
}

section('items: boxes + roulette');
{
  events.length = 0;
  const { ks, race, items } = itemSetup();
  park(ks, race);
  const k = ks[0];
  const box = items.boxes[0];
  ok(items.boxes.length === track.itemBoxes.length && Math.abs(box.position.y - track.itemBoxes[0].position.y - 1.1) < 1e-6, 'boxes 1.1 m above the road');
  k.position.copy(box.position); k.position.y -= 1.1; k.velocity.set(0, 0, 0);
  items.update(DT, race);
  ok(!box.active && count('item:boxHit') === 1 && count('item:rollStart') === 1, 'box broken, roulette started');
  ok(k.rolling && Math.abs(k.rollTimer - ITEM.aiRouletteSeconds) < 0.02 && ITEM_IDS.includes(k.rollItem), 'CPU roll time + rollItem decided');
  const rolled = k.rollItem;
  k.input.useItem = true;
  items.update(DT, race);
  ok(k.rollTimer <= ITEM_TUNE.rollShortenTo && !k.input.useItem, 'item press shortens the roll, pulse consumed');
  for (let i = 0; i < 40; i++) items.update(DT, race);
  ok(!k.rolling && k.item === rolled && count('item:get') === 1, `item assigned at roll end (${k.item})`);
  // second box while holding: breaks, no roll
  const box2 = items.boxes[1];
  k.position.copy(box2.position); k.position.y -= 1.1;
  items.update(DT, race);
  ok(!box2.active && !k.rolling && count('item:rollStart') === 1, 'holding an item: box breaks, no roulette');
  placeAt(k, 600, 0);
  for (let i = 0; i < Math.ceil(ITEM.boxRespawn * 120) + 2; i++) items.update(DT, race);
  ok(box.active && box2.active, 'boxes respawn');
  // player roll time
  const pk = ks[1]; pk.isPlayer = true; park(ks, race); pk.position.copy(items.boxes[3].position); pk.position.y -= 1.1;
  items.update(DT, race);
  ok(pk.rolling && Math.abs(pk.rollTimer - ITEM.rouletteSeconds) < 0.02, 'player roll time');
  // roulette table: 1st never gets star / zap / triple; 8th never banana / stink
  const rng = makeRng(9);
  const it8 = new ItemSystem({ track, karts: makeKarts(8), scene: null, rng });
  const got = { 1: new Set(), 8: new Set() };
  for (let i = 0; i < 4000; i++) { got[1].add(it8.rollFor(ks[0], 1)); it8.time += 20; got[8].add(it8.rollFor(ks[0], 8)); }
  ok(!got[1].has('star') && !got[1].has('zap') && !got[1].has('triple_toot'), `1st place items ${[...got[1]]}`);
  ok(!got[8].has('banana') && !got[8].has('stink') && got[8].has('star'), `8th place items ${[...got[8]]}`);
  ok(ITEM_TABLE.length === 8, 'table rows');
}

section('items: banana, stink');
{
  events.length = 0;
  const { ks, race, items } = itemSetup();
  park(ks, race);
  const [a, b, c] = ks;
  placeAt(a, 100, 0, { speed: 0 });
  a.item = 'banana'; a.itemCount = 1;
  a.input.useItem = true;
  items.update(DT, race);
  const h = items.hazards[0];
  ok(h && h.type === 'banana' && !a.item && count('item:use') === 1, 'banana dropped, slot emptied');
  ok(Math.abs(track.deltaS(h.s, 100) - ITEM_TUNE.bananaBack) < 0.1 && Math.abs(h.position.y - h.proj.height) < 1e-6, `2.2 m behind, on the road (${track.deltaS(h.s, 100).toFixed(2)})`);
  // the owner backing over it right away: grace; later it would hit
  placeAt(a, h.s, h.lateral); items.update(DT, race);
  ok(items.hazards.length === 1 && a.spinTimer === 0, 'owner grace');
  placeAt(a, 300, 0);
  placeAt(b, h.s, h.lateral, { speed: 20 }); items.update(DT, race);
  ok(b.spinTimer > 0 && items.hazards.length === 0 && count('item:hit', (d) => d.kart === b && d.item === 'banana') === 1, 'banana spins the victim and disappears');
  // disabled karts cannot use items
  b.item = 'toot'; b.itemCount = 1; b.input.useItem = true; items.update(DT, race);
  ok(b.item === 'toot' && !b.input.useItem, 'use ignored while spinning (pulse consumed)');
  // stink: owner immune for 1 s, spins each kart once, slows
  b.spinTimer = 0; b.invulnTimer = 0;
  placeAt(c, 200, 0); c.item = 'stink'; c.itemCount = 1; items.useItem(c);
  const cloud = items.hazards.find((x) => x.type === 'stink');
  ok(cloud && Math.abs(cloud.radius - ITEM.stinkRadius) < 1e-6 && cloud.life === ITEM.stinkLife, 'stink cloud radius/life');
  placeAt(c, cloud.s, cloud.lateral); items.update(DT, race);
  ok(c.spinTimer === 0, 'stink owner immune at first');
  placeAt(c, 400, 0);
  for (let i = 0; i < 70; i++) items.update(DT, race);     // let it billow out
  placeAt(b, cloud.s, cloud.lateral + 2.5, { speed: 20 });
  const v0 = b.velocity.length();
  items.update(DT, race);
  ok(b.spinTimer > 0 && b.velocity.length() < v0, 'stink spins + slows an entering kart');
  b.spinTimer = 0; b.invulnTimer = 0;
  items.update(DT, race);
  ok(b.spinTimer === 0, 'only once per cloud per kart');
  for (let i = 0; i < ITEM.stinkLife * 120; i++) items.update(DT, race);
  ok(!items.hazards.includes(cloud), 'stink expires');
}

section('items: bouncer, rocket, blocking');
{
  events.length = 0;
  const { ks, race, items } = itemSetup();
  park(ks, race);
  const [a, b, c] = ks;
  // bouncer: launched at max(speed, kart+20), hits a kart ahead with a tumble
  placeAt(a, 20, 0, { speed: 25 });
  placeAt(b, 50, 0);
  a.item = 'bouncer'; a.itemCount = 1; items.useItem(a);
  const ball = items.projectiles[0];
  ok(ball && ball.type === 'bouncer' && Math.abs(ball.speed - Math.max(ITEM.bouncerSpeed, 45)) < 0.6, `bouncer speed ${ball && ball.speed.toFixed(1)}`);
  for (let i = 0; i < 120 && items.projectiles.length; i++) items.update(DT, race);
  ok(b.tumbleTimer > 0 && count('item:hit', (d) => d.kart === b && d.item === 'bouncer' && d.by === a) === 1, 'bouncer tumbles the kart ahead');
  // bouncer bounces off walls (aim it across the road) and dies after max bounces / life
  park(ks, race);
  placeAt(a, 30, 0); a.yaw += 1.2; a.item = 'bouncer'; a.itemCount = 1; items.useItem(a);
  let bounces = 0; const offB = bus.on('item:bounce', () => bounces++);
  let life = 0;
  while (items.projectiles.length && life < 10) { items.update(DT, race); life += DT; }
  offB();
  ok(bounces >= 2 && bounces <= ITEM.bouncerMaxBounces && life <= ITEM.bouncerLife + 0.05, `bounced ${bounces}x, gone after ${life.toFixed(2)} s`);
  // rocket: c is 3rd, b 2nd -> targets b and hits it even with a lateral offset
  placeAt(ks[3], 30); placeAt(c, 100, -5); placeAt(b, 180, 5); placeAt(a, 600);
  b.tumbleTimer = 0; b.invulnTimer = 0; b.velocity.set(0, 0, 0);
  syncDistances(race, ks);
  ok(race.getPlace(b) === 2 && race.getPlace(c) === 3, 'places for the rocket test');
  c.item = 'rocket'; c.itemCount = 1; items.useItem(c);
  const r = items.projectiles[0];
  ok(r && r.type === 'rocket' && r.target === b && r.mode === 'track', 'rocket locks on the kart one place ahead');
  let sawHome = false;
  for (let i = 0; i < 400 && items.projectiles.length; i++) { items.update(DT, race); if (r.mode === 'home') sawHome = true; }
  ok(sawHome && b.tumbleTimer > 0 && count('item:explode', (d) => d.hit && d.kart === b) === 1 && count('item:hit', (d) => d.kart === b && d.item === 'rocket') === 1, 'rocket homes in + tumbles + explodes');
  // leader's rocket flies straight
  placeAt(a, 700); syncDistances(race, ks);
  a.item = 'rocket'; a.itemCount = 1; items.useItem(a);
  ok(items.projectiles[0].mode === 'straight' && !items.projectiles[0].target, 'rocket from 1st flies straight');
  items.clear();
  // projectile vs banana -> item:blocked
  park(ks, race);
  placeAt(b, 72.2, 0); b.item = 'banana'; b.itemCount = 1; items.useItem(b); placeAt(b, 900, 0);
  placeAt(a, 30, items.hazards[0].lateral, { speed: 0 });
  a.item = 'bouncer'; a.itemCount = 1; items.useItem(a);
  for (let i = 0; i < 120 && items.projectiles.length; i++) items.update(DT, race);
  ok(items.hazards.length === 0 && count('item:blocked', (d) => d.kart === a) === 1, 'bouncer clears a banana (item:blocked)');
}

section('items: point-blank rocket (target right alongside), owner immunity');
{
  // shooter 2nd, target 1st just ahead + to the side, both at 27 m/s on the
  // start straight; after firing the shooter keeps its lane or tucks in 6 m
  // behind the target: the rocket must connect at once, never loop back
  const cases = [[0, 2.4, false], [0.5, 3, false], [1, 4, false], [1.5, 5, false], [0, 2.4, true], [0.5, 3, true], [1, 2.5, true], [1.5, 4, true]];
  let prompt = 0, selfHits = 0;
  const bad = [];
  for (const [gap, dl, tuck] of cases) {
    const ks = makeKarts(2);
    const [tgt, sh] = ks;
    const race = new Race({ track, karts: ks, laps: 3, player: sh });
    race.skipIntro();
    step(race, 361);
    const items = new ItemSystem({ track, karts: ks, scene: null, rng: makeRng(3) });
    const v = 27;
    let sS = 10, sT = 10 + gap, latS = -dl / 2;
    const latT = dl / 2;
    placeAt(sh, sS, latS, { speed: v }); placeAt(tgt, sT, latT, { speed: v });
    for (const k of ks) k.frozen = false;
    race.update(DT);
    sh.item = 'rocket'; sh.itemCount = 1; sh.input.useItem = true;
    let hit = null, t = 0;
    const off = bus.on('item:hit', (e) => { if (e.projectile && !hit) hit = { kart: e.kart, t }; });
    while (t < 3 && !hit) {
      items.update(DT, race);
      sT += v * DT;
      if (tuck) { latS = damp(latS, latT, 3, DT); sS += (v + clamp((sT - 6 - sS) * 1.5, -6, 6)) * DT; } else sS += v * DT;
      placeAt(tgt, sT, latT, { speed: v }); placeAt(sh, sS, latS, { speed: v });
      race.update(DT);
      t += DT;
    }
    off();
    if (hit && hit.kart === sh) selfHits++;
    if (hit && hit.kart === tgt && hit.t < 0.35) prompt++;
    else bad.push(`gap ${gap} lat ${dl}${tuck ? ' tuck' : ''}: ${hit ? `${hit.kart === sh ? 'SHOOTER' : 'target'} @${hit.t.toFixed(2)}s` : 'miss'}`);
    items.dispose();
  }
  ok(selfHits === 0, `no rocket self-hits at point-blank range (${selfHits})`);
  ok(prompt === cases.length, `point-blank rocket hits the target within 0.35 s (${prompt}/${cases.length}) ${bad.join('; ')}`);
  // a rocket locked on a target flies through its own shooter harmlessly
  {
    const { ks, race, items } = itemSetup(3);
    park(ks, race);
    const [a, b] = ks;
    placeAt(a, 300, 0); placeAt(b, 200, 0);
    syncDistances(race, ks);
    b.item = 'rocket'; b.itemCount = 1; items.useItem(b);
    const r = items.projectiles[0];
    for (let i = 0; i < Math.ceil((ITEM.shooterGrace + 0.1) * 120); i++) items.update(DT, race);
    ok(r.active && r.mode === 'track' && r.target === a, 'rocket still tracking after the shooter grace');
    b.position.copy(r.position); b.position.y -= 0.6; b.invulnTimer = 0;
    items.update(DT, race);
    ok(r.active && b.tumbleTimer === 0, 'locked-on rocket ignores its shooter after the grace period');
    ok(!items.getThreatsNear(b, 40).some((x) => x.ref === r), 'shooter does not dodge its own locked-on rocket (threats)');
    items.dispose();
  }
}

section('items: toot, triple toot, star, zap, threats, clear');
{
  events.length = 0;
  const { ks, race, items } = itemSetup();
  park(ks, race);
  const [a, b, c, d] = ks;
  a.item = 'toot'; a.itemCount = 1; items.useItem(a);
  ok(Math.abs(a.boostTimer - BOOST.tootDuration) < 1e-6 && !a.item, 'toot boost');
  a.boostTimer = 0;
  a.item = 'triple_toot'; a.itemCount = 3;
  items.useItem(a); ok(a.item === 'triple_toot' && a.itemCount === 2, 'triple toot keeps the slot (2 left)');
  items.useItem(a); items.useItem(a);
  ok(!a.item && a.itemCount === 0 && count('item:use', (e) => e.item === 'triple_toot') === 3, 'triple toot: 3 uses');
  b.item = 'star'; b.itemCount = 1; items.useItem(b);
  ok(b.starTimer > 0 && b.isInvincible(), 'star');
  // zap from 4th: 1st..3rd zapped except the starred one
  placeAt(d, 500); placeAt(a, 600); placeAt(b, 700); placeAt(c, 800);
  syncDistances(race, ks);
  ok(race.getPlace(d) === 4, 'zap user is 4th');
  d.item = 'zap'; d.itemCount = 1; items.useItem(d);
  ok(c.slowTimer > 0 && a.slowTimer > 0 && b.slowTimer === 0 && d.slowTimer === 0, 'zap hits better-placed, not starred, not the user');
  ok(count('item:zap', (e) => e.kart === d) === 1 && count('item:hit', (e) => e.item === 'zap') === 2, 'item:zap + item:hit per victim');
  ok(count('item:zap', (e) => Array.isArray(e.victims) && e.victims.length === 2 && e.victims.includes(a) && e.victims.includes(c) && e.count === 2) === 1,
    'item:zap lists its victims (main.js shows ZAPPED! when the player is one)');
  ok(Math.abs(c.maxSpeed - c.stats.topSpeed * HIT.zapSlowMult) < 1e-6 || c.isDisabled(), 'zapped kart slowed');
  // threats
  park(ks, race);
  placeAt(a, 300, 0); a.item = 'banana'; a.itemCount = 1; items.useItem(a);
  placeAt(b, 280, 0);
  const th = items.getThreatsNear(b, 40);
  ok(th.length === 1 && th[0].type === 'banana' && th[0].ahead && Math.abs(th[0].distance - 17.8) < 0.5, `threat ahead (${th.length} ${th[0] && th[0].distance.toFixed(1)})`);
  const th2 = items.getThreatsNear(b, 40);
  ok(th2 === th && th2[0] === th[0], 'threat list is reused (no allocation)');
  items.clear();
  ok(items.hazards.length === 0 && items.projectiles.length === 0 && items.boxes.every((x) => x.active), 'clear()');
  items.dispose();
}

section('ai: no bouncer fired across the lighthouse hairpin');
{
  // a rival straight ahead on our nose line, 26 m away: on the hill straight
  // before the hairpin it is already in the turn (the ball would rebound off
  // the outer wall into us); on a plain straight it is a fair shot
  const ks = makeKarts(2);
  const [me, o] = ks;
  const race = new Race({ track, karts: ks, laps: 3 });
  const ai = new AIDriver(me, { track, difficulty: 'hard', skill: 0.9, rng: makeRng(4) });
  const aimAt = (s0) => {
    placeAt(me, s0, 0, { speed: 25 });
    const f = track.frameAt(s0);
    const pr = track.project({ x: f.x + Math.sin(f.yaw) * 26, y: f.y, z: f.z + Math.cos(f.yaw) * 26 }, -1, {});
    placeAt(o, pr.s, pr.lateral, { speed: 20 });
    return ai._shouldUse('bouncer', { karts: ks, race }, me.proj.s, me.speed);
  };
  const hairpin = track.zones.find((z) => z.type === 'hairpin');
  ok(!aimAt(hairpin.s0 - 12), 'bouncer held when the target is across the hairpin');
  ok(aimAt(320), 'bouncer fired at a kart ahead on a straight');
}

section('ai: never NaN, start timing, recovery from a wall-facing standstill');
{
  const ks = makeKarts(2);
  const race = new Race({ track, karts: ks, laps: 3 });
  const ai = new AIDriver(ks[0], { track, skill: 0.9, rng: makeRng(2) });
  race.skipIntro();
  let pressed = null;
  while (race.state === 'countdown') { ai.update(DT, { karts: ks, race }); if (ks[0].input.throttle > 0 && pressed === null) pressed = race.countdown; race.update(DT); }
  ok(pressed !== null, `AI pressed the throttle during the countdown (${pressed && pressed.toFixed(2)} s before GO)`);
  // park facing the right wall at standstill
  const f = track.frameAt(120);
  placeAt(ks[0], 120, f.wallR - 1.15);
  ks[0].yaw = f.yaw - Math.PI / 2;
  let t = 0, moved = 0; const s0 = ks[0].distance;
  while (t < 9) { ai.update(DT, { karts: ks, race }); ks[0].update(DT); race.update(DT); t += DT; }
  moved = ks[0].distance - s0;
  ok(moved > 60, `AI recovered from facing the wall (moved ${moved.toFixed(1)} m in 9 s, respawns ${ai.respawns})`);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
