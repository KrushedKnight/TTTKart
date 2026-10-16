// Synthesized audio for KRISHIV KART. Everything is generated live with WebAudio
// (oscillators, noise buffers, filters, envelopes) — there are no audio files.
//
//   const audio = new AudioEngine();
//   window.addEventListener('pointerdown', () => audio.unlock());   // any user gesture
//   audio.play('toot', { volume: 0.8, pitch: 1.05, pan: -0.2 });
//   audio.updateEngine(dt, { speed, maxSpeed, throttle, drifting, boosting, grounded, offroad, active });
//   audio.startMusic('race'); audio.setMusicIntensity(1); audio.stopMusic();
//
// Layout of this module:
//   * SOUNDS[name](ctx, destination, { when, pitch }) → duration in seconds.
//     Stateless scheduling functions, so tests can render every sound in an
//     OfflineAudioContext (see public/dev/audio.html).
//   * buildMasterChain(ctx): SFX bus + music bus → compressor → master gain →
//     soft limiter. Shared by the live engine and the offline tests.
//   * Music: SONGS (original chiptunes), createMusicRig + scheduleMusicStep
//     (one 16th-note step of a song) driven by a lookahead sequencer that runs
//     on AudioContext time, so it never drifts and loops seamlessly.
//   * EngineLoops: continuous player engine / drift screech / off-road rumble /
//     boost jet loops.
//   * AudioEngine: the runtime façade used by the game. Every method is a safe
//     no-op until unlock() has created a running AudioContext.

import { clamp, damp, makeRng } from './utils.js';
import { KART } from './config.js';

// ------------------------------------------------------------------ pitch

const NOTE_OFFSETS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C4' → 60, 'F#5' → 78, 'Bb2' → 46 */
export function noteToMidi(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`[audio] bad note "${name}"`);
  return NOTE_OFFSETS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const nf = (name) => mtof(noteToMidi(name));

// ---------------------------------------------------- per-context caches

const CACHES = new WeakMap();
function cacheFor(ctx) {
  let c = CACHES.get(ctx);
  if (!c) { c = {}; CACHES.set(ctx, c); }
  return c;
}

// 2 s of deterministic white noise, shared by every noise voice of a context.
function noiseBuffer(ctx) {
  const c = cacheFor(ctx);
  if (!c.noise) {
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const rng = makeRng(0x70075);
    for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
    c.noise = buf;
  }
  return c.noise;
}

// Band-limited pulse wave with the given duty cycle (0.125 / 0.25 = classic chiptune).
function pulseWave(ctx, duty) {
  const c = cacheFor(ctx);
  const key = 'pulse' + duty;
  if (!c[key]) {
    const n = 48;
    const real = new Float32Array(n), imag = new Float32Array(n);
    for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
    c[key] = ctx.createPeriodicWave(real, imag);
  }
  return c[key];
}

// Soft-knee limiter curve: linear up to 0.75, then a tanh shoulder that never
// exceeds ~0.99. Covers input -2..2 (a 0.5 pre-gain maps it onto -1..1).
function softClipCurve(n = 2049) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    const ax = Math.abs(x);
    const y = ax <= 0.75 ? ax : 0.75 + 0.24 * Math.tanh((ax - 0.75) / 0.24);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

// ------------------------------------------------------------ node helpers

function osc(ctx, type, freq, t) {
  const o = ctx.createOscillator();
  if (typeof type === 'number') o.setPeriodicWave(pulseWave(ctx, type));
  else o.type = type;
  o.frequency.setValueAtTime(freq, t);
  return o;
}

function gain(ctx, v = 1) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function filter(ctx, type, freq, Q = 0.707) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  return f;
}

// Looping white-noise source. offset < 0 → random start (variation between plays).
function noise(ctx, t, dur, rate = 1, offset = -1) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(t, offset >= 0 ? offset : Math.random() * 1.8);
  s.stop(t + dur);
  return s;
}

// Percussive envelope: 0 → peak in `attack`, then exponential decay reaching
// about -60 dB after `decay` seconds.
function perc(param, t, peak, attack, decay) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0, t + attack, decay / 6.9);
}

// ADSR envelope with an explicit note-off time `end`.
function adsr(param, t, peak, attack, decay, sustain, end, release) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  if (decay > 0) param.setTargetAtTime(peak * sustain, t + attack, decay / 3);
  param.setTargetAtTime(0, Math.max(end, t + attack + 0.001), release / 5);
}

// Pitched one-shot with an exponential glide and a percussive envelope.
function blip(ctx, out, t, o) {
  const dur = o.dur ?? 0.1;
  const s = osc(ctx, o.type ?? 'square', o.f0, t);
  if (o.detune) s.detune.value = o.detune;
  if (o.f1 && o.f1 !== o.f0) s.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + (o.glide ?? dur));
  const g = gain(ctx, 0);
  perc(g.gain, t, o.peak ?? 0.2, o.attack ?? 0.003, dur);
  let head = s;
  if (o.lp) { const f = filter(ctx, 'lowpass', o.lp, o.Q ?? 0.8); head.connect(f); head = f; }
  head.connect(g);
  g.connect(out);
  if (o.vib) {
    const l = osc(ctx, 'sine', o.vibRate ?? 8, t);
    const d = gain(ctx, o.vib);
    l.connect(d); d.connect(s.detune);
    l.start(t); l.stop(t + dur + 0.05);
  }
  s.start(t);
  s.stop(t + dur + 0.05);
  return s;
}

// Filtered noise burst with an optional exponential filter sweep.
function hiss(ctx, out, t, o) {
  const dur = o.dur ?? 0.2;
  const n = noise(ctx, t, dur + 0.05, o.rate ?? 1, o.offset ?? -1);
  const f = filter(ctx, o.type ?? 'bandpass', o.f0 ?? 1000, o.Q ?? 1);
  if (o.f1 && o.f1 !== o.f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.sweep ?? dur));
  const g = gain(ctx, 0);
  perc(g.gain, t, o.peak ?? 0.3, o.attack ?? 0.002, dur);
  n.connect(f); f.connect(g); g.connect(out);
  return g;
}

// Sustained note with ADSR, optional vibrato and lowpass (jingles).
function note(ctx, out, t, freq, dur, o = {}) {
  const g = gain(ctx, 0);
  const end = t + dur;
  const rel = o.release ?? 0.08;
  adsr(g.gain, t, o.peak ?? 0.12, o.attack ?? 0.006, o.decay ?? 0.1, o.sustain ?? 0.65, end, rel);
  const s = osc(ctx, o.type ?? 0.25, freq, t);
  if (o.detune) s.detune.value = o.detune;
  let head = s;
  if (o.lp) { const f = filter(ctx, 'lowpass', o.lp, o.Q ?? 0.7); head.connect(f); head = f; }
  head.connect(g); g.connect(out);
  if (o.vib && dur > 0.2) {
    const l = osc(ctx, 'sine', o.vibRate ?? 5.5, t);
    const d = gain(ctx, 0);
    d.gain.setValueAtTime(0, t);
    d.gain.linearRampToValueAtTime(o.vib, t + Math.min(dur, 0.3));
    l.connect(d); d.connect(s.detune);
    l.start(t); l.stop(end + rel + 0.05);
  }
  s.start(t);
  s.stop(end + rel + 0.05);
  return s;
}

// Inharmonic bell (sine partials with staggered decays).
const BELL_PARTIALS = [[1, 1, 1], [2, 0.42, 0.7], [2.76, 0.26, 0.5], [5.4, 0.1, 0.25], [8.93, 0.05, 0.15]];
function bell(ctx, out, t, freq, peak = 0.12, dur = 0.7) {
  for (const [ratio, amp, dk] of BELL_PARTIALS) {
    const s = osc(ctx, 'sine', freq * ratio, t);
    const g = gain(ctx, 0);
    perc(g.gain, t, peak * amp, 0.002, dur * dk);
    s.connect(g); g.connect(out);
    s.start(t); s.stop(t + dur * dk + 0.05);
  }
}

// Brassy stab: two detuned saws through a lowpass with a "blat" filter envelope.
function brass(ctx, out, t, freq, dur, peak = 0.08) {
  const g = gain(ctx, 0);
  g.connect(out);
  adsr(g.gain, t, peak, 0.015, 0.18, 0.7, t + dur, 0.14);
  const lp = filter(ctx, 'lowpass', 500, 1.4);
  lp.frequency.setValueAtTime(450, t);
  lp.frequency.exponentialRampToValueAtTime(3400, t + 0.045);
  lp.frequency.exponentialRampToValueAtTime(1500, t + 0.3);
  lp.connect(g);
  for (const d of [-9, 9]) {
    const s = osc(ctx, 'sawtooth', freq, t);
    s.detune.value = d;
    s.connect(lp);
    s.start(t); s.stop(t + dur + 0.25);
  }
}

// Shared drum voices (used by the music and by jingles).
function kickDrum(ctx, out, t, vel = 1, offset = 0) {
  const s = osc(ctx, 'sine', 155, t);
  s.frequency.exponentialRampToValueAtTime(46, t + 0.09);
  const g = gain(ctx, 0);
  perc(g.gain, t, 0.62 * vel, 0.002, 0.24);
  s.connect(g); g.connect(out);
  s.start(t); s.stop(t + 0.3);
  hiss(ctx, out, t, { type: 'lowpass', f0: 2500, Q: 0.7, dur: 0.018, peak: 0.12 * vel, offset });
}
function snareDrum(ctx, out, t, vel = 1, offset = 0) {
  hiss(ctx, out, t, { type: 'bandpass', f0: 2100, Q: 0.6, dur: 0.16, peak: 0.36 * vel, offset });
  hiss(ctx, out, t, { type: 'highpass', f0: 5000, Q: 0.7, dur: 0.07, peak: 0.12 * vel, offset: offset + 0.31 });
  blip(ctx, out, t, { type: 'triangle', f0: 230, f1: 170, dur: 0.07, peak: 0.24 * vel });
}
function hatDrum(ctx, out, t, vel = 1, offset = 0, open = false) {
  hiss(ctx, out, t, { type: 'highpass', f0: 7600, Q: 0.8, dur: open ? 0.2 : 0.04, peak: 0.12 * vel, offset });
}
function crashCymbal(ctx, out, t, vel = 1, offset = 0) {
  hiss(ctx, out, t, { type: 'highpass', f0: 4200, Q: 0.5, dur: 1.4, peak: 0.13 * vel, offset });
  hiss(ctx, out, t, { type: 'bandpass', f0: 7000, Q: 1.5, dur: 0.9, peak: 0.07 * vel, offset: offset + 0.5 });
}

// Schedule [step, note, lengthInSteps, velocity] tuples through a voice fn.
function seqNotes(list, t, stepDur, fn) {
  for (const [st, n, len, vel = 1] of list) {
    fn(t + st * stepDur, typeof n === 'string' ? nf(n) : mtof(n), len * stepDur, vel);
  }
}

const opt = (ctx, o) => ({ t: o && o.when != null ? o.when : ctx.currentTime, p: (o && o.pitch) || 1 });

// ================================================================ SOUNDS
// Every function: (ctx, destination, { when, pitch }) → duration (s).
// RAW holds the voice designs; SOUNDS (below) wraps each with a level trim.

const RAW = {
  // ---------------------------------------------------------------- menus
  menuMove(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 0.25, f0: 990 * p, f1: 1320 * p, glide: 0.025, dur: 0.07, peak: 0.16, lp: 6000 });
    return 0.1;
  },
  menuSelect(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 0.25, f0: 784 * p, dur: 0.07, peak: 0.17, lp: 6000 });
    blip(ctx, out, t + 0.065, { type: 0.25, f0: 1175 * p, dur: 0.16, peak: 0.19, lp: 7000 });
    blip(ctx, out, t + 0.065, { type: 'sine', f0: 2350 * p, dur: 0.18, peak: 0.07 });
    return 0.3;
  },
  menuBack(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 0.25, f0: 740 * p, dur: 0.06, peak: 0.15, lp: 5000 });
    blip(ctx, out, t + 0.06, { type: 0.25, f0: 494 * p, f1: 440 * p, dur: 0.13, peak: 0.15, lp: 4000 });
    return 0.25;
  },

  // ---------------------------------------------------------------- race start
  countdown(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    note(ctx, out, t, 523.25 * p, 0.22, { type: 'square', peak: 0.13, decay: 0.05, sustain: 0.8, release: 0.06, lp: 3800 });
    note(ctx, out, t, 1046.5 * p, 0.22, { type: 'sine', peak: 0.09, decay: 0.05, sustain: 0.8, release: 0.06 });
    return 0.35;
  },
  go(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    note(ctx, out, t, 1046.5 * p, 0.55, { type: 'square', peak: 0.13, decay: 0.1, sustain: 0.75, release: 0.2, lp: 4500 });
    note(ctx, out, t, 1568 * p, 0.55, { type: 0.25, peak: 0.07, decay: 0.1, sustain: 0.7, release: 0.2, lp: 6000 });
    note(ctx, out, t, 2093 * p, 0.6, { type: 'sine', peak: 0.08, decay: 0.15, sustain: 0.5, release: 0.25 });
    return 0.9;
  },
  startBoost(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    bell(ctx, out, t, 1568 * p, 0.09, 0.5);
    hiss(ctx, out, t, { type: 'bandpass', f0: 300, f1: 4200, Q: 1.3, dur: 0.95, sweep: 0.55, peak: 0.42, attack: 0.03 });
    const s = osc(ctx, 'sawtooth', 220 * p, t);
    s.frequency.exponentialRampToValueAtTime(880 * p, t + 0.5);
    const lp = filter(ctx, 'lowpass', 600, 3);
    lp.frequency.exponentialRampToValueAtTime(5000, t + 0.45);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.13, 0.04, 0.8);
    s.connect(lp); lp.connect(g); g.connect(out);
    s.start(t); s.stop(t + 0.9);
    return 1.0;
  },
  stall(ctx, out, o) {
    // engine coughs three times and dies
    const { t, p } = opt(ctx, o);
    const chugs = [[0, 78], [0.17, 66], [0.38, 50]];
    for (const [dt, f] of chugs) {
      blip(ctx, out, t + dt, { type: 'sawtooth', f0: f * p * 1.4, f1: f * p, dur: 0.13, peak: 0.34, attack: 0.008, lp: 520, Q: 3 });
      hiss(ctx, out, t + dt, { type: 'lowpass', f0: 900, Q: 1, dur: 0.1, peak: 0.16 });
    }
    hiss(ctx, out, t + 0.52, { type: 'bandpass', f0: 1500, f1: 600, Q: 1.5, dur: 0.22, peak: 0.12, attack: 0.02 });
    return 0.8;
  },

  // ---------------------------------------------------------------- items
  itemBox(ctx, out, o) {
    // crystalline shatter: bright crack + scattered glassy partials + quick sparkle run
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'highpass', f0: 2800, Q: 0.9, dur: 0.12, peak: 0.42 });
    hiss(ctx, out, t, { type: 'bandpass', f0: 6500, f1: 3500, Q: 3, dur: 0.3, peak: 0.12 });
    const shards = [2093, 2637, 3136, 3520, 4186, 4699, 5588, 6272];
    for (let i = 0; i < shards.length; i++) {
      const dt = 0.004 + i * 0.011 + Math.random() * 0.02;
      const f = shards[i] * p * (1 + (Math.random() - 0.5) * 0.02);
      const s = osc(ctx, 'sine', f, t + dt);
      const g = gain(ctx, 0);
      perc(g.gain, t + dt, 0.07, 0.001, 0.22 + Math.random() * 0.35);
      s.connect(g); g.connect(out);
      s.start(t + dt); s.stop(t + dt + 0.65);
    }
    const run = ['E6', 'G#6', 'B6', 'E7'];
    run.forEach((n, i) => blip(ctx, out, t + 0.05 + i * 0.035, { type: 'triangle', f0: nf(n) * p, dur: 0.18, peak: 0.07 }));
    return 0.8;
  },
  roulette(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'square', f0: 1900 * p, f1: 1250 * p, glide: 0.02, dur: 0.035, peak: 0.09, lp: 7000 });
    hiss(ctx, out, t, { type: 'highpass', f0: 5000, dur: 0.012, peak: 0.06 });
    return 0.06;
  },
  itemGet(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    bell(ctx, out, t, 1318.5 * p, 0.11, 0.55);
    bell(ctx, out, t + 0.085, 1760 * p, 0.13, 0.8);
    blip(ctx, out, t + 0.085, { type: 0.25, f0: 1760 * p, dur: 0.12, peak: 0.05, lp: 6000 });
    return 0.9;
  },
  throw(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'bandpass', f0: 500 * p, f1: 2600 * p, Q: 2.2, dur: 0.24, sweep: 0.18, peak: 0.36, attack: 0.02 });
    blip(ctx, out, t, { type: 'triangle', f0: 520 * p, f1: 210 * p, dur: 0.14, peak: 0.16 });
    return 0.3;
  },
  bouncer(ctx, out, o) {
    // springy "bwoing" launch
    const { t, p } = opt(ctx, o);
    const s = osc(ctx, 'triangle', 180 * p, t);
    s.frequency.exponentialRampToValueAtTime(760 * p, t + 0.09);
    s.frequency.exponentialRampToValueAtTime(420 * p, t + 0.3);
    const l = osc(ctx, 'sine', 22, t);
    const d = gain(ctx, 60);
    l.connect(d); d.connect(s.detune);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.32, 0.006, 0.34);
    s.connect(g); g.connect(out);
    s.start(t); s.stop(t + 0.4); l.start(t); l.stop(t + 0.4);
    hiss(ctx, out, t, { type: 'lowpass', f0: 1200, Q: 1, dur: 0.08, peak: 0.22 });
    return 0.4;
  },
  rocket(ctx, out, o) {
    // ignition crackle then a rising roar
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'lowpass', f0: 380, f1: 3200, Q: 1.8, dur: 1.0, sweep: 0.5, peak: 0.42, attack: 0.04 });
    hiss(ctx, out, t, { type: 'highpass', f0: 3000, Q: 0.8, dur: 0.12, peak: 0.25 });
    const s = osc(ctx, 'sawtooth', 110 * p, t);
    s.frequency.exponentialRampToValueAtTime(520 * p, t + 0.7);
    const lp = filter(ctx, 'lowpass', 400, 2);
    lp.frequency.exponentialRampToValueAtTime(2600, t + 0.6);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.15, 0.08, 0.95);
    s.connect(lp); lp.connect(g); g.connect(out);
    s.start(t); s.stop(t + 1.05);
    return 1.1;
  },
  toot(ctx, out, o) {
    // Comedic "pfff-rrrrt!" boost toot: a buzzing low reed with irregular lip
    // flutter through a resonant "mouth" lowpass, a breathy pff at the start
    // and a little upward squeak at the end. Silly, never gross.
    const { t, p } = opt(ctx, o);
    const dur = 0.72;
    const out2 = gain(ctx, 0);
    out2.connect(out);
    const A = out2.gain;
    A.setValueAtTime(0, t);
    A.linearRampToValueAtTime(0.62, t + 0.035);
    A.linearRampToValueAtTime(0.46, t + 0.22);
    A.linearRampToValueAtTime(0.52, t + 0.46);
    A.linearRampToValueAtTime(0.24, t + 0.56);
    A.linearRampToValueAtTime(0.6, t + 0.6);
    A.setTargetAtTime(0, t + 0.62, 0.03);

    const f0 = 88 * p;
    const contour = (param, m) => {
      param.setValueAtTime(f0 * 1.35 * m, t);
      param.exponentialRampToValueAtTime(f0 * m, t + 0.12);
      param.linearRampToValueAtTime(f0 * 0.86 * m, t + 0.45);
      param.exponentialRampToValueAtTime(f0 * 0.68 * m, t + 0.55);
      param.exponentialRampToValueAtTime(f0 * 2.1 * m, t + 0.63);
    };
    const reed = osc(ctx, 'sawtooth', f0, t);
    const reed2 = osc(ctx, 'square', f0, t);
    contour(reed.frequency, 1);
    contour(reed2.frequency, 1.007);
    // lip flutter: two unrelated LFO rates → irregular pitch wobble + chopping
    const fl1 = osc(ctx, 'square', 24, t);
    fl1.frequency.linearRampToValueAtTime(31, t + dur);
    const fl2 = osc(ctx, 'sine', 37.3, t);
    const fd1 = gain(ctx, 120), fd2 = gain(ctx, 80);
    fl1.connect(fd1); fl2.connect(fd2);
    fd1.connect(reed.detune); fd1.connect(reed2.detune);
    fd2.connect(reed.detune); fd2.connect(reed2.detune);
    const chop = gain(ctx, 0.6);
    const chopDepth = gain(ctx, 0.38);
    fl1.connect(chopDepth); chopDepth.connect(chop.gain);
    const r1 = gain(ctx, 0.7), r2 = gain(ctx, 0.35);
    reed.connect(r1); reed2.connect(r2);
    r1.connect(chop); r2.connect(chop);
    // breath underneath the buzz (also chopped by the flutter)
    const air = noise(ctx, t, dur);
    const airBp = filter(ctx, 'bandpass', 360, 0.9);
    const airG = gain(ctx, 0.5);
    air.connect(airBp); airBp.connect(airG); airG.connect(chop);
    // resonant mouth
    const mouth = filter(ctx, 'lowpass', 1100, 7);
    mouth.frequency.setValueAtTime(1200, t);
    mouth.frequency.exponentialRampToValueAtTime(560, t + 0.42);
    mouth.frequency.exponentialRampToValueAtTime(1500, t + 0.62);
    chop.connect(mouth); mouth.connect(out2);
    for (const n of [reed, reed2, fl1, fl2]) { n.start(t); n.stop(t + dur + 0.1); }
    // the initial "pff"
    hiss(ctx, out, t, { type: 'bandpass', f0: 1900, f1: 700, Q: 1.3, dur: 0.17, peak: 0.24, attack: 0.008 });
    return dur + 0.15;
  },
  boost(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'bandpass', f0: 380, f1: 2800, Q: 1.6, dur: 0.7, sweep: 0.35, peak: 0.42, attack: 0.025 });
    const s = osc(ctx, 'sawtooth', 160 * p, t);
    s.frequency.exponentialRampToValueAtTime(340 * p, t + 0.3);
    const lp = filter(ctx, 'lowpass', 700, 2);
    lp.frequency.exponentialRampToValueAtTime(2400, t + 0.3);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.12, 0.03, 0.6);
    s.connect(lp); lp.connect(g); g.connect(out);
    s.start(t); s.stop(t + 0.7);
    return 0.75;
  },
  star(ctx, out, o) {
    // twinkling ascending sparkle arpeggio + shimmer
    const { t, p } = opt(ctx, o);
    const run = ['C6', 'E6', 'G6', 'C7', 'E7', 'G7', 'C8'];
    run.forEach((n, i) => {
      const tt = t + i * 0.045;
      blip(ctx, out, tt, { type: 'triangle', f0: nf(n) * p, dur: 0.3, peak: 0.11 });
      blip(ctx, out, tt, { type: 'sine', f0: nf(n) * p * 2.005, dur: 0.18, peak: 0.04 });
    });
    const sh = noise(ctx, t, 0.9);
    const hp = filter(ctx, 'highpass', 8000, 0.8);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.09, 0.05, 0.85);
    const trem = osc(ctx, 'square', 18, t);
    const td = gain(ctx, 0.5);
    const tg = gain(ctx, 0.5);
    trem.connect(td); td.connect(tg.gain);
    sh.connect(hp); hp.connect(tg); tg.connect(g); g.connect(out);
    trem.start(t); trem.stop(t + 0.95);
    return 1.0;
  },
  zap(ctx, out, o) {
    // electric crackle: random-stepped square buzz + gated noise + falling zzzt
    const { t, p } = opt(ctx, o);
    const dur = 0.7;
    const s = osc(ctx, 'square', 300, t);
    for (let k = 0; k < 48; k++) s.frequency.setValueAtTime((90 + Math.random() * 2200) * p, t + k * 0.013);
    const hp = filter(ctx, 'highpass', 350, 0.7);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    for (let k = 0; k < 28; k++) g.gain.setValueAtTime(Math.random() < 0.65 ? 0.09 + Math.random() * 0.07 : 0, t + k * 0.022);
    g.gain.setTargetAtTime(0, t + 0.62, 0.02);
    s.connect(hp); hp.connect(g); g.connect(out);
    s.start(t); s.stop(t + dur);
    const n = noise(ctx, t, dur);
    const nf2 = filter(ctx, 'highpass', 2500, 0.7);
    const ng = gain(ctx, 0);
    ng.gain.setValueAtTime(0, t);
    for (let k = 0; k < 22; k++) ng.gain.setValueAtTime(Math.random() < 0.5 ? 0.16 + Math.random() * 0.12 : 0.02, t + k * 0.028);
    ng.gain.setTargetAtTime(0, t + 0.62, 0.02);
    n.connect(nf2); nf2.connect(ng); ng.connect(out);
    blip(ctx, out, t, { type: 'sawtooth', f0: 1400 * p, f1: 70 * p, dur: 0.55, peak: 0.1, lp: 3000, Q: 4 });
    return dur + 0.05;
  },
  stink(ctx, out, o) {
    // gassy "psssshhh" hiss with a wobbly low burble
    const { t, p } = opt(ctx, o);
    const dur = 1.0;
    const n = noise(ctx, t, dur);
    const bp = filter(ctx, 'bandpass', 3800 * p, 1.1);
    bp.frequency.exponentialRampToValueAtTime(1300 * p, t + dur);
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.06);
    g.gain.setTargetAtTime(0, t + 0.45, 0.16);
    const wob = osc(ctx, 'sine', 9, t);
    const wd = gain(ctx, 0.35);
    const wg = gain(ctx, 0.65);
    wob.connect(wd); wd.connect(wg.gain);
    n.connect(bp); bp.connect(wg); wg.connect(g); g.connect(out);
    wob.start(t); wob.stop(t + dur);
    const b = osc(ctx, 'sawtooth', 62 * p, t);
    b.frequency.linearRampToValueAtTime(48 * p, t + 0.6);
    const fl = osc(ctx, 'sine', 17, t);
    const fd = gain(ctx, 160);
    fl.connect(fd); fd.connect(b.detune);
    const blp = filter(ctx, 'lowpass', 340, 4);
    const bg = gain(ctx, 0);
    perc(bg.gain, t, 0.26, 0.03, 0.6);
    b.connect(blp); blp.connect(bg); bg.connect(out);
    b.start(t); b.stop(t + 0.7); fl.start(t); fl.stop(t + 0.7);
    return dur + 0.1;
  },
  banana(ctx, out, o) {
    // wet squish + slip
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'bandpass', f0: 1400 * p, f1: 260 * p, Q: 4, dur: 0.22, sweep: 0.16, peak: 0.5, attack: 0.004 });
    blip(ctx, out, t, { type: 'sine', f0: 420 * p, f1: 110 * p, dur: 0.24, peak: 0.34, vib: 260, vibRate: 32 });
    blip(ctx, out, t + 0.12, { type: 'triangle', f0: 900 * p, f1: 1800 * p, dur: 0.16, peak: 0.08 });
    return 0.35;
  },

  // ---------------------------------------------------------------- hits
  hit(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'sine', f0: 150 * p, f1: 42 * p, dur: 0.3, peak: 0.55 });
    blip(ctx, out, t, { type: 'square', f0: 330 * p, f1: 150 * p, dur: 0.12, peak: 0.14, lp: 2200 });
    hiss(ctx, out, t, { type: 'lowpass', f0: 2600, f1: 500, Q: 0.9, dur: 0.3, peak: 0.42 });
    return 0.4;
  },
  spin(ctx, out, o) {
    // cartoon spin-out: falling warbly whistle over a tire squeal
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'triangle', f0: 1500 * p, f1: 300 * p, dur: 0.85, glide: 0.8, peak: 0.16, attack: 0.02, vib: 160, vibRate: 13 });
    blip(ctx, out, t, { type: 'sine', f0: 3000 * p, f1: 600 * p, dur: 0.6, glide: 0.8, peak: 0.04, vib: 160, vibRate: 13 });
    hiss(ctx, out, t, { type: 'bandpass', f0: 2600, f1: 1800, Q: 8, dur: 0.7, peak: 0.42, attack: 0.02 });
    return 0.95;
  },
  explode(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    hiss(ctx, out, t, { type: 'lowpass', f0: 4500, f1: 110, Q: 0.8, dur: 1.3, sweep: 0.9, peak: 0.75, rate: 0.8 });
    blip(ctx, out, t, { type: 'sine', f0: 95 * p, f1: 28 * p, dur: 0.8, peak: 0.6, attack: 0.004 });
    for (let k = 0; k < 6; k++) {
      hiss(ctx, out, t + 0.08 + k * 0.07 + Math.random() * 0.05, { type: 'highpass', f0: 1800, Q: 0.7, dur: 0.05, peak: 0.1 + Math.random() * 0.1 });
    }
    return 1.4;
  },
  wall(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'sine', f0: 115 * p, f1: 44 * p, dur: 0.2, peak: 0.5 });
    hiss(ctx, out, t, { type: 'lowpass', f0: 900 * p, Q: 1, dur: 0.16, peak: 0.46 });
    hiss(ctx, out, t, { type: 'bandpass', f0: 2400 * p, Q: 3, dur: 0.06, peak: 0.12 });
    return 0.25;
  },
  bump(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'triangle', f0: 320 * p, f1: 140 * p, dur: 0.1, peak: 0.34 });
    blip(ctx, out, t, { type: 'sine', f0: 120 * p, f1: 60 * p, dur: 0.14, peak: 0.34 });
    hiss(ctx, out, t, { type: 'bandpass', f0: 900 * p, Q: 1.5, dur: 0.07, peak: 0.24 });
    return 0.18;
  },
  hop(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'square', f0: 250 * p, f1: 560 * p, glide: 0.07, dur: 0.12, peak: 0.1, lp: 1900, Q: 2 });
    blip(ctx, out, t, { type: 'sine', f0: 250 * p, f1: 560 * p, glide: 0.07, dur: 0.12, peak: 0.12 });
    return 0.16;
  },
  land(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'sine', f0: 95 * p, f1: 40 * p, dur: 0.17, peak: 0.42 });
    hiss(ctx, out, t, { type: 'lowpass', f0: 500, Q: 0.8, dur: 0.12, peak: 0.34 });
    return 0.2;
  },
  respawn(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    const s = osc(ctx, 'sine', 300 * p, t);
    s.frequency.exponentialRampToValueAtTime(1250 * p, t + 0.5);
    const g = gain(ctx, 0);
    perc(g.gain, t, 0.2, 0.05, 0.6);
    const trem = osc(ctx, 'sine', 16, t);
    const td = gain(ctx, 0.45);
    const tg = gain(ctx, 0.55);
    trem.connect(td); td.connect(tg.gain);
    s.connect(tg); tg.connect(g); g.connect(out);
    s.start(t); s.stop(t + 0.65); trem.start(t); trem.stop(t + 0.65);
    ['G6', 'B6', 'D7'].forEach((n, i) => blip(ctx, out, t + 0.42 + i * 0.05, { type: 'triangle', f0: nf(n) * p, dur: 0.2, peak: 0.07 }));
    return 0.75;
  },

  // ---------------------------------------------------------------- drifting
  drift1(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'triangle', f0: 1050 * p, f1: 1500 * p, glide: 0.06, dur: 0.18, peak: 0.13 });
    hiss(ctx, out, t, { type: 'highpass', f0: 6000, dur: 0.1, peak: 0.1 });
    return 0.22;
  },
  drift2(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 'triangle', f0: 1350 * p, f1: 1800 * p, glide: 0.05, dur: 0.1, peak: 0.12 });
    blip(ctx, out, t + 0.07, { type: 'triangle', f0: 1800 * p, f1: 2250 * p, glide: 0.05, dur: 0.2, peak: 0.13 });
    blip(ctx, out, t + 0.07, { type: 0.125, f0: 3600 * p, dur: 0.12, peak: 0.03 });
    hiss(ctx, out, t, { type: 'highpass', f0: 6500, dur: 0.16, peak: 0.12 });
    return 0.32;
  },
  drift3(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    const f = [1700, 2270, 2860];
    f.forEach((fr, i) => {
      blip(ctx, out, t + i * 0.06, { type: 'triangle', f0: fr * p, f1: fr * 1.2 * p, glide: 0.04, dur: 0.16 + i * 0.06, peak: 0.12 });
      blip(ctx, out, t + i * 0.06, { type: 'sine', f0: fr * 2 * p, dur: 0.12, peak: 0.04 });
    });
    hiss(ctx, out, t, { type: 'highpass', f0: 7000, dur: 0.4, peak: 0.13, attack: 0.02 });
    return 0.5;
  },

  // ---------------------------------------------------------------- race flow
  lap(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    bell(ctx, out, t, nf('G5') * p, 0.13, 0.6);
    bell(ctx, out, t + 0.11, nf('D6') * p, 0.14, 0.9);
    blip(ctx, out, t + 0.11, { type: 0.25, f0: nf('D6') * p, dur: 0.14, peak: 0.05, lp: 5000 });
    return 1.0;
  },
  finalLap(ctx, out, o) {
    // rising stab fanfare that lands on a big D major chord (V of the race key)
    const { t, p } = opt(ctx, o);
    const sd = 0.09;
    const stabs = [[0, 'G4', 1], [2, 'G4', 1], [3, 'A4', 1], [4, 'B4', 1]];
    seqNotes(stabs, t, sd, (tt, f, d) => {
      brass(ctx, out, tt, f * p, d, 0.07);
      note(ctx, out, tt, f * 2 * p, d, { type: 0.25, peak: 0.06, release: 0.04 });
    });
    const tc = t + 6 * sd;
    for (const n of ['D4', 'F#4', 'A4', 'D5']) brass(ctx, out, tc, nf(n) * p, 0.8, 0.055);
    note(ctx, out, tc, nf('A5') * p, 0.8, { type: 0.25, peak: 0.08, vib: 25, release: 0.25 });
    for (let k = 0; k < 6; k++) snareDrum(ctx, out, t + k * sd, 0.35 + k * 0.1, k * 0.11);
    crashCymbal(ctx, out, tc, 0.9);
    kickDrum(ctx, out, tc, 1);
    return 6 * sd + 1.3;
  },
  finish(ctx, out, o) {
    // victory fanfare (~2.6 s)
    const { t, p } = opt(ctx, o);
    const sd = 0.1;
    const lead = [[0, 'G5', 1], [1, 'A5', 1], [2, 'B5', 1], [3, 'C6', 3], [6, 'G5', 1], [7, 'C6', 1], [8, 'E6', 4],
      [12, 'D6', 2], [14, 'E6', 2], [16, 'G6', 10]];
    seqNotes(lead, t, sd, (tt, f, d) => {
      note(ctx, out, tt, f * p, d * 0.95, { type: 0.25, peak: 0.1, vib: 20, release: 0.12, lp: 7000 });
      brass(ctx, out, tt, (f / 2) * p, d * 0.95, 0.045);
    });
    for (const n of ['C5', 'E5', 'G5']) brass(ctx, out, t + 16 * sd, nf(n) * p, 1.0, 0.05);
    const bass = [[0, 'G2', 3], [3, 'C3', 3], [8, 'C3', 4], [12, 'G2', 4], [16, 'C3', 10]];
    seqNotes(bass, t, sd, (tt, f, d) => note(ctx, out, tt, f * p, d * 0.85, { type: 'triangle', peak: 0.22, release: 0.1 }));
    [0, 3, 8, 16].forEach((s) => kickDrum(ctx, out, t + s * sd, 0.9, s * 0.05));
    for (let s = 12; s < 16; s++) snareDrum(ctx, out, t + s * sd, 0.5 + (s - 12) * 0.12, s * 0.07);
    crashCymbal(ctx, out, t + 16 * sd, 1);
    return 26 * sd + 1.0;
  },
  lose(ctx, out, o) {
    // gentle "nice try" tune: falls, then a wistful lift to an open chord (~2.3 s)
    const { t, p } = opt(ctx, o);
    const sd = 0.13;
    const lead = [[0, 'G5', 2], [2, 'E5', 2], [4, 'C5', 3], [7, 'D5', 1], [8, 'B4', 4], [12, 'A4', 2], [14, 'C5', 6]];
    seqNotes(lead, t, sd, (tt, f, d) => {
      note(ctx, out, tt, f * p, d * 0.92, { type: 'triangle', peak: 0.16, vib: 30, vibRate: 5, release: 0.15 });
      note(ctx, out, tt, f * p, d * 0.92, { type: 0.125, peak: 0.035, release: 0.1, lp: 3000 });
    });
    const chords = [[0, ['A3', 'C4', 'E4'], 8], [8, ['G3', 'B3', 'D4'], 6], [14, ['F3', 'A3', 'C4', 'G4'], 6]];
    for (const [st, notes, len] of chords) {
      for (const n of notes) note(ctx, out, t + st * sd, nf(n) * p, len * sd, { type: 'sine', peak: 0.05, attack: 0.04, release: 0.25 });
    }
    seqNotes([[0, 'A2', 7], [8, 'G2', 5], [14, 'F2', 6]], t, sd, (tt, f, d) => note(ctx, out, tt, f * p, d, { type: 'triangle', peak: 0.18, release: 0.2 }));
    return 20 * sd + 0.6;
  },
  jingleStart(ctx, out, o) {
    // short pre-race "get ready" flourish (~1.6 s)
    const { t, p } = opt(ctx, o);
    const sd = 0.075;
    const run = [[0, 'C5', 1], [1, 'E5', 1], [2, 'G5', 1], [3, 'C6', 1], [4, 'E6', 1], [5, 'G6', 3]];
    seqNotes(run, t, sd, (tt, f, d) => note(ctx, out, tt, f * p, d, { type: 0.25, peak: 0.09, release: 0.06, lp: 7000 }));
    const tc = t + 9 * sd;
    for (const n of ['C4', 'G4', 'C5', 'E5']) brass(ctx, out, tc, nf(n) * p, 0.6, 0.05);
    kickDrum(ctx, out, tc, 0.9);
    crashCymbal(ctx, out, tc, 0.7);
    return 9 * sd + 1.0;
  },

  // ---------------------------------------------------------------- phone
  join(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 0.25, f0: nf('C6') * p, f1: nf('D6') * p, glide: 0.05, dur: 0.09, peak: 0.13, lp: 6000 });
    blip(ctx, out, t + 0.09, { type: 0.25, f0: nf('G6') * p, dur: 0.2, peak: 0.14, lp: 7000 });
    bell(ctx, out, t + 0.09, nf('G6') * p, 0.05, 0.4);
    return 0.45;
  },
  leave(ctx, out, o) {
    const { t, p } = opt(ctx, o);
    blip(ctx, out, t, { type: 0.25, f0: nf('G5') * p, dur: 0.09, peak: 0.13, lp: 5000 });
    blip(ctx, out, t + 0.1, { type: 0.25, f0: nf('C5') * p, f1: nf('B4') * p, dur: 0.22, peak: 0.13, lp: 4000 });
    return 0.4;
  },
};

// Per-sound level trims (linear) balancing perceived loudness after the master
// chain: UI blips and spark tones sit a bit under impacts; item/boost cues pop.
const TRIM = {
  menuMove: 2.6, menuSelect: 1.4, menuBack: 1.5, roulette: 2.8, throw: 2.2, boost: 1.9, star: 1.5,
  startBoost: 1.5, spin: 1.4, respawn: 1.25, itemBox: 1.5, bouncer: 1.4, rocket: 1.5, banana: 1.5,
  drift1: 2.4, drift2: 1.7, drift3: 1.5, hop: 1.5, join: 1.4, leave: 1.7,
};

export const SOUNDS = {};
for (const [name, fn] of Object.entries(RAW)) {
  const trim = TRIM[name] || 1;
  SOUNDS[name] = trim === 1 ? fn : (ctx, out, o) => {
    const g = gain(ctx, trim);
    g.connect(out);
    return fn(ctx, g, o);
  };
}

/** Names required by SPEC §10 (all present in SOUNDS; SOUNDS also has 'jingleStart'). */
export const SOUND_NAMES = ['menuMove', 'menuSelect', 'menuBack', 'countdown', 'go', 'itemBox', 'roulette',
  'itemGet', 'throw', 'bouncer', 'rocket', 'toot', 'boost', 'hit', 'spin', 'explode', 'banana', 'stink', 'star',
  'zap', 'lap', 'finalLap', 'finish', 'lose', 'wall', 'bump', 'hop', 'land', 'drift1', 'drift2', 'drift3',
  'stall', 'startBoost', 'respawn', 'join', 'leave'];

// ============================================================ master chain

export const MUSIC_LEVEL = 0.3;      // music bus gain relative to the SFX bus

/**
 * SFX bus + music bus → compressor → master gain → soft limiter.
 * Returns { sfx, music, comp, master, output }; connect `output` to the destination.
 */
export function buildMasterChain(ctx, { limiter = true, volume = 0.8 } = {}) {
  const sfx = gain(ctx, 1);
  const music = gain(ctx, MUSIC_LEVEL);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.22;
  const master = gain(ctx, volume);
  sfx.connect(comp);
  music.connect(comp);
  comp.connect(master);
  let output = master;
  if (limiter) {
    const pre = gain(ctx, 0.5);
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve();
    shaper.oversample = '2x';
    master.connect(pre);
    pre.connect(shaper);
    output = shaper;
  }
  return { sfx, music, comp, master, output };
}

// ================================================================== music
//
// Songs are written as 16 steps (16th notes) per bar. Lead lines use tokens:
// a note name starts a note, '-' sustains the previous note, '.' is a rest.
// Drum lines: 'x' = hit, 'o' = soft hit, '.' = nothing.
// Event layers: 0 = always, 1 = only at intensity 1 (final lap), 2 = only at intensity 0.

const CHORD_TONES = { '': [0, 4, 7], m: [0, 3, 7] };

function parseChord(name) {
  const m = /^([A-G][#b]?)(m?)$/.exec(name);
  if (!m) throw new Error(`[audio] bad chord "${name}"`);
  return { root: noteToMidi(m[1] + '2'), tones: CHORD_TONES[m[2]] };
}

function parseLine(line, fn) {
  const tok = line.trim().split(/\s+/);
  if (tok.length !== 16) throw new Error(`[audio] music bar needs 16 steps, got ${tok.length}: "${line}"`);
  let cur = null;
  const flush = () => { if (cur) fn(cur.step, cur.midi, cur.len); cur = null; };
  tok.forEach((tk, i) => {
    if (tk === '-') { if (cur) cur.len++; }
    else if (tk === '.') flush();
    else { flush(); cur = { step: i, midi: noteToMidi(tk), len: 1 }; }
  });
  flush();
}

const SONG_DEFS = {
  // Upbeat race theme in C major, 16 bars (A + B sections), 150 bpm → 168 bpm on the final lap.
  race: {
    bpm: 150, finalBpm: 168, swing: 0,
    chords: ['C', 'G', 'Am', 'F', 'C', 'G', 'F', 'G', 'Am', 'Em', 'F', 'C', 'Dm', 'G', 'F', 'G'],
    lead: [
      'G5 - E5 . G5 - C6 . B5 - G5 . E5 - D5 .',
      'D5 - - . G5 . B5 . D6 - B5 . G5 . A5 B5',
      'C6 - A5 . E5 - A5 . C6 - D6 . E6 - D6 C6',
      'A5 - - - F5 . A5 . C6 - - . A5 . G5 .',
      'G5 - E5 . G5 - C6 . B5 - G5 . E5 - G5 .',
      'B5 - D6 . B5 - G5 . A5 - B5 . D6 - E6 .',
      'F6 - E6 . D6 - C6 . A5 - C6 . D6 - C6 .',
      'B5 - - - D6 - - - G5 . A5 . B5 . D6 .',
      'E5 . E5 . A5 - E5 . C5 . E5 . A5 - B5 .',
      'G5 - - . E5 . G5 . B5 - - . G5 . E5 .',
      'A5 . A5 . C6 - A5 . F5 . A5 . C6 - D6 .',
      'E6 - - - D6 - C6 - - - G5 . E5 . G5 .',
      'F5 . F5 . A5 - F5 . D6 . C6 . A5 - F5 .',
      'G5 - B5 . D6 - B5 . G5 - B5 . D6 - F6 .',
      'E6 - - . C6 . A5 . F6 - - . E6 . C6 .',
      'D6 - - - B5 - - - G5 . B5 . D6 . G6 .',
    ],
    bass: 'octave',
    arp: { bars0: [8, 16], bars1: [0, 16], every: 1 },
    double: true,
    drums(bar) {
      const fill = bar === 7 || bar === 15;
      return {
        kick: bar === 15 ? 'x...x...x.x.x...' : 'x...x...x...x...',
        snare: fill ? '....x.......xoxx' : '....x.......x...',
        hat2: '..x...x...x...x.',
        hat1: 'xoxoxoxoxoxoxoxo',
        ohat: bar % 2 === 1 && !fill ? '..............o.' : '................',
        crash: bar === 0 || bar === 8 ? 'o...............' : '................',
      };
    },
  },
  // Laid-back, swung menu groove in F major, 8 bars at 112 bpm.
  menu: {
    bpm: 112, finalBpm: 124, swing: 0.16,
    chords: ['F', 'Dm', 'Bb', 'C', 'F', 'Am', 'Bb', 'C'],
    lead: [
      'A5 - - . C6 . A5 . G5 - F5 - - - . .',
      'D5 - F5 . A5 - - . G5 . F5 . E5 - D5 .',
      'F5 - - - D5 . F5 . Bb5 - - . A5 . G5 .',
      'E5 - - - G5 - - - C6 - - - - - . .',
      'A5 - - . C6 . F6 . E6 - C6 . A5 - - .',
      'C6 - - . E5 . A5 . C6 - B5 . A5 - E5 .',
      'D6 - - . Bb5 . F5 . D6 - C6 . Bb5 - A5 .',
      'G5 - - - - - . . E5 . F5 . G5 - - .',
    ],
    bass: 'bounce',
    arp: { bars0: [4, 8], bars1: [0, 8], every: 2 },
    double: false,
    drums(bar) {
      return {
        kick: bar % 2 === 1 ? 'x.........x...o.' : 'x.........x.....',
        snare: '....o.......o...',
        hat2: 'o.o.o.o.o.o.o.o.',
        hat1: 'oooooooooooooooo',
        ohat: bar === 7 ? '..............o.' : '................',
        crash: '................',
      };
    },
  },
};

function compileSong(name, def) {
  const bars = def.chords.length;
  const totalSteps = bars * 16;
  const steps = Array.from({ length: totalSteps }, () => []);
  const add = (step, ev) => steps[step].push(ev);

  def.lead.forEach((line, b) => parseLine(line, (i, midi, len) => {
    add(b * 16 + i, { inst: 'lead', midi, len, vel: 1, layer: 0 });
    if (def.double) add(b * 16 + i, { inst: 'lead2', midi: midi - 12, len, vel: 1, layer: 1 });
  }));

  def.chords.forEach((cname, b) => {
    const { root, tones } = parseChord(cname);
    const base = b * 16;
    // bass
    if (def.bass === 'octave') {
      for (let k = 0; k < 8; k++) {
        let m = root + (k % 2 ? 12 : 0);
        if (b % 4 === 3 && k === 6) m = root + 7;
        add(base + k * 2, { inst: 'bass', midi: m, len: 1.6, vel: k % 2 ? 0.85 : 1, layer: 0 });
      }
    } else {
      const third = root + tones[1];
      const pat = [[0, root, 3, 1], [3, root, 1, 0.7], [6, root + 7, 2, 0.9], [8, root + 12, 2, 0.9],
        [11, root + 7, 1, 0.7], [12, root, 2, 0.9], [14, third, 2, 0.8]];
      for (const [st, m, len, vel] of pat) add(base + st, { inst: 'bass', midi: m, len, vel, layer: 0 });
    }
    // arpeggio (chord tones in octave 5)
    const pc = root % 12;
    const arpNotes = [...tones, 12].map((iv) => 72 + pc + iv - (pc > 6 ? 12 : 0));
    const inRange = ([a, z]) => b >= a && b < z;
    const always = inRange(def.arp.bars0);
    if (always || inRange(def.arp.bars1)) {
      for (let k = 0; k < 16; k += def.arp.every) {
        const idx = Math.floor(k / def.arp.every) % 4;
        add(base + k, { inst: 'arp', midi: arpNotes[idx], len: def.arp.every * 0.8, vel: k % 4 === 0 ? 1 : 0.7, layer: always ? 0 : 1 });
      }
    }
    // drums
    const d = def.drums(b);
    const lane = (pat, inst, layer) => {
      for (let i = 0; i < 16; i++) {
        const c = pat[i];
        if (c === 'x' || c === 'o') add(base + i, { inst, midi: 0, len: 1, vel: c === 'x' ? 1 : 0.55, layer });
      }
    };
    lane(d.kick, 'kick', 0);
    lane(d.snare, 'snare', 0);
    lane(d.hat2, 'hat', 2);
    lane(d.hat1, 'hat', 1);
    lane(d.ohat, 'ohat', 0);
    lane(d.crash, 'crash', 0);
  });

  return { name, bpm: def.bpm, finalBpm: def.finalBpm, swing: def.swing, bars, totalSteps, steps };
}

const COMPILED = {};
/** Compiled song by kind ('race' | 'menu') or null. */
export function getSong(kind) {
  if (!SONG_DEFS[kind]) return null;
  return COMPILED[kind] || (COMPILED[kind] = compileSong(kind, SONG_DEFS[kind]));
}
export const SONG_KINDS = Object.keys(SONG_DEFS);

/** Seconds per 16th-note step at the given intensity. */
export function songStepDuration(song, intensity = 0) {
  return 60 / ((intensity >= 1 ? song.finalBpm : song.bpm) * 4);
}

/** Loop length in seconds at the given intensity. */
export function songLoopDuration(song, intensity = 0) {
  return song.totalSteps * songStepDuration(song, intensity);
}

/** Per-song node graph (instrument buses + a tempo-synced echo on the lead). */
export function createMusicRig(ctx, destination) {
  const out = gain(ctx, 1);
  out.connect(destination);
  const lead = gain(ctx, 1), bass = gain(ctx, 1), drums = gain(ctx, 1), arp = gain(ctx, 1);
  const pan = (node, v) => {
    if (!ctx.createStereoPanner) { node.connect(out); return; }
    const p = ctx.createStereoPanner();
    p.pan.value = v;
    node.connect(p); p.connect(out);
  };
  pan(lead, 0.1);
  pan(arp, -0.35);
  bass.connect(out);
  drums.connect(out);
  const echo = ctx.createDelay(2);
  echo.delayTime.value = 0.3;
  const send = gain(ctx, 0.24), fb = gain(ctx, 0.3), lp = filter(ctx, 'lowpass', 2600, 0.5);
  const ret = ctx.createStereoPanner ? ctx.createStereoPanner() : gain(ctx, 1);
  if (ret.pan) ret.pan.value = -0.25;
  lead.connect(send); send.connect(echo); echo.connect(lp); lp.connect(fb); fb.connect(echo);
  lp.connect(ret); ret.connect(out);
  return {
    ctx, out, lead, bass, drums, arp, echo,
    setTempo(stepDur, t) { echo.delayTime.setValueAtTime(Math.min(1.9, stepDur * 3), t); },
    dispose() { try { out.disconnect(); } catch { /* already gone */ } },
  };
}

const INSTRUMENTS = {
  lead(rig, t, midi, dur, vel) {
    const ctx = rig.ctx, f = mtof(midi);
    const end = t + Math.max(0.04, dur - 0.015);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.12 * vel, 0.005, 0.12, 0.72, end, 0.06);
    const o = osc(ctx, 0.25, f * 1.015, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.025);
    o.connect(g); g.connect(rig.lead);
    if (dur > 0.28) {
      const l = osc(ctx, 'sine', 5.8, t);
      const d = gain(ctx, 0);
      d.gain.setValueAtTime(0, t + 0.12);
      d.gain.linearRampToValueAtTime(16, t + 0.35);
      l.connect(d); d.connect(o.detune);
      l.start(t); l.stop(end + 0.1);
    }
    o.start(t); o.stop(end + 0.1);
  },
  lead2(rig, t, midi, dur, vel) {
    const ctx = rig.ctx;
    const end = t + Math.max(0.04, dur - 0.015);
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.07 * vel, 0.005, 0.1, 0.6, end, 0.05);
    const o = osc(ctx, 0.125, mtof(midi), t);
    o.detune.value = 6;
    o.connect(g); g.connect(rig.lead);
    o.start(t); o.stop(end + 0.08);
  },
  bass(rig, t, midi, dur, vel) {
    const ctx = rig.ctx, f = mtof(midi);
    const end = t + dur * 0.85;
    const g = gain(ctx, 0);
    adsr(g.gain, t, 0.22 * vel, 0.004, 0.1, 0.55, end, 0.04);
    const lp = filter(ctx, 'lowpass', 2200, 3);
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.setTargetAtTime(520, t, 0.06);
    const o1 = osc(ctx, 0.5, f, t), o2 = osc(ctx, 'triangle', f, t);
    const g1 = gain(ctx, 0.45);
    o1.connect(g1); g1.connect(lp); o2.connect(lp);
    lp.connect(g); g.connect(rig.bass);
    o1.start(t); o2.start(t); o1.stop(end + 0.06); o2.stop(end + 0.06);
  },
  arp(rig, t, midi, dur, vel) {
    const ctx = rig.ctx;
    const g = gain(ctx, 0);
    const d = Math.min(dur, 0.09);
    perc(g.gain, t, 0.045 * vel, 0.002, d);
    const o = osc(ctx, 0.125, mtof(midi), t);
    o.connect(g); g.connect(rig.arp);
    o.start(t); o.stop(t + d + 0.03);
  },
  kick(rig, t, m, d, vel, seed) { kickDrum(rig.ctx, rig.drums, t, vel, (seed * 0.0731) % 1.7); },
  snare(rig, t, m, d, vel, seed) { snareDrum(rig.ctx, rig.drums, t, vel * 0.8, (seed * 0.0517) % 1.5); },
  hat(rig, t, m, d, vel, seed) { hatDrum(rig.ctx, rig.drums, t, vel * 0.8, (seed * 0.0373) % 1.9, false); },
  ohat(rig, t, m, d, vel, seed) { hatDrum(rig.ctx, rig.drums, t, vel * 0.8, (seed * 0.0291) % 1.7, true); },
  crash(rig, t, m, d, vel, seed) { crashCymbal(rig.ctx, rig.drums, t, vel * 0.8, (seed * 0.0119) % 0.5); },
};

/**
 * Schedule one 16th-note step of `song` at AudioContext time `t`.
 * Deterministic (noise offsets derive from the step index) so loops render
 * identically every time around.
 */
export function scheduleMusicStep(rig, song, step, t, stepDur, intensity = 0) {
  const events = song.steps[step];
  if (!events || !events.length) return;
  const tt = t + (step % 2 === 1 ? song.swing * stepDur : 0);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.layer === 1 && intensity < 1) continue;
    if (ev.layer === 2 && intensity >= 1) continue;
    INSTRUMENTS[ev.inst](rig, tt, ev.midi, ev.len * stepDur, ev.vel, step);
  }
}

// ============================================================ engine loops

// Gear model: speed ratio thresholds where each of 5 gears begins.
const GEARS = [0, 0.17, 0.37, 0.59, 0.83];

/** Continuous player engine + drift screech + off-road rumble + boost jet. */
export class EngineLoops {
  constructor(ctx, destination) {
    this.ctx = ctx;
    const t = ctx.currentTime;
    this.out = gain(ctx, 1);
    this.out.connect(destination);
    this._last = Object.create(null);
    this.rpm = 0.2;
    this.gear = 0;
    this.refSpeed = KART.topSpeedBase + 3 * KART.topSpeedPerStar;
    this.screechPhase = 0;
    this.nodes = [];

    // engine: sawtooth + detuned square sub → AM "firing" chop → resonant lowpass
    this.engGain = gain(ctx, 0);
    this.engLP = filter(ctx, 'lowpass', 600, 2.6);
    this.engAM = gain(ctx, 0.75);
    this.oA = osc(ctx, 'sawtooth', 45, t);
    this.oB = osc(ctx, 'square', 22.6, t);
    const gA = gain(ctx, 0.6), gB = gain(ctx, 0.32);
    this.oA.connect(gA); this.oB.connect(gB);
    gA.connect(this.engAM); gB.connect(this.engAM);
    this.engAM.connect(this.engLP); this.engLP.connect(this.engGain); this.engGain.connect(this.out);
    this.wobble = osc(ctx, 'sine', 5.5, t);
    this.wobDepth = gain(ctx, 2.5);
    this.wobble.connect(this.wobDepth);
    this.wobDepth.connect(this.oA.frequency);
    this.wobDepth.connect(this.oB.frequency);
    this.fire = osc(ctx, 'triangle', 22, t);
    this.fireDepth = gain(ctx, 0.25);
    this.fire.connect(this.fireDepth); this.fireDepth.connect(this.engAM.gain);

    // drift screech: two resonant bands of noise
    this.drGain = gain(ctx, 0);
    this.drN = noise(ctx, t, 1e6, 1, 0.3);
    this.drBp1 = filter(ctx, 'bandpass', 2100, 7);
    this.drBp2 = filter(ctx, 'bandpass', 3300, 9);
    const d2 = gain(ctx, 0.6);
    this.drN.connect(this.drBp1); this.drN.connect(this.drBp2);
    this.drBp1.connect(this.drGain); this.drBp2.connect(d2); d2.connect(this.drGain);
    this.drGain.connect(this.out);

    // off-road rumble: low noise with a bumpy amplitude LFO
    this.orGain = gain(ctx, 0);
    this.orN = noise(ctx, t, 1e6, 0.7, 0.9);
    this.orLP = filter(ctx, 'lowpass', 260, 1.2);
    this.orAM = gain(ctx, 0.6);
    this.orLfo = osc(ctx, 'triangle', 13, t);
    const orD = gain(ctx, 0.4);
    this.orLfo.connect(orD); orD.connect(this.orAM.gain);
    this.orN.connect(this.orLP); this.orLP.connect(this.orAM); this.orAM.connect(this.orGain);
    // a little gravel crackle on top
    this.orHi = filter(ctx, 'bandpass', 1800, 1.5);
    const orHiG = gain(ctx, 0.25);
    this.orN.connect(this.orHi); this.orHi.connect(orHiG); orHiG.connect(this.orAM);
    this.orGain.connect(this.out);

    // boost jet: bright band of noise
    this.bGain = gain(ctx, 0);
    this.bN = noise(ctx, t, 1e6, 1, 1.4);
    this.bBp = filter(ctx, 'bandpass', 1100, 0.9);
    this.bN.connect(this.bBp); this.bBp.connect(this.bGain); this.bGain.connect(this.out);

    for (const n of [this.oA, this.oB, this.wobble, this.fire, this.orLfo]) n.start(t);
    this.sources = [this.oA, this.oB, this.wobble, this.fire, this.orLfo, this.drN, this.orN, this.bN];
  }

  // setTargetAtTime only when the target moved meaningfully (keeps automation lists short).
  _to(key, param, v, tc) {
    const last = this._last[key];
    if (last !== undefined && Math.abs(last - v) <= Math.abs(v) * 0.005 + 1e-4) return;
    this._last[key] = v;
    param.setTargetAtTime(v, this.ctx.currentTime, tc);
  }

  update(dt, s, active) {
    dt = clamp(dt || 0, 0, 0.1);
    const speed = Math.abs(s.speed || 0);
    const throttle = clamp(s.throttle || 0, 0, 1);
    const grounded = s.grounded !== false;
    const boosting = !!s.boosting;
    if (!boosting && s.maxSpeed > 1) this.refSpeed = s.maxSpeed;
    const ratio = clamp(speed / Math.max(this.refSpeed, 1), 0, 1.3);

    // gear selection with hysteresis
    let g = this.gear;
    while (g < GEARS.length - 1 && ratio > GEARS[g + 1] + 0.01) g++;
    while (g > 0 && ratio < GEARS[g] - 0.04) g--;
    this.gear = g;
    const lo = GEARS[g], hi = g < GEARS.length - 1 ? GEARS[g + 1] : 1.12;
    const frac = clamp((ratio - lo) / (hi - lo), 0, 1.15);
    let rpmT = g === 0 ? 0.18 + 0.82 * frac : 0.46 + 0.54 * frac;
    if (ratio < 0.12 && throttle > 0) rpmT = Math.max(rpmT, 0.3 + 0.62 * throttle);   // revving on the grid
    if (!grounded) rpmT = Math.min(1.15, rpmT + 0.12 * throttle);                       // free-revving in the air
    if (throttle <= 0.05) rpmT *= 0.86;
    this.rpm = damp(this.rpm, rpmT, rpmT < this.rpm ? 14 : 6, dt);
    const rpm = this.rpm;

    const on = active ? 1 : 0;
    let freq = 52 + rpm * 108 + g * 8;          // ~60 Hz idle → ~175 Hz flat out (buzzy kart engine)
    if (boosting) freq *= 1.1;
    const tc = 0.03;
    this._to('fA', this.oA.frequency, freq, tc);
    this._to('fB', this.oB.frequency, freq * 0.502, tc);
    this._to('fire', this.fire.frequency, freq * 0.5, tc);
    this._to('wob', this.wobDepth.gain, rpm < 0.3 ? 2.6 : 0.7, 0.2);
    this._to('lp', this.engLP.frequency, 320 + rpm * 1400 + throttle * 700 + (boosting ? 800 : 0), 0.05);
    this._to('eg', this.engGain.gain, on * (0.1 + throttle * 0.06 + rpm * 0.05), 0.06);

    // drift screech (only while drifting on the ground at speed)
    const screech = on && s.drifting && grounded && speed > 5 ? 0.09 : 0;
    this._to('dg', this.drGain.gain, screech, screech ? 0.04 : 0.07);
    if (screech) {
      this.screechPhase += dt * (8 + Math.random() * 3);
      const wob = Math.sin(this.screechPhase);
      this._to('d1', this.drBp1.frequency, 1950 + wob * 260 + speed * 6, 0.05);
      this._to('d2', this.drBp2.frequency, 3150 - wob * 300 + speed * 8, 0.05);
    }

    // off-road rumble
    const rumble = on && s.offroad && grounded && speed > 1.5 ? 0.3 * clamp(speed / 14, 0.35, 1) : 0;
    this._to('og', this.orGain.gain, rumble, 0.06);
    if (rumble) this._to('of', this.orLfo.frequency, 8 + speed * 0.4, 0.1);

    // boost jet
    this._to('bg', this.bGain.gain, on && boosting ? 0.07 : 0, boosting ? 0.03 : 0.15);
  }

  silence() {
    const now = this.ctx.currentTime;
    for (const g of [this.engGain, this.drGain, this.orGain, this.bGain]) g.gain.setTargetAtTime(0, now, 0.06);
    this._last = Object.create(null);
  }

  dispose() {
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } }
    try { this.out.disconnect(); } catch { /* gone */ }
  }
}

// ============================================================ AudioEngine

const LOOKAHEAD = 0.25;        // seconds of music scheduled ahead of the clock
const TICK_MS = 25;            // sequencer wake-up interval
const MAX_VOICES = 40;         // concurrent one-shot voices
const MIN_REPEAT = 0.03;       // seconds before the same sound may retrigger ...
const REPEAT_LOUDER = 1.5;     // ... unless the new call is this much louder (a distant rival's
                               //     quiet 'spin' must not swallow the player's own in the same zap)
const DUCKERS = { finalLap: 1.8, jingleStart: 1.6 };   // sounds that duck the music (s)
const STORE_KEY = 'tootkart.audio';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.chain = null;
    this.muted = false;
    this.volume = 0.8;
    this._loadPrefs();
    this._engine = null;
    this._engineActive = true;
    this._music = null;           // { kind, song, rig, gain, step, nextTime, intensity, pending }
    this._musicWanted = null;
    this._intensity = 0;
    this._timer = null;
    this._lastPlay = new Map();   // name -> { t, v }: time + volume of its last trigger
    this._voices = 0;
    this._warned = new Set();
    this._visSuspended = false;
    this._onVis = () => this._handleVisibility();
    this._onState = () => { if (this.ready) this._resumeWanted(); };
    this.stepLog = null;          // tests: set to [] to record (step, time, scheduledAt) triples
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  // ------------------------------------------------------------ lifecycle

  /** Create/resume the AudioContext. Call from a user gesture; idempotent. */
  unlock() {
    if (typeof window === 'undefined') return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.chain = buildMasterChain(this.ctx, { volume: this._masterLevel() });
        this.chain.output.connect(this.ctx.destination);
        // iOS: a silent buffer started inside the gesture fully unlocks output
        const b = this.ctx.createBufferSource();
        b.buffer = this.ctx.createBuffer(1, 1, 22050);
        b.connect(this.ctx.destination);
        b.start(0);
        this.ctx.addEventListener('statechange', this._onState);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVis);
        this._timer = setInterval(() => this._tick(), TICK_MS);
      }
      if (this.ctx.state === 'suspended' && !this._visSuspended) {
        this.ctx.resume().then(() => this._resumeWanted()).catch(() => { /* needs a later gesture */ });
      } else if (this.ready) {
        this._resumeWanted();
      }
    } catch (err) {
      console.warn('[audio] unlock failed', err);
    }
  }

  dispose() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVis);
    if (this._engine) this._engine.dispose();
    this._engine = null;
    this._music = null;
    if (this.ctx) {
      this.ctx.removeEventListener('statechange', this._onState);
      this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.chain = null;
  }

  _handleVisibility() {
    if (!this.ctx) return;
    if (document.hidden) {
      if (this.ctx.state === 'running') {
        this._visSuspended = true;
        this.ctx.suspend().catch(() => {});
      }
    } else if (this._visSuspended) {
      this._visSuspended = false;
      this.ctx.resume().catch(() => {});
    }
  }

  _resumeWanted() {
    if (this._musicWanted && (!this._music || this._music.kind !== this._musicWanted)) {
      const kind = this._musicWanted;
      const intensity = this._intensity;
      this.startMusic(kind);
      if (intensity) this.setMusicIntensity(intensity);
    }
  }

  // ------------------------------------------------------------ volume

  _loadPrefs() {
    try {
      const raw = typeof localStorage !== 'undefined' && localStorage.getItem(STORE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.muted === 'boolean') this.muted = p.muted;
        if (Number.isFinite(p.volume)) this.volume = clamp(p.volume, 0, 1);
      }
    } catch { /* storage unavailable */ }
  }

  _savePrefs() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify({ muted: this.muted, volume: this.volume }));
    } catch { /* storage unavailable */ }
  }

  _masterLevel() { return this.muted ? 0 : this.volume; }

  _applyMaster() {
    if (!this.chain) return;
    const g = this.chain.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(this._masterLevel(), now, 0.04);
  }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  setMuted(b) {
    this.muted = !!b;
    this._applyMaster();
    this._savePrefs();
  }

  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    this._applyMaster();
    this._savePrefs();
  }

  // ------------------------------------------------------------ one-shots

  /** Play a named one-shot. No-op before unlock. */
  play(name, { volume = 1, pitch = 1, pan = 0 } = {}) {
    if (!this.ready) return;
    const fn = SOUNDS[name];
    if (!fn) {
      if (!this._warned.has(name)) { this._warned.add(name); console.warn(`[audio] unknown sound "${name}"`); }
      return;
    }
    if (!(volume > 0.001) || this._voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    let last = this._lastPlay.get(name);
    if (last && now - last.t < MIN_REPEAT && !(volume > last.v * REPEAT_LOUDER)) return;
    if (!last) this._lastPlay.set(name, (last = { t: 0, v: 0 }));
    last.t = now;
    last.v = volume;

    const v = gain(ctx, clamp(volume, 0, 2));
    let panner = null;
    if (pan && ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      v.connect(panner);
      panner.connect(this.chain.sfx);
    } else {
      v.connect(this.chain.sfx);
    }
    let dur = 0.5;
    try {
      dur = fn(ctx, v, { when: now + 0.005, pitch: clamp(pitch || 1, 0.25, 4) }) || 0.5;
    } catch (err) {
      console.error(`[audio] sound "${name}" failed`, err);
    }
    if (DUCKERS[name]) this._duck(DUCKERS[name]);
    this._voices++;
    setTimeout(() => {
      this._voices--;
      try { v.disconnect(); if (panner) panner.disconnect(); } catch { /* gone */ }
    }, (dur + 0.4) * 1000);
  }

  /** 'finish' | 'lose' end the race music; 'start' plays over a ducked mix. */
  playJingle(name) {
    if (!this.ready) return;
    if (name === 'finish' || name === 'lose') {
      this.stopMusic(0.35);
      this.play(name);
    } else if (name === 'start') {
      this.play('jingleStart');
    } else if (SOUNDS[name]) {
      this.play(name);
    }
  }

  _duck(seconds) {
    if (!this.chain) return;
    const g = this.chain.music.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(MUSIC_LEVEL * 0.3, now, 0.05);
    g.setTargetAtTime(MUSIC_LEVEL, now + seconds, 0.35);
  }

  // ------------------------------------------------------------ engine loops

  updateEngine(dt, state = {}) {
    if (!this.ready) return;
    if (!this._engine) this._engine = new EngineLoops(this.ctx, this.chain.sfx);
    this._engine.update(dt, state, this._engineActive && state.active !== false);
  }

  setEngineActive(b) {
    this._engineActive = !!b;
    if (!b && this._engine) this._engine.silence();
  }

  // ------------------------------------------------------------ music

  /** Start (or crossfade to) a music loop. Resets intensity to 0. Remembered until unlock. */
  startMusic(kind) {
    this._musicWanted = kind;
    if (!this.ready) return;
    if (this._music && this._music.kind === kind) return;
    const song = getSong(kind);
    if (!song) { console.warn(`[audio] unknown music "${kind}"`); return; }
    this._fadeOutMusic(0.6);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + 0.4);
    g.connect(this.chain.music);
    const rig = createMusicRig(ctx, g);
    rig.setTempo(songStepDuration(song, 0), now);
    this._intensity = 0;
    this._music = { kind, song, rig, gain: g, step: 0, nextTime: now + 0.06, intensity: 0, pending: 0 };
    this._tick();
  }

  /** 0 = normal, 1 = final lap (faster tempo + extra layers). Applied on the next beat. */
  setMusicIntensity(level) {
    this._intensity = level >= 1 ? 1 : 0;
    if (this._music) this._music.pending = this._intensity;
  }

  stopMusic(fade = 0.6) {
    this._musicWanted = null;
    this._fadeOutMusic(fade);
  }

  _fadeOutMusic(fade) {
    const m = this._music;
    if (!m) return;
    this._music = null;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const g = m.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + Math.max(0.02, fade));
    setTimeout(() => m.rig.dispose(), (fade + LOOKAHEAD + 0.6) * 1000);
  }

  // Lookahead sequencer: schedule every step whose time falls before now + LOOKAHEAD.
  _tick() {
    const m = this._music;
    if (!m || !this.ready) return;
    const now = this.ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    while (m.nextTime < horizon) {
      if (m.step % 4 === 0 && m.pending !== m.intensity) {
        m.intensity = m.pending;
        m.rig.setTempo(songStepDuration(m.song, m.intensity), m.nextTime);
      }
      const stepDur = songStepDuration(m.song, m.intensity);
      // If we fell far behind (long stall), skip late steps rather than bursting them.
      if (m.nextTime >= now - 0.03) {
        scheduleMusicStep(m.rig, m.song, m.step, m.nextTime, stepDur, m.intensity);
        if (this.stepLog) this.stepLog.push(m.step, m.nextTime, now);
      }
      m.nextTime += stepDur;
      m.step = (m.step + 1) % m.song.totalSteps;
    }
  }
}
