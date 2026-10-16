// Track geometry + spatial queries. Node-safe (no DOM): used by the browser
// game AND by the headless simulation (tools/sim.mjs).
//
// Conventions (see SPEC.md):
//   * Y is up, units are meters.
//   * s = arc length along the centerline from the start/finish line, in [0, length).
//   * lateral = signed horizontal offset from the centerline, + = RIGHT of the
//     driving direction.
//   * forward = (sin yaw, 0, cos yaw); right = (-cos yaw, 0, sin yaw).
//
// The road is laterally flat (no banking): the road surface height depends
// only on s, plus kicker ramps which add height over a strip.

import * as THREE from 'three';
import { TRACK_DEF } from './track-def.js';
import { clamp, lerp, wrapAngle } from './utils.js';

export const CURB_WIDTH = 1.0;          // curb strip just outside each road edge (m)
const SEARCH_WINDOW = 30;               // samples searched around the hint in project()

export class Track {
  constructor(def = TRACK_DEF) {
    this.def = def;
    this.name = def.name;
    this._buildCenterline();
    this._buildAttributes();
    this._buildFrames();
    this._buildFeatures();
    this._buildRacingLine();
  }

  // ------------------------------------------------------------------ build

  _buildCenterline() {
    const def = this.def;
    const step = 0.05;
    let x = def.start.x, z = def.start.z, yaw = def.start.yaw;
    let s = 0;
    const dense = [{ x, z, s: 0 }];
    this.segStartS = [];
    this.segments = [];
    def.segments.forEach((seg, si) => {
      const s0 = s;
      this.segStartS.push(s);
      if (seg.type === 'straight') {
        const n = Math.max(1, Math.ceil(seg.length / step));
        const ds = seg.length / n;
        for (let k = 1; k <= n; k++) {
          x += Math.sin(yaw) * ds; z += Math.cos(yaw) * ds; s += ds;
          dense.push({ x, z, s });
        }
      } else {
        const ang = (seg.angle * Math.PI) / 180;
        const len = ang * seg.radius;
        const n = Math.max(2, Math.ceil(len / step));
        const dyaw = ((seg.dir === 'right' ? -1 : 1) * ang) / n;
        const ds = len / n;
        for (let k = 1; k <= n; k++) {
          const mid = yaw + dyaw * 0.5;
          x += Math.sin(mid) * ds; z += Math.cos(mid) * ds; yaw += dyaw; s += ds;
          dense.push({ x, z, s });
        }
      }
      this.segments.push({ ...seg, index: si, s0, s1: s });
    });
    this.segStartS.push(s);
    const L = s;

    const turned = yaw - def.start.yaw;
    if (Math.abs(Math.abs(turned) - Math.PI * 2) > 1e-3) {
      console.warn(`[track] segments turn ${(turned * 180 / Math.PI).toFixed(2)}°, expected ±360°`);
    }
    // Distribute any closure error linearly along the loop.
    const ex = x - def.start.x, ez = z - def.start.z;
    this.closureError = Math.hypot(ex, ez);
    if (this.closureError > 2) console.warn(`[track] closure error ${this.closureError.toFixed(2)} m`);
    for (const p of dense) { const t = p.s / L; p.x -= ex * t; p.z -= ez * t; }

    // Resample at uniform arc-length spacing.
    const N = Math.max(16, Math.round(L / (def.sampleSpacing || 1)));
    const spacing = L / N;
    this.length = L;
    this.N = N;
    this.spacing = spacing;
    this.px = new Float32Array(N);
    this.py = new Float32Array(N);
    this.pz = new Float32Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const si = i * spacing;
      while (j < dense.length - 2 && dense[j + 1].s < si) j++;
      const a = dense[j], b = dense[j + 1];
      const f = b.s > a.s ? clamp((si - a.s) / (b.s - a.s), 0, 1) : 0;
      this.px[i] = lerp(a.x, b.x, f);
      this.pz[i] = lerp(a.z, b.z, f);
    }
  }

  // u (segmentIndex + fraction) -> s
  sOfU(u) {
    const n = this.def.segments.length;
    u = clamp(u, 0, n);
    const i = Math.min(Math.floor(u), n - 1);
    const f = u - i;
    return this.segStartS[i] + f * (this.segStartS[i + 1] - this.segStartS[i]);
  }

  _keyframeArray(keys, fallback) {
    const N = this.N, L = this.length;
    const out = new Float32Array(N);
    if (!keys || !keys.length) { out.fill(fallback); return out; }
    const ks = keys.map(([u, v]) => [this.sOfU(u), v]).sort((a, b) => a[0] - b[0]);
    // wrap: append first key + L so interpolation across the line works
    const ext = [[ks[ks.length - 1][0] - L, ks[ks.length - 1][1]], ...ks, [ks[0][0] + L, ks[0][1]]];
    let k = 0;
    for (let i = 0; i < N; i++) {
      const s = i * this.spacing;
      while (k < ext.length - 2 && ext[k + 1][0] <= s) k++;
      const a = ext[k], b = ext[k + 1];
      const f = b[0] > a[0] ? clamp((s - a[0]) / (b[0] - a[0]), 0, 1) : 0;
      out[i] = lerp(a[1], b[1], f);
    }
    return out;
  }

  _smooth(arr, radius) {
    if (!radius) return arr;
    const N = arr.length, out = new Float32Array(N);
    for (let pass = 0; pass < 2; pass++) {
      const src = pass === 0 ? arr : out.slice();
      for (let i = 0; i < N; i++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += src[(i + k + N) % N];
        out[i] = sum / (2 * radius + 1);
      }
    }
    return out;
  }

  _buildAttributes() {
    const d = this.def, sm = d.smoothing || {};
    this.py = this._smooth(this._keyframeArray(d.elevation, 0), sm.elevation || 0);
    this.hw = this._smooth(this._keyframeArray(d.halfWidth, 9), sm.halfWidth || 0);
    const oL = this._smooth(this._keyframeArray(d.offroadLeft, 7), sm.offroad || 0);
    const oR = this._smooth(this._keyframeArray(d.offroadRight, 7), sm.offroad || 0);
    this.offL = oL; this.offR = oR;
    this.wl = new Float32Array(this.N);
    this.wr = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) { this.wl[i] = this.hw[i] + oL[i]; this.wr[i] = this.hw[i] + oR[i]; }
  }

  _buildFrames() {
    const N = this.N, px = this.px, pz = this.pz, py = this.py;
    this.tx = new Float32Array(N); this.tz = new Float32Array(N);   // horizontal unit tangent
    this.rx = new Float32Array(N); this.rz = new Float32Array(N);   // horizontal unit right
    this.yawArr = new Float32Array(N);
    this.slope = new Float32Array(N);                               // dy/ds
    this.curv = new Float32Array(N);                                // + = turning right (1/m)
    this.segH = new Float32Array(N);                                // horizontal dist to next sample
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      let dx = px[b] - px[a], dz = pz[b] - pz[a];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      this.tx[i] = dx; this.tz[i] = dz;
      this.rx[i] = -dz; this.rz[i] = dx;
      this.yawArr[i] = Math.atan2(dx, dz);
      this.slope[i] = (py[b] - py[a]) / (2 * this.spacing);
      this.segH[i] = Math.hypot(px[b] - px[i], pz[b] - pz[i]) || this.spacing;
    }
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      raw[i] = -wrapAngle(this.yawArr[b] - this.yawArr[a]) / (2 * this.spacing);
    }
    this.curv = this._smooth(raw, 3);

    // Convenience object view used by visual builders.
    this.samples = new Array(N);
    for (let i = 0; i < N; i++) {
      this.samples[i] = {
        index: i,
        s: i * this.spacing,
        pos: new THREE.Vector3(px[i], py[i], pz[i]),
        tangent: new THREE.Vector3(this.tx[i], 0, this.tz[i]),
        right: new THREE.Vector3(this.rx[i], 0, this.rz[i]),
        yaw: this.yawArr[i],
        halfWidth: this.hw[i],
        wallL: this.wl[i],
        wallR: this.wr[i],
        curvature: this.curv[i],
        slope: this.slope[i],
      };
    }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < N; i++) {
      const w = Math.max(this.wl[i], this.wr[i]);
      minX = Math.min(minX, px[i] - w); maxX = Math.max(maxX, px[i] + w);
      minZ = Math.min(minZ, pz[i] - w); maxZ = Math.max(maxZ, pz[i] + w);
      minY = Math.min(minY, py[i]); maxY = Math.max(maxY, py[i]);
    }
    this.bounds = { minX, maxX, minZ, maxZ, minY, maxY };
    this.center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  }

  _buildFeatures() {
    const d = this.def;
    // Ramps first: pointAt() below consults them.
    this.ramps = (d.ramps || []).map((r) => {
      const s0 = this.sOfU(r.u);
      const full = !r.width;
      return {
        s0, s1: s0 + r.length, length: r.length, height: r.height,
        fullWidth: full,
        lat0: full ? null : r.lateral - r.width / 2,
        lat1: full ? null : r.lateral + r.width / 2,
      };
    });

    this.itemBoxes = [];
    this.itemRows = (d.itemRows || []).map((row, ri) => {
      const s = this.sOfU(row.u);
      const f = this.frameAt(s);
      const count = Math.max(1, row.count || 4);
      const span = f.halfWidth * 0.68;
      const boxes = [];
      for (let k = 0; k < count; k++) {
        const lateral = count === 1 ? 0 : lerp(-span, span, k / (count - 1));
        const box = { row: ri, s, lateral, position: this.pointAt(s, lateral) };
        boxes.push(box);
        this.itemBoxes.push(box);
      }
      return { s, boxes };
    });

    this.boostPads = (d.boostPads || []).map((p) => {
      const s0 = this.sOfU(p.u);
      const sc = s0 + p.length / 2;
      return {
        s0, s1: s0 + p.length, length: p.length, width: p.width,
        lateral: p.lateral, lat0: p.lateral - p.width / 2, lat1: p.lateral + p.width / 2,
        center: this.pointAt(sc, p.lateral),
        yaw: this.frameAt(sc).yaw,
      };
    });

    this.zones = (d.zones || []).map((z) => ({ type: z.type, s0: this.sOfU(z.u0), s1: this.sOfU(z.u1) }));

    const f0 = this.frameAt(0);
    this.startLine = { s: 0, position: f0.position.clone(), yaw: f0.yaw, halfWidth: f0.halfWidth };
  }

  _buildRacingLine() {
    // Elastic-band relaxation: repeatedly move each point toward the midpoint of
    // its neighbours (k samples away), clamped inside the road. Converges to a
    // smooth line that cuts toward the inside of corners.
    const N = this.N, margin = 2.4;
    const off = new Float32Array(N);
    const { px, pz, rx, rz, hw } = this;
    const passes = [[12, 260], [6, 160], [3, 80]];
    for (const [k, iters] of passes) {
      for (let it = 0; it < iters; it++) {
        for (let i = 0; i < N; i++) {
          const a = (i - k + N) % N, b = (i + k) % N;
          const mx = (px[a] + rx[a] * off[a] + px[b] + rx[b] * off[b]) * 0.5;
          const mz = (pz[a] + rz[a] * off[a] + pz[b] + rz[b] * off[b]) * 0.5;
          const target = (mx - px[i]) * rx[i] + (mz - pz[i]) * rz[i];
          const lim = Math.max(0, hw[i] - margin);
          off[i] = clamp(off[i] + (target - off[i]) * 0.5, -lim, lim);
        }
      }
    }
    this.racingLine = this._smooth(off, 2);
  }

  // ---------------------------------------------------------------- helpers

  wrapS(s) { const L = this.length; s %= L; return s < 0 ? s + L : s; }

  // Shortest signed distance from a to b along the loop, in [-L/2, L/2].
  deltaS(a, b) {
    const L = this.length;
    let d = (b - a) % L;
    if (d > L / 2) d -= L; else if (d < -L / 2) d += L;
    return d;
  }

  // Forward distance from a to b, in [0, L).
  forwardDistance(a, b) { return this.wrapS(b - a); }

  indexAt(s) { return Math.floor(this.wrapS(s) / this.spacing) % this.N; }

  // Extra height from kicker ramps at (s, lateral).
  rampHeight(s, lateral, halfWidth) {
    let h = 0;
    for (const r of this.ramps) {
      const d = this.deltaS(r.s0, s);
      if (d < 0 || d > r.length) continue;
      const inside = r.fullWidth ? Math.abs(lateral) <= halfWidth : lateral >= r.lat0 && lateral <= r.lat1;
      if (inside) h = Math.max(h, (r.height * d) / r.length);
    }
    return h;
  }

  // Road surface point at (s, lateral). Returns a THREE.Vector3.
  pointAt(s, lateral = 0, out = new THREE.Vector3()) {
    s = this.wrapS(s);
    const fi = s / this.spacing;
    const i0 = Math.floor(fi) % this.N, i1 = (i0 + 1) % this.N, f = fi - Math.floor(fi);
    let rxv = lerp(this.rx[i0], this.rx[i1], f), rzv = lerp(this.rz[i0], this.rz[i1], f);
    const rl = Math.hypot(rxv, rzv) || 1; rxv /= rl; rzv /= rl;
    const cx = lerp(this.px[i0], this.px[i1], f), cz = lerp(this.pz[i0], this.pz[i1], f);
    const hw = lerp(this.hw[i0], this.hw[i1], f);
    const y = lerp(this.py[i0], this.py[i1], f) + this.rampHeight(s, lateral, hw);
    return out.set(cx + rxv * lateral, y, cz + rzv * lateral);
  }

  // Interpolated frame at arc length s.
  frameAt(s, out = {}) {
    s = this.wrapS(s);
    const fi = s / this.spacing;
    const i0 = Math.floor(fi) % this.N, i1 = (i0 + 1) % this.N, f = fi - Math.floor(fi);
    let rxv = lerp(this.rx[i0], this.rx[i1], f), rzv = lerp(this.rz[i0], this.rz[i1], f);
    const rl = Math.hypot(rxv, rzv) || 1; rxv /= rl; rzv /= rl;
    out.index = i0;
    out.s = s;
    out.x = lerp(this.px[i0], this.px[i1], f);
    out.y = lerp(this.py[i0], this.py[i1], f);
    out.z = lerp(this.pz[i0], this.pz[i1], f);
    out.position = (out.position || new THREE.Vector3()).set(out.x, out.y, out.z);
    out.tangent = (out.tangent || new THREE.Vector3()).set(rzv, 0, -rxv);
    out.right = (out.right || new THREE.Vector3()).set(rxv, 0, rzv);
    out.yaw = Math.atan2(rzv, -rxv);
    out.halfWidth = lerp(this.hw[i0], this.hw[i1], f);
    out.wallL = lerp(this.wl[i0], this.wl[i1], f);
    out.wallR = lerp(this.wr[i0], this.wr[i1], f);
    out.curvature = lerp(this.curv[i0], this.curv[i1], f);
    out.slope = lerp(this.slope[i0], this.slope[i1], f);
    out.racingLine = lerp(this.racingLine ? this.racingLine[i0] : 0, this.racingLine ? this.racingLine[i1] : 0, f);
    return out;
  }

  // Project a world position onto the track.
  //   pos:  {x, y, z} (THREE.Vector3 or plain object)
  //   hint: previous result's .index (or -1 for a full search)
  //   out:  optional object to write into (avoids allocations; reuse per kart)
  // Returns out with:
  //   index (int, use as next hint), f, s, lateral, height (road surface y at
  //   this point incl. ramps), centerY, halfWidth, wallL, wallR, curvature,
  //   slope, yaw (track heading), tangent / right (THREE.Vector3, horizontal
  //   unit), surface ('road' | 'boost' | 'curb' | 'offroad'), onRamp (bool),
  //   boostPad (pad object or null).
  project(pos, hint = -1, out = {}) {
    const N = this.N, px = this.px, pz = this.pz;
    let best = -1, bestD = Infinity, edge = false;
    if (hint >= 0 && hint < N) {
      for (let k = -SEARCH_WINDOW; k <= SEARCH_WINDOW; k++) {
        let i = hint + k;
        if (i < 0) i += N; else if (i >= N) i -= N;
        const dx = pos.x - px[i], dz = pos.z - pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; edge = k === -SEARCH_WINDOW || k === SEARCH_WINDOW; }
      }
    }
    if (best < 0 || edge || bestD > 60 * 60) {
      best = 0; bestD = Infinity;
      for (let i = 0; i < N; i++) {
        const dx = pos.x - px[i], dz = pos.z - pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    }

    const i = best;
    const along = (pos.x - px[i]) * this.tx[i] + (pos.z - pz[i]) * this.tz[i];
    let i0, f;
    if (along >= 0) { i0 = i; f = along / this.segH[i]; }
    else { i0 = (i - 1 + N) % N; f = 1 + along / this.segH[i0]; }
    f = clamp(f, 0, 1);
    const i1 = (i0 + 1) % N;

    let rxv = lerp(this.rx[i0], this.rx[i1], f), rzv = lerp(this.rz[i0], this.rz[i1], f);
    const rl = Math.hypot(rxv, rzv) || 1; rxv /= rl; rzv /= rl;
    const cx = lerp(px[i0], px[i1], f), cz = lerp(pz[i0], pz[i1], f);
    const cy = lerp(this.py[i0], this.py[i1], f);
    const lateral = (pos.x - cx) * rxv + (pos.z - cz) * rzv;
    const s = this.wrapS((i0 + f) * this.spacing);
    const hw = lerp(this.hw[i0], this.hw[i1], f);
    const ramp = this.rampHeight(s, lateral, hw);

    out.index = f > 0.5 ? i1 : i0;
    out.f = f;
    out.s = s;
    out.lateral = lateral;
    out.centerY = cy;
    out.height = cy + ramp;
    out.onRamp = ramp > 0;
    out.halfWidth = hw;
    out.wallL = lerp(this.wl[i0], this.wl[i1], f);
    out.wallR = lerp(this.wr[i0], this.wr[i1], f);
    out.curvature = lerp(this.curv[i0], this.curv[i1], f);
    out.slope = lerp(this.slope[i0], this.slope[i1], f);
    out.yaw = Math.atan2(rzv, -rxv);
    out.tangent = (out.tangent || new THREE.Vector3()).set(rzv, 0, -rxv);
    out.right = (out.right || new THREE.Vector3()).set(rxv, 0, rzv);

    const al = Math.abs(lateral);
    let surface = al <= hw ? 'road' : al <= hw + CURB_WIDTH ? 'curb' : 'offroad';
    out.boostPad = null;
    if (surface === 'road') {
      for (const p of this.boostPads) {
        const d = this.deltaS(p.s0, s);
        if (d >= 0 && d <= p.length && lateral >= p.lat0 && lateral <= p.lat1) { surface = 'boost'; out.boostPad = p; break; }
      }
    }
    out.surface = surface;
    return out;
  }

  // Road height under a world position (convenience wrapper around project()).
  heightAt(pos, hint = -1) { return this.project(pos, hint, this._tmpProj || (this._tmpProj = {})).height; }

  // Starting grid slot i (0 = pole). Slots are behind the start line,
  // staggered left/right. Returns { position: Vector3, yaw, s, lateral }.
  gridSlot(i) {
    const s = this.wrapS(-(7 + i * 3.4));
    const lateral = (i % 2 === 0 ? -1 : 1) * 3.6;
    const f = this.frameAt(s);
    return { position: this.pointAt(s, lateral), yaw: f.yaw, s, lateral };
  }
}

let _shared = null;
// Lazily-created shared Track instance for the default layout.
export function getTrack() { return _shared || (_shared = new Track()); }
