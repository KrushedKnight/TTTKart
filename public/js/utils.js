// Small math helpers shared by all modules. Node-safe.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

// Frame-rate independent exponential smoothing: move `current` toward `target`
// with time constant controlled by `rate` (1/s). damp(x, y, 10, dt)
export const damp = (current, target, rate, dt) => lerp(current, target, 1 - Math.exp(-rate * dt));

// Move value toward target by at most maxDelta.
export const approach = (current, target, maxDelta) =>
  current < target ? Math.min(current + maxDelta, target) : Math.max(current - maxDelta, target);

// Wrap an angle to (-PI, PI].
export const wrapAngle = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

// Shortest signed difference b - a between two angles.
export const angleDiff = (a, b) => wrapAngle(b - a);

// Exponential smoothing for angles (handles wrap-around).
export const dampAngle = (current, target, rate, dt) =>
  current + angleDiff(current, target) * (1 - Math.exp(-rate * dt));

// Heading conventions (see SPEC.md): forward = (sin(yaw), 0, cos(yaw)),
// right = (-cos(yaw), 0, sin(yaw)). Increasing yaw turns LEFT.
export const yawFromDir = (dx, dz) => Math.atan2(dx, dz);

// Deterministic PRNG (mulberry32). rng() -> [0, 1)
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randRange = (rng, lo, hi) => lo + (hi - lo) * rng();

// Pick an index from an array of non-negative weights.
export function weightedPick(weights, rng = Math.random) {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return 0;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r < 0) return i;
  }
  return weights.length - 1;
}

export const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export const formatTime = (seconds) => {
  if (!isFinite(seconds) || seconds < 0) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
};
