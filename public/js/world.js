// World builder for "Breezy Bay Circuit" (browser only).
//
//   import { buildWorld } from './world.js';
//   const world = buildWorld(scene, track, { renderer, quality: 'high' });
//   // every frame:
//   world.update(dt, playerKart.position, camera);
//   // teardown:
//   world.dispose();
//
// Everything visual that is static to the course lives here: sky, fog,
// lights (the shadow-casting sun follows the focus position), terrain with
// embankments / cliffs / beaches, the animated bay, the road ribbon (exactly
// at physics height), curbs, off-road strips, barriers at exactly
// wallL / wallR, the arch bridge, start gantry, grid marks, boost pads,
// kicker ramps, corner signs, lighthouse, grandstands with a crowd, flags,
// instanced vegetation, distant mountains, clouds and sailboats.
// Item boxes are NOT built here (items.js owns them).
//
// Geography (x right, z "down" on a map seen from above):
//   * the sea fills the south-west; the bay reaches north to the Bay Bridge
//     and wraps a lagoon behind it, at the foot of Breezy Hill's rocky face;
//   * the Lighthouse Hairpin sits on a headland, the lighthouse on its tip;
//   * the Cliff Sweeps run along a sea cliff on the south coast;
//   * grandstands flank the start straight on the east side.
//
// Performance: static geometry is merged per material, repeated props use
// InstancedMesh. Budget at quality 'high': < 120 draw calls, < 250k tris.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CURB_WIDTH } from './track.js';
import { GAME_TITLE } from './config.js';
import { makeRng, clamp, lerp, smoothstep } from './utils.js';
import * as TX from './textures.js';

// ------------------------------------------------------------------ constants

export const WATER_LEVEL = -1.6;           // sea surface height (m)
const SEABED = -7.5;                       // deepest terrain under the bay
const CLIFF_SLOPE = 3.2;                   // sea-cliff face steepness (m drop per m)
const CLIFF_SHOULDER = 0.9;                // flat cliff-top lip beyond the wall (m)
const MIN_CAMERA_FAR = 1900;               // view distance the scenery is designed for

const QUALITY = {
  high: { shadowMap: 2048, terrainCell: 3.5, veg: 1.0, crowd: 1.0, clouds: 16, depthTex: 1024, aniso: 8 },
  low:  { shadowMap: 1024, terrainCell: 5.5, veg: 0.45, crowd: 0.5, clouds: 9, depthTex: 512, aniso: 4 },
};

// Palette (sRGB hex). Bright, saturated, friendly.
const C = {
  skyTop: 0x3c8fe8, skyHorizon: 0xcfeafb, skyBottom: 0xb6dcf3,
  sun: 0xfff2dc, hemiSky: 0xd7ecff, hemiGround: 0x7d9a55,
  grass: 0x5cbc43, grassAlt: 0x78c94b, grassDeep: 0x46a336, meadow: 0x9fd25a,
  sand: 0xf0db9b, sandWet: 0xd8c084, rock: 0x9c9284, rockDark: 0x7b7267, seabed: 0xd3c088,
  farLand: 0x5f9f4f, concrete: 0xd4d1ca, concreteDark: 0xa9a59d, steel: 0xf05a28,
  white: 0xf7f6f2, red: 0xe5302a, blue: 0x2b6fd8, yellow: 0xffcf33, wood: 0x9a6a3c,
  trunk: 0x7a5232, pine: 0x2f8a46, leaf: 0x58b544, palmLeaf: 0x4fb04a, bush: 0x4aa83e,
  waterShallow: 0x5fe0d2, waterDeep: 0x1f7fc4, waterSky: 0xbfe6ff, foam: 0xffffff,
};

// Sea outline (x, z): everything inside the polygon is sea / bay.
const SEA_POLY = [
  [-3200, -3200], [3200, -3200], [3200, -700], [900, -430], [320, -215], [140, -118], [62, -80], [24, -62],
  [17, -85], [2, -107], [-20, -121], [-46, -127], [-76, -127], [-101, -122], [-123, -107], [-138, -85], [-144, -60],
  [-150, -30], [-151, 0], [-150, 26], [-150, 44], [-153, 58], [-160, 66],
  [-166, 96], [-182, 106], [-210, 108], [-240, 108], [-257, 104], [-262, 92], [-265, 77],
  [-292, 64], [-322, 72], [-350, 98], [-354, 124], [-342, 150], [-336, 170], [-390, 192], [-560, 220],
  [-1000, 250], [-3200, 280],
];
// Raised rocky mounds: the lighthouse headland tip and a little palm islet in the bay.
const ISLETS = [
  { x: -338, z: 108, r: 24, h: 3.6 },
  { x: -248, z: -58, r: 16, h: 2.4 },
];
const LIGHTHOUSE = { x: -338, z: 108 };
const WORLD_CENTER = { x: -150, z: 20 };

// ------------------------------------------------------------------ small math

const _col = new THREE.Color();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _eul = new THREE.Euler();
const _p3 = new THREE.Vector3();
const _s3 = new THREE.Vector3();

function hash2(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}
function fbm(x, z, octaves = 4) {
  let s = 0, a = 1, t = 0;
  for (let o = 0; o < octaves; o++) { s += vnoise(x, z) * a; t += a; a *= 0.5; x *= 2.03; z *= 2.03; }
  return s / t;
}

// Signed distance to the sea outline: + on land, - at sea.
const SEA_X = new Float64Array(SEA_POLY.map((p) => p[0]));
const SEA_Z = new Float64Array(SEA_POLY.map((p) => p[1]));
function coastDistance(x, z) {
  const n = SEA_X.length;
  let inside = false, best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = SEA_X[i], zi = SEA_Z[i], xj = SEA_X[j], zj = SEA_Z[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const ex = xi - xj, ez = zi - zj, l2 = ex * ex + ez * ez;
    let t = l2 > 0 ? ((x - xj) * ex + (z - zj) * ez) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (xj + ex * t), dz = z - (zj + ez * t);
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  const d = Math.sqrt(best);
  return inside ? -d : d;
}

// Place a geometry: rotation (Euler YXZ: yaw, pitch, roll), translation, scale.
function place(geom, x, y, z, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _eul.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_eul);
  _m4.compose(_p3.set(x, y, z), _q, _s3.set(sx, sy, sz));
  return geom.applyMatrix4(_m4);
}

// Make a geometry merge-compatible: indexed, has uv, has a color attribute
// (filled with `color` unless one exists and color is null).
function paint(geom, color) {
  const n = geom.attributes.position.count;
  if (!geom.index) {
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!geom.attributes.normal) geom.computeVertexNormals();
  if (!geom.attributes.uv) geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (color !== null && color !== undefined) {
    _col.set(color);
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b; }
    geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  return geom;
}

// Color each face of a non-indexed geometry with fn(centroidY, normalY) -> hex/Color.
function faceColors(geom, fn) {
  const pos = geom.attributes.position, n = pos.count;
  const arr = new Float32Array(n * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    nrm.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    const col = fn((a.y + b.y + c.y) / 3, nrm.y, i / 3);
    _col.set(col);
    for (let k = 0; k < 3; k++) { arr[(i + k) * 3] = _col.r; arr[(i + k) * 3 + 1] = _col.g; arr[(i + k) * 3 + 2] = _col.b; }
  }
  geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geom;
}

const mixHex = (a, b, t) => _col.set(a).lerp(new THREE.Color(b), clamp(t, 0, 1)).getHex();

// ------------------------------------------------------------------ track strips

// Build an indexed strip following the track. `sList` = arc lengths of the
// rows; `cols` columns per row; fn(frame, s, c, o, r) sets o.lat (lateral),
// o.dy (height offset), optional o.y (absolute base height, default road
// centerline height), o.u / o.v and (with color) o.r / o.g / o.b.
// Column order must go left -> right (increasing lateral) for an upward face;
// in general the face normal is (col1 - col0) x forward.
const _frame = {};
function trackStrip(track, sList, cols, fn, { color = false } = {}) {
  const rows = sList.length, nv = rows * cols;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const col = color ? new Float32Array(nv * 3) : null;
  const o = { lat: 0, dy: 0, y: NaN, u: 0, v: 0, r: 1, g: 1, b: 1 };
  let p = 0, q = 0;
  for (let r = 0; r < rows; r++) {
    const s = sList[r];
    track.frameAt(s, _frame);
    for (let c = 0; c < cols; c++) {
      o.y = NaN; o.dy = 0;
      fn(_frame, s, c, o, r);
      const base = Number.isNaN(o.y) ? _frame.y : o.y;
      pos[p] = _frame.x + _frame.right.x * o.lat;
      pos[p + 1] = base + o.dy;
      pos[p + 2] = _frame.z + _frame.right.z * o.lat;
      if (col) { col[p] = o.r; col[p + 1] = o.g; col[p + 2] = o.b; }
      p += 3;
      uv[q++] = o.u; uv[q++] = o.v;
    }
  }
  const idx = new (nv > 65535 ? Uint32Array : Uint16Array)((rows - 1) * (cols - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, c2 = a + cols, d = c2 + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = c2;
      idx[k++] = b; idx[k++] = d; idx[k++] = c2;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// Arc lengths from s0 to s1 (s1 may exceed L; frameAt wraps) with ~step spacing.
function sRange(s0, s1, step) {
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const out = new Array(n + 1);
  for (let i = 0; i <= n; i++) out[i] = s0 + ((s1 - s0) * i) / n;
  return out;
}

// Weight of arc length s inside zone z: 1 inside, falling to 0 over `soft` m outside.
function zoneWeight(track, z, s, soft) {
  const len = track.forwardDistance(z.s0, z.s1);
  const d = track.forwardDistance(z.s0, s);
  if (d <= len) return 1;
  const out = Math.min(d - len, track.length - d);
  return 1 - smoothstep(out / soft);
}
// Weight that is 0 at the zone ends and 1 deeper than `ramp` m inside.
function zoneInterior(track, z, s, ramp) {
  const len = track.forwardDistance(z.s0, z.s1);
  const d = track.forwardDistance(z.s0, s);
  if (d > len) return 0;
  return smoothstep(Math.min(d, len - d) / ramp);
}
function inZone(track, z, s) {
  return track.forwardDistance(z.s0, s) <= track.forwardDistance(z.s0, z.s1);
}

// ------------------------------------------------------------------ terrain field

// Height function of the landscape. Natural ground (land, beaches, seabed,
// hills far from the track) is combined with embankment fills / cuts from
// every nearby track section, and pinned flat just under the road surface
// inside each wall corridor (+ a shoulder) so no road section ever floats.
function createTerrainField(track, cellSize) {
  const N = track.N, sp = track.spacing;
  const { px, py, pz, rx, rz, wl, wr } = track;
  const fillL = new Float32Array(N).fill(0.55), fillR = new Float32Array(N).fill(0.55);
  const shL = new Float32Array(N).fill(4.0), shR = new Float32Array(N).fill(4.0);
  const bridge = new Float32Array(N);
  const cliff = new Float32Array(N);       // sea-cliff strength (left side), 0 at the zone ends
  for (let i = 0; i < N; i++) {
    const s = i * sp;
    for (const z of track.zones) {
      if (z.type === 'bridge') bridge[i] = Math.max(bridge[i], zoneInterior(track, z, s, 14));
      else if (z.type === 'hill') fillR[i] = lerp(fillR[i], 1.25, zoneWeight(track, z, s, 14));
      else if (z.type === 'cliff') {
        const w = zoneWeight(track, z, s, 10);
        cliff[i] = Math.max(cliff[i], zoneInterior(track, z, s, 18));
        fillL[i] = lerp(fillL[i], CLIFF_SLOPE, w);
        shL[i] = lerp(shL[i], CLIFF_SHOULDER, w);
      }
    }
  }

  // Chunked bounding circles over the samples for fast neighbourhood queries.
  const CH = 8, nCh = Math.ceil(N / CH);
  const chX = new Float64Array(nCh), chZ = new Float64Array(nCh), chR = new Float64Array(nCh);
  for (let c = 0; c < nCh; c++) {
    const i0 = c * CH, i1 = Math.min(N, i0 + CH);
    let sx = 0, sz = 0;
    for (let i = i0; i < i1; i++) { sx += px[i]; sz += pz[i]; }
    chX[c] = sx / (i1 - i0); chZ[c] = sz / (i1 - i0);
    let r = 0;
    for (let i = i0; i < i1; i++) r = Math.max(r, Math.hypot(px[i] - chX[c], pz[i] - chZ[c]));
    chR[c] = r;
  }
  const INF_R = 75, INF_R2 = INF_R * INF_R;
  const d2 = new Float64Array(N).fill(Infinity);
  const touched = new Int32Array(N);
  const MAXS = 48;
  const secI = new Int32Array(MAXS), secE = new Float64Array(MAXS), secR = new Uint8Array(MAXS);

  // Finds every track section near (x, z): local minima of distance along the
  // sample sequence. Fills secI (sample), secE (distance beyond the wall,
  // negative inside the corridor), secR (1 = right side). Returns the count.
  function sections(x, z) {
    let nt = 0;
    for (let c = 0; c < nCh; c++) {
      const dx = x - chX[c], dz = z - chZ[c], rr = INF_R + chR[c];
      if (dx * dx + dz * dz > rr * rr) continue;
      const i1 = Math.min(N, (c + 1) * CH);
      for (let i = c * CH; i < i1; i++) {
        const ex = x - px[i], ez = z - pz[i];
        d2[i] = ex * ex + ez * ez;
        touched[nt++] = i;
      }
    }
    let ns = 0;
    for (let k = 0; k < nt; k++) {
      const i = touched[k], di = d2[i];
      if (di > INF_R2) continue;
      if (di <= d2[(i - 1 + N) % N] && di < d2[(i + 1) % N] && ns < MAXS) {
        const lat = (x - px[i]) * rx[i] + (z - pz[i]) * rz[i];
        const right = lat >= 0;
        secI[ns] = i; secR[ns] = right ? 1 : 0;
        secE[ns] = Math.abs(lat) - (right ? wr[i] : wl[i]);
        ns++;
      }
    }
    for (let k = 0; k < nt; k++) d2[touched[k]] = Infinity;
    return ns;
  }

  function natural(x, z, minE, sd) {
    let h;
    if (sd >= 0) {
      const rc = Math.hypot(x - WORLD_CENTER.x, z - WORLD_CENTER.z);
      const amp = lerp(9, 46, smoothstep((rc - 380) / 1000)) *
        smoothstep((minE - 18) / 95) * smoothstep((sd - 6) / 60);
      const n = fbm(x * 0.0062 + 3.1, z * 0.0062 - 1.7, 4);
      h = 0.35 * smoothstep(sd / 9) + amp * Math.max(0, n - 0.3) * 1.9;
    } else {
      h = Math.max(SEABED, -0.35 + sd * 0.2);
    }
    for (const isl of ISLETS) {
      const d = Math.hypot(x - isl.x, z - isl.z);
      if (d < isl.r) {
        const t = smoothstep((1 - d / isl.r) / 0.65);
        const bump = lerp(SEABED + 2, isl.h, t) + (fbm(x * 0.15, z * 0.15, 2) - 0.5) * 1.2 * t;
        if (bump > h) h = bump;
      }
    }
    return h;
  }

  // Exact height (slow-ish: used to build the grid).
  function heightAt(x, z, sd = coastDistance(x, z)) {
    const ns = sections(x, z);
    let minE = Infinity;
    for (let k = 0; k < ns; k++) if (secE[k] < minE) minE = secE[k];
    let h = natural(x, z, minE, sd);
    // embankment fills (raise terrain toward elevated road)
    for (let k = 0; k < ns; k++) {
      const i = secI[k], e = secE[k], right = secR[k];
      const y0 = py[i] - 0.25, b = bridge[i];
      const sh = right ? shR[i] : shL[i], sl = right ? fillR[i] : fillL[i];
      const f = y0 - b * 16 - sl * Math.max(0, e - sh);
      if (f > h) h = f;
    }
    // cuts (terrain never above the road corridor; under the bridge: seabed)
    for (let k = 0; k < ns; k++) {
      const i = secI[k], e = secE[k], right = secR[k];
      const y0 = py[i] - 0.25, b = bridge[i];
      const sh = right ? shR[i] : shL[i];
      const top = lerp(y0, SEABED, b), slope = lerp(0.8, 1.3, b);
      const c = top + slope * Math.max(0, e - lerp(sh, 1.5, b));
      if (c < h) h = c;
    }
    // sea cliffs: the sea side of cliff sections plunges steeply to deep water
    for (let k = 0; k < ns; k++) {
      const i = secI[k];
      if (secR[k] || cliff[i] <= 0) continue;
      const drop = Math.max(SEABED, py[i] - 0.25 - CLIFF_SLOPE * Math.max(0, secE[k] - shL[i]));
      if (drop < h) h = lerp(h, drop, cliff[i]);
    }
    // pins: flat, just below the road, inside corridor + shoulder
    for (let k = 0; k < ns; k++) {
      const i = secI[k];
      if (bridge[i] > 0) continue;
      if (secE[k] <= (secR[k] ? shR[i] : shL[i])) h = py[i] - 0.25;
    }
    return h;
  }

  // Tensor-product grid: uniform cells over the course, growing geometrically outside.
  const b = track.bounds;
  const core = { x0: Math.floor(b.minX - 58), x1: Math.ceil(b.maxX + 52), z0: Math.floor(b.minZ - 60), z1: Math.ceil(b.maxZ + 56) };
  function axis(a0, a1, cell, ext) {
    const n = Math.max(2, Math.round((a1 - a0) / cell));
    const st = (a1 - a0) / n;
    const before = [], after = [];
    let step = st, p = a1;
    while (p < a1 + ext) { step *= 1.36; p += step; after.push(p); }
    step = st; p = a0;
    while (p > a0 - ext) { step *= 1.36; p -= step; before.push(p); }
    const arr = [...before.reverse()];
    for (let k = 0; k <= n; k++) arr.push(a0 + k * st);
    arr.push(...after);
    return { arr: new Float64Array(arr), i0: before.length, i1: before.length + n, step: st };
  }
  const ax = axis(core.x0, core.x1, cellSize, 2600);
  const az = axis(core.z0, core.z1, cellSize, 2600);
  const xs = ax.arr, zs = az.arr, nx = xs.length, nz = zs.length;
  const H = new Float32Array(nx * nz), SD = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xs[i], z = zs[j];
      const sd = coastDistance(x, z);
      SD[j * nx + i] = sd;
      H[j * nx + i] = heightAt(x, z, sd);
    }
  }

  function findCell(arr, v) {
    let lo = 0, hi = arr.length - 1;
    if (v <= arr[0]) return 0;
    if (v >= arr[hi]) return hi - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid; else hi = mid; }
    return lo;
  }
  // Height of the rendered (triangulated) terrain surface at (x, z).
  function surfaceHeight(x, z) {
    const i = findCell(xs, x), j = findCell(zs, z);
    const fx = clamp((x - xs[i]) / (xs[i + 1] - xs[i]), 0, 1);
    const fz = clamp((z - zs[j]) / (zs[j + 1] - zs[j]), 0, 1);
    const h00 = H[j * nx + i], h10 = H[j * nx + i + 1], h01 = H[(j + 1) * nx + i], h11 = H[(j + 1) * nx + i + 1];
    // diagonal (i,j)-(i+1,j+1), matching the mesh triangulation
    if (fx >= fz) return h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    return h00 + (h11 - h01) * fx + (h01 - h00) * fz;
  }

  // Clearance of (x, z) from the drivable corridor: min distance beyond any wall.
  function wallClearance(x, z) {
    const ns = sections(x, z);
    let minE = Infinity;
    for (let k = 0; k < ns; k++) if (secE[k] < minE) minE = secE[k];
    return minE;
  }

  return { xs, zs, nx, nz, H, SD, core, coreIdx: { i0: ax.i0, i1: ax.i1, j0: az.i0, j1: az.i1 },
    heightAt, surfaceHeight, wallClearance, bridge, cliff, fillL, fillR, shL, shR };
}

// ------------------------------------------------------------------ buildWorld

export function buildWorld(scene, track, { renderer = null, quality = 'high' } = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const Q = QUALITY[quality] || QUALITY.high;
  const maxAniso = renderer ? Math.min(Q.aniso, renderer.capabilities.getMaxAnisotropy()) : 4;
  const N = track.N, L = track.length, sp = track.spacing;

  const root = new THREE.Group();
  root.name = 'World';
  scene.add(root);

  const textures = [];          // every texture we create (disposed in dispose())
  const animators = [];         // (dt, time, camera) callbacks run by update()
  // stats.props: footprint circles [x, z, radius, kind] of everything placed
  // beside the track (used by the sandbox / tools to prove nothing intrudes
  // on the drivable area).
  const stats = { instances: {}, buildMs: 0, props: [] };
  const prop = (kind, x, z, r) => { stats.props.push([x, z, r, kind]); };
  const tex = (t) => { textures.push(t); return t; };
  const add = (obj, { cast = false, receive = false, name = '' } = {}) => {
    obj.castShadow = cast; obj.receiveShadow = receive;
    if (name) obj.name = name;
    root.add(obj);
    return obj;
  };
  const timeUniform = { value: 0 };

  const prevFog = scene.fog, prevBackground = scene.background;

  // ---------------------------------------------------------------- sky + fog
  // Sun ~59° high, from the side of the start/home straights (-x, slightly
  // +z): kart shadows fall beside the karts in the chase view there, and the
  // high elevation keeps them close under the karts everywhere else.
  const sunDir = new THREE.Vector3(-0.46, 0.84, 0.2).normalize();
  scene.fog = new THREE.Fog(C.skyHorizon, 220, 1650);
  scene.background = new THREE.Color(C.skyHorizon);

  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(C.skyTop) },
      uHorizon: { value: new THREE.Color(C.skyHorizon) },
      uBottom: { value: new THREE.Color(C.skyBottom) },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(0xfff6e0) },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = vec4(p.xy, p.w * 0.99999, p.w);   // always on the far plane
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uHorizon, uBottom, uSunDir, uSunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0
          ? mix(uHorizon, uTop, pow(smoothstep(0.0, 0.72, h), 0.75))
          : mix(uHorizon, uBottom, smoothstep(0.0, -0.2, h));
        float sd = max(dot(d, uSunDir), 0.0);
        col += uSunColor * (pow(sd, 6.0) * 0.12 + pow(sd, 90.0) * 0.45);
        col = mix(col, vec3(1.0, 0.99, 0.94), smoothstep(0.99935, 0.99965, sd));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
    toneMapped: false,
  });
  const sky = add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat), { name: 'Sky' });
  sky.frustumCulled = false;
  sky.renderOrder = -1000;

  // ---------------------------------------------------------------- lights
  const hemi = add(new THREE.HemisphereLight(C.hemiSky, C.hemiGround, 1.35), { name: 'Hemi' });
  const sun = new THREE.DirectionalLight(C.sun, 2.7);
  sun.name = 'Sun';
  sun.castShadow = true;
  // Tight 70 m shadow box; the light sits SUN_DIST m up-sun of the focus and
  // the depth range only spans what can shade the box (tall props included),
  // which keeps depth precision high so the bias can stay small.
  const SHADOW_HALF = 35, SUN_DIST = 150;
  sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
  Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: SUN_DIST - 90, far: SUN_DIST + 60 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.00022;      // ~3 cm over the 150 m depth range
  sun.shadow.normalBias = 0.028;   // ~0.8 texel
  sun.shadow.radius = 2.2;
  root.add(sun);
  root.add(sun.target);
  // light-space basis for texel snapping (prevents shadow shimmer while moving)
  const lightRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize();
  const lightUp = new THREE.Vector3().crossVectors(sunDir, lightRight).normalize();
  const shadowTexel = (SHADOW_HALF * 2) / Q.shadowMap;

  // ---------------------------------------------------------------- textures
  const T = {
    asphalt: tex(TX.createAsphaltTexture({ aniso: maxAniso })),
    curb: tex(TX.createCurbTexture({ aniso: maxAniso })),
    grassStrip: tex(TX.createGrassTexture({ aniso: maxAniso, stripes: true })),
    detail: tex(TX.createDetailTexture({ aniso: maxAniso })),
    rock: tex(TX.createRockTexture({ aniso: maxAniso })),
    dirt: tex(TX.createDirtTexture({ aniso: maxAniso })),
    checker: tex(TX.createCheckerTexture({ aniso: maxAniso })),
    chevron: tex(TX.createChevronTexture({ aniso: maxAniso })),
    hazard: tex(TX.createHazardTexture({ aniso: maxAniso })),
    rampTop: tex(TX.createRampTopTexture({ aniso: maxAniso })),
    wall: tex(TX.createWallAtlasTexture({ aniso: maxAniso })),
    banner: tex(TX.createBannerTexture(GAME_TITLE, { aniso: maxAniso })),
    sign: tex(TX.createTurnSignTexture({ aniso: maxAniso })),
    waterN: tex(TX.createWaterNormalTexture()),
  };
  T.wall.wrapT = THREE.ClampToEdgeWrapping;

  // Shared materials
  const M = {
    structure: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    veg: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  };

  // ---------------------------------------------------------------- terrain
  const field = createTerrainField(track, Q.terrainCell);
  const loopS = new Array(N + 1);
  for (let i = 0; i <= N; i++) loopS[i] = i * sp;

  // Weight of the bridge zone at arc length s (1 = on the bridge deck).
  const bridgeZone = track.zones.find((z) => z.type === 'bridge') || null;
  const isBridge = (s) => (bridgeZone ? inZone(track, bridgeZone, s) : false);

  {
    const { xs, zs, nx, nz, H, SD } = field;
    const nv = nx * nz;
    const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3);
    const cGrass = new THREE.Color(C.grass), cAlt = new THREE.Color(C.grassAlt), cDeep = new THREE.Color(C.grassDeep);
    const cMeadow = new THREE.Color(C.meadow), cSand = new THREE.Color(C.sand), cWet = new THREE.Color(C.sandWet);
    const cRock = new THREE.Color(C.rock), cRockD = new THREE.Color(C.rockDark), cSea = new THREE.Color(C.seabed);
    const cFar = new THREE.Color(C.farLand), c = new THREE.Color(), tmp = new THREE.Color();
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i, x = xs[i], z = zs[j], h = H[k], sd = SD[k];
        pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
        uv[k * 2] = x / 9; uv[k * 2 + 1] = z / 9;
        // slope from neighbours
        const il = Math.max(0, i - 1), ir = Math.min(nx - 1, i + 1), jl = Math.max(0, j - 1), jr = Math.min(nz - 1, j + 1);
        const gx = (H[j * nx + ir] - H[j * nx + il]) / (xs[ir] - xs[il]);
        const gz = (H[jr * nx + i] - H[jl * nx + i]) / (zs[jr] - zs[jl]);
        const slope = Math.hypot(gx, gz);
        // grass with soft variation and meadow patches
        const n1 = fbm(x * 0.022, z * 0.022, 3), n2 = fbm(x * 0.006 + 7, z * 0.006 - 3, 3);
        c.copy(cGrass).lerp(cAlt, smoothstep((n1 - 0.35) / 0.35));
        c.lerp(cDeep, smoothstep((0.42 - n1) / 0.2) * 0.6);
        c.lerp(cMeadow, smoothstep((n2 - 0.6) / 0.15) * 0.55);
        const rc = Math.hypot(x - WORLD_CENTER.x, z - WORLD_CENTER.z);
        c.lerp(cFar, smoothstep((rc - 450) / 600) * 0.7);
        // beaches
        const beach = smoothstep((WATER_LEVEL + 1.35 - h) / 0.6) * smoothstep((28 - sd) / 10);
        c.lerp(tmp.copy(cSand).lerp(cWet, smoothstep((WATER_LEVEL + 0.3 - h) / 0.5)), beach);
        // seabed
        if (h < WATER_LEVEL - 0.25) c.copy(cSea).lerp(cWet, smoothstep((WATER_LEVEL - 1 - h) / 4) * 0.5);
        // steep faces → rock
        const rock = smoothstep((slope - 0.5) / 0.5);
        c.lerp(tmp.copy(cRock).lerp(cRockD, n1), rock);
        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      }
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let q = 0;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c2 = a + nx, d = c2 + 1;
        idx[q++] = a; idx[q++] = d; idx[q++] = b;      // diagonal a-d (see surfaceHeight)
        idx[q++] = a; idx[q++] = c2; idx[q++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: T.detail, flatShading: true });
    add(new THREE.Mesh(g, mat), { receive: true, name: 'Terrain' });
  }

  // ---------------------------------------------------------------- water
  {
    // Water depth map (R8): covers the course plus a wide margin; the shader
    // fades to "deep" toward its border so the turquoise shallows never stop
    // along a straight line. depth = WATER_LEVEL - ground, encoded over [-1, 8] m.
    const { core } = field;
    const res = Q.depthTex;
    const pad = 420;
    const rx0 = core.x0 - pad, rz0 = core.z0 - pad;
    const w = core.x1 - core.x0 + pad * 2, hgt = core.z1 - core.z0 + pad * 2;
    const data = new Uint8Array(res * res);
    for (let j = 0; j < res; j++) {
      const z = rz0 + ((j + 0.5) / res) * hgt;
      for (let i = 0; i < res; i++) {
        const x = rx0 + ((i + 0.5) / res) * w;
        const depth = WATER_LEVEL - field.surfaceHeight(x, z);
        data[j * res + i] = Math.round(clamp((depth + 1) / 9, 0, 1) * 255);
      }
    }
    const depthTex = tex(new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.UnsignedByteType));
    depthTex.magFilter = THREE.LinearFilter; depthTex.minFilter = THREE.LinearFilter;
    depthTex.needsUpdate = true;

    const waterMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 },
        uDepth: { value: null },
        uNormal: { value: null },
        uRect: { value: new THREE.Vector4(rx0, rz0, 1 / w, 1 / hgt) },
        uSunDir: { value: sunDir.clone() },
        uSunColor: { value: new THREE.Color(0xfff4dc) },
        uShallow: { value: new THREE.Color(C.waterShallow) },
        uDeep: { value: new THREE.Color(C.waterDeep) },
        uSkyHorizon: { value: new THREE.Color(C.waterSky) },
        uSkyTop: { value: new THREE.Color(C.skyTop) },
        uFoam: { value: new THREE.Color(C.foam) },
      }]),
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform sampler2D uDepth, uNormal;
        uniform vec4 uRect;
        uniform vec3 uSunDir, uSunColor, uShallow, uDeep, uSkyHorizon, uSkyTop, uFoam;
        varying vec3 vWorld;
        #include <common>
        #include <fog_pars_fragment>
        void main() {
          // depth below the surface (fades to deep toward the map border)
          vec2 duv = (vWorld.xz - uRect.xy) * uRect.zw;
          vec2 ed = min(duv, 1.0 - duv);
          float inMap = smoothstep(0.0, 0.1, min(ed.x, ed.y));
          float depth = mix(8.0, texture2D(uDepth, clamp(duv, 0.0, 1.0)).r * 9.0 - 1.0, inMap);

          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          vec3 V = toCam / dist;
          vec2 p = vWorld.xz;
          vec4 s1 = texture2D(uNormal, p * 0.031 + vec2(uTime * 0.011, uTime * 0.007));
          vec4 s2 = texture2D(uNormal, p * 0.077 + vec2(-uTime * 0.016, uTime * 0.012));
          vec2 nxy = (s1.xy * 2.0 - 1.0) + (s2.xy * 2.0 - 1.0) * 0.7;
          // ripples calm down with distance (no aliasing / milky streaks far away)
          float rip = mix(0.36, 0.07, smoothstep(25.0, 420.0, dist));
          vec3 n = normalize(vec3(nxy.x * rip, 1.0, nxy.y * rip));

          // Sky reflection uses a heavily damped normal: a smooth fresnel
          // gradient instead of white blotches. Glints use the detailed one.
          vec3 nF = normalize(vec3(nxy.x * rip * 0.3, 1.0, nxy.y * rip * 0.3));
          float ndv = max(dot(nF, V), 0.0);
          float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
          vec3 R = reflect(-V, n);
          vec3 sky = mix(uSkyHorizon, uSkyTop, smoothstep(0.02, 0.45, reflect(-V, nF).y));
          vec3 col = mix(uShallow, uDeep, smoothstep(0.15, 5.5, depth));
          col *= 0.94 + 0.12 * s2.b;                       // soft swell patches
          col = mix(col, sky, clamp(fres, 0.0, 0.55));

          // sun glint + twinkling sparkles
          float rs = max(dot(R, uSunDir), 0.0);
          col += uSunColor * (pow(rs, 700.0) * 4.0 + pow(rs, 60.0) * 0.18);
          float tw = texture2D(uNormal, p * 0.23 + vec2(uTime * 0.05, -uTime * 0.04)).b;
          float twk = smoothstep(0.8, 0.88, tw * s1.b * 1.45);
          col += uSunColor * twk * (smoothstep(0.9, 0.99, rs) * 1.6 + 0.12 * (1.0 - smoothstep(60.0, 220.0, dist)));

          // shoreline foam: an animated band hugging the beaches
          float wave = sin(uTime * 1.4 - depth * 4.0 + s1.b * 5.0);
          float edge = 1.0 - smoothstep(0.0, 0.45 + 0.22 * wave, depth);
          float foam = edge * smoothstep(0.32, 0.6, s2.b + edge * 0.45);
          col = mix(col, uFoam, clamp(foam, 0.0, 1.0) * 0.92);

          float alpha = mix(0.55, 0.96, smoothstep(0.0, 3.0, depth));
          alpha = max(alpha, foam);
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    waterMat.uniforms.uDepth.value = depthTex;
    waterMat.uniforms.uNormal.value = T.waterN;
    const cx = (core.x0 + core.x1) / 2, cz = (core.z0 + core.z1) / 2;
    const wg = new THREE.PlaneGeometry(5600, 5600, 8, 8).rotateX(-Math.PI / 2).translate(cx, WATER_LEVEL, cz);
    const water = add(new THREE.Mesh(wg, waterMat), { name: 'Water' });
    water.renderOrder = -10;
    animators.push((dt, time) => { waterMat.uniforms.uTime.value = time; });
  }

  // ---------------------------------------------------------------- road, curbs, off-road
  const roadTile = L / Math.max(1, Math.round(L / 16));
  const curbTile = L / Math.max(1, Math.round(L / 3));
  const curbWidth = (f, side) => clamp(Math.min(CURB_WIDTH, (side > 0 ? f.wallR : f.wallL) - f.halfWidth - 0.03), 0.12, CURB_WIDTH);
  {
    // Five columns (u = 0, .25, .5, .75, 1): where the width changes, a
    // two-column trapezoid would kink the painted lines (affine per-triangle
    // mapping); with a vertex column on the center line it stays straight.
    const ROAD_U = [0, 0.25, 0.5, 0.75, 1];
    const road = trackStrip(track, loopS, ROAD_U.length, (f, s, c, o) => {
      o.lat = (ROAD_U[c] * 2 - 1) * f.halfWidth;
      o.u = ROAD_U[c]; o.v = s / roadTile;
    });
    const mat = new THREE.MeshStandardMaterial({ map: T.asphalt, roughness: 0.88, metalness: 0.0 });
    add(new THREE.Mesh(road, mat), { receive: true, name: 'Road' });

    // Curbs: beveled profile, raised 7 cm, on both edges.
    const prof = [[0, 0.004], [0.28, 0.07], [0.93, 0.07], [1.0, 0.0]];
    const curbs = [];
    for (const side of [-1, 1]) {
      curbs.push(trackStrip(track, loopS, 4, (f, s, c, o) => {
        const k = side > 0 ? c : 3 - c;
        const cw = curbWidth(f, side);
        o.lat = side * (f.halfWidth + prof[k][0] * cw);
        o.dy = prof[k][1];
        o.u = prof[k][0]; o.v = s / curbTile;
      }));
    }
    const curbMat = new THREE.MeshStandardMaterial({ map: T.curb, roughness: 0.7 });
    add(new THREE.Mesh(mergeGeometries(curbs), curbMat), { receive: true, name: 'Curbs' });
    curbs.forEach((g) => g.dispose());

    // Off-road grass from the curb to just past the wall (concrete on the bridge).
    const cG = new THREE.Color(C.grass), cB = new THREE.Color(C.concrete), cc = new THREE.Color();
    const strips = [];
    for (const side of [-1, 1]) {
      strips.push(trackStrip(track, loopS, 2, (f, s, c, o) => {
        const k = side > 0 ? c : 1 - c;
        const wall = side > 0 ? f.wallR : f.wallL;
        const e = k ? wall + 0.55 : f.halfWidth + curbWidth(f, side);
        o.lat = side * e;
        o.u = o.lat / 12; o.v = s / 12;
        cc.copy(cG).lerp(cB, isBridge(s) ? 1 : 0);
        o.r = cc.r; o.g = cc.g; o.b = cc.b;
      }, { color: true }));
    }
    const grassMat = new THREE.MeshLambertMaterial({ map: T.grassStrip, vertexColors: true });
    add(new THREE.Mesh(mergeGeometries(strips), grassMat), { receive: true, name: 'Offroad' });
    strips.forEach((g) => g.dispose());
  }

  // ---------------------------------------------------------------- start line + grid marks
  {
    const hwAt = (s) => track.frameAt(s).halfWidth;
    const start = trackStrip(track, [-1.1, 0, 1.1], 2, (f, s, c, o) => {
      o.lat = (c ? 1 : -1) * f.halfWidth; o.dy = 0.012;
      o.u = (o.lat + f.halfWidth) / 2.2; o.v = (s + 1.1) / 2.2;
    });
    const mat = new THREE.MeshStandardMaterial({ map: T.checker, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    add(new THREE.Mesh(start, mat), { receive: true, name: 'StartLine' });

    // white "U" brackets in front of each grid slot
    const marks = [];
    const bar = (sA, sB, latA, latB) => trackStrip(track, sRange(sA, sB, 0.5), 2, (f, s, c, o) => {
      o.lat = c ? latB : latA; o.dy = 0.012; o.u = 0; o.v = 0;
    });
    for (let i = 0; i < 8; i++) {
      const g = track.gridSlot(i);
      const sF = g.s + 1.7, sB = g.s - 1.3, l = g.lateral;
      marks.push(bar(sF - 0.25, sF, l - 1.3, l + 1.3));
      marks.push(bar(sB, sF - 0.25, l - 1.3, l - 1.1));
      marks.push(bar(sB, sF - 0.25, l + 1.1, l + 1.3));
    }
    // a thin white line just behind the checker strip
    marks.push(bar(-1.5, -1.25, -hwAt(0), hwAt(0)));
    const markMat = new THREE.MeshLambertMaterial({ color: 0xf4f4ee, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    add(new THREE.Mesh(mergeGeometries(marks), markMat), { receive: true, name: 'GridMarks' });
    marks.forEach((g) => g.dispose());
  }

  // ---------------------------------------------------------------- walls
  // style per sample & side: 'red' | 'blue' | 'stone' | 'tires' | 'rail'
  const turnDir = (i) => Math.sign(track.curv[i]);
  const wallStyle = (i, side) => {
    const s = i * sp;
    for (const z of track.zones) {
      if (!inZone(track, z, s)) continue;
      if (z.type === 'bridge') return 'rail';
      if (z.type === 'hairpin' && side === -turnDir(i)) return 'tires';
      if (z.type === 'cliff' && side === -1) return 'stone';
    }
    if (s >= track.segments[track.segments.length - 1].s0 || s <= track.segments[1].s0) return 'blue';
    return 'red';
  };
  const tireSpots = [];   // [x, y, z, yaw] of tire stacks
  // Min distance of a circle (x, z, r) beyond the wall lines of the samples
  // around index i0 that it overlaps along the track (negative = intrudes).
  const stackClearance = (x, z, r, i0) => {
    let worst = Infinity;
    for (let k = -4; k <= 4; k++) {
      const i = (i0 + k + N) % N;
      const dx = x - track.px[i], dz = z - track.pz[i];
      if (Math.abs(dx * track.tx[i] + dz * track.tz[i]) > sp * 0.5 + r) continue;
      const lat = dx * track.rx[i] + dz * track.rz[i];
      worst = Math.min(worst, Math.abs(lat) - r - (lat >= 0 ? track.wr[i] : track.wl[i]));
    }
    return worst;
  };
  {
    const WALL_H = 0.95, WALL_T = 0.5, WALL_TILE = 6;
    const bandOf = { red: TX.WALL_BANDS.redWhite, blue: TX.WALL_BANDS.blueWhite, stone: TX.WALL_BANDS.stone };
    const geoms = [];
    for (const side of [-1, 1]) {
      // find runs of equal style starting at a style boundary
      const styles = new Array(N);
      for (let i = 0; i < N; i++) styles[i] = wallStyle(i, side);
      let startI = 0;
      while (startI < N && styles[startI] === styles[(startI - 1 + N) % N]) startI++;
      if (startI >= N) startI = 0;
      let k = 0;
      while (k < N) {
        const st = styles[(startI + k) % N];
        let len = 1;
        while (k + len < N && styles[(startI + k + len) % N] === st) len++;
        const iA = startI + k, iB = startI + k + len;          // rows iA..iB inclusive
        if (st === 'tires') {
          for (let s = iA * sp + 0.5; s < iB * sp; s += 1.0) {
            const f = track.frameAt(s);
            const wall = side > 0 ? f.wallR : f.wallL;
            // Start touching the wall line, then push outward while any sample
            // the stack overlaps sees it inside the corridor (the wall line runs
            // diagonally where the run-off narrows, e.g. into the bridge).
            let lat = side * (wall + 0.47), x = 0, z = 0;
            for (let it = 0; it < 12; it++) {
              x = f.x + f.right.x * lat; z = f.z + f.right.z * lat;
              const clr = stackClearance(x, z, 0.46, f.index);
              if (clr >= 0.005) break;
              lat += side * (0.005 - clr);
            }
            tireSpots.push([x, f.y - 0.05, z, f.yaw]);
          }
        } else if (st !== 'rail') {
          // extend barrier runs one sample into neighbouring tire runs to hide the ends
          const ext0 = styles[(iA - 1 + N) % N] === 'tires' ? 1 : 0;
          const ext1 = styles[iB % N] === 'tires' ? 1 : 0;
          const sList = sRange((iA - ext0) * sp, (iB + ext1) * sp, sp);
          const [v0, v1] = TX.wallBandV(bandOf[st]);
          const H = st === 'stone' ? 0.85 : WALL_H;
          const wallAt = (f) => (side > 0 ? f.wallR : f.wallL);
          // profile for the right side: inner face (up), top (outward), outer face (down)
          const faces = [
            [[0, -0.45], [0, H]],
            [[0, H], [WALL_T, H]],
            [[WALL_T, H], [WALL_T, -2.6]],
          ];
          for (const face of faces) {
            geoms.push(trackStrip(track, sList, 2, (f, s, c, o) => {
              const pt = side > 0 ? face[c] : face[1 - c];
              o.lat = side * (wallAt(f) + pt[0]);
              o.dy = pt[1];
              o.u = s / WALL_TILE;
              const isTop = face[0][1] === face[1][1];
              o.v = isTop ? v1 - 0.01 * (pt[0] / WALL_T) : lerp(v0, v1, clamp((pt[1] + 0.45) / (H + 0.45), 0, 1));
            }));
          }
        }
        k += len;
      }
    }
    const wallMat = new THREE.MeshLambertMaterial({ map: T.wall });
    add(new THREE.Mesh(mergeGeometries(geoms), wallMat), { cast: true, receive: true, name: 'Walls' });
    geoms.forEach((g) => g.dispose());

    // Tire stacks: three pinched tyres per stack, painted in bright colours,
    // with a dark hole on top. The stack's inner face touches the wall line.
    if (tireSpots.length) {
      const TR = 0.46, TH = 0.96;
      const tg = new THREE.CylinderGeometry(TR, TR, TH, 10, 3);
      const p = tg.attributes.position;
      const cols = new Float32Array(p.count * 3).fill(1);
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        if (Math.abs(Math.abs(y) - TH / 6) < 0.01) { p.setX(i, x * 0.8); p.setZ(i, z * 0.8); }   // seams between tyres
        if (y > TH / 2 - 0.001 && Math.hypot(x, z) < 0.001) cols.fill(0.06, i * 3, i * 3 + 3); // tyre hole
      }
      tg.translate(0, TH / 2, 0);
      tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      tg.computeVertexNormals();
      const inst = new THREE.InstancedMesh(tg, M.veg, tireSpots.length);
      const colors = [0xe8392f, 0xf5f5f0, 0x2f6fe0, 0xf5f5f0, 0xffc928, 0xf5f5f0];
      tireSpots.forEach(([x, y, z, yaw], i) => {
        place_m4(_m4, x, y, z, yaw + i * 0.7, 1, 1, 1);
        inst.setMatrixAt(i, _m4);
        inst.setColorAt(i, _col.set(colors[i % colors.length]));
        prop('tires', x, z, TR);
      });
      inst.computeBoundingSphere();
      add(inst, { cast: true, receive: true, name: 'TireStacks' });
      stats.instances.tires = tireSpots.length;
    }
  }

  // ---------------------------------------------------------------- bridge
  if (bridgeZone) {
    const parts = [];
    const z0 = bridgeZone.s0, z1 = bridgeZone.s1;
    const sList = sRange(z0, z1, 1.0);
    const wallAt = (f, side) => (side > 0 ? f.wallR : f.wallL);
    // Deck slab (profile traversed so every face points outward).
    const deckProfile = (f) => {
      const L0 = -(f.wallL + 0.75), R0 = f.wallR + 0.75;
      return [[f.wallR + 0.45, -0.02], [R0, -0.02], [R0, -1.15], [L0, -1.15], [L0, -0.02], [-(f.wallL + 0.45), -0.02]];
    };
    const deckCols = [C.concrete, C.white, C.concreteDark, C.white, C.concrete];
    for (let seg = 0; seg < 5; seg++) {
      const g = trackStrip(track, sList, 2, (f, s, c, o) => {
        const pts = deckProfile(f), pt = pts[seg + c];
        o.lat = pt[0]; o.dy = pt[1];
      });
      parts.push(paint(g, deckCols[seg]));
    }
    // Parapets (inner face exactly at the wall), posts and two rails per side.
    const parH = 0.42, parT = 0.36;
    for (const side of [-1, 1]) {
      const faces = [[[0, -0.1], [0, parH]], [[0, parH], [parT, parH]], [[parT, parH], [parT, -0.1]]];
      for (const face of faces) {
        parts.push(paint(trackStrip(track, sList, 2, (f, s, c, o) => {
          const pt = side > 0 ? face[c] : face[1 - c];
          o.lat = side * (wallAt(f, side) + pt[0]); o.dy = pt[1];
        }), C.white));
      }
      for (const rail of [[0.78, 0.09], [1.12, 0.11]]) {
        const [ry, rt] = rail;
        const rfaces = [[[0.08, ry - rt], [0.08, ry + rt]], [[0.08, ry + rt], [0.24, ry + rt]], [[0.24, ry + rt], [0.24, ry - rt]], [[0.24, ry - rt], [0.08, ry - rt]]];
        for (const face of rfaces) {
          parts.push(paint(trackStrip(track, sList, 2, (f, s, c, o) => {
            const pt = side > 0 ? face[c] : face[1 - c];
            o.lat = side * (wallAt(f, side) + pt[0]); o.dy = pt[1];
          }), C.steel));
        }
      }
      for (let s = z0 + 1; s < z1; s += 2.5) {
        const f = track.frameAt(s), lat = side * (wallAt(f, side) + 0.16);
        parts.push(paint(place(new THREE.BoxGeometry(0.14, 0.8, 0.14), f.x + f.right.x * lat, f.y + parH + 0.4, f.z + f.right.z * lat, f.yaw), C.steel));
      }
    }
    // Piers down to the seabed + cap beams.
    const len = z1 - z0, nP = Math.max(2, Math.round(len / 19));
    for (let k = 1; k < nP; k++) {
      const s = z0 + (len * k) / nP, f = track.frameAt(s);
      const bot = SEABED - 1, top = f.y - 1.15, h = top - bot;
      for (const lat of [-f.halfWidth * 0.55, f.halfWidth * 0.55]) {
        parts.push(paint(place(new THREE.CylinderGeometry(0.75, 0.9, h, 10), f.x + f.right.x * lat, bot + h / 2, f.z + f.right.z * lat), C.concrete));
      }
      const capW = f.wallL + f.wallR + 1.2;
      const latC = (f.wallR - f.wallL) / 2;
      parts.push(paint(place(new THREE.BoxGeometry(capW, 0.9, 1.6), f.x + f.right.x * latC, top - 0.45, f.z + f.right.z * latC, f.yaw), C.concreteDark));
    }
    // Abutments at both ends.
    for (const [s, dir] of [[z0, 1], [z1, -1]]) {
      const f = track.frameAt(s + dir * 3.5);
      const w = Math.max(f.wallL, f.wallR) * 2 + 1.8, top = f.y - 1.15, bot = SEABED, h = top - bot;
      parts.push(paint(place(new THREE.BoxGeometry(w, h, 7), f.x, bot + h / 2, f.z, f.yaw), C.concreteDark));
    }
    // Two steel arches with hangers and top bracing.
    const sa = z0 + 7, sb = z1 - 7, ARCH_H = 14.5, aLatPad = 0.95;
    const archPoint = (side, t, out) => {
      const s = lerp(sa, sb, t), f = track.frameAt(s);
      const lat = side * (wallAt(f, side) + aLatPad);
      const h = ARCH_H * (1 - (2 * t - 1) * (2 * t - 1));
      return out.set(f.x + f.right.x * lat, f.y + 0.4 + h, f.z + f.right.z * lat);
    };
    const K = 44, P0 = new THREE.Vector3(), P1 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (const side of [-1, 1]) {
      for (let k = 0; k < K; k++) {
        archPoint(side, k / K, P0); archPoint(side, (k + 1) / K, P1);
        const d = P1.distanceTo(P0);
        const mid = P0.clone().add(P1).multiplyScalar(0.5);
        const box = new THREE.BoxGeometry(0.9, 0.9, d + 0.12);
        const look = new THREE.Matrix4().lookAt(P0, P1, up);
        box.applyMatrix4(look).translate(mid.x, mid.y, mid.z);
        parts.push(paint(box, C.steel));
      }
      // hangers
      for (let t = 0.1; t < 0.95; t += 0.8 / 13) {
        archPoint(side, t, P0);
        const s = lerp(sa, sb, t), f = track.frameAt(s);
        const yb = f.y + parH + 0.75, h = P0.y - yb;
        if (h > 0.6) parts.push(paint(place(new THREE.CylinderGeometry(0.07, 0.07, h, 5), P0.x, yb + h / 2, P0.z), C.white));
      }
      // arch feet
      for (const t of [0, 1]) {
        archPoint(side, t, P0);
        const f = track.frameAt(lerp(sa, sb, t));
        parts.push(paint(place(new THREE.BoxGeometry(1.7, 1.6, 2.4), P0.x, f.y - 0.1, P0.z, f.yaw), C.concrete));
      }
    }
    for (const t of [0.32, 0.5, 0.68]) {
      archPoint(-1, t, P0); archPoint(1, t, P1);
      const d = P0.distanceTo(P1), mid = P0.clone().add(P1).multiplyScalar(0.5);
      const box = new THREE.BoxGeometry(0.5, 0.5, d);
      box.applyMatrix4(new THREE.Matrix4().lookAt(P0, P1, up)).translate(mid.x, mid.y, mid.z);
      parts.push(paint(box, C.steel));
    }
    const geo = mergeGeometries(parts);
    parts.forEach((g) => g.dispose());
    add(new THREE.Mesh(geo, M.structure), { cast: true, receive: true, name: 'Bridge' });
  }

  // ---------------------------------------------------------------- boost pads
  if (track.boostPads.length) {
    const pads = track.boostPads.map((p) => trackStrip(track, sRange(p.s0, p.s1, 0.5), 2, (f, s, c, o) => {
      o.lat = c ? p.lat1 : p.lat0;
      o.y = track.pointAt(s, o.lat, _p3).y; o.dy = 0.025;
      o.u = c; o.v = (s - p.s0) / p.width;
    }));
    const padMat = new THREE.MeshBasicMaterial({ map: T.chevron, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    add(new THREE.Mesh(mergeGeometries(pads), padMat), { receive: false, name: 'BoostPads' });
    pads.forEach((g) => g.dispose());
    animators.push((dt, time) => {
      T.chevron.offset.y = (T.chevron.offset.y - dt * 1.8) % 1;
      const k = 0.86 + 0.14 * Math.sin(time * 9);
      padMat.color.setRGB(k, k, k);
    });
  }

  // ---------------------------------------------------------------- kicker ramps
  if (track.ramps.length) {
    const tops = [], sides = [];
    for (const r of track.ramps) {
      const latBounds = (f) => (r.fullWidth ? [-f.halfWidth, f.halfWidth] : [r.lat0, r.lat1]);
      const sL = sRange(r.s0, r.s1, 0.25);
      const topY = (s, lat) => track.pointAt(s, lat, _p3).y;   // includes the ramp height (matches physics)
      tops.push(trackStrip(track, sL, 2, (f, s, c, o) => {
        const [a, b] = latBounds(f);
        o.lat = c ? b : a;
        o.y = topY(s, lat01(a, b, 0.5)); o.dy = 0.006;
        o.u = (o.lat - a) / 4.3; o.v = (s - r.s0) / r.length;
      }));
      // side walls (outward facing)
      for (const sideK of [0, 1]) {
        sides.push(trackStrip(track, sL, 2, (f, s, c, o) => {
          const [a, b] = latBounds(f);
          const lat = sideK ? b : a;
          const top = sideK ? c === 0 : c === 1;    // right side: top→bottom; left: bottom→top
          o.lat = lat;
          o.y = top ? topY(s, lat01(a, b, 0.5)) + 0.006 : f.y;
          o.u = (s - r.s0) / 1.6; o.v = top ? (o.y - f.y) / 1.6 : 0;
        }));
      }
      // vertical drop face at s1 (faces forward)
      const f = track.frameAt(r.s1);
      const [a, b] = latBounds(f);
      const yTop = topY(r.s1, lat01(a, b, 0.5)) + 0.006, yB = f.y;
      const P = (lat, y) => [f.x + f.right.x * lat, y, f.z + f.right.z * lat];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([...P(a, yB), ...P(a, yTop), ...P(b, yB), ...P(b, yTop)], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, (yTop - yB) / 1.6, (b - a) / 1.6, 0, (b - a) / 1.6, (yTop - yB) / 1.6], 2));
      g.setIndex([0, 1, 2, 1, 3, 2]);
      g.computeVertexNormals();
      sides.push(g);
    }
    const topMat = new THREE.MeshStandardMaterial({ map: T.rampTop, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const sideMat = new THREE.MeshStandardMaterial({ map: T.hazard, roughness: 0.6 });
    add(new THREE.Mesh(mergeGeometries(tops), topMat), { cast: true, receive: true, name: 'RampTops' });
    add(new THREE.Mesh(mergeGeometries(sides), sideMat), { cast: true, receive: true, name: 'RampSides' });
    tops.forEach((g) => g.dispose()); sides.forEach((g) => g.dispose());
  }
  function lat01(a, b, t) { return a + (b - a) * t; }

  // ---------------------------------------------------------------- corner signs
  {
    const thr = 1 / 43;
    const curv = track.curv;
    let start = 0;
    while (start < N && Math.abs(curv[start]) > thr) start++;
    const turns = [];
    let cur = null;
    for (let k = 0; k <= N; k++) {
      const i = (start + k) % N, c = curv[i];
      const dir = Math.abs(c) > thr ? Math.sign(c) : 0;
      if (cur && (dir !== cur.dir || k === N)) { cur.iB = start + k - 1; turns.push(cur); cur = null; }
      if (!cur && dir !== 0 && k < N) cur = { dir, iA: start + k };
    }
    const spots = [];
    for (const t of turns) {
      const sA = t.iA * sp - 4, sB = t.iB * sp - 2;
      for (let s = sA; s <= sB; s += 8.5) {
        const f = track.frameAt(s);
        const side = -t.dir;                       // outside of the turn
        const wall = side > 0 ? f.wallR : f.wallL;
        const lat = side * (wall + 1.5);
        const inward = t.dir;                      // toward the inside (+right for right turns)
        const nx = -f.tangent.x * 0.85 + f.right.x * inward * 0.5;
        const nz = -f.tangent.z * 0.85 + f.right.z * inward * 0.5;
        spots.push({ x: f.x + f.right.x * lat, y: f.y - 0.25, z: f.z + f.right.z * lat, yaw: Math.atan2(nx, nz), flip: t.dir < 0 });
        prop('sign', f.x + f.right.x * lat, f.z + f.right.z * lat, 1.0);   // board half-span across the track
      }
    }
    if (spots.length) {
      const boardG = new THREE.BoxGeometry(2.3, 1.15, 0.12);
      const boardMat = new THREE.MeshLambertMaterial({ map: T.sign });
      const boards = new THREE.InstancedMesh(boardG, boardMat, spots.length);
      const postG = mergeGeometries([
        paint(new THREE.BoxGeometry(0.12, 2.0, 0.12).translate(-0.8, 1.0, -0.1), 0x9aa0a8),
        paint(new THREE.BoxGeometry(0.12, 2.0, 0.12).translate(0.8, 1.0, -0.1), 0x9aa0a8),
      ]);
      const posts = new THREE.InstancedMesh(postG, M.structure, spots.length);
      spots.forEach((sp2, i) => {
        _eul.set(0, sp2.yaw, sp2.flip ? Math.PI : 0, 'YXZ'); _q.setFromEuler(_eul);
        _m4.compose(_p3.set(sp2.x, sp2.y + 2.05, sp2.z), _q, _s3.set(1, 1, 1));
        boards.setMatrixAt(i, _m4);
        place_m4(_m4, sp2.x, sp2.y, sp2.z, sp2.yaw, 1, 1, 1);
        posts.setMatrixAt(i, _m4);
      });
      add(boards, { cast: true, receive: true, name: 'TurnSigns' });
      add(posts, { cast: true, name: 'TurnSignPosts' });
      stats.instances.signs = spots.length;
    }
  }

  // ---------------------------------------------------------------- start gantry + banner
  {
    const f = track.frameAt(0);
    const parts = [];
    const span = Math.max(f.wallL, f.wallR) + 1.6;
    const P = (lat, y, along = 0) => [f.x + f.right.x * lat + f.tangent.x * along, f.y + y, f.z + f.right.z * lat + f.tangent.z * along];
    for (const side of [-1, 1]) {
      for (let k = 0; k < 7; k++) {
        const [x, y, z] = P(side * span, 0.75 + k * 1.45);
        parts.push(paint(place(new THREE.BoxGeometry(1.1, 1.45, 1.1), x, y - 0.25, z, f.yaw), k % 2 ? C.white : C.red));
        if (k === 0) prop('gantry', x, z, 0.78);
      }
      const [bx, by, bz] = P(side * span, -0.4);
      parts.push(paint(place(new THREE.BoxGeometry(1.8, 0.5, 1.8), bx, by, bz, f.yaw), C.concreteDark));
    }
    // truss beams above the banner
    for (const y of [9.05, 5.35]) {
      const [x, yy, z] = P(0, y);
      parts.push(paint(place(new THREE.BoxGeometry(span * 2, 0.35, 0.7), x, yy, z, f.yaw), C.concreteDark));
    }
    // start light pods
    for (let k = -2; k <= 2; k++) {
      const [x, y, z] = P(k * 1.6, 9.7, -0.2);
      parts.push(paint(place(new THREE.BoxGeometry(1.1, 1.1, 0.6), x, y, z, f.yaw), 0x24242c));
      const [lx, ly, lz] = P(k * 1.6, 9.7, -0.55);
      parts.push(paint(place(new THREE.CylinderGeometry(0.34, 0.34, 0.12, 12), lx, ly, lz, f.yaw, Math.PI / 2), k === 2 ? 0x35e05a : 0xff3b30));
    }
    // banner backing frame
    {
      const [x, y, z] = P(0, 7.2);
      parts.push(paint(place(new THREE.BoxGeometry(span * 2 - 1.2, 3.4, 0.45), x, y, z, f.yaw + Math.PI), 0x1b3f9a));
    }
    add(new THREE.Mesh(mergeGeometries(parts), M.structure), { cast: true, receive: true, name: 'Gantry' });
    parts.forEach((g) => g.dispose());
    // banner faces (front toward the approaching karts, back toward the grid's rear view)
    const bh = 3.1, bw = Math.min(span * 2 - 1.6, bh * 8);   // texture is 8:1
    const front = new THREE.PlaneGeometry(bw, bh);
    const back = front.clone();
    // plane faces +Z; front must face -tangent (toward oncoming karts)
    place(front, ...P(0, 7.2, -0.24), f.yaw + Math.PI);
    place(back, ...P(0, 7.2, 0.24), f.yaw);
    const bannerMat = new THREE.MeshBasicMaterial({ map: T.banner, toneMapped: false });
    add(new THREE.Mesh(mergeGeometries([front, back]), bannerMat), { name: 'Banner' });
    front.dispose(); back.dispose();
  }

  // ---------------------------------------------------------------- grandstands + crowd + flags
  const exclusions = [];   // [x, z, r] circles where no vegetation may grow
  const flagSpots = [];    // [x, y, z, yaw]
  {
    const parts = [];
    const crowd = [];      // [x, y, z, yaw]
    const rng = makeRng(77);
    const seatCols = [0x2f7de1, 0xffc93a, 0xff5a4e, 0x35c46a];
    const buildStand = (sA, sB, side, rows) => {
      const fa = track.frameAt(sA), fb = track.frameAt(sB);
      const sMid = (sA + sB) / 2, f = track.frameAt(sMid);
      const wall = side > 0 ? f.wallR : f.wallL;
      const latFront = side * (wall + 4.5);
      const len = Math.hypot(fb.x - fa.x, fb.z - fa.z);
      const ox = f.x + f.right.x * latFront, oz = f.z + f.right.z * latFront;
      const wx = f.right.x * side, wz = f.right.z * side;      // outward (away from the track)
      const ax2 = f.tangent.x, az2 = f.tangent.z;
      const g0 = Math.min(field.surfaceHeight(ox, oz), field.surfaceHeight(ox + wx * rows, oz + wz * rows)) - 0.6;
      const faceYaw = Math.atan2(-wx, -wz);
      const yaw = f.yaw;
      for (let k = 0; k < rows; k++) {
        const top = f.y + 0.35 + 0.55 * (k + 1);
        const h = top - g0;
        const cx = ox + wx * (k * 1.05 + 0.525), cz = oz + wz * (k * 1.05 + 0.525);
        parts.push(paint(place(new THREE.BoxGeometry(1.05, h, len), cx, g0 + h / 2, cz, yaw), seatCols[k % seatCols.length]));
        // spectators on the step
        for (let a = -len / 2 + 0.5; a < len / 2 - 0.4; a += 0.82) {
          if (rng() < 0.12) continue;
          if (Q.crowd < 1 && rng() > Q.crowd) continue;
          const j = (rng() - 0.5) * 0.25;
          crowd.push([cx + ax2 * (a + j) - wx * 0.12, top, cz + az2 * (a + j) - wz * 0.12, faceYaw + (rng() - 0.5) * 0.5]);
        }
      }
      const backD = rows * 1.05 + 0.2, roofY = f.y + 0.35 + 0.55 * rows + 3.4;
      // back wall
      {
        const cx = ox + wx * backD, cz = oz + wz * backD, h = roofY - g0;
        parts.push(paint(place(new THREE.BoxGeometry(0.4, h, len + 0.4), cx, g0 + h / 2, cz, yaw), 0xe9e4da));
      }
      // front parapet
      {
        const cx = ox - wx * 0.15, cz = oz - wz * 0.15, h = f.y + 1.2 - g0;
        parts.push(paint(place(new THREE.BoxGeometry(0.3, h, len), cx, g0 + h / 2, cz, yaw), C.blue));
      }
      // columns + striped roof
      for (let a = -len / 2; a <= len / 2 + 0.01; a += len / Math.max(1, Math.round(len / 9))) {
        const cx = ox + ax2 * a - wx * 0.1, cz = oz + az2 * a - wz * 0.1, h = roofY - g0;
        parts.push(paint(place(new THREE.BoxGeometry(0.3, h, 0.3), cx, g0 + h / 2, cz, yaw), 0xe9e4da));
        flagSpots.push([cx, roofY + 0.2, cz, f.yaw]);
      }
      const nSeg = Math.max(2, Math.round(len / 3));
      for (let k = 0; k < nSeg; k++) {
        const a = -len / 2 + (k + 0.5) * (len / nSeg);
        const cx = ox + ax2 * a + wx * (backD / 2 - 0.2), cz = oz + az2 * a + wz * (backD / 2 - 0.2);
        parts.push(paint(place(new THREE.BoxGeometry(backD + 1.2, 0.22, len / nSeg), cx, roofY, cz, yaw, 0, side * -0.06), k % 2 ? C.white : C.red));
      }
      // keep vegetation away; record the stand's footprint (front parapet is nearest the track)
      for (let a = -len / 2; a <= len / 2; a += 6) exclusions.push([ox + ax2 * a + wx * backD / 2, oz + az2 * a + wz * backD / 2, backD + 4]);
      for (let a = -len / 2; a <= len / 2 + 0.01; a += 1) prop('grandstand', ox + ax2 * a - wx * 0.15, oz + az2 * a - wz * 0.15, 0.25);
    };
    buildStand(L - 48, L - 6, -1, 7);
    buildStand(6, 48, -1, 7);
    buildStand(10, 42, 1, 5);
    add(new THREE.Mesh(mergeGeometries(parts), M.structure), { cast: true, receive: true, name: 'Grandstands' });
    parts.forEach((g) => g.dispose());

    // Crowd: shirt (white vertices) takes the instance colour; heads get a
    // hashed skin tone; everyone hops in the vertex shader (no CPU cost).
    if (crowd.length) {
      const body = paint(new THREE.BoxGeometry(0.46, 0.62, 0.3).translate(0, 0.31, 0), 0xffffff);
      const head = paint(new THREE.OctahedronGeometry(0.2, 0).translate(0, 0.84, 0), 0xf0c8a0);
      const arms = paint(new THREE.BoxGeometry(0.66, 0.12, 0.12).translate(0, 0.58, 0.02), 0xffffff);
      const g = mergeGeometries([body, head, arms]);
      [body, head, arms].forEach((x) => x.dispose());
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = timeUniform;
        // (r186: vColor is a vec4 varying; the stock chunk runs first.)
        shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader
          .replace('#include <color_vertex>', /* glsl */`
            #include <color_vertex>
            float hsh = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
            #if defined( USE_INSTANCING_COLOR ) && defined( USE_COLOR )
              float shirt = step(0.99, min(color.r, min(color.g, color.b)));
              vec3 skin = mix(vec3(1.0, 0.8, 0.62), vec3(0.42, 0.27, 0.16), fract(hsh * 7.31));
              vColor.rgb = mix(skin, instanceColor.rgb, shirt);
            #endif`)
          .replace('#include <begin_vertex>', /* glsl */`
            #include <begin_vertex>
            float hop = max(0.0, sin(uTime * (5.0 + hsh * 4.0) + hsh * 40.0));
            transformed.y += hop * hop * 0.24 * step(0.3, hsh);`);
      };
      mat.customProgramCacheKey = () => 'tootkart-crowd';
      const inst = new THREE.InstancedMesh(g, mat, crowd.length);
      const shirtCols = [0xff4d4d, 0xffd23f, 0x3fa7ff, 0x5ad35a, 0xff8c2e, 0xb06bff, 0xffffff, 0xff6fb5, 0x2ec4b6];
      crowd.forEach(([x, y, z, yaw], i) => {
        place_m4(_m4, x, y, z, yaw, 1, 1, 1);
        inst.setMatrixAt(i, _m4);
        inst.setColorAt(i, _col.set(shirtCols[Math.floor(rng() * shirtCols.length)]).multiplyScalar(0.985));
      });
      add(inst, { receive: false, name: 'Crowd' });
      stats.instances.crowd = crowd.length;
    }
  }

  // ---------------------------------------------------------------- lighthouse
  {
    const parts = [];
    const lx = LIGHTHOUSE.x, lz = LIGHTHOUSE.z;
    const g0 = field.surfaceHeight(lx, lz) - 0.4;
    parts.push(paint(place(new THREE.CylinderGeometry(4.2, 4.8, 1.6, 12), lx, g0 + 0.8, lz), 0xb7afa2));
    const bands = 6, towerH = 15, r0 = 2.7, r1 = 1.9;
    for (let k = 0; k < bands; k++) {
      const ya = (k / bands) * towerH, yb = ((k + 1) / bands) * towerH;
      const ra = lerp(r0, r1, k / bands), rb = lerp(r0, r1, (k + 1) / bands);
      parts.push(paint(place(new THREE.CylinderGeometry(rb, ra, yb - ya, 16), lx, g0 + 1.6 + (ya + yb) / 2, lz), k % 2 ? C.white : 0xe0342c));
    }
    const top = g0 + 1.6 + towerH;
    parts.push(paint(place(new THREE.CylinderGeometry(2.75, 2.75, 0.35, 16), lx, top + 0.17, lz), 0x30343c));
    parts.push(paint(place(new THREE.CylinderGeometry(2.7, 2.7, 0.75, 16, 1, true), lx, top + 0.72, lz), 0x30343c));
    parts.push(paint(place(new THREE.CylinderGeometry(1.55, 1.55, 0.3, 12), lx, top + 0.5, lz), 0x30343c));
    parts.push(paint(place(new THREE.ConeGeometry(2.0, 1.8, 12), lx, top + 3.55, lz), 0xe0342c));
    parts.push(paint(place(new THREE.SphereGeometry(0.35, 8, 6), lx, top + 4.6, lz), 0x30343c));
    // keeper's cottage
    const hx = lx + 7.5, hz = lz - 5.5, hg = field.surfaceHeight(hx, hz) - 0.3;
    parts.push(paint(place(new THREE.BoxGeometry(5.5, 3.2, 4.2), hx, hg + 1.6, hz, 0.4), C.white));
    // triangular prism roof: apex up, ridge along the cottage's local x
    const roof = new THREE.CylinderGeometry(3.3, 3.3, 6.1, 3, 1).rotateX(-Math.PI / 2).rotateY(Math.PI / 2).scale(1, 0.6, 0.8);
    parts.push(paint(place(roof, hx, hg + 3.2 + 0.99, hz, 0.4), 0x2f6fd0));
    parts.push(paint(place(new THREE.BoxGeometry(1.0, 1.9, 0.1), hx + Math.sin(0.4) * 2.12, hg + 0.95, hz + Math.cos(0.4) * 2.12, 0.4), 0x7a4f2a));
    add(new THREE.Mesh(mergeGeometries(parts), M.structure), { cast: true, receive: true, name: 'Lighthouse' });
    parts.forEach((g) => g.dispose());
    // glowing lantern room
    const lantern = add(new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.45, 2.0, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff3b0, toneMapped: false })), { name: 'Lantern' });
    lantern.position.set(lx, top + 1.65, lz);
    // Two rotating light shafts. Daylight-subtle: additive, fading out along
    // the shaft and toward its silhouette (so it never reads as a solid bar).
    const BEAM_LEN = 40;
    const beamG = new THREE.ConeGeometry(2.4, BEAM_LEN, 14, 1, true).rotateZ(Math.PI / 2).translate(BEAM_LEN / 2, 0, 0);
    const beamG2 = beamG.clone().rotateY(Math.PI);
    const beamMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xfff0b8) }, uIntensity: { value: 0.32 } },
      vertexShader: /* glsl */`
        varying float vT;
        varying vec3 vN, vV;
        void main() {
          vT = abs(position.x) / ${BEAM_LEN.toFixed(1)};
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalMatrix * normal;
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uIntensity;
        varying float vT;
        varying vec3 vN, vV;
        void main() {
          float facing = abs(dot(normalize(vN), normalize(vV)));
          float a = uIntensity * pow(1.0 - vT, 1.8) * smoothstep(0.0, 0.06, vT) * facing * facing;
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    const beam = new THREE.Mesh(mergeGeometries([beamG, beamG2]), beamMat);
    beamG.dispose(); beamG2.dispose();
    beam.position.set(lx, top + 1.7, lz);
    beam.renderOrder = 5;
    add(beam, { name: 'LighthouseBeam' });
    animators.push((dt) => { beam.rotation.y += dt * 0.9; });
    exclusions.push([lx, lz, 10], [hx, hz, 7]);
    prop('lighthouse', lx, lz, 4.8);
    prop('cottage', hx, hz, 3.6);
    flagSpots.push([hx + 2.5, hg + 5.5, hz - 2.5, 0]);
  }

  // ---------------------------------------------------------------- flags
  {
    // extra flags around Turn 1 and the hairpin, outside the walls
    for (const seg of [track.segments[1], track.segments[7]]) {
      if (!seg) continue;
      for (let s = seg.s0 + 6; s < seg.s1 - 4; s += 11) {
        const f = track.frameAt(s);
        const side = -Math.sign(f.curvature || 1);
        const wall = side > 0 ? f.wallR : f.wallL;
        const lat = side * (wall + 3.2);
        flagSpots.push([f.x + f.right.x * lat, f.y - 0.25, f.z + f.right.z * lat, f.yaw, true]);
      }
    }
    const n = flagSpots.length;
    if (n) {
      const poleG = paint(new THREE.CylinderGeometry(0.06, 0.08, 4.2, 6).translate(0, 2.1, 0), 0xeeeeee);
      const poles = new THREE.InstancedMesh(poleG, M.structure, n);
      const clothG = new THREE.PlaneGeometry(1.7, 1.05, 8, 1).translate(0.85, 3.6, 0);
      const clothMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
      clothMat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = timeUniform;
        shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          float fph = dot(instanceMatrix[3].xz, vec2(0.37, 0.23));
          float fw = clamp(position.x / 1.7, 0.0, 1.0);
          transformed.z += sin(uTime * 7.0 - position.x * 2.4 + fph) * 0.2 * fw;
          transformed.y += sin(uTime * 5.0 - position.x * 1.7 + fph) * 0.06 * fw;`);
      };
      clothMat.customProgramCacheKey = () => 'tootkart-flag';
      const cloths = new THREE.InstancedMesh(clothG, clothMat, n);
      const flagCols = [0xff3b30, 0xffcc00, 0x2f80ff, 0x34c759, 0xff9500, 0xaf52de, 0xff2d92];
      flagSpots.forEach(([x, y, z, yaw, tall], i) => {
        const sc = tall ? 1.35 : 1;
        place_m4(_m4, x, y, z, yaw + Math.PI * 0.5 + (i % 3) * 0.3, sc, sc, sc);
        poles.setMatrixAt(i, _m4);
        cloths.setMatrixAt(i, _m4);
        cloths.setColorAt(i, _col.set(flagCols[i % flagCols.length]));
      });
      add(poles, { cast: true, name: 'FlagPoles' });
      add(cloths, { cast: true, name: 'Flags' });
      stats.instances.flags = n;
      for (const [x, , z] of flagSpots) { exclusions.push([x, z, 2]); prop('flag', x, z, 0.1); }
    }
  }

  // gantry pillars keep clear of trees too
  {
    const f = track.frameAt(0), span = Math.max(f.wallL, f.wallR) + 1.6;
    for (const side of [-1, 1]) exclusions.push([f.x + f.right.x * side * span, f.z + f.right.z * side * span, 4]);
  }

  // ---------------------------------------------------------------- vegetation & rocks
  {
    const rng = makeRng(2024);
    // Deterministic per-position lumpiness: shared corners of non-indexed
    // polyhedra move together, so the jittered shapes stay crack-free.
    const lumpy = (geo, amt, sx = 1, sy = 1, sz = 1, salt = 0) => {
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const k = 1 + (hash2(Math.round(x * 13 + salt), Math.round(z * 11 + y * 7 - salt)) - 0.5) * amt;
        p.setXYZ(i, x * k * sx, y * k * sy, z * k * sz);
      }
      geo.computeVertexNormals();
      return geo;
    };
    // Geometry (triangles): pine 66, broadleaf 48, palm ~79, bush 40, rock 36.
    const pine = mergeGeometries([
      paint(new THREE.CylinderGeometry(0.22, 0.32, 1.8, 6).translate(0, 0.9, 0), C.trunk),
      paint(new THREE.ConeGeometry(2.1, 3.2, 7).translate(0, 3.0, 0), C.pine),
      paint(new THREE.ConeGeometry(1.65, 2.8, 7).translate(0, 4.6, 0), mixHex(C.pine, 0x3fa356, 0.4)),
      paint(new THREE.ConeGeometry(1.1, 2.3, 7).translate(0, 6.1, 0), mixHex(C.pine, 0x5cbf5a, 0.5)),
    ]);
    const broad = mergeGeometries([
      paint(new THREE.CylinderGeometry(0.26, 0.36, 2.6, 6, 1, true).translate(0, 1.3, 0), C.trunk),
      paint(lumpy(new THREE.DodecahedronGeometry(2.3, 0), 0.22, 1, 0.86, 1).translate(0, 4.1, 0), C.leaf),
    ]);
    const palmParts = [];
    {
      let x = 0, y = 0, lean = 0;
      for (let k = 0; k < 5; k++) {
        const h = 1.25;
        palmParts.push(paint(place(new THREE.CylinderGeometry(0.19 - k * 0.012, 0.24 - k * 0.012, h, 5, 1, true), x + Math.sin(lean) * h / 2, y + Math.cos(lean) * h / 2, 0, 0, 0, -lean), k % 2 ? 0x9b7448 : 0x8a6539));
        y += Math.cos(lean) * h; x += Math.sin(lean) * h; lean += 0.07;
      }
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        const fr = new THREE.ConeGeometry(0.42, 3.4, 3, 1, true).rotateZ(-Math.PI / 2).scale(1, 0.28, 1).translate(1.7, 0, 0).rotateZ(-0.35);
        palmParts.push(paint(place(fr, x, y + 0.1, 0, a), k % 2 ? C.palmLeaf : 0x3e9c43));
      }
      palmParts.push(paint(new THREE.OctahedronGeometry(0.34, 0).translate(x, y - 0.12, 0), 0x6b4a2a));
    }
    const palm = mergeGeometries(palmParts);
    palmParts.forEach((g) => g.dispose());
    const bush = mergeGeometries([
      paint(lumpy(new THREE.IcosahedronGeometry(1.0, 0), 0.3, 1.25, 0.8, 1.25, 5).translate(0, 0.45, 0), C.bush),
      paint(lumpy(new THREE.IcosahedronGeometry(0.72, 0), 0.3, 1.2, 0.85, 1.2, 9).translate(0.75, 0.35, 0.35), mixHex(C.bush, 0x6cc24a, 0.35)),
    ]);
    const rock = paint(lumpy(new THREE.DodecahedronGeometry(1.0, 0), 0.35, 1.2, 0.72, 1, 3), C.rock);
    // Footprint radius (m, at scale 1) used for wall clearance & verification.
    const R = { pine: 2.1, broad: 2.6, palm: 3.25, bush: 1.75, rock: 1.45 };

    const core = field.core;
    const inExcl = (x, z) => exclusions.some(([ex, ez, er]) => (x - ex) * (x - ex) + (z - ez) * (z - ez) < er * er);
    const slopeAt = (x, z) => {
      const a = field.surfaceHeight(x + 1.5, z), b = field.surfaceHeight(x - 1.5, z);
      const c2 = field.surfaceHeight(x, z + 1.5), d = field.surfaceHeight(x, z - 1.5);
      return Math.hypot(a - b, c2 - d) / 3;
    };
    const ext = 150;
    const pick = (count, accept) => {
      const out = [];
      let tries = 0;
      while (out.length < count && tries < count * 80) {
        tries++;
        const x = lerp(core.x0 - ext, core.x1 + ext, rng()), z = lerp(core.z0 - ext, core.z1 + ext, rng());
        const r = accept(x, z);
        if (r) out.push(r);
      }
      return out;
    };
    const dry = (x, z, minH) => field.surfaceHeight(x, z) > WATER_LEVEL + minH;
    const forest = (x, z) => fbm(x * 0.012 + 11, z * 0.012 - 4, 3);
    // Spot = [x, y, z, yaw, scale, wallClearance, footprintRadius]. Every prop
    // keeps its whole footprint (+1 m for barrier/tyre thickness) beyond the walls.
    const makeSpot = (x, z, type, sc, sink) => {
      const clr = field.wallClearance(x, z), r = R[type] * sc;
      if (!(clr > r + 1.0)) return null;
      // denser near the track, sparser far away
      if (rng() > lerp(1, 0.3, smoothstep((clr - 40) / 170))) return null;
      return [x, field.surfaceHeight(x, z) - sink, z, rng() * Math.PI * 2, sc, clr, r];
    };
    const treeSpots = (count, type) => pick(count, (x, z) => {
      if (!dry(x, z, 0.9) || inExcl(x, z)) return null;
      const sd = coastDistance(x, z);
      if (type === 'palm') { if (sd > 34 || sd < 1) return null; } else if (sd < 14) return null;
      const dens = type === 'pine' ? smoothstep((forest(x, z) - 0.5) / 0.12) : smoothstep((0.58 - forest(x, z)) / 0.2) * 0.8 + 0.2;
      if (type !== 'palm' && rng() > dens) return null;
      if (slopeAt(x, z) > (type === 'palm' ? 0.35 : 0.55)) return null;
      return makeSpot(x, z, type, lerp(0.8, 1.3, rng()), 0.25);
    });
    const smallSpots = (count, type) => pick(count, (x, z) => {
      const rocky = type === 'rock';
      if (!dry(x, z, rocky ? -1.2 : 0.7) || inExcl(x, z)) return null;
      const sl = slopeAt(x, z);
      if (!rocky && sl > 0.6) return null;
      if (rocky && sl < 0.25 && rng() < 0.7) return null;     // prefer slopes, cliffs and shores
      const sc = rocky ? lerp(0.7, 2.6, rng() * rng()) : lerp(0.7, 1.4, rng());
      return makeSpot(x, z, type, sc, rocky ? 0.3 * sc : 0.12);
    });

    const V = Q.veg;
    const sets = {
      Pines: { geo: pine, spots: treeSpots(Math.round(280 * V), 'pine'), near: 45 },
      Trees: { geo: broad, spots: treeSpots(Math.round(230 * V), 'broad'), near: 45 },
      Palms: { geo: palm, spots: treeSpots(Math.round(80 * V), 'palm'), near: 45 },
      Bushes: { geo: bush, spots: smallSpots(Math.round(300 * V), 'bush'), near: 22, tints: [0xffffff, 0xffffff, 0xffffff, 0xffd0e8, 0xfff0a0], tint: [0.8, 1.2] },
      Rocks: { geo: rock, spots: smallSpots(Math.round(170 * V), 'rock'), near: 0 },
    };
    // The palm islet always gets a few palms.
    {
      const isl = ISLETS[1];
      for (let k = 0; k < 4; k++) {
        const a = k * 1.7 + 0.4, d = 3 + (k % 2) * 3;
        const x = isl.x + Math.cos(a) * d, z = isl.z + Math.sin(a) * d;
        if (field.surfaceHeight(x, z) > WATER_LEVEL + 0.6) sets.Palms.spots.push([x, field.surfaceHeight(x, z) - 0.25, z, a * 2, 1.1, 999, R.palm * 1.1]);
      }
    }
    // Sea stacks: boulders standing in the surf at the foot of the cliffs.
    for (const zn of track.zones) {
      if (zn.type !== 'cliff') continue;
      const len = track.forwardDistance(zn.s0, zn.s1);
      for (let d = 14; d < len - 10; d += 9 + rng() * 9) {
        const f = track.frameAt(zn.s0 + d);
        const sc = lerp(1.2, 2.6, rng()), r = R.rock * sc;
        const lat = -(f.wallL + r + 1.6 + rng() * 3.5);
        const x = f.x + f.right.x * lat, z = f.z + f.right.z * lat;
        if (field.surfaceHeight(x, z) > WATER_LEVEL - 0.5 || field.wallClearance(x, z) < r + 1.0) continue;
        sets.Rocks.spots.push([x, WATER_LEVEL - 0.35 * sc + rng() * 0.4, z, rng() * 6.28, sc, field.wallClearance(x, z), r]);
      }
    }
    for (const [name, set] of Object.entries(sets)) {
      const { geo, spots, near } = set;
      if (!spots.length) { geo.dispose(); continue; }
      const tint = set.tint || [0.85, 1.12];
      // Near-track instances cast (and receive) shadows; the rest skip both,
      // so the shadow pass only draws what can actually shade the course.
      const groups = near > 0
        ? [[spots.filter((p) => p[5] < near), true, 'Near'], [spots.filter((p) => p[5] >= near), false, 'Far']]
        : [[spots, false, '']];
      for (const [list, cast, suffix] of groups) {
        if (!list.length) continue;
        const inst = new THREE.InstancedMesh(geo, M.veg, list.length);
        for (let i = 0; i < list.length; i++) {
          const [x, y, z, yaw, sc] = list[i];
          place_m4(_m4, x, y, z, yaw, sc, sc * lerp(0.9, 1.12, rng()), sc);
          inst.setMatrixAt(i, _m4);
          const t = lerp(tint[0], tint[1], rng());
          if (set.tints) _col.set(set.tints[Math.floor(rng() * set.tints.length)]).multiplyScalar(t);
          else _col.setRGB(t * lerp(0.95, 1.05, rng()), t, t * lerp(0.9, 1.05, rng()));
          inst.setColorAt(i, _col);
        }
        inst.computeBoundingSphere();
        add(inst, { cast, receive: cast, name: name + suffix });
      }
      for (const p of spots) prop(name.toLowerCase(), p[0], p[2], p[6]);
      stats.instances[name.toLowerCase()] = spots.length;
    }
  }

  // ---------------------------------------------------------------- beach umbrellas
  {
    const rng = makeRng(99);
    const spots = [];
    for (let k = 0; k < 400 && spots.length < 14; k++) {
      const x = lerp(-160, -138, rng()), z = lerp(-60, 40, rng());
      const h = field.surfaceHeight(x, z);
      if (h < WATER_LEVEL + 0.45 || h > 0.5 || field.wallClearance(x, z) < 2.5) continue;
      if (spots.some(([sx, , sz]) => Math.hypot(sx - x, sz - z) < 6)) continue;
      spots.push([x, h, z]);
      prop('umbrella', x, z, 1.5);
    }
    if (spots.length) {
      const canopy = new THREE.ConeGeometry(1.5, 0.6, 8).toNonIndexed().translate(0, 2.35, 0);
      faceColors(canopy, (y, ny, fi) => (fi % 2 ? 0xffffff : 0xff4f6a));
      const g = mergeGeometries([paint(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 5).translate(0, 1.2, 0), 0xf2f2f2), paint(canopy, null)]);
      const towelG = paint(new THREE.BoxGeometry(0.9, 0.03, 1.8).translate(1.3, 0.04, 0.2), 0xffffff);
      const umbrellas = new THREE.InstancedMesh(g, M.structure, spots.length);
      const towels = new THREE.InstancedMesh(towelG, M.structure, spots.length);
      const tc = [0x3fa7ff, 0xffd23f, 0xff6fb5, 0x5ad35a];
      spots.forEach(([x, h, z], i) => {
        place_m4(_m4, x, h - 0.05, z, rng() * 6.28, 1, 1, 1);
        umbrellas.setMatrixAt(i, _m4); towels.setMatrixAt(i, _m4);
        umbrellas.setColorAt(i, _col.set(i % 3 === 0 ? 0xffffff : i % 3 === 1 ? 0xb8f0ff : 0xfff0a0));
        towels.setColorAt(i, _col.set(tc[i % tc.length]));
      });
      add(umbrellas, { cast: true, name: 'Umbrellas' });
      add(towels, { receive: true, name: 'Towels' });
      stats.instances.umbrellas = spots.length;
    }
  }

  // ---------------------------------------------------------------- distant mountains & islands
  {
    const rng = makeRng(555);
    const geos = [];
    const cx = WORLD_CENTER.x, cz = WORLD_CENTER.z;
    const mountain = (x, z, radius, height, seg, snow) => {
      const g = new THREE.ConeGeometry(radius, height, seg, 4).toNonIndexed();
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
        const t = (vy + height / 2) / height;               // 0 base .. 1 apex
        const key = Math.round(vx * 3 + 1000) * 7919 + Math.round(vz * 3 + 1000) * 31 + Math.round(vy * 3);
        const j = 1 + (hash2(key, 17) - 0.5) * 0.36 * (1 - t * 0.6);
        p.setXYZ(i, vx * j, vy + (hash2(key, 5) - 0.5) * height * 0.06 * (1 - t), vz * j);
      }
      g.translate(x, height / 2 - 14, z);
      faceColors(g, (y, ny) => {
        const t = (y + 14) / height;
        if (snow && t > 0.68) return 0xf4f7fb;
        if (t > 0.42 || ny < 0.45) return mixHex(0x8a8d7c, 0x6f7566, hash2(Math.round(y), 3));
        return mixHex(0x4f9a4c, 0x6db356, hash2(Math.round(y * 3), 9));
      });
      geos.push(paint(g, null));
    };
    // ring of mountains on the land side (north / east / north-west)
    for (let k = 0; k < 26; k++) {
      const a = lerp(-0.42, 2.95, k / 25) + (rng() - 0.5) * 0.12;     // radians, 0 = +x
      const r = lerp(760, 1160, rng());
      const h = lerp(110, 290, rng() * rng() + 0.15);
      mountain(cx + Math.cos(a) * r, cz + Math.sin(a) * r, h * lerp(1.2, 1.8, rng()), h, 9 + Math.floor(rng() * 3), h > 200);
      if (rng() < 0.6) {   // foothills in front
        const r2 = r - lerp(120, 220, rng()), h2 = h * lerp(0.3, 0.5, rng());
        mountain(cx + Math.cos(a + 0.06) * r2, cz + Math.sin(a + 0.06) * r2, h2 * 2.2, h2, 8, false);
      }
    }
    // islands out at sea (south / south-west)
    for (let k = 0; k < 6; k++) {
      const a = lerp(3.5, 5.3, k / 5) + (rng() - 0.5) * 0.2;
      const r = lerp(620, 1050, rng()), h = lerp(30, 90, rng());
      mountain(cx + Math.cos(a) * r, cz + Math.sin(a) * r, h * 2.6, h, 9, false);
    }
    add(new THREE.Mesh(mergeGeometries(geos), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })), { name: 'Mountains' });
    geos.forEach((g) => g.dispose());
  }

  // ---------------------------------------------------------------- clouds
  {
    const rng = makeRng(808);
    const puffs = [];
    const offs = [[0, 0, 0, 1], [1.4, -0.2, 0.3, 0.8], [-1.3, -0.25, -0.2, 0.75], [0.5, 0.45, -0.4, 0.7], [-0.4, 0.3, 0.6, 0.65], [2.4, -0.45, -0.1, 0.55], [-2.3, -0.4, 0.3, 0.5]];
    for (const [x, y, z, r] of offs) puffs.push(new THREE.IcosahedronGeometry(r * 10, 1).scale(1, 0.72, 1).translate(x * 10, y * 10, z * 10));
    const cloudG = mergeGeometries(puffs);
    puffs.forEach((g) => g.dispose());
    const sunN = sunDir;
    faceColors(cloudG, (y, ny) => mixHex(0xc9d8ea, 0xffffff, smoothstep((ny + 0.55) / 1.1)));
    // re-tint by sun direction for a soft lit look
    {
      const pos = cloudG.attributes.position, colA = cloudG.attributes.color;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
      for (let i = 0; i < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
        n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
        const lit = 0.9 + 0.1 * Math.max(0, n.dot(sunN));
        for (let k = 0; k < 3; k++) colA.setXYZ(i + k, colA.getX(i + k) * lit, colA.getY(i + k) * lit, colA.getZ(i + k) * lit);
      }
    }
    paint(cloudG, null);
    const count = Q.clouds;
    const clouds = new THREE.InstancedMesh(cloudG, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true }), count);
    clouds.frustumCulled = false;
    const cl = [];
    for (let k = 0; k < count; k++) {
      const a = rng() * Math.PI * 2, r = lerp(150, 850, Math.sqrt(rng()));
      cl.push({ x: WORLD_CENTER.x + Math.cos(a) * r, z: WORLD_CENTER.z + Math.sin(a) * r, y: lerp(95, 170, rng()), s: lerp(0.8, 1.9, rng()), yaw: rng() * 6.28, sp: lerp(2.5, 5, rng()) });
    }
    const placeClouds = () => {
      for (let k = 0; k < count; k++) {
        const c = cl[k];
        place_m4(_m4, c.x, c.y, c.z, c.yaw, c.s, c.s * 0.9, c.s);
        clouds.setMatrixAt(k, _m4);
      }
      clouds.instanceMatrix.needsUpdate = true;
    };
    placeClouds();
    add(clouds, { name: 'Clouds' });
    animators.push((dt) => {
      for (let k = 0; k < count; k++) {
        const c = cl[k];
        c.x += c.sp * dt;
        if (c.x > WORLD_CENTER.x + 900) c.x -= 1800;
      }
      placeClouds();
    });
  }

  // ---------------------------------------------------------------- sailboats
  {
    const hull = new THREE.BoxGeometry(1.7, 0.8, 4.6, 1, 1, 2);
    {
      const p = hull.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const z = p.getZ(i), y = p.getY(i);
        if (z > 1) p.setX(i, p.getX(i) * 0.08);
        if (y < 0) p.setX(i, p.getX(i) * 0.6);
      }
      hull.computeVertexNormals();
    }
    const sail = new THREE.BufferGeometry();
    sail.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.9, -1.4, 0, 6.2, 0.2, 0, 0.9, 1.5, 0, 0.9, -1.4, 0, 0.9, 1.5, 0, 6.2, 0.2], 3));
    sail.computeVertexNormals();
    const jib = new THREE.BufferGeometry();
    jib.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.9, 0.5, 0, 5.4, 0.35, 0, 0.9, 2.3, 0, 0.9, 0.5, 0, 0.9, 2.3, 0, 5.4, 0.35], 3));
    jib.computeVertexNormals();
    const boatG = mergeGeometries([
      paint(hull.translate(0, 0.1, 0), 0xffffff),
      paint(new THREE.CylinderGeometry(0.07, 0.08, 6.4, 5).translate(0, 3.3, 0.2), 0x8a6a4a),
      paint(sail, 0xffffff),
      paint(jib, 0xfff6e0),
    ]);
    const boatMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
    const candidates = [
      { cx: -232, cz: -10, rx: 34, rz: 48, sp: 0.05 },
      { cx: -205, cz: -95, rx: 30, rz: 18, sp: -0.06 },
      { cx: -290, cz: -30, rx: 18, rz: 40, sp: 0.045 },
      { cx: -120, cz: -200, rx: 60, rz: 25, sp: 0.03 },
      { cx: -330, cz: 30, rx: 14, rz: 22, sp: -0.05 },
    ];
    // keep only paths that stay in deep enough water
    const boats = candidates.filter((b) => {
      for (let a = 0; a < Math.PI * 2; a += 0.2) {
        if (field.surfaceHeight(b.cx + Math.cos(a) * b.rx, b.cz + Math.sin(a) * b.rz) > WATER_LEVEL - 1.2) return false;
      }
      return true;
    });
    if (boats.length) {
      const inst = new THREE.InstancedMesh(boatG, boatMat, boats.length);
      inst.frustumCulled = false;
      const bc = [0xffffff, 0xffe0e0, 0xe0f0ff, 0xfff4c8, 0xe6ffe6];
      boats.forEach((b, i) => { b.a = i * 2.1; inst.setColorAt(i, _col.set(bc[i % bc.length])); });
      const placeBoats = (time) => {
        for (let i = 0; i < boats.length; i++) {
          const b = boats[i];
          const x = b.cx + Math.cos(b.a) * b.rx, z = b.cz + Math.sin(b.a) * b.rz;
          // heading = derivative of the ellipse
          const dx = -Math.sin(b.a) * b.rx * Math.sign(b.sp), dz = Math.cos(b.a) * b.rz * Math.sign(b.sp);
          const yaw = Math.atan2(dx, dz);
          _eul.set(Math.sin(time * 1.3 + i) * 0.04, yaw, Math.sin(time * 0.9 + i * 2) * 0.08 + 0.1 * Math.sign(b.sp), 'YXZ');
          _q.setFromEuler(_eul);
          _m4.compose(_p3.set(x, WATER_LEVEL - 0.15 + Math.sin(time * 1.7 + i) * 0.08, z), _q, _s3.set(1.2, 1.2, 1.2));
          inst.setMatrixAt(i, _m4);
        }
        inst.instanceMatrix.needsUpdate = true;
      };
      placeBoats(0);
      add(inst, { cast: false, name: 'Boats' });
      animators.push((dt, time) => {
        for (let i = 0; i < boats.length; i++) boats[i].a += boats[i].sp * dt;
        placeBoats(time);
      });
      stats.instances.boats = boats.length;
    } else {
      boatG.dispose();
    }
    hull.dispose(); sail.dispose(); jib.dispose();
  }

  // ---------------------------------------------------------------- update / dispose
  let time = 0;
  const _focus = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const startPos = track.startLine.position.clone();

  function update(dt, focusPosition, camera) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    time += dt;
    timeUniform.value = time;

    if (camera && camera.isPerspectiveCamera && camera.far < MIN_CAMERA_FAR) {
      camera.far = MIN_CAMERA_FAR;
      camera.updateProjectionMatrix();
    }

    // Shadow box follows the focus, pushed a little ahead along the view
    // direction so more of the visible ground gets shadows; snapped to
    // shadow-map texels to avoid shimmering edges.
    _focus.copy(focusPosition || startPos);
    if (camera) {
      camera.getWorldDirection(_fwd);
      _fwd.y = 0;
      const l = _fwd.length();
      if (l > 1e-4) _focus.addScaledVector(_fwd, 12 / l);
    }
    const a = Math.round(_focus.dot(lightRight) / shadowTexel) * shadowTexel;
    const b2 = Math.round(_focus.dot(lightUp) / shadowTexel) * shadowTexel;
    const c = _focus.dot(sunDir);
    _focus.copy(lightRight).multiplyScalar(a).addScaledVector(lightUp, b2).addScaledVector(sunDir, c);
    sun.target.position.copy(_focus);
    sun.position.copy(_focus).addScaledVector(sunDir, SUN_DIST);
    sun.target.updateMatrixWorld();

    for (let i = 0; i < animators.length; i++) animators[i](dt, time, camera);
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    scene.remove(root);
    const mats = new Set(), geos = new Set();
    root.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
      if (o.isInstancedMesh) o.dispose();
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    textures.forEach((t) => t.dispose());
    sun.dispose();
    if (scene.fog && scene.fog === fogRef) scene.fog = prevFog || null;
    if (scene.background === bgRef) scene.background = prevBackground || null;
  }
  const fogRef = scene.fog, bgRef = scene.background;

  stats.buildMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);

  return {
    sun,
    hemi,
    root,
    update,
    dispose,
    itemBoxAnchor: null,
    waterLevel: WATER_LEVEL,
    /** Terrain height at (x, z) as rendered (off-track ground, beaches, seabed). */
    getGroundHeight: (x, z) => field.surfaceHeight(x, z),
    stats,
  };
}

// Compose a TRS matrix (yaw only) into `m`.
function place_m4(m, x, y, z, yaw, sx, sy, sz) {
  _eul.set(0, yaw, 0, 'YXZ');
  _q.setFromEuler(_eul);
  return m.compose(_p3.set(x, y, z), _q, _s3.set(sx, sy, sz));
}

// Node-safe internals exported for tools/world-check.mjs (no DOM needed).
export { coastDistance, createTerrainField, SEA_POLY, ISLETS, LIGHTHOUSE };
