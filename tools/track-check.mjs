// Sanity checks for track.js: closure, projection round-trips, racing line.
import { Track } from '../public/js/track.js';
const t0 = performance.now();
const tr = new Track();
console.log('build ms', (performance.now() - t0).toFixed(1), 'length', tr.length.toFixed(1), 'N', tr.N, 'closureErr', tr.closureError.toFixed(4));
console.log('bounds', JSON.stringify(Object.fromEntries(Object.entries(tr.bounds).map(([k, v]) => [k, +v.toFixed(1)]))));
let maxErrS = 0, maxErrL = 0, bad = 0;
const proj = {};
for (let k = 0; k < 4000; k++) {
  const s = Math.random() * tr.length;
  const f = tr.frameAt(s);
  const lat = (Math.random() * 2 - 1) * Math.min(f.wallL, f.wallR);
  const p = tr.pointAt(s, lat);
  tr.project(p, -1, proj);
  const es = Math.abs(tr.deltaS(s, proj.s)), el = Math.abs(proj.lateral - lat);
  maxErrS = Math.max(maxErrS, es); maxErrL = Math.max(maxErrL, el);
  if (es > 0.5 || el > 0.3) bad++;
}
console.log('project round-trip max |ds|', maxErrS.toFixed(3), 'max |dlat|', maxErrL.toFixed(3), 'bad', bad);
let maxC = 0, maxRL = 0; for (let i = 0; i < tr.N; i++) { maxC = Math.max(maxC, Math.abs(tr.curv[i])); maxRL = Math.max(maxRL, Math.abs(tr.racingLine[i])); }
console.log('min radius', (1 / maxC).toFixed(1), 'max racing-line offset', maxRL.toFixed(2));
console.log('itemBoxes', tr.itemBoxes.length, 'pads', tr.boostPads.map(p => p.s0.toFixed(0)).join(','), 'ramps', tr.ramps.map(r => r.s0.toFixed(0)).join(','));
console.log('grid', [0, 7].map(i => { const g = tr.gridSlot(i); return `${i}:(${g.position.x.toFixed(1)},${g.position.y.toFixed(1)},${g.position.z.toFixed(1)}) yaw ${g.yaw.toFixed(3)}`; }).join(' '));
console.log('segments', tr.segments.map(s => `${s.index}:${s.s0.toFixed(0)}`).join(' '));
const ys = []; for (let s = 330; s < 440; s += 10) ys.push(`${s}:${tr.frameAt(s).y.toFixed(1)}`); console.log('hill profile', ys.join(' '));
// hint tracking perf
let hint = -1; const t1 = performance.now(); for (let k = 0; k < 100000; k++) { const s = (k * 0.3) % tr.length; const p = tr.pointAt(s, 2); tr.project(p, hint, proj); hint = proj.index; }
console.log('100k hinted projections ms', (performance.now() - t1).toFixed(1));
