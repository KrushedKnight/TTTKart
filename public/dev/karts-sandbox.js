// KARTS sandbox (dev only) — served at /dev/karts.html by tools/devserver.mjs.
//
//   ?mode=lineup [&view=front|three|side|back] [&grid=1]
//        all 8 characters side by side (grid=1: 4x2 close portraits)
//   ?mode=closeup [&char=blaze] [&front=1] [&speed=0]
//        one kart at chase-camera distance (front=1: look-back camera = face view)
//   ?mode=drive [&scenario=race|pack] [&s=50] [&follow=0] [&intro=1] [&stopAt=2.5]
//        [&boostAt=t] [&starAt=t] [&spinAt=t] [&tumbleAt=t] [&zapAt=t] [&lat=x] [&nodrift=1]
//        debug ribbon of the real track, 8 autopiloted karts, ChaseCamera on kart `follow`.
//        stopAt freezes the simulation at that sim time (rendering continues), and
//        fast-forwards there, so screenshots are deterministic.
//
// Simulation is fixed-step: every rendered frame advances 1/60 s (2 substeps).
// Debug handle: window.__karts (scene, renderer, karts, views, effects, chase, stats()).

import * as THREE from 'three';
import { Track, CURB_WIDTH } from '../js/track.js';
import { Kart, resolveKartCollisions } from '../js/kart.js';
import { CHARACTERS, getCharacter, buildKartModel } from '../js/characters.js';
import { KartView } from '../js/kartview.js';
import { Effects } from '../js/effects.js';
import { ChaseCamera } from '../js/camera.js';
import { RACE } from '../js/config.js';
import { Autopilot } from './karts-autopilot.js';

const Q = new URLSearchParams(location.search);
const MODE = Q.get('mode') || 'drive';
const num = (k, d) => (Q.has(k) && Q.get(k) !== '' ? Number(Q.get(k)) : d);
const FRAME_DT = 1 / 60;
const SUBSTEPS = 2;

// ------------------------------------------------------------ renderer/scene

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd3f5);
scene.fog = new THREE.Fog(0xcfeafb, 220, 1650);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 2000);

// Lights roughly matching world.js (hemi + one shadow-casting sun).
const hemi = new THREE.HemisphereLight(0xd7ecff, 0x7d9a55, 1.35);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dc, 2.7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 200 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.035;
sun.shadow.radius = 2.2;
scene.add(sun, sun.target);
const SUN_OFFSET = new THREE.Vector3(-38, 70, -26);
function sunFollow(p) {
  sun.position.copy(p).add(SUN_OFFSET);
  sun.target.position.copy(p);
}

const hud = document.getElementById('hud');
const labelsRoot = document.getElementById('labels');

window.addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ------------------------------------------------------------ debug track

// Vertex-colored ribbon of the real track: road (incl. kicker ramp height),
// red/white curbs, banded grass to the walls, wall strips with skirts down to
// the ground, boost pads and a checkered start line. Plus a ground plane and
// instanced cone "trees" for depth cues. ~5 draw calls.
function buildDebugTrack(track) {
  const group = new THREE.Group();
  group.name = 'debug-track';
  const pos = [], col = [];
  const c = new THREE.Color();
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3(), pd = new THREE.Vector3();
  const quad = (a, b, cc, d, color) => {
    // a-b at sample i (left->right), d-cc at sample i+1
    c.set(color);
    for (const p of [a, b, cc, a, cc, d]) { pos.push(p.x, p.y, p.z); col.push(c.r, c.g, c.b); }
  };
  const N = track.N, sp = track.spacing;
  for (let i = 0; i < N; i++) {
    const s0 = i * sp, s1 = (i + 1) * sp;
    const j = (i + 1) % N;
    const stripe = Math.floor(s0 / 10) % 2 === 0;
    const curbRed = Math.floor(s0 / 2) % 2 === 0;
    const grass = stripe ? 0x5cbc43 : 0x4fae3a;
    // grass left / right (flat at center height)
    const gl0 = -track.wl[i], gl1 = -(track.hw[i] + CURB_WIDTH);
    const gl0n = -track.wl[j], gl1n = -(track.hw[j] + CURB_WIDTH);
    quad(track.pointAt(s0, gl1, pa), track.pointAt(s0, gl0, pb), track.pointAt(s1, gl0n, pc), track.pointAt(s1, gl1n, pd), grass);
    quad(track.pointAt(s0, track.wr[i], pa), track.pointAt(s0, track.hw[i] + CURB_WIDTH, pb), track.pointAt(s1, track.hw[j] + CURB_WIDTH, pc), track.pointAt(s1, track.wr[j], pd), grass);
    // curbs
    const curb = curbRed ? 0xe5302a : 0xf7f6f2;
    quad(track.pointAt(s0, -(track.hw[i] + 0.001), pa), track.pointAt(s0, -(track.hw[i] + CURB_WIDTH), pb), track.pointAt(s1, -(track.hw[j] + CURB_WIDTH), pc), track.pointAt(s1, -(track.hw[j] + 0.001), pd), curb);
    quad(track.pointAt(s0, track.hw[i] + CURB_WIDTH, pa), track.pointAt(s0, track.hw[i] + 0.001, pb), track.pointAt(s1, track.hw[j] + 0.001, pc), track.pointAt(s1, track.hw[j] + CURB_WIDTH, pd), curb);
    // road in 4 lanes (center dashes)
    const lanes = [-1, -0.04, 0.04, 1];
    for (let l = 0; l < 3; l++) {
      const la = lanes[l], lb = lanes[l + 1];
      const color = l === 1 ? (Math.floor(s0 / 4) % 2 === 0 ? 0xf2f2f2 : 0x5a5d66) : (stripe ? 0x5a5d66 : 0x555861);
      quad(track.pointAt(s0, lb * track.hw[i], pa), track.pointAt(s0, la * track.hw[i], pb), track.pointAt(s1, la * track.hw[j], pc), track.pointAt(s1, lb * track.hw[j], pd), color);
    }
  }
  // boost pads (slightly above the road)
  for (const p of track.boostPads) {
    for (let x = 0; x < p.length; x += 1) {
      const s0 = p.s0 + x, s1 = Math.min(p.s1, s0 + 1);
      const lift = (v) => { v.y += 0.03; return v; };
      quad(lift(track.pointAt(s0, p.lat1, pa)), lift(track.pointAt(s0, p.lat0, pb)), lift(track.pointAt(s1, p.lat0, pc)), lift(track.pointAt(s1, p.lat1, pd)), x % 2 ? 0xffb21f : 0xff6a1a);
    }
  }
  // start line checkers
  {
    const hw = track.hw[0];
    const cells = 16;
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < cells; k++) {
        const la = -hw + (2 * hw * k) / cells, lb = -hw + (2 * hw * (k + 1)) / cells;
        const s0 = r * 0.8 - 0.8, s1 = s0 + 0.8;
        const lift = (v) => { v.y += 0.02; return v; };
        quad(lift(track.pointAt(s0, lb, pa)), lift(track.pointAt(s0, la, pb)), lift(track.pointAt(s1, la, pc)), lift(track.pointAt(s1, lb, pd)), (k + r) % 2 ? 0x111111 : 0xffffff);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  const ribbon = new THREE.Mesh(geo, mat);
  ribbon.receiveShadow = true;
  ribbon.name = 'ribbon';
  group.add(ribbon);

  // walls + skirts down to the ground (shows elevation)
  const wp = [], wc = [];
  const ground = track.bounds.minY - 1.5;
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const s0 = i * sp, s1 = (i + 1) * sp;
      const l0 = side > 0 ? track.wr[i] : -track.wl[i];
      const l1 = side > 0 ? track.wr[j] : -track.wl[j];
      track.pointAt(s0, l0, pa); track.pointAt(s1, l1, pb);
      const top0 = pa.y + 0.9, top1 = pb.y + 0.9;
      const band = Math.floor(s0 / 4) % 2 === 0;
      c.set(band ? 0xf05a28 : 0xf7f6f2);
      const verts = [[pa.x, top0, pa.z], [pa.x, ground, pa.z], [pb.x, ground, pb.z], [pa.x, top0, pa.z], [pb.x, ground, pb.z], [pb.x, top1, pb.z]];
      for (const v of verts) { wp.push(...v); wc.push(c.r, c.g, c.b); }
    }
  }
  const wgeo = new THREE.BufferGeometry();
  wgeo.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
  wgeo.setAttribute('color', new THREE.Float32BufferAttribute(wc, 3));
  wgeo.computeVertexNormals();
  const walls = new THREE.Mesh(wgeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
  walls.castShadow = true;
  walls.receiveShadow = true;
  walls.name = 'walls';
  group.add(walls);

  // ground plane
  const b = track.bounds;
  const gw = (b.maxX - b.minX) + 600, gd = (b.maxZ - b.minZ) + 600;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(gw, gd), new THREE.MeshStandardMaterial({ color: 0x6fbf55, roughness: 1 }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.set((b.minX + b.maxX) / 2, ground, (b.minZ + b.maxZ) / 2);
  plane.receiveShadow = true;
  group.add(plane);

  // instanced cone trees outside the walls
  const treeGeo = new THREE.ConeGeometry(1.6, 5, 7);
  treeGeo.translate(0, 2.5, 0);
  const trees = new THREE.InstancedMesh(treeGeo, new THREE.MeshStandardMaterial({ color: 0x2f8a46, roughness: 0.9, flatShading: true }), 260);
  const m4 = new THREE.Matrix4();
  let n = 0;
  for (let s = 0; s < track.length && n < trees.count; s += 7.5) {
    const f = track.frameAt(s);
    for (const side of [-1, 1]) {
      if (n >= trees.count) break;
      const wall = side > 0 ? f.wallR : f.wallL;
      const off = wall + 4 + ((s * 7.31) % 9);
      const p = track.pointAt(s, side * off, pa);
      const sc = 0.7 + ((s * 3.7) % 0.6);
      m4.makeScale(sc, sc, sc).setPosition(p.x, ground, p.z);
      trees.setMatrixAt(n++, m4);
    }
  }
  trees.count = n;
  trees.castShadow = true;
  group.add(trees);
  return group;
}

// ------------------------------------------------------------ helpers

const stats = { frames: 0, last: performance.now(), fps: 0 };
function measure(fn) {
  renderer.info.autoReset = false;
  renderer.info.reset();
  fn();
  const r = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  renderer.info.autoReset = true;
  return r;
}

function addLabel(text, sub) {
  const el = document.createElement('div');
  el.className = 'label';
  el.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
  labelsRoot.appendChild(el);
  return el;
}
const _lp = new THREE.Vector3();
function placeLabel(el, worldPos, cam, vp = null) {
  _lp.copy(worldPos).project(cam);
  const W = vp ? vp.w : innerWidth, H = vp ? vp.h : innerHeight;
  const ox = vp ? vp.x : 0, oy = vp ? vp.y : 0;
  el.style.left = `${ox + (_lp.x * 0.5 + 0.5) * W}px`;
  el.style.top = `${oy + (-_lp.y * 0.5 + 0.5) * H}px`;
}

const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

// ------------------------------------------------------------ mode: lineup

function runLineup() {
  const view = Q.get('view') || 'three';
  const grid = Q.get('grid') === '1';
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardMaterial({ color: 0x6cc35a, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(grid ? 70 : 26, 0.04, grid ? 6 : 5), new THREE.MeshStandardMaterial({ color: 0x5a5d66, roughness: 0.9 }));
  pad.position.y = 0.02;
  pad.receiveShadow = true;
  scene.add(pad);

  const spacing = grid ? 8 : 2.75;
  const models = CHARACTERS.map((c, i) => {
    const m = buildKartModel(c);
    m.position.set((i - 3.5) * spacing, 0.04, 0);   // Blaze on the viewer's left
    const yaw = view === 'back' ? Math.PI : view === 'side' ? -Math.PI / 2 : view === 'three' ? 0.55 : 0;
    m.rotation.y = yaw;
    scene.add(m);
    return m;
  });
  sunFollow(new THREE.Vector3(0, 0, 0));
  sun.position.set(-30, 60, 40);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 20, bottom: -20 });
  sun.shadow.camera.updateProjectionMatrix();

  if (!grid) {
    camera.fov = 32;
    camera.position.set(0, 3.2, 21);
    camera.lookAt(0, 0.65, 0);
    camera.updateProjectionMatrix();
    const labels = CHARACTERS.map((c) => addLabel(c.name, `SPD ${c.ratings.speed} ACC ${c.ratings.accel} HND ${c.ratings.handling} WGT ${c.ratings.weight}`));
    const frame = () => {
      models.forEach((m, i) => placeLabel(labels[i], _lp.set(m.position.x, -0.15, m.position.z + 1.2), camera));
      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    };
    frame();
    const info = measure(() => renderer.render(scene, camera));
    console.log(`[karts] lineup draw calls ${info.calls}, triangles ${info.triangles}`);
    return;
  }
  // 4x2 portrait grid: one camera per character
  const cams = models.map(() => new THREE.PerspectiveCamera(30, 1, 0.1, 200));
  const labels = CHARACTERS.map((c) => addLabel(c.name, c.tagline));
  renderer.setScissorTest(true);
  const frame = () => {
    const W = innerWidth, H = innerHeight, cw = W / 4, ch = H / 2;
    models.forEach((m, i) => {
      const cx = i % 4, cy = Math.floor(i / 4);
      const cam = cams[i];
      cam.aspect = cw / ch;
      const ang = view === 'back' ? Math.PI : view === 'side' ? -Math.PI / 2 : 0.5;
      const d = 5.2;
      cam.position.set(m.position.x + Math.sin(ang) * d, 1.75, m.position.z + Math.cos(ang) * d);
      cam.lookAt(m.position.x, 0.72, m.position.z);
      cam.updateProjectionMatrix();
      const x = cx * cw, y = (1 - cy) * ch;
      renderer.setViewport(x, y, cw, ch);
      renderer.setScissor(x, y, cw, ch);
      renderer.render(scene, cam);
      labels[i].style.left = `${x + cw / 2}px`;
      labels[i].style.top = `${cy * ch + ch - 46}px`;
      m.rotation.y = 0;
    });
    requestAnimationFrame(frame);
  };
  frame();
}

// ------------------------------------------------------------ mode: drive / closeup

function runDrive() {
  const track = new Track();
  scene.add(buildDebugTrack(track));
  const effects = new Effects(scene);
  const chase = new ChaseCamera(camera);
  const closeup = MODE === 'closeup';
  const scenario = Q.get('scenario') || (Q.has('s') ? 'pack' : 'race');
  const follow = num('follow', 0);
  const stopAt = num('stopAt', Infinity);

  const chars = closeup ? [getCharacter(Q.get('char') || 'blaze')] : CHARACTERS;
  const karts = chars.map((c, i) => new Kart({ id: c.id, character: c, track, isPlayer: i === follow }));
  const pilots = karts.map((k, i) => new Autopilot(k, {
    drift: Q.get('nodrift') !== '1',
    offset: ((i % 3) - 1) * 2.2 + num('lat', 0),
    throttle: 1,
  }));

  // placement
  if (scenario === 'race') {
    karts.forEach((k, i) => k.placeOnGrid(track.gridSlot(i)));
  } else {
    const s0 = num('s', 50);
    karts.forEach((k, i) => {
      const order = i === follow ? 0 : i < follow ? i + 1 : i;
      const s = track.wrapS(s0 - order * 4.5);
      const f = track.frameAt(s);
      const lat = closeup ? num('lat', 0) : f.racingLine + ((order % 3) - 1) * 2.6 + (order === 0 ? num('lat', 0) : 0);
      k.placeOnGrid({ position: track.pointAt(s, lat), yaw: f.yaw, s, lateral: lat });
      const v = closeup ? num('speed', 0) : k.stats.topSpeed * (order === 0 ? 1 : 0.97);
      k.velocity.set(Math.sin(k.yaw) * v, 0, Math.cos(k.yaw) * v);
    });
  }
  const target = karts[Math.min(follow, karts.length - 1)];
  const views = karts.map((k) => new KartView(k, scene, effects));
  for (const [q, key] of [['camDist', 'distance'], ['camHeight', 'height'], ['camLook', 'lookAhead'], ['camLookH', 'lookHeight'], ['fov', 'baseFov']]) {
    if (Q.has(q)) chase.params[key] = num(q, chase.params[key]);
  }
  chase.setTarget(target);
  chase.lookBack = Q.get('front') === '1';
  chase.snap();

  let introLeft = 0;
  if (Q.get('intro') === '1') {
    for (const k of karts) k.frozen = true;
    introLeft = num('introSeconds', RACE.introSeconds);
    chase.startIntro(track, introLeft);
  }
  if (Q.get('orbit') === '1') chase.startOrbit();

  // scripted events at sim times
  const script = [];
  const at = (key, fn) => { if (Q.has(key)) script.push({ t: num(key, 0), fn, done: false }); };
  at('boostAt', () => target.applyBoost(num('boostDur', 2.0), Q.get('boostSource') || 'pad'));
  at('starAt', () => target.startStar());
  at('spinAt', () => target.spinOut('banana'));
  at('tumbleAt', () => target.tumble('rocket'));
  at('zapAt', () => target.zap());
  at('tootAt', () => target.applyBoost(1.25, 'item'));

  let simTime = 0;
  let stopped = false;
  const step = () => {
    const h = FRAME_DT / SUBSTEPS;
    for (let n = 0; n < SUBSTEPS; n++) {
      for (const e of script) if (!e.done && simTime >= e.t) { e.done = true; e.fn(); }
      if (introLeft > 0) {
        introLeft -= h;
        // rev engines on the grid in the last second of the intro
        for (const k of karts) k.input.throttle = introLeft < 1.2 ? 1 : 0;
        if (introLeft <= 0) for (const k of karts) k.frozen = false;
      } else if (!closeup || num('speed', 0) > 0) {
        for (const p of pilots) p.update(h);
      } else {
        for (const k of karts) { k.input.throttle = 0; k.input.steer = 0; }
      }
      for (const k of karts) k.update(h);
      resolveKartCollisions(karts);
      simTime += h;
    }
    for (const v of views) v.update(FRAME_DT, camera);
    effects.update(FRAME_DT, camera);
    chase.update(FRAME_DT);
    sunFollow(target.position);
  };

  let hudT = 0;
  const frame = () => {
    // fast-forward toward stopAt (full frame updates, no rendering in between)
    let guard = 0;
    if (!stopped) {
      do {
        step();
        if (simTime >= stopAt - 1e-6) {
          stopped = true;
          console.log(`[karts] stopped at t=${simTime.toFixed(3)}`);
          setTimeout(() => console.log('[karts] stats', JSON.stringify(window.__karts.stats())), 300);
          break;
        }
      } while (isFinite(stopAt) && simTime < stopAt - 0.25 && ++guard < 14);
    }
    renderer.render(scene, camera);
    stats.frames++;
    const now = performance.now();
    if (now - stats.last > 500) { stats.fps = (stats.frames * 1000) / (now - stats.last); stats.frames = 0; stats.last = now; }
    hudT -= FRAME_DT;
    if (hudT <= 0) {
      hudT = 0.25;
      const k = target, d = k.drift;
      hud.textContent = [
        `t ${simTime.toFixed(2)}${stopped ? ' (stopped)' : ''}  fps ${stats.fps.toFixed(0)}  cam ${chase.mode}`,
        `${k.character.name}: ${k.speed.toFixed(1)} m/s  s ${k.proj.s.toFixed(0)}  lat ${k.proj.lateral.toFixed(1)}  ${k.surface}${k.grounded ? '' : '  AIR ' + k.airTime.toFixed(2)}`,
        `drift ${d.active ? (d.dir > 0 ? 'R' : 'L') + ' tier ' + d.tier + ' ' + d.charge.toFixed(2) : '-'}  boost ${k.boostTimer.toFixed(2)}  star ${k.starTimer.toFixed(1)}`,
        `calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}  particles ${effects.count}`,
      ].join('\n');
    }
    requestAnimationFrame(frame);
  };
  frame();

  window.__karts = {
    scene, renderer, camera, chase, karts, views, effects, track,
    get simTime() { return simTime; },
    // draw-call breakdown (includes the shadow pass)
    stats() {
      const all = measure(() => renderer.render(scene, camera));
      const hide = scene.children.filter((o) => o.name === 'debug-track' || o.isPoints);
      hide.forEach((o) => { o.visible = false; });
      const kartsOnly = measure(() => renderer.render(scene, camera));
      sun.castShadow = false;
      const kartsNoShadow = measure(() => renderer.render(scene, camera));
      sun.castShadow = true;
      hide.forEach((o) => { o.visible = true; });
      const lods = views.map((v) => v.lod).join(',');
      return { all, kartsOnly, kartsNoShadow, lods, particles: effects.count };
    },
  };
  if (!isFinite(stopAt)) setTimeout(() => console.log('[karts] stats', JSON.stringify(window.__karts.stats())), 1500);
}

if (MODE === 'lineup') runLineup();
else runDrive();
