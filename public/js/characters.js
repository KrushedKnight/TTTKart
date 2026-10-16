// Character roster + low-poly kart/driver model builder.
//
// Node-safe: only uses THREE geometry/material classes (no canvas/DOM), so the
// headless simulation can import CHARACTERS / statsFromRatings from here.
//
// Every model is built from primitives and MERGED per moving part to keep the
// draw-call count tiny:
//   chassis mesh (1) + driver torso mesh (1) + head mesh (1) + 4 wheels as one
//   InstancedMesh (1)  =  4 draw calls per kart (+1 for Nova's glass helmet).
// Colors are baked into vertex colors; a per-vertex "surface" attribute
// (glow, roughness, metalness) is injected into MeshStandardMaterial so a
// single material per kart can have glossy paint, matte fur, chrome pipes and
// glowing lights. That one material is the kart's tint material (star rainbow).
//
// Models face +Z with the origin at ground level, centered (see SPEC §2/§4).
// NOTE: the kart's RIGHT side is -X (right = (-cos yaw, 0, sin yaw)).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { KART } from './config.js';

// --------------------------------------------------------------- roster data

export const CHARACTERS = [
  { id: 'blaze', name: 'Blaze', color: 0xff7a1f, accent: 0x2ec4d6, cssColor: '#ff7a1f',
    ratings: { speed: 3, accel: 3, handling: 4, weight: 3 },
    tagline: 'Quick-witted fox with a flair for drifting.',
    signature: { body: 'standard', wheels: 'standard', paint: 'orange', trim: 'teal', rim: 'silver' } },
  { id: 'bolt', name: 'Bolt', color: 0x2f6bff, accent: 0xd3dbe6, cssColor: '#2f6bff',
    ratings: { speed: 4, accel: 2, handling: 3, weight: 5 },
    tagline: 'Heavy-metal robot built like a tank.',
    signature: { body: 'tank', wheels: 'monster', paint: 'blue', trim: 'silver', rim: 'silver' } },
  { id: 'pip', name: 'Pip', color: 0xe8344e, accent: 0xffb020, cssColor: '#e8344e',
    ratings: { speed: 2, accel: 5, handling: 4, weight: 1 },
    tagline: 'Tiny penguin, huge getaway.',
    signature: { body: 'buggy', wheels: 'tiny', paint: 'red', trim: 'yellow', rim: 'white' } },
  { id: 'duke', name: 'Duke', color: 0xffc21f, accent: 0x7a4a24, cssColor: '#ffc21f',
    ratings: { speed: 5, accel: 1, handling: 2, weight: 5 },
    tagline: 'Big bear, bigger top speed.',
    signature: { body: 'tank', wheels: 'offroad', paint: 'yellow', trim: 'brown', rim: 'black' } },
  { id: 'nova', name: 'Nova', color: 0x8b5cff, accent: 0xf4f4ff, cssColor: '#8b5cff',
    ratings: { speed: 3, accel: 4, handling: 4, weight: 2 },
    tagline: 'Space cadet with stellar reflexes.',
    signature: { body: 'buggy', wheels: 'neon', paint: 'purple', trim: 'white', rim: 'sky' } },
  { id: 'gus', name: 'Gus', color: 0x35c64a, accent: 0xffd23a, cssColor: '#35c64a',
    ratings: { speed: 2, accel: 4, handling: 5, weight: 2 },
    tagline: 'Sticky-footed frog who hugs every corner.',
    signature: { body: 'feather', wheels: 'standard', paint: 'green', trim: 'yellow', rim: 'yellow' } },
  { id: 'mochi', name: 'Mochi', color: 0xff7fc0, accent: 0xffffff, cssColor: '#ff7fc0',
    ratings: { speed: 3, accel: 4, handling: 3, weight: 2 },
    tagline: 'Purr-fectly balanced street cat.',
    signature: { body: 'feather', wheels: 'slick', paint: 'pink', trim: 'white', rim: 'white' } },
  { id: 'ziggy', name: 'Ziggy', color: 0x15c9b0, accent: 0x7a55ff, cssColor: '#15c9b0',
    ratings: { speed: 4, accel: 3, handling: 2, weight: 3 },
    tagline: 'Out-of-this-world speed, wobbly steering.',
    signature: { body: 'rocket', wheels: 'neon', paint: 'teal', trim: 'purple', rim: 'lime' } },

  // Human kid racers (SPEC §13.2). `look` and `signature` feed customize.js.
  { id: 'krishiv', name: 'Krishiv', human: true, color: 0xe8344e, accent: 0xd9a514, cssColor: '#e8344e',
    ratings: { speed: 4, accel: 4, handling: 3, weight: 3 },
    tagline: 'The champ this whole Grand Prix is named after.',
    look: { skin: 's4', hair: 'spiky', hairColor: 'black', headwear: 'none', eyewear: 'none', outfit: 'red' },
    signature: { body: 'speedster', wheels: 'slick', paint: 'red', trim: 'gold', rim: 'gold' } },
  { id: 'striker_max', name: 'Striker Max', human: true, color: 0x2f6bff, accent: 0xffc21f, cssColor: '#2f6bff',
    ratings: { speed: 5, accel: 2, handling: 3, weight: 4 },
    tagline: 'Full throttle, zero brakes, all swagger.',
    look: { skin: 's3', hair: 'mohawk', hairColor: 'blonde', headwear: 'none', eyewear: 'sunglasses', outfit: 'blue' },
    signature: { body: 'rocket', wheels: 'standard', paint: 'blue', trim: 'yellow', rim: 'silver' } },
  { id: 'rayyaan', name: 'Rayyaan', human: true, color: 0x35c64a, accent: 0xf4f4f4, cssColor: '#35c64a',
    ratings: { speed: 3, accel: 4, handling: 5, weight: 2 },
    tagline: 'Smooth lines and silky drifts.',
    look: { skin: 's4', hair: 'curly', hairColor: 'black', headwear: 'cap_back', eyewear: 'none', outfit: 'green' },
    signature: { body: 'feather', wheels: 'neon', paint: 'green', trim: 'white', rim: 'lime' } },
  { id: 'jordan', name: 'Jordan', human: true, color: 0x38c8ff, accent: 0xff7a1f, cssColor: '#38c8ff',
    ratings: { speed: 3, accel: 5, handling: 3, weight: 3 },
    tagline: 'Launches off the line like a rocket.',
    look: { skin: 's2', hair: 'short', hairColor: 'brown', headwear: 'helmet', eyewear: 'goggles', outfit: 'sky' },
    signature: { body: 'buggy', wheels: 'tiny', paint: 'sky', trim: 'orange', rim: 'white' } },
];

// The player's own creation (SPEC §13.2). Only ever the player; never a CPU.
export const CUSTOM_CHARACTER = {
  id: 'custom', name: 'My Racer', isCustom: true, human: true,
  color: 0x8b5cff, accent: 0xffc21f, cssColor: '#8b5cff',
  ratings: { speed: 3, accel: 3, handling: 3, weight: 3 },
  tagline: 'Your racer, your rules.',
  look: { skin: 's3', hair: 'short', hairColor: 'dark', headwear: 'helmet', eyewear: 'none', outfit: 'purple' },
  signature: { body: 'standard', wheels: 'standard', paint: 'purple', trim: 'yellow', rim: 'silver' },
};

// Everything shown on the select screen: the 12-racer roster + the custom slot.
export const SELECTABLE = [...CHARACTERS, CUSTOM_CHARACTER];

const BY_ID = new Map(SELECTABLE.map((c) => [c.id, c]));

export function getCharacter(id) {
  return BY_ID.get(id) || CHARACTERS[0];
}

// Map 1..5 star ratings to physical stats (config KART.*Base/PerStar).
export function statsFromRatings(ratings = {}) {
  const r = (k) => Math.min(5, Math.max(1, Number(ratings[k]) || 3));
  return {
    topSpeed: KART.topSpeedBase + KART.topSpeedPerStar * r('speed'),
    accel: KART.accelBase + KART.accelPerStar * r('accel'),
    turnRate: KART.turnBase + KART.turnPerStar * r('handling'),
    mass: KART.massBase + KART.massPerStar * r('weight'),
  };
}

// ------------------------------------------------------------ layout consts

// Wheel layout (model space). +X is the kart's LEFT side.
export const WHEEL_RADIUS_REAR = 0.34;
export const FRONT_WHEEL_SCALE = 0.82;
export const WHEEL_RADIUS_FRONT = WHEEL_RADIUS_REAR * FRONT_WHEEL_SCALE;
const WHEEL_POS = {
  fl: [0.57, WHEEL_RADIUS_FRONT, 0.68],
  fr: [-0.57, WHEEL_RADIUS_FRONT, 0.68],
  rl: [0.6, WHEEL_RADIUS_REAR, -0.6],
  rr: [-0.6, WHEEL_RADIUS_REAR, -0.6],
};
const SEAT = [0, 0.44, -0.3];          // driver group origin (hips)
const NECK = [0, 0.86, -0.28];         // head pivot (kart space, before driver scale)
const WHEEL_CENTER = [0, 0.76, 0.16];  // steering wheel
const EXHAUST_TIPS = [[0.2, 0.585, -1.2], [-0.2, 0.585, -1.2]];

// Surface presets: [roughness, metalness, glow]
const S = {
  paint: [0.3, 0.06, 0],
  plastic: [0.55, 0, 0],
  rubber: [0.92, 0, 0],
  metal: [0.28, 0.5, 0],
  fur: [0.82, 0, 0],
  skin: [0.62, 0, 0],
  cloth: [0.88, 0, 0],
  gloss: [0.12, 0, 0],
  glow: [0.5, 0, 1],
  softGlow: [0.4, 0, 0.45],
};

const DARK = 0x33353f;
const SEAT_COL = 0x3b3e4a;
const CHROME = 0xc3ccd6;

// --------------------------------------------------------- material shader

// Inject the per-vertex surface attribute (roughness, metalness, glow) into the
// standard material. One shared program for every kart (same cache key).
function surfaceOnBeforeCompile(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aSurf;\nvarying vec3 vSurf;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = aSurf;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vSurf;')
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(vSurf.x * (roughness / 0.5), 0.04, 1.0);')
    .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vSurf.y;')
    .replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor.rgb * vSurf.z * 1.4;\n#endif');
}

function makeSurfaceMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
  m.onBeforeCompile = surfaceOnBeforeCompile;
  m.customProgramCacheKey = () => 'tootkart-surface-v1';
  return m;
}

let _wheelMaterial = null;
function wheelMaterial() {
  return _wheelMaterial || (_wheelMaterial = makeSurfaceMaterial());
}

// -------------------------------------------------------- geometry builder

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _sv = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

// Collects transformed, colored primitives and merges them into one geometry.
class Parts {
  constructor(seg = 1) {
    this.geos = [];
    this.seg = seg;                       // LOD multiplier for segment counts
    this.stack = [new THREE.Matrix4()];   // parent transform stack
  }

  n(base, min = 3) { return Math.max(min, Math.round(base * this.seg)); }

  // Push a parent transform (pos, rot euler, uniform/vec scale).
  push(pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
    const sc = Array.isArray(scale) ? scale : [scale, scale, scale];
    _m.compose(_pv.fromArray(pos), _q.setFromEuler(_e.set(rot[0], rot[1], rot[2])), _sv.fromArray(sc));
    const top = this.stack[this.stack.length - 1];
    this.stack.push(new THREE.Matrix4().multiplyMatrices(top, _m));
    return this;
  }

  pop() { if (this.stack.length > 1) this.stack.pop(); return this; }

  // Add a primitive geometry with color + surface preset.
  add(geo, color, surf = S.plastic, pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    const sc = Array.isArray(scale) ? scale : [scale, scale, scale];
    _m.compose(_pv.fromArray(pos), _q.setFromEuler(_e.set(rot[0], rot[1], rot[2])), _sv.fromArray(sc));
    _m2.multiplyMatrices(this.stack[this.stack.length - 1], _m);
    g.applyMatrix4(_m2);
    const count = g.attributes.position.count;
    const col = new Float32Array(count * 3);
    const srf = new Float32Array(count * 3);
    _c.set(color);
    for (let i = 0; i < count; i++) {
      col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
      srf[i * 3] = surf[0]; srf[i * 3 + 1] = surf[1]; srf[i * 3 + 2] = surf[2];
    }
    if (g.attributes.uv) g.deleteAttribute('uv');
    if (g.attributes.uv1) g.deleteAttribute('uv1');
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSurf', new THREE.BufferAttribute(srf, 3));
    this.geos.push(g);
    return this;
  }

  // Mirror helper: adds the part at +x and -x (rotation y/z mirrored).
  sym(geoFn, color, surf, pos, rot = [0, 0, 0], scale = 1) {
    this.add(geoFn(), color, surf, pos, rot, scale);
    this.add(geoFn(), color, surf, [-pos[0], pos[1], pos[2]], [rot[0], -rot[1], -rot[2]], scale);
    return this;
  }

  // Capsule/limb between two points.
  limb(a, b, radius, color, surf = S.cloth) {
    _dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = _dir.length();
    _dir.normalize();
    _q.setFromUnitVectors(_up, _dir);
    _e.setFromQuaternion(_q);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    this.add(new THREE.CapsuleGeometry(radius, Math.max(0.001, len), this.n(3, 2), this.n(8, 5)), color, surf, mid, [_e.x, _e.y, _e.z]);
    return this;
  }

  merge() {
    const g = mergeGeometries(this.geos, false);
    for (const p of this.geos) p.dispose();
    this.geos = [];
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Primitive factories (fresh geometry each call; Parts.add consumes them).
const sphere = (P, r, w = 14, h = 10) => new THREE.SphereGeometry(r, P.n(w, 6), P.n(h, 4));
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const rbox = (P, w, h, d, r = 0.06, segs = 1) => new RoundedBoxGeometry(w, h, d, P.seg < 0.8 ? 1 : segs, r);
const cyl = (P, rt, rb, h, seg = 14, open = false, t0 = 0, tl = Math.PI * 2) =>
  new THREE.CylinderGeometry(rt, rb, h, P.n(seg, 5), 1, open, t0, tl);
const cone = (P, r, h, seg = 10) => new THREE.ConeGeometry(r, h, P.n(seg, 4));
const torus = (P, R, t, rs = 6, ts = 16, arc = Math.PI * 2) => new THREE.TorusGeometry(R, t, P.n(rs, 3), P.n(ts, 6), arc);

// Cartoon eye facing +Z (head space): sclera, iris, pupil, two glints.
function eye(P, x, y, z, r, { iris = 0x3a2a1e, pupil = 0x0d0d12, sclera = 0xffffff, yaw = 0, pitch = 0, squash = 1.15, irisScale = 0.62 } = {}) {
  P.push([x, y, z], [pitch, yaw, 0]);
  P.add(sphere(P, r, 12, 8), sclera, S.gloss, [0, 0, 0], [0, 0, 0], [1, squash, 0.6]);
  P.add(sphere(P, r * irisScale, 10, 6), iris, S.gloss, [0, -r * 0.05, r * 0.36], [0, 0, 0], [1, 1.08, 0.5]);
  P.add(sphere(P, r * irisScale * 0.55, 8, 5), pupil, S.gloss, [0, -r * 0.05, r * 0.5], [0, 0, 0], [1, 1.1, 0.4]);
  P.add(sphere(P, r * 0.17, 5, 3), 0xffffff, S.softGlow, [-r * 0.22, r * 0.24, r * 0.58]);
  P.add(sphere(P, r * 0.08, 4, 3), 0xffffff, S.softGlow, [r * 0.2, -r * 0.22, r * 0.56]);
  P.pop();
}

// ------------------------------------------------------------ the chassis

function buildChassis(P, def) {
  const C = def.color, A = def.accent;
  // floor pan + axles
  P.add(rbox(P, 0.84, 0.12, 1.9, 0.05), DARK, S.plastic, [0, 0.18, -0.02]);
  P.add(cyl(P, 0.045, 0.045, 1.14, 8), 0x55585f, S.metal, [0, WHEEL_RADIUS_REAR, -0.6], [0, 0, Math.PI / 2]);
  P.add(cyl(P, 0.04, 0.04, 1.06, 8), 0x55585f, S.metal, [0, WHEEL_RADIUS_FRONT, 0.68], [0, 0, Math.PI / 2]);
  // main tub
  P.add(rbox(P, 0.86, 0.32, 1.16, 0.12, 2), C, S.paint, [0, 0.38, -0.12]);
  // cockpit rim (dark lip around the driver)
  P.add(torus(P, 0.3, 0.045, 5, 18), DARK, S.plastic, [0, 0.545, -0.22], [Math.PI / 2, 0, 0], [1.15, 1.25, 1]);
  // nose + hood stripe + emblem
  P.push([0, 0.35, 0.64], [0.1, 0, 0]);
  P.add(rbox(P, 0.74, 0.25, 0.68, 0.11, 2), C, S.paint);
  P.add(box(0.18, 0.03, 0.6), A, S.paint, [0, 0.125, -0.02]);
  P.add(cyl(P, 0.1, 0.1, 0.02, 16), 0xffffff, S.paint, [0, 0.02, 0.341], [Math.PI / 2, 0, 0]);
  P.add(cyl(P, 0.06, 0.06, 0.025, 12), A, S.paint, [0, 0.02, 0.345], [Math.PI / 2, 0, 0]);
  // headlights
  P.add(cyl(P, 0.05, 0.05, 0.03, 10), 0xfff4c8, S.glow, [0.23, 0.03, 0.335], [Math.PI / 2, 0, 0]);
  P.add(cyl(P, 0.05, 0.05, 0.03, 10), 0xfff4c8, S.glow, [-0.23, 0.03, 0.335], [Math.PI / 2, 0, 0]);
  P.pop();
  // dashboard
  P.add(rbox(P, 0.6, 0.12, 0.2, 0.05), DARK, S.plastic, [0, 0.55, 0.3], [-0.3, 0, 0]);
  // front bumper
  P.add(rbox(P, 1.16, 0.15, 0.18, 0.07), DARK, S.plastic, [0, 0.23, 1.04]);
  P.sym(() => box(0.12, 0.17, 0.2), A, S.paint, [0.54, 0.24, 1.04]);
  // side pods
  P.sym(() => rbox(P, 0.26, 0.24, 0.56, 0.09), A, S.paint, [0.5, 0.33, 0.05]);
  P.sym(() => box(0.16, 0.05, 0.4), C, S.paint, [0.58, 0.39, 0.05]);
  // rear fenders over the chunky rear wheels
  P.sym(() => torus(P, 0.4, 0.07, 6, 14, Math.PI * 0.86), C, S.paint, [0.6, WHEEL_RADIUS_REAR, -0.6], [0, Math.PI / 2, 0.22], [1, 1, 2.7]);
  // seat
  P.add(rbox(P, 0.5, 0.08, 0.42, 0.04), SEAT_COL, S.cloth, [0, 0.44, -0.3]);
  P.add(rbox(P, 0.52, 0.5, 0.1, 0.05), SEAT_COL, S.cloth, [0, 0.7, -0.53], [-0.22, 0, 0]);
  // engine block, cylinder heads
  P.add(rbox(P, 0.6, 0.28, 0.36, 0.06), DARK, S.plastic, [0, 0.44, -0.8]);
  P.sym(() => box(0.18, 0.1, 0.28), CHROME, S.metal, [0.13, 0.62, -0.8]);
  // rear cowl in body color (what the chase camera sees most): taillights,
  // a white plate with the emblem, diffuser
  P.add(rbox(P, 0.82, 0.24, 0.12, 0.05, 2), C, S.paint, [0, 0.42, -1.0]);
  P.sym(() => rbox(P, 0.12, 0.07, 0.03, 0.015), 0xff2a2a, S.glow, [0.31, 0.47, -1.065]);
  P.add(rbox(P, 0.2, 0.09, 0.02, 0.02), 0xffffff, S.paint, [0, 0.37, -1.064]);
  P.add(cyl(P, 0.03, 0.03, 0.02, 10), A, S.paint, [0, 0.37, -1.075], [Math.PI / 2, 0, 0]);
  P.add(box(0.7, 0.06, 0.1), DARK, S.plastic, [0, 0.28, -1.0]);
  // exhaust pipes (angled up and back) with dark mouths
  for (const sx of [1, -1]) {
    P.push([0.2 * sx, 0.52, -1.02], [-Math.PI / 2 + 0.35, 0, 0]);
    P.add(cyl(P, 0.07, 0.08, 0.38, 12), CHROME, S.metal);
    P.add(torus(P, 0.07, 0.022, 5, 12), CHROME, S.metal, [0, 0.19, 0], [Math.PI / 2, 0, 0]);
    P.add(cyl(P, 0.052, 0.052, 0.02, 10), 0x111114, S.rubber, [0, 0.192, 0]);
    P.pop();
  }
  // rear bumper (accent) + side taillights
  P.add(rbox(P, 1.34, 0.13, 0.13, 0.06), A, S.paint, [0, 0.25, -1.06]);
  P.sym(() => box(0.12, 0.06, 0.03), 0xff2a2a, S.glow, [0.34, 0.46, -0.71]);
  // spoiler
  P.sym(() => box(0.05, 0.36, 0.08), DARK, S.plastic, [0.28, 0.72, -0.97], [-0.15, 0, 0]);
  P.add(rbox(P, 1.22, 0.06, 0.32, 0.03), C, S.paint, [0, 0.91, -1.02], [0.1, 0, 0]);
  P.add(box(1.0, 0.02, 0.1), A, S.paint, [0, 0.945, -0.96], [0.1, 0, 0]);
  P.sym(() => box(0.04, 0.2, 0.36), A, S.paint, [0.62, 0.9, -1.02]);
  // steering column + wheel
  P.limb([0, 0.5, 0.38], WHEEL_CENTER, 0.025, DARK, S.plastic);
  P.push(WHEEL_CENTER, [0.69, 0, 0]);
  P.add(torus(P, 0.14, 0.028, 6, 18), DARK, S.rubber);
  P.add(box(0.26, 0.03, 0.02), DARK, S.plastic);
  P.add(cyl(P, 0.045, 0.045, 0.04, 10), A, S.paint, [0, 0, 0.01], [Math.PI / 2, 0, 0]);
  P.pop();
}

// One wheel (rear size, axis = X). Front wheels are scaled instances.
function buildWheel(P, def) {
  const r = WHEEL_RADIUS_REAR;
  const rot = [0, 0, Math.PI / 2];
  P.add(cyl(P, r, r, 0.26, 18), 0x24242b, S.rubber, [0, 0, 0], rot);
  P.add(cyl(P, r * 0.9, r * 0.9, 0.34, 18), 0x2c2c34, S.rubber, [0, 0, 0], rot);
  // tread blocks so spinning reads
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    P.add(box(0.27, 0.05, 0.07), 0x1c1c22, S.rubber, [0, Math.cos(a) * r, Math.sin(a) * r], [a, 0, 0]);
  }
  P.add(cyl(P, r * 0.55, r * 0.55, 0.355, 16), def.accent === 0xffffff ? 0xe9edf2 : def.accent, S.paint, [0, 0, 0], rot);
  for (let k = 0; k < 3; k++) {
    P.add(box(0.365, 0.05, r * 1.0), def.color, S.paint, [0, 0, 0], [(k * Math.PI) / 3, 0, 0]);
  }
  P.add(cyl(P, r * 0.18, r * 0.18, 0.375, 10), CHROME, S.metal, [0, 0, 0], rot);
}

// ------------------------------------------------------------ the drivers
//
// Torso parts are built in kart space and later re-centered on SEAT; head
// parts are built relative to the head pivot (NECK) — +Z is the face.

function arms(T, sleeve, glove, r = 0.068, gloveR = 0.078) {
  for (const sx of [1, -1]) {
    const sh = [0.2 * sx, 0.79, -0.27];
    const el = [0.27 * sx, 0.67, -0.07];
    const ha = [0.14 * sx, 0.76, 0.15];
    T.limb(sh, el, r, sleeve);
    T.limb(el, ha, r * 0.92, sleeve);
    T.add(sphere(T, gloveR, 10, 8), glove, S.cloth, ha);
  }
}

function torsoBlob(T, color, { belly = null, surf = S.cloth, w = 1, h = 1 } = {}) {
  T.add(sphere(T, 0.25, 16, 12), color, surf, [0, 0.66, -0.31], [0, 0, 0], [1.05 * w, 1.0 * h, 0.85]);
  if (belly !== null) T.add(sphere(T, 0.2, 14, 10), belly, surf, [0, 0.64, -0.17], [0, 0, 0], [0.95 * w, 0.95 * h, 0.5]);
}

const DRIVERS = {
  // --- Blaze: orange fox, pointy ears, white muzzle, bushy tail ------------
  blaze(T, H, def) {
    const FUR = 0xff7a1f, WHITE = 0xfff3e2, SUIT = def.accent;
    torsoBlob(T, SUIT, { belly: 0xffffff });
    T.add(torus(T, 0.15, 0.05, 6, 14), WHITE, S.fur, [0, 0.86, -0.28], [Math.PI / 2, 0, 0]);
    arms(T, SUIT, 0xffffff);
    // bushy tail: J-curl out to the left behind the seat, white tip on top
    // (presents its side to the chase camera so it reads as a tail)
    const tail = [
      [0.1, 0.6, -0.66, 0.1], [0.27, 0.64, -0.72, 0.14], [0.44, 0.73, -0.76, 0.17],
      [0.56, 0.88, -0.78, 0.17], [0.6, 1.04, -0.78, 0.15], [0.58, 1.17, -0.77, 0.11],
    ];
    for (let i = 0; i < tail.length; i++) {
      const [x, y, z, r] = tail[i];
      const nb = tail[Math.min(i + 1, tail.length - 1)], pb = tail[Math.max(i - 1, 0)];
      _dir.set(nb[0] - pb[0], nb[1] - pb[1], nb[2] - pb[2]).normalize();
      _q.setFromUnitVectors(_up, _dir);
      _e.setFromQuaternion(_q);
      T.add(sphere(T, r, 12, 9), i >= tail.length - 2 ? WHITE : FUR, S.fur, [x, y, z], [_e.x, _e.y, _e.z], [1, 1.45, 1]);
    }
    T.add(cone(T, 0.08, 0.15, 9), WHITE, S.fur, [0.555, 1.27, -0.77], [0, 0, 0.18]);

    const hc = 0.27;
    H.add(sphere(H, 0.28, 18, 14), FUR, S.fur, [0, hc, 0], [0, 0, 0], [1.06, 0.96, 1]);
    // cheek tufts
    H.sym(() => cone(H, 0.09, 0.2, 6), WHITE, S.fur, [0.25, hc - 0.09, 0.04], [0, 0, 1.9]);
    // muzzle + nose
    H.add(sphere(H, 0.16, 14, 10), WHITE, S.fur, [0, hc - 0.08, 0.19], [0, 0, 0], [1.05, 0.72, 1.2]);
    H.add(sphere(H, 0.048, 10, 8), 0x1b1b20, S.gloss, [0, hc - 0.03, 0.375], [0, 0, 0], [1.3, 0.9, 1]);
    H.add(torus(H, 0.05, 0.012, 4, 10, Math.PI), 0x3a2016, S.plastic, [0, hc - 0.115, 0.33], [0, 0, Math.PI], [1, 0.7, 1]);
    // pointy ears with dark tips + inner
    for (const sx of [1, -1]) {
      H.push([0.15 * sx, hc + 0.26, -0.02], [0, 0, -0.32 * sx]);
      H.add(cone(H, 0.11, 0.26, 4), FUR, S.fur, [0, 0, 0], [0, Math.PI / 4, 0], [1, 1, 0.55]);
      H.add(cone(H, 0.07, 0.16, 4), 0x3a2016, S.fur, [0, -0.03, 0.035], [0, Math.PI / 4, 0], [1, 1, 0.4]);
      H.add(cone(H, 0.045, 0.08, 4), 0x2b1a14, S.fur, [0, 0.1, 0], [0, Math.PI / 4, 0], [1, 1, 0.6]);
      H.pop();
    }
    // forehead tuft
    H.add(cone(H, 0.06, 0.14, 6), FUR, S.fur, [0, hc + 0.26, 0.12], [0.9, 0, 0]);
    eye(H, 0.105, hc + 0.05, 0.23, 0.075, { iris: 0x2fae5b, yaw: 0.28 });
    eye(H, -0.105, hc + 0.05, 0.23, 0.075, { iris: 0x2fae5b, yaw: -0.28 });
    // brows
    H.sym(() => rbox(H, 0.09, 0.022, 0.03, 0.01), 0x6a2a0c, S.fur, [0.11, hc + 0.15, 0.25], [0, 0.3, -0.18]);
  },

  // --- Bolt: chunky silver/blue robot, antenna, glowing visor --------------
  bolt(T, H, def) {
    const SILVER = 0xd3dbe6, BLUE = def.color, VISOR = 0x3ff3ff;
    T.add(rbox(T, 0.52, 0.42, 0.34, 0.08), BLUE, S.paint, [0, 0.66, -0.3]);
    T.add(rbox(T, 0.36, 0.2, 0.06, 0.04), SILVER, S.metal, [0, 0.7, -0.12]);
    T.add(cyl(T, 0.05, 0.05, 0.03, 12), 0xffd23a, S.glow, [0, 0.7, -0.09], [Math.PI / 2, 0, 0]);
    T.sym(() => sphere(T, 0.1, 10, 8), SILVER, S.metal, [0.27, 0.8, -0.28]);
    // segmented metal arms, blue mitts
    for (const sx of [1, -1]) {
      T.limb([0.27 * sx, 0.79, -0.27], [0.29 * sx, 0.66, -0.06], 0.05, SILVER, S.metal);
      T.add(sphere(T, 0.065, 10, 8), 0x55606c, S.metal, [0.29 * sx, 0.66, -0.06]);
      T.limb([0.29 * sx, 0.66, -0.06], [0.14 * sx, 0.76, 0.15], 0.05, SILVER, S.metal);
      T.add(rbox(T, 0.12, 0.12, 0.12, 0.04), BLUE, S.paint, [0.14 * sx, 0.76, 0.15]);
    }
    // neck
    T.add(cyl(T, 0.07, 0.09, 0.12, 10), 0x55606c, S.metal, [0, 0.88, -0.28]);

    const hc = 0.25;
    H.add(rbox(H, 0.52, 0.42, 0.44, 0.1), SILVER, S.metal, [0, hc, 0]);
    H.add(rbox(H, 0.54, 0.08, 0.46, 0.03), BLUE, S.paint, [0, hc + 0.19, 0]);
    // visor band with two bright eye slits
    H.add(rbox(H, 0.44, 0.15, 0.06, 0.03), 0x0b1a2a, S.gloss, [0, hc + 0.03, 0.215]);
    H.add(rbox(H, 0.4, 0.11, 0.02, 0.02), VISOR, S.softGlow, [0, hc + 0.03, 0.245]);
    H.sym(() => sphere(H, 0.045, 10, 8), 0xeaffff, S.glow, [0.1, hc + 0.035, 0.255], [0, 0, 0], [1.25, 0.9, 0.4]);
    // mouth grille
    for (let k = -1; k <= 1; k++) H.add(box(0.035, 0.07, 0.02), 0x2a313a, S.plastic, [k * 0.07, hc - 0.12, 0.222]);
    // ear bolts
    H.sym(() => cyl(H, 0.075, 0.075, 0.08, 12), BLUE, S.paint, [0.27, hc, 0], [0, 0, Math.PI / 2]);
    H.sym(() => cyl(H, 0.035, 0.035, 0.1, 8), CHROME, S.metal, [0.3, hc, 0], [0, 0, Math.PI / 2]);
    // antenna
    H.add(cyl(H, 0.014, 0.014, 0.24, 6), CHROME, S.metal, [0.1, hc + 0.33, -0.03], [0, 0, -0.15]);
    H.add(sphere(H, 0.055, 10, 8), 0xff3b3b, S.glow, [0.12, hc + 0.46, -0.03]);
  },

  // --- Pip: small penguin, black/white, orange beak, scarf ------------------
  pip(T, H, def) {
    const BLACK = 0x23262f, WHITE = 0xf8f8fb, BEAK = 0xffa21f, SCARF = def.color;
    torsoBlob(T, BLACK, { belly: WHITE, surf: S.fur });
    // flipper arms
    for (const sx of [1, -1]) {
      T.limb([0.21 * sx, 0.78, -0.28], [0.26 * sx, 0.66, -0.05], 0.06, BLACK, S.fur);
      T.limb([0.26 * sx, 0.66, -0.05], [0.14 * sx, 0.76, 0.14], 0.055, BLACK, S.fur);
      T.add(sphere(T, 0.07, 10, 8), BLACK, S.fur, [0.14 * sx, 0.76, 0.15], [0, 0, 0], [1, 0.8, 1.2]);
    }
    // scarf: ring + two striped tails flapping behind
    T.add(torus(T, 0.15, 0.06, 6, 16), SCARF, S.cloth, [0, 0.85, -0.28], [Math.PI / 2, 0, 0]);
    T.add(rbox(T, 0.12, 0.05, 0.36, 0.02), SCARF, S.cloth, [0.1, 0.84, -0.55], [0.35, 0.25, 0.1]);
    T.add(rbox(T, 0.125, 0.055, 0.06, 0.02), 0xffffff, S.cloth, [0.13, 0.78, -0.66], [0.35, 0.25, 0.1]);
    T.add(rbox(T, 0.1, 0.045, 0.28, 0.02), SCARF, S.cloth, [-0.04, 0.8, -0.52], [0.6, -0.15, -0.1]);

    const hc = 0.25;
    H.add(sphere(H, 0.27, 18, 14), BLACK, S.fur, [0, hc, 0], [0, 0, 0], [1.02, 0.97, 0.98]);
    // white face mask (two lobes)
    H.sym(() => sphere(H, 0.13, 12, 10), WHITE, S.fur, [0.08, hc - 0.01, 0.17], [0, 0, 0], [1, 1.15, 0.7]);
    H.add(sphere(H, 0.15, 12, 10), WHITE, S.fur, [0, hc - 0.08, 0.15], [0, 0, 0], [1.2, 0.8, 0.75]);
    // beak
    H.add(cone(H, 0.07, 0.17, 10), BEAK, S.gloss, [0, hc - 0.05, 0.33], [Math.PI / 2, 0, 0], [1.2, 1, 0.75]);
    // blush
    H.sym(() => sphere(H, 0.035, 8, 6), 0xff8fb0, S.skin, [0.16, hc - 0.07, 0.2], [0, 0, 0], [1, 0.7, 0.4]);
    eye(H, 0.085, hc + 0.05, 0.235, 0.062, { iris: 0x1e2433, yaw: 0.25, irisScale: 0.7 });
    eye(H, -0.085, hc + 0.05, 0.235, 0.062, { iris: 0x1e2433, yaw: -0.25, irisScale: 0.7 });
    // head tuft
    for (let k = -1; k <= 1; k++) H.add(cone(H, 0.035, 0.13, 5), BLACK, S.fur, [k * 0.04, hc + 0.29, 0.02], [0.2, 0, -k * 0.45]);
  },

  // --- Duke: big brown bear, round ears, aviator goggles --------------------
  duke(T, H, def) {
    const FUR = 0x8b5a2b, TAN = 0xdcb88e, JACKET = 0x6b3d1e, BRASS = 0xd6a94a;
    torsoBlob(T, JACKET, { belly: TAN, w: 1.08 });
    T.add(torus(T, 0.16, 0.065, 6, 16), 0xf3e6cf, S.fur, [0, 0.85, -0.28], [Math.PI / 2, 0, 0]);
    // aviator scarf tail
    T.add(rbox(T, 0.11, 0.04, 0.4, 0.02), 0xffffff, S.cloth, [-0.12, 0.86, -0.56], [0.25, -0.35, -0.15]);
    arms(T, JACKET, FUR, 0.078, 0.09);

    const hc = 0.27;
    H.add(sphere(H, 0.3, 18, 14), FUR, S.fur, [0, hc, 0], [0, 0, 0], [1.08, 0.98, 1]);
    // round ears
    H.sym(() => sphere(H, 0.1, 12, 10), FUR, S.fur, [0.21, hc + 0.22, -0.04], [0, 0, 0], [1, 1, 0.6]);
    H.sym(() => sphere(H, 0.06, 10, 8), TAN, S.fur, [0.21, hc + 0.215, 0.0], [0, 0, 0], [1, 1, 0.35]);
    // muzzle + nose + mouth
    H.add(sphere(H, 0.15, 14, 10), TAN, S.fur, [0, hc - 0.09, 0.21], [0, 0, 0], [1.15, 0.8, 0.95]);
    H.add(sphere(H, 0.06, 10, 8), 0x1b1412, S.gloss, [0, hc - 0.04, 0.345], [0, 0, 0], [1.35, 0.9, 0.9]);
    H.add(torus(H, 0.045, 0.012, 4, 10, Math.PI), 0x2e1d12, S.plastic, [0, hc - 0.135, 0.33], [0, 0, Math.PI], [1.2, 0.7, 1]);
    eye(H, 0.11, hc + 0.05, 0.25, 0.055, { iris: 0x2a1a10, yaw: 0.3, irisScale: 0.75 });
    eye(H, -0.11, hc + 0.05, 0.25, 0.055, { iris: 0x2a1a10, yaw: -0.3, irisScale: 0.75 });
    H.sym(() => rbox(H, 0.11, 0.03, 0.03, 0.012), 0x4a2c14, S.fur, [0.11, hc + 0.12, 0.27], [0, 0.3, 0.12]);
    // aviator goggles pushed up on the forehead + strap
    H.add(torus(H, 0.3, 0.03, 4, 24), 0x3b2a1c, S.cloth, [0, hc + 0.13, -0.01], [Math.PI / 2 - 0.25, 0, 0], [1.08, 1, 1]);
    for (const sx of [1, -1]) {
      H.push([0.1 * sx, hc + 0.18, 0.25], [-0.6, 0.25 * sx, 0]);
      H.add(torus(H, 0.07, 0.025, 6, 14), BRASS, S.metal);
      H.add(cyl(H, 0.065, 0.065, 0.02, 14), 0x8fe3ff, S.softGlow, [0, 0, 0], [Math.PI / 2, 0, 0]);
      H.pop();
    }
  },

  // --- Nova: astronaut kid, purple suit, bubble helmet ----------------------
  nova(T, H, def, G) {
    const SUIT = def.color, WHITE = 0xf4f4ff, SKIN = 0xffd1ae, HAIR = 0x4a2c1d;
    torsoBlob(T, SUIT);
    T.add(rbox(T, 0.26, 0.2, 0.06, 0.03), WHITE, S.plastic, [0, 0.68, -0.12]);
    T.sym(() => sphere(T, 0.025, 8, 6), 0x3ff3ff, S.glow, [0.06, 0.7, -0.085]);
    T.add(sphere(T, 0.025, 8, 6), 0xff5fd2, S.glow, [0, 0.64, -0.085]);
    // helmet collar ring
    T.add(torus(T, 0.17, 0.05, 6, 18), WHITE, S.plastic, [0, 0.86, -0.28], [Math.PI / 2, 0, 0]);
    // backpack + thrusters
    T.add(rbox(T, 0.38, 0.4, 0.16, 0.05), WHITE, S.plastic, [0, 0.72, -0.52]);
    T.sym(() => cyl(T, 0.05, 0.06, 0.14, 10), 0x9aa3b0, S.metal, [0.11, 0.5, -0.53]);
    T.add(rbox(T, 0.2, 0.04, 0.02, 0.01), SUIT, S.paint, [0, 0.82, -0.605]);
    arms(T, SUIT, WHITE, 0.07, 0.085);

    const hc = 0.28;
    H.add(sphere(H, 0.2, 16, 12), SKIN, S.skin, [0, hc - 0.01, 0.01]);
    // hair cap (partial sphere tilted back) + little bun
    H.add(new THREE.SphereGeometry(0.212, H.n(16, 6), H.n(8, 3), 0, Math.PI * 2, 0, Math.PI * 0.42), HAIR, S.fur, [0, hc - 0.005, -0.005], [-0.35, 0, 0]);
    H.add(sphere(H, 0.07, 10, 8), HAIR, S.fur, [0, hc + 0.18, -0.1]);
    eye(H, 0.075, hc + 0.0, 0.17, 0.052, { iris: 0x5a3d2a, yaw: 0.3, irisScale: 0.72 });
    eye(H, -0.075, hc + 0.0, 0.17, 0.052, { iris: 0x5a3d2a, yaw: -0.3, irisScale: 0.72 });
    H.sym(() => sphere(H, 0.03, 8, 6), 0xff9db5, S.skin, [0.12, hc - 0.07, 0.15], [0, 0, 0], [1, 0.7, 0.4]);
    H.add(torus(H, 0.04, 0.011, 4, 10, Math.PI), 0x6b2b2b, S.plastic, [0, hc - 0.085, 0.185], [0, 0, Math.PI]);
    // helmet glint + antenna
    H.add(sphere(H, 0.05, 8, 6), 0xffffff, S.softGlow, [0.15, hc + 0.18, 0.22], [0, 0, 0.6], [1.6, 0.5, 0.3]);
    H.add(cyl(H, 0.014, 0.014, 0.16, 6), 0xb8c2cf, S.metal, [-0.12, hc + 0.36, -0.05], [0, 0, 0.3]);
    H.add(sphere(H, 0.045, 10, 8), 0xffe14d, S.glow, [-0.145, hc + 0.44, -0.05]);
    // transparent bubble (separate glass mesh)
    G.add(new THREE.SphereGeometry(0.335, G.n(22, 10), G.n(16, 8)), 0xd9ecff, S.gloss, [0, hc + 0.02, 0.01]);
  },

  // --- Gus: green frog, big eyes on top, wide mouth -------------------------
  gus(T, H, def) {
    const GREEN = 0x3fc84a, BELLY = 0xdaf5a2, VEST = def.accent;
    torsoBlob(T, GREEN, { belly: BELLY, surf: S.skin });
    // little racing vest straps
    T.sym(() => rbox(T, 0.06, 0.38, 0.05, 0.02), VEST, S.cloth, [0.12, 0.67, -0.15], [0.15, 0, -0.08]);
    T.add(torus(T, 0.14, 0.035, 5, 14), VEST, S.cloth, [0, 0.83, -0.28], [Math.PI / 2, 0, 0]);
    arms(T, GREEN, 0xff8fa8, 0.06, 0.075);

    const hc = 0.2;
    H.add(sphere(H, 0.28, 18, 14), GREEN, S.skin, [0, hc, 0.02], [0, 0, 0], [1.28, 0.78, 1.02]);
    H.add(sphere(H, 0.24, 16, 10), BELLY, S.skin, [0, hc - 0.07, 0.07], [0, 0, 0], [1.2, 0.55, 1.0]);
    // eyes on top: green lids + big bulging eyes
    for (const sx of [1, -1]) {
      H.add(sphere(H, 0.12, 14, 10), GREEN, S.skin, [0.15 * sx, hc + 0.17, 0.06]);
      eye(H, 0.15 * sx, hc + 0.19, 0.13, 0.1, { iris: 0x1a1a1a, yaw: 0.22 * sx, pitch: -0.1, squash: 1.0, irisScale: 0.6 });
    }
    // wide smile + nostrils + cheeks
    H.add(torus(H, 0.22, 0.017, 4, 22, Math.PI * 0.85), 0x2b1a1a, S.plastic, [0, hc - 0.02, 0.2], [Math.PI / 2 + 0.35, 0, Math.PI * 1.075 + Math.PI], [1, 0.62, 1]);
    H.sym(() => sphere(H, 0.014, 6, 4), 0x1c3a1c, S.plastic, [0.04, hc + 0.05, 0.3]);
    H.sym(() => sphere(H, 0.05, 10, 8), 0xff8fa8, S.skin, [0.25, hc - 0.03, 0.18], [0, 0, 0], [1, 0.7, 0.4]);
  },

  // --- Mochi: white cat, pink ears, bell collar -----------------------------
  mochi(T, H, def) {
    const WHITE = 0xfbf8f3, PINK = 0xff9ec7, HOODIE = def.color;
    torsoBlob(T, HOODIE, { belly: 0xffffff });
    arms(T, HOODIE, WHITE, 0.066, 0.08);
    // collar + golden bell
    T.add(torus(T, 0.15, 0.035, 6, 16), 0xe8344e, S.cloth, [0, 0.86, -0.28], [Math.PI / 2, 0, 0]);
    T.add(sphere(T, 0.055, 12, 10), 0xffcf3a, S.metal, [0, 0.8, -0.12]);
    T.add(torus(T, 0.054, 0.008, 4, 12), 0xb88a1a, S.metal, [0, 0.8, -0.12], [Math.PI / 2, 0, 0]);
    // curly tail
    const tail = [[0.0, 0.5, -0.62], [0.12, 0.62, -0.76], [0.2, 0.84, -0.84], [0.17, 1.04, -0.84], [0.06, 1.12, -0.8]];
    for (let k = 0; k < tail.length - 1; k++) T.limb(tail[k], tail[k + 1], 0.045, k === tail.length - 2 ? PINK : WHITE, S.fur);

    const hc = 0.27;
    H.add(sphere(H, 0.28, 18, 14), WHITE, S.fur, [0, hc, 0], [0, 0, 0], [1.1, 0.95, 1]);
    H.sym(() => sphere(H, 0.1, 10, 8), WHITE, S.fur, [0.17, hc - 0.07, 0.13], [0, 0, 0], [1.3, 1, 1]);
    // pink triangle ears
    for (const sx of [1, -1]) {
      H.push([0.16 * sx, hc + 0.22, -0.01], [0, 0, -0.38 * sx]);
      H.add(cone(H, 0.12, 0.22, 4), WHITE, S.fur, [0, 0, 0], [0, Math.PI / 4, 0], [1, 1, 0.6]);
      H.add(cone(H, 0.08, 0.15, 4), PINK, S.fur, [0, -0.02, 0.035], [0, Math.PI / 4, 0], [1, 1, 0.4]);
      H.pop();
    }
    eye(H, 0.11, hc + 0.04, 0.235, 0.078, { iris: 0x2bb5a0, yaw: 0.3, irisScale: 0.7 });
    eye(H, -0.11, hc + 0.04, 0.235, 0.078, { iris: 0x2bb5a0, yaw: -0.3, irisScale: 0.7 });
    // pink nose + "w" mouth + whiskers + blush
    H.add(sphere(H, 0.03, 8, 6), 0xff6fa5, S.gloss, [0, hc - 0.05, 0.3], [0, 0, 0], [1.3, 0.8, 0.8]);
    H.sym(() => torus(H, 0.03, 0.009, 4, 8, Math.PI), 0x4a3a40, S.plastic, [0.028, hc - 0.09, 0.28], [0, 0, Math.PI]);
    for (const sx of [1, -1]) {
      for (let k = -1; k <= 1; k++) {
        H.add(box(0.2, 0.008, 0.008), 0x6a5d63, S.plastic, [0.27 * sx, hc - 0.06 + k * 0.03, 0.17], [0, -0.35 * sx, -k * 0.18 * sx]);
      }
    }
    H.sym(() => sphere(H, 0.04, 8, 6), 0xffb3cf, S.skin, [0.17, hc - 0.08, 0.2], [0, 0, 0], [1, 0.6, 0.4]);
  },

  // --- Ziggy: teal alien, three eyes, antenna bobbles -----------------------
  ziggy(T, H, def) {
    const SKIN = 0x22d3b6, SUIT = 0x4b3a8f, GLOW = 0xff5fd2;
    torsoBlob(T, SUIT);
    T.add(torus(T, 0.2, 0.025, 5, 18), 0x3ff3ff, S.glow, [0, 0.6, -0.3], [Math.PI / 2, 0, 0], [1.15, 0.95, 1]);
    T.add(cyl(T, 0.07, 0.08, 0.12, 10), SKIN, S.skin, [0, 0.86, -0.28]);
    T.sym(() => cone(T, 0.09, 0.12, 6), def.accent, S.paint, [0.26, 0.82, -0.3], [0, 0, -1.2]);
    arms(T, SUIT, SKIN, 0.062, 0.076);

    const hc = 0.3;
    H.add(sphere(H, 0.27, 18, 14), SKIN, S.skin, [0, hc, 0], [0, 0, 0], [1.02, 1.18, 0.96]);
    H.add(sphere(H, 0.14, 12, 10), SKIN, S.skin, [0, hc - 0.18, 0.06], [0, 0, 0], [1, 0.8, 0.9]);
    // three eyes (big center one)
    eye(H, 0, hc + 0.08, 0.235, 0.085, { iris: 0x7a3cff, irisScale: 0.66 });
    eye(H, 0.135, hc + 0.0, 0.205, 0.06, { iris: 0x7a3cff, yaw: 0.45, irisScale: 0.66 });
    eye(H, -0.135, hc + 0.0, 0.205, 0.06, { iris: 0x7a3cff, yaw: -0.45, irisScale: 0.66 });
    H.add(torus(H, 0.05, 0.012, 4, 10, Math.PI), 0x0f4a40, S.plastic, [0, hc - 0.14, 0.235], [0, 0, Math.PI], [1.2, 0.8, 1]);
    // antennae with glowing bobbles
    for (const sx of [1, -1]) {
      H.limb([0.07 * sx, hc + 0.28, -0.02], [0.17 * sx, hc + 0.5, -0.05], 0.016, SKIN, S.skin);
      H.add(sphere(H, 0.06, 12, 10), GLOW, S.glow, [0.18 * sx, hc + 0.53, -0.05]);
    }
    // tiny pointy ears
    H.sym(() => cone(H, 0.05, 0.14, 6), SKIN, S.skin, [0.28, hc + 0.02, -0.02], [0, 0, -1.3]);
  },
};

// --------------------------------------------------------------- the model

// Per-character visual scale tweaks.
const DRIVER_SCALE = { pip: 0.86, duke: 1.12, bolt: 1.06, nova: 0.96, gus: 0.98 };

const _geoCache = new Map();

function buildGeometries(def, lod) {
  const key = `${def.id}|${lod}`;
  const hit = _geoCache.get(key);
  if (hit) return hit;
  const seg = lod === 'low' ? 0.55 : 1;
  const chassis = new Parts(seg);
  buildChassis(chassis, def);
  const wheel = new Parts(seg);
  buildWheel(wheel, def);

  const T = new Parts(seg);
  const H = new Parts(seg);
  const G = new Parts(seg);
  const fn = DRIVERS[def.id] || DRIVERS.blaze;
  // Head parts are authored relative to the neck pivot; torso in kart space.
  fn(T, H, def, G);
  const torso = T.merge();
  torso.translate(-SEAT[0], -SEAT[1], -SEAT[2]);
  const out = {
    chassis: chassis.merge(),
    wheel: wheel.merge(),
    torso,
    head: H.merge(),
    glass: G.geos.length ? G.merge() : null,
  };
  _geoCache.set(key, out);
  return out;
}

const _wm = new THREE.Matrix4();

/**
 * Build a kart + driver model for a character definition.
 * Faces +Z, origin at ground center. See SPEC §4 for userData fields.
 */
export function buildKartModel(def, { lod = 'high' } = {}) {
  def = def && def.id ? def : getCharacter(def);
  const geos = buildGeometries(def, lod);
  const paint = makeSurfaceMaterial();
  paint.name = `kart-${def.id}`;

  const root = new THREE.Group();
  root.name = `kart:${def.id}`;
  const kartScale = 0.95 + 0.025 * ((def.ratings && def.ratings.weight) || 3);
  root.scale.setScalar(kartScale);

  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);
  const chassis = new THREE.Mesh(geos.chassis, paint);
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  body.add(chassis);

  const driver = new THREE.Group();
  driver.name = 'driver';
  driver.position.fromArray(SEAT);
  driver.scale.setScalar(DRIVER_SCALE[def.id] || 1);
  body.add(driver);
  const torso = new THREE.Mesh(geos.torso, paint);
  torso.castShadow = true;
  torso.receiveShadow = true;
  driver.add(torso);

  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(NECK[0] - SEAT[0], NECK[1] - SEAT[1], NECK[2] - SEAT[2]);
  driver.add(head);
  const headMesh = new THREE.Mesh(geos.head, paint);
  headMesh.castShadow = true;
  headMesh.receiveShadow = true;
  head.add(headMesh);

  let glassMat = null;
  if (geos.glass) {
    glassMat = new THREE.MeshStandardMaterial({
      color: 0xdcefff, transparent: true, opacity: 0.2, roughness: 0.04, metalness: 0.1, depthWrite: false,
    });
    const glass = new THREE.Mesh(geos.glass, glassMat);
    glass.castShadow = true;
    glass.renderOrder = 2;
    head.add(glass);
  }

  // Exhaust tip markers (for boost flames).
  const exhausts = EXHAUST_TIPS.map((p, i) => {
    const o = new THREE.Object3D();
    o.name = `exhaust${i}`;
    o.position.fromArray(p);
    body.add(o);
    return o;
  });

  // Wheel "bones" (empty transforms) + one InstancedMesh drawing all 4 wheels.
  const steerPivots = {};
  const wheels = {};
  for (const k of ['fl', 'fr', 'rl', 'rr']) {
    const bone = new THREE.Object3D();
    bone.name = `wheel_${k}`;
    if (k[0] === 'f') {
      const pivot = new THREE.Object3D();
      pivot.name = `steer_${k}`;
      pivot.position.fromArray(WHEEL_POS[k]);
      bone.scale.setScalar(FRONT_WHEEL_SCALE);
      pivot.add(bone);
      root.add(pivot);
      steerPivots[k] = pivot;
    } else {
      bone.position.fromArray(WHEEL_POS[k]);
      root.add(bone);
    }
    wheels[k] = bone;
  }
  const wheelMesh = new THREE.InstancedMesh(geos.wheel, wheelMaterial(), 4);
  wheelMesh.name = 'wheels';
  wheelMesh.castShadow = true;
  wheelMesh.receiveShadow = true;
  root.add(wheelMesh);
  const order = ['fl', 'fr', 'rl', 'rr'];
  const syncWheels = () => {
    for (let i = 0; i < 4; i++) {
      const k = order[i];
      const bone = wheels[k];
      bone.updateMatrix();
      if (k[0] === 'f') {
        const pivot = steerPivots[k];
        pivot.updateMatrix();
        _wm.multiplyMatrices(pivot.matrix, bone.matrix);
      } else {
        _wm.copy(bone.matrix);
      }
      wheelMesh.setMatrixAt(i, _wm);
    }
    wheelMesh.instanceMatrix.needsUpdate = true;
  };
  syncWheels();
  wheelMesh.computeBoundingSphere();
  // a little slack so steering/spin never culls a wheel
  if (wheelMesh.boundingSphere) wheelMesh.boundingSphere.radius += 0.2;

  root.userData = {
    character: def,
    body,
    driver,
    head,
    wheels,
    steerPivots,
    exhausts,
    rearWheelL: wheels.rl,
    rearWheelR: wheels.rr,
    tintMaterials: [paint],
    wheelMesh,
    syncWheels,
    wheelRadius: { front: WHEEL_RADIUS_FRONT, rear: WHEEL_RADIUS_REAR },
    kartScale,
    ownedMaterials: glassMat ? [paint, glassMat] : [paint],
  };
  return root;
}

// Free the per-kart GPU resources of a model built by buildKartModel (its
// materials and the wheel instance buffer). Geometries are cached and shared
// between models of the same character, so they stay.
export function disposeKartModel(model) {
  const ud = model && model.userData;
  if (!ud) return;
  if (ud.ownedMaterials) for (const m of ud.ownedMaterials) m.dispose();
  ud.ownedMaterials = [];
  if (ud.wheelMesh && ud.wheelMesh.dispose) ud.wheelMesh.dispose();
  ud.wheelMesh = null;
}
