// In-race HUD: a DOM overlay (styles in css/game.css) drawn above the WebGL canvas.
//
//   const hud = new HUD(document.getElementById('hud'), { audio });  // audio optional
//   hud.setTrack(track);           // pre-renders the minimap outline
//   hud.show();
//   // every frame:
//   hud.update(dt, { player, race, karts, items, phoneConnected });
//   hud.countdown(3) … hud.countdown(0);   hud.flash('FINAL LAP!', { color: '#ff5a3c' });
//   hud.flash('KABOOM!', { size: 'medium', sub: 'Bolt', subColor: '#2f6bff' });   // + name pill
//   hud.setWrongWay(true);  hud.showFinish(1);  hud.reset();
//
// Elements: lap + race timer (top-left), item slot with roulette (top-right),
// phone badge (top-center), minimap (bottom-left), speedometer + drift charge
// + place badge (bottom-right), countdown / flash / wrong-way / finish (center).
// The DOM is only touched when a displayed value changes; animations use the
// Web Animations API (compositor-friendly transforms/opacity).
//
// Roulette ticks: if an `audio` (AudioEngine) is passed, the HUD plays the
// 'roulette' tick in sync with its reel. It also emits bus 'hud:rouletteTick'
// { progress } — use one or the other, not both.

import { ITEM_INFO, ITEM_IDS, ITEM, DRIFT, KART, RACE } from './config.js';
import { clamp, ordinal } from './utils.js';
import { bus } from './bus.js';

const PLACE_FILLS = {
  1: 'linear-gradient(180deg, #fffbe6 0%, #ffe680 30%, #ffc21a 52%, #f29100 78%, #ffd45c 100%)',
  2: 'linear-gradient(180deg, #ffffff 0%, #eef3f8 32%, #b9c5d3 54%, #8d9bad 76%, #dfe6ee 100%)',
  3: 'linear-gradient(180deg, #ffe9d2 0%, #f7b47a 32%, #c9773a 55%, #9c5427 78%, #e39a62 100%)',
  other: 'linear-gradient(180deg, #ffffff 0%, #ffffff 50%, #d9defa 100%)',
};
const COUNT_FILLS = {
  3: 'linear-gradient(180deg, #fff1f1 0%, #ff8a8a 40%, #ff2e4d 75%, #d4002f 100%)',
  2: 'linear-gradient(180deg, #fff8e6 0%, #ffd27a 40%, #ff9d1a 75%, #e06a00 100%)',
  1: 'linear-gradient(180deg, #fffde6 0%, #fff27a 40%, #ffd91a 75%, #f0b400 100%)',
  0: 'linear-gradient(180deg, #f0fff4 0%, #9dff9a 35%, #2ee86a 70%, #00b84a 100%)',
};
const DRIFT_NAMES = ['', 'MINI', 'SUPER', 'ULTRA'];

// One icon per distinct item look, cycled by the roulette reel.
const REEL_ICONS = [...new Set(ITEM_IDS.map((id) => ITEM_INFO[id].icon))];

// Minimap orientation: rotate the world so the start straight points up.
const MAP_ROT = Math.PI;

let hudCounter = 0;

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

// Text with a thick outline: an outlined back copy under a gradient-filled front copy.
function outlined(cls, parent, text = '') {
  const wrap = el('span', 'olt ' + cls, parent);
  const back = el('span', 'olt-back', wrap, text);
  const front = el('span', 'olt-front', wrap, text);
  back.setAttribute('aria-hidden', 'true');
  return {
    el: wrap,
    text,
    set(t) {
      if (t === this.text) return;
      this.text = t;
      back.textContent = t;
      front.textContent = t;
    },
    fill(css) { wrap.style.setProperty('--fill', css); },
  };
}

// Whole centiseconds of a time in seconds (floored; 0 for negative / NaN).
const toCs = (t) => (Number.isFinite(t) && t > 0 ? Math.floor(t * 100 + 1e-6) : 0);

// m:ss.cc from whole centiseconds
function fmtCs(cs) {
  const m = Math.floor(cs / 6000), rem = cs - m * 6000;
  const whole = Math.floor(rem / 100), frac = rem - whole * 100;
  return `${m}:${whole < 10 ? '0' : ''}${whole}.${frac < 10 ? '0' : ''}${frac}`;
}
const fmtClock = (t) => fmtCs(toCs(t));

const POP = [
  { transform: 'scale(1)' },
  { transform: 'scale(1.38)', offset: 0.28 },
  { transform: 'scale(0.94)', offset: 0.62 },
  { transform: 'scale(1)' },
];
const POP_OPTS = { duration: 460, easing: 'ease-out' };

export class HUD {
  constructor(root, { audio = null } = {}) {
    this.root = root;
    this.audio = audio;
    this.track = null;
    this.visible = false;
    this._id = ++hudCounter;
    this._build();
    this._mapBg = null;
    this._mapXf = null;
    this._mapDirty = true;
    this._onResize = () => { this._mapDirty = true; };
    window.addEventListener('resize', this._onResize);
    this.reset();
  }

  // ------------------------------------------------------------------ DOM

  _build() {
    const r = el('div', 'hud hud--hidden', this.root);
    this.el = r;

    // top-left: lap + timer
    const tl = el('div', 'hud-tl', r);
    const lap = el('div', 'hud-lap', tl);
    el('span', 'hud-lap-label', lap, 'LAP');
    this.lapNum = el('span', 'hud-lap-num', lap, '1');
    this.lapTotal = el('span', 'hud-lap-total', lap, '/3');
    this.lapEl = lap;
    const timer = el('div', 'hud-timer', tl);
    this.timerText = document.createTextNode('0:00.00');
    timer.appendChild(this.timerText);
    this.split = el('div', 'hud-split', tl);

    // top-center: phone badge
    this.phone = el('div', 'hud-phone', r);
    el('span', 'hud-phone-dot', this.phone);
    el('span', 'hud-phone-icon', this.phone, '📱');
    this.phoneText = el('span', 'hud-phone-text', this.phone, 'PHONE CONNECTED');

    // top-right: item slot
    const item = el('div', 'hud-item', r);
    this.itemEl = item;
    const ring = el('div', 'hud-item-ring', item);
    el('div', 'hud-item-ring-spin', ring);
    const frame = el('div', 'hud-item-frame', item);
    this.itemFrame = frame;
    el('div', 'hud-item-shine', frame);
    this.itemIcon = el('div', 'hud-item-icon', frame);
    this.itemGlyph = el('span', '', this.itemIcon, '');
    this.itemBurst = el('div', 'hud-item-burst', item);
    this.itemCount = el('div', 'hud-item-count', item);
    this.itemName = el('div', 'hud-item-name', item);

    // bottom-left: minimap
    const map = el('div', 'hud-map', r);
    this.mapEl = map;
    this.canvas = el('canvas', 'hud-map-canvas', map);
    this.ctx2d = this.canvas.getContext('2d');

    // bottom-right: speedometer, drift charge, place
    const br = el('div', 'hud-br', r);
    const spd = el('div', 'hud-speed', br);
    this.speedEl = spd;
    const gid = `hudSpd${this._id}`, bid = `hudBoost${this._id}`, sid = `hudStar${this._id}`;
    spd.innerHTML = `
      <svg class="hud-speed-svg" viewBox="0 0 100 78" aria-hidden="true">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#3be8ff"/><stop offset="0.55" stop-color="#8f7bff"/><stop offset="1" stop-color="#ff4fa0"/>
          </linearGradient>
          <linearGradient id="${bid}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#ffe14d"/><stop offset="0.5" stop-color="#ff9d2e"/><stop offset="1" stop-color="#ff3b2e"/>
          </linearGradient>
          <linearGradient id="${sid}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#ff4f6d"/><stop offset="0.2" stop-color="#ffb02e"/><stop offset="0.4" stop-color="#fff24d"/>
            <stop offset="0.6" stop-color="#4dff7a"/><stop offset="0.8" stop-color="#38c8ff"/><stop offset="1" stop-color="#b56bff"/>
          </linearGradient>
        </defs>
        <path class="hud-speed-track" d="M 18.9 66.8 A 38 38 0 1 1 81.1 66.8" pathLength="100"/>
        <path class="hud-speed-ticks" d="M 13.5 70.6 A 44.5 44.5 0 1 1 86.5 70.6" pathLength="100"/>
        <path class="hud-speed-val" d="M 18.9 66.8 A 38 38 0 1 1 81.1 66.8" pathLength="100"
              stroke="url(#${gid})" data-normal="url(#${gid})" data-boost="url(#${bid})" data-star="url(#${sid})"/>
      </svg>`;
    this.speedVal = spd.querySelector('.hud-speed-val');
    this.speedNum = el('div', 'hud-speed-num', spd, '0');
    el('div', 'hud-speed-unit', spd, 'KM/H');

    const drift = el('div', 'hud-drift', spd);
    this.driftEl = drift;
    this.driftSegs = [];
    const bar = el('div', 'hud-drift-bar', drift);
    for (let k = 1; k <= 3; k++) {
      const seg = el('div', 'hud-drift-seg', bar);
      seg.style.setProperty('--seg', DRIFT.tierColors[k]);
      this.driftSegs.push(el('i', '', seg));
    }
    this.driftLabel = el('div', 'hud-drift-label', drift, '');

    const place = el('div', 'hud-place', br);
    this.placeEl = place;
    this.placeNum = outlined('hud-place-num', place, '8');
    this.placeSuf = outlined('hud-place-suf', place, 'th');

    // center layers
    const c = el('div', 'hud-center', r);
    this.countEl = el('div', 'hud-count', c);
    this.countBurst = el('div', 'hud-count-burst', this.countEl);
    this.countText = outlined('hud-count-text', this.countEl, '');
    this.flashEl = el('div', 'hud-flash', c);
    this.flashText = outlined('hud-flash-text', this.flashEl, '');
    this.flashSub = el('div', 'hud-flash-sub', this.flashEl);
    this.flashSubText = document.createTextNode('');
    this.flashSub.appendChild(this.flashSubText);
    this.wrongEl = el('div', 'hud-wrong', c);
    this.wrongEl.innerHTML = `
      <svg class="hud-wrong-icon" viewBox="0 0 64 64" aria-hidden="true">
        <path d="M44 50V26a12 12 0 0 0-24 0v8" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>
        <path d="M8 30l12 14 12-14z" fill="currentColor"/>
      </svg>`;
    el('span', 'hud-wrong-text', this.wrongEl, 'WRONG WAY!');
    this.finishEl = el('div', 'hud-finish', c);
    el('div', 'hud-finish-band', this.finishEl);
    this.finishTitle = outlined('hud-finish-title', this.finishEl, 'FINISH!');
    this.finishPlace = outlined('hud-finish-place', this.finishEl, '');
    this.finishTime = el('div', 'hud-finish-time', this.finishEl, '');
    el('div', 'hud-finish-band', this.finishEl);
  }

  // ------------------------------------------------------------------ public API

  setTrack(track) {
    this.track = track;
    this._mapDirty = true;
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.el.classList.remove('hud--hidden');
    this._mapDirty = true;
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.add('hud--hidden');
  }

  reset() {
    this._v = {
      lap: null, laps: null, finalLap: null, time: null, place: null, speed: null, speedPct: null, speedMode: null,
      driftOn: null, driftFill: [-1, -1, -1], driftTier: -1, phone: null, splits: 0,
    };
    this._item = { shown: null, count: 0, rolling: false };
    this._reel = { acc: 0, idx: Math.floor(Math.random() * REEL_ICONS.length), total: ITEM.rouletteSeconds };
    this._splitTimer = 0;
    this._nameTimer = 0;
    this._phoneTimer = 0;
    this._lastPlayer = null;
    for (const a of [this._countAnim, this._flashAnim, this._finishAnim]) if (a) a.cancel();
    this._countAnim = this._flashAnim = this._finishAnim = null;
    this.countEl.classList.remove('on');
    this.flashEl.classList.remove('on');
    this.finishEl.classList.remove('on');
    this.wrongEl.classList.remove('on');
    this._wrong = false;
    this.split.classList.remove('on');
    this.itemName.classList.remove('on');
    this.itemEl.classList.remove('has', 'rolling');
    this.itemGlyph.textContent = '';
    this.itemCount.classList.remove('on');
    this.lapEl.classList.remove('final');
    this.driftEl.classList.remove('on');
    this.phone.classList.remove('on', 'lost', 'expanded');
    this.speedEl.classList.remove('boosting', 'star', 'zero');
  }

  /** Big center "3", "2", "1"; n = 0 → "GO!". */
  countdown(n) {
    if (this._countAnim) this._countAnim.cancel();
    const go = n <= 0;
    this.countText.set(go ? 'GO!' : String(n));
    this.countText.fill(COUNT_FILLS[go ? 0 : clamp(n, 1, 3)] || COUNT_FILLS[1]);
    this.countEl.classList.toggle('go', go);
    this.countEl.classList.add('on');
    // Linear overall timing with per-segment easing, so the number holds fully
    // visible for most of its second instead of fading early.
    const frames = go
      ? [{ transform: 'scale(0.3)', opacity: 0, easing: 'cubic-bezier(.2,.8,.3,1)' },
        { transform: 'scale(1.2)', opacity: 1, offset: 0.13, easing: 'ease-in-out' },
        { transform: 'scale(1)', opacity: 1, offset: 0.25 },
        { transform: 'scale(1.05)', opacity: 1, offset: 0.7, easing: 'ease-in' },
        { transform: 'scale(1.8)', opacity: 0 }]
      : [{ transform: 'scale(2.4)', opacity: 0, easing: 'cubic-bezier(.15,.8,.3,1)' },
        { transform: 'scale(0.9)', opacity: 1, offset: 0.16, easing: 'ease-out' },
        { transform: 'scale(1.05)', opacity: 1, offset: 0.26, easing: 'ease-in-out' },
        { transform: 'scale(1)', opacity: 1, offset: 0.36 },
        { transform: 'scale(0.97)', opacity: 1, offset: 0.8, easing: 'ease-in' },
        { transform: 'scale(0.6)', opacity: 0 }];
    const anim = this.countEl.animate(frames, { duration: go ? 1200 : 980, fill: 'forwards' });
    this.countBurst.animate(
      [{ transform: 'scale(0.3)', opacity: 0.9 }, { transform: 'scale(1.6)', opacity: 0 }],
      { duration: go ? 700 : 520, easing: 'ease-out' });
    anim.onfinish = () => { if (this._countAnim === anim) { this.countEl.classList.remove('on'); this._countAnim = null; } };
    this._countAnim = anim;
  }

  /**
   * Transient banner: "LAP 2", "FINAL LAP!", item names, etc. `sub` adds a small
   * name pill under it (a racer's name; `subColor` = their kart color).
   */
  flash(text, { color = '#ffd23a', duration = 1.5, size = 'big', sub = '', subColor = '#ffffff' } = {}) {
    if (this._flashAnim) this._flashAnim.cancel();
    this.flashText.set(String(text));
    this.flashText.fill(`linear-gradient(180deg, #ffffff 0%, #ffffff 18%, ${color} 58%, ${color} 100%)`);
    this.flashEl.classList.toggle('medium', size === 'medium');
    const subText = sub ? String(sub) : '';
    if (this.flashSubText.data !== subText) this.flashSubText.data = subText;
    this.flashSub.classList.toggle('on', !!subText);
    if (subText) this.flashSub.style.setProperty('--c', subColor || '#ffffff');
    this.flashEl.classList.add('on');
    const d = Math.max(0.4, duration) * 1000;
    const anim = this.flashEl.animate([
      { transform: 'translateY(30%) scale(0.4)', opacity: 0, easing: 'cubic-bezier(.2,.8,.3,1)' },
      { transform: 'translateY(0) scale(1.14)', opacity: 1, offset: Math.min(0.14, 170 / d), easing: 'ease-in-out' },
      { transform: 'translateY(0) scale(1)', opacity: 1, offset: Math.min(0.24, 300 / d) },
      { transform: 'translateY(0) scale(1)', opacity: 1, offset: Math.max(0.5, 1 - 260 / d), easing: 'ease-in' },
      { transform: 'translateY(-35%) scale(1.04)', opacity: 0 },
    ], { duration: d, fill: 'forwards' });
    anim.onfinish = () => { if (this._flashAnim === anim) { this.flashEl.classList.remove('on'); this._flashAnim = null; } };
    this._flashAnim = anim;
  }

  setWrongWay(on) {
    on = !!on;
    if (on === this._wrong) return;
    this._wrong = on;
    this.wrongEl.classList.toggle('on', on);
  }

  /** "FINISH!" + finishing place (stays until reset()/hide()). */
  showFinish(place) {
    this.setWrongWay(false);
    if (this._countAnim) { this._countAnim.cancel(); this.countEl.classList.remove('on'); }
    const p = clamp(Math.round(place) || 1, 1, 99);
    this.finishPlace.set(ordinal(p));
    this.finishPlace.fill(PLACE_FILLS[p] || PLACE_FILLS.other);
    const pl = this._lastPlayer;
    this.finishTime.textContent = pl && pl.finished && Number.isFinite(pl.finishTime) ? fmtClock(pl.finishTime) : '';
    this.finishEl.classList.toggle('podium', p <= 3);
    this.finishEl.classList.add('on');
    if (this._finishAnim) this._finishAnim.cancel();
    this._finishAnim = this.finishEl.animate([
      { transform: 'scale(2.2) rotate(-6deg)', opacity: 0 },
      { transform: 'scale(0.92) rotate(1deg)', opacity: 1, offset: 0.45 },
      { transform: 'scale(1.04) rotate(0deg)', opacity: 1, offset: 0.7 },
      { transform: 'scale(1) rotate(0deg)', opacity: 1 },
    ], { duration: 650, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' });
  }

  update(dt, { player = null, race = null, karts = null, phoneConnected = false } = {}) {
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, 0.25);
    const v = this._v;
    this._lastPlayer = player;

    // ---- phone badge: announces a connection, then collapses to a compact
    // dot + icon; a dropped connection shows a red warning for a few seconds.
    const ph = !!phoneConnected;
    if (ph !== v.phone) {
      const was = v.phone;
      v.phone = ph;
      const cl = this.phone.classList;
      if (ph) {
        this.phoneText.textContent = 'PHONE CONNECTED';
        cl.remove('lost');
        cl.add('on', 'expanded');
        this._phoneTimer = 4;
      } else if (was) {
        this.phoneText.textContent = 'PHONE DISCONNECTED';
        cl.add('on', 'lost', 'expanded');
        this._phoneTimer = 3.5;
      } else {
        cl.remove('on', 'lost', 'expanded');
        this._phoneTimer = 0;
      }
    }
    if (this._phoneTimer > 0) {
      this._phoneTimer -= dt;
      if (this._phoneTimer <= 0) {
        // connected → collapse; disconnected → fade out as-is (red, expanded)
        this.phone.classList.remove(v.phone ? 'expanded' : 'on');
      }
    }

    // ---- lap
    const laps = (race && race.laps) || RACE.laps;
    const lap = player ? clamp(player.lap || 1, 1, laps) : 1;
    if (lap !== v.lap || laps !== v.laps) {
      const changed = v.lap !== null && lap !== v.lap;
      v.lap = lap; v.laps = laps;
      this.lapNum.textContent = String(lap);
      this.lapTotal.textContent = `/${laps}`;
      if (changed) this.lapNum.animate(POP, POP_OPTS);
    }
    const isFinal = lap === laps && laps > 1 && !!race && race.state === 'racing' && !(player && player.finished);
    if (isFinal !== v.finalLap) { v.finalLap = isFinal; this.lapEl.classList.toggle('final', isFinal); }

    // ---- timer (frozen at the player's finish time); compared in whole
    // centiseconds so an unchanged clock costs no string formatting
    let t = race && Number.isFinite(race.time) ? race.time : 0;
    if (player && player.finished && Number.isFinite(player.finishTime)) t = player.finishTime;
    const cs = toCs(t);
    if (cs !== v.time) { v.time = cs; this.timerText.nodeValue = fmtCs(cs); }

    // ---- lap split
    const splits = player && player.lapTimes ? player.lapTimes.length : 0;
    if (splits !== v.splits) {
      if (splits > v.splits && splits > 0) {
        const lt = player.lapTimes[splits - 1];
        const best = Math.min(...player.lapTimes);
        this.split.textContent = `LAP ${splits}  ${fmtClock(lt)}`;
        this.split.classList.toggle('best', splits > 1 && lt <= best + 1e-6);
        this.split.classList.add('on');
        this._splitTimer = 4;
      }
      v.splits = splits;
    }
    if (this._splitTimer > 0) {
      this._splitTimer -= dt;
      if (this._splitTimer <= 0) this.split.classList.remove('on');
    }

    // ---- place badge
    const place = player ? player.place || 0 : 0;
    if (place !== v.place) {
      const changed = v.place !== null && v.place > 0 && place > 0;
      v.place = place;
      if (place > 0) {
        const suffix = ordinal(place).slice(String(place).length);
        this.placeNum.set(String(place));
        this.placeSuf.set(suffix);
        const fill = PLACE_FILLS[place] || PLACE_FILLS.other;
        this.placeNum.fill(fill);
        this.placeSuf.fill(fill);
        this.placeEl.classList.remove('p1', 'p2', 'p3');
        if (place <= 3) this.placeEl.classList.add('p' + place);
        this.placeEl.style.visibility = '';
        if (changed) this.placeEl.animate(POP, { duration: 480, easing: 'ease-out' });
      } else {
        this.placeEl.style.visibility = 'hidden';
      }
    }

    // ---- speedometer
    if (player) {
      const sp = Math.abs(player.speed || 0);
      const kmh = Math.round(sp * 3.6);
      if (kmh !== v.speed) { v.speed = kmh; this.speedNum.textContent = String(kmh); }
      const full = ((player.stats && player.stats.topSpeed) || 30) * KART.boostSpeedMult;
      const pct = Math.round(clamp(sp / full, 0, 1) * 200) / 2;
      if (pct !== v.speedPct) {
        if ((pct === 0) !== (v.speedPct === 0)) this.speedEl.classList.toggle('zero', pct === 0);
        v.speedPct = pct;
        this.speedVal.style.strokeDashoffset = String(100 - pct);
      }
      // arc style: normal gradient, hot boost gradient, or cycling rainbow while starred
      const mode = (player.starTimer || 0) > 0 ? 'star' : (player.boostTimer || 0) > 0 ? 'boost' : 'normal';
      if (mode !== v.speedMode) {
        v.speedMode = mode;
        this.speedEl.classList.toggle('boosting', mode !== 'normal');
        this.speedEl.classList.toggle('star', mode === 'star');
        this.speedVal.setAttribute('stroke', this.speedVal.dataset[mode]);
      }
    }

    // ---- drift charge
    const d = player && player.drift;
    const driftOn = !!(d && d.active);
    if (driftOn !== v.driftOn) { v.driftOn = driftOn; this.driftEl.classList.toggle('on', driftOn); }
    if (driftOn) {
      const charge = d.charge || 0, tt = DRIFT.tierTimes;
      for (let k = 0; k < 3; k++) {
        const a = k === 0 ? 0 : tt[k - 1], b = tt[k];
        const f = Math.round(clamp((charge - a) / (b - a), 0, 1) * 50) / 50;
        if (f !== v.driftFill[k]) { v.driftFill[k] = f; this.driftSegs[k].style.transform = `scaleX(${f})`; }
      }
      const tier = clamp(d.tier | 0, 0, 3);
      if (tier !== v.driftTier) {
        v.driftTier = tier;
        this.driftEl.style.setProperty('--tier', DRIFT.tierColors[tier]);
        this.driftEl.classList.toggle('charged', tier > 0);
        this.driftLabel.textContent = DRIFT_NAMES[tier] || 'DRIFT';
        if (tier > 0) this.driftLabel.animate(POP, { duration: 320, easing: 'ease-out' });
      }
    } else if (v.driftTier !== -1) {
      v.driftTier = -1;
    }

    // ---- item slot + roulette
    this._updateItem(dt, player);

    // ---- minimap
    if (this.visible) this._drawMap(karts, player);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    for (const a of [this._countAnim, this._flashAnim, this._finishAnim]) if (a) a.cancel();
    this.el.remove();
    this._mapBg = null;
  }

  // ------------------------------------------------------------------ item slot

  _updateItem(dt, player) {
    const st = this._item;
    const rolling = !!(player && player.rolling);
    const item = player ? player.item || null : null;
    const count = player ? player.itemCount || 0 : 0;

    if (rolling) {
      if (!st.rolling) {
        st.rolling = true;
        this._reel.acc = 0;
        this._reel.total = Math.max(0.3, player.rollTimer || ITEM.rouletteSeconds, ITEM.rouletteSeconds);
        this.itemEl.classList.add('has', 'rolling');
        this.itemCount.classList.remove('on');
        this.itemName.classList.remove('on');
        this._tickReel(0);
      }
      // reel slows down as the roll timer runs out: fast ticks → long ticks
      const progress = clamp(1 - (player.rollTimer || 0) / this._reel.total, 0, 1);
      const interval = 0.05 + 0.2 * Math.pow(progress, 2.1);
      this._reel.acc += dt;
      if (this._reel.acc >= interval) {
        this._reel.acc = 0;
        this._tickReel(progress);
      }
      st.shown = null;
      return;
    }

    if (st.rolling) {
      // roll just ended
      st.rolling = false;
      this.itemEl.classList.remove('rolling');
      if (item) this._landItem(item, count);
      else this._clearItem();
      return;
    }

    if (item !== st.shown) {
      if (item) this._landItem(item, count);
      else this._clearItem();
      return;
    }

    if (item && count !== st.count) {
      st.count = count;
      this._setCount(item, count, true);
      this.itemIcon.animate([
        { transform: 'scale(1)' }, { transform: 'scale(0.6)', offset: 0.35 }, { transform: 'scale(1.12)', offset: 0.7 }, { transform: 'scale(1)' },
      ], { duration: 360, easing: 'ease-out' });
    }

    if (this._nameTimer > 0) {
      this._nameTimer -= dt;
      if (this._nameTimer <= 0) this.itemName.classList.remove('on');
    }
  }

  _tickReel(progress) {
    const r = this._reel;
    r.idx = (r.idx + 1 + Math.floor(Math.random() * (REEL_ICONS.length - 2))) % REEL_ICONS.length;
    this.itemGlyph.textContent = REEL_ICONS[r.idx];
    this.itemIcon.animate([
      { transform: 'translateY(-62%) scale(0.85)', opacity: 0.2 },
      { transform: 'translateY(0) scale(1)', opacity: 1 },
    ], { duration: Math.min(140, 60 + progress * 120), easing: 'ease-out' });
    if (this.audio) this.audio.play('roulette', { pitch: 1.12 - progress * 0.22, volume: 0.8 });
    bus.emit('hud:rouletteTick', { progress });
  }

  _landItem(item, count) {
    const info = ITEM_INFO[item];
    const st = this._item;
    st.shown = item;
    st.count = count;
    this.itemGlyph.textContent = info ? info.icon : '?';
    this.itemEl.classList.add('has');
    this.itemEl.style.setProperty('--item', info ? info.color : '#fff');
    this._setCount(item, count, false);
    this.itemName.textContent = info ? info.name : item;
    this.itemName.classList.add('on');
    this._nameTimer = 1.8;
    this.itemIcon.animate([
      { transform: 'scale(0.3) rotate(-25deg)', opacity: 0.4 },
      { transform: 'scale(1.45) rotate(8deg)', opacity: 1, offset: 0.4 },
      { transform: 'scale(0.9) rotate(-3deg)', offset: 0.7 },
      { transform: 'scale(1) rotate(0deg)' },
    ], { duration: 520, easing: 'ease-out' });
    this.itemBurst.animate([
      { transform: 'scale(0.6)', opacity: 1 }, { transform: 'scale(1.75)', opacity: 0 },
    ], { duration: 520, easing: 'ease-out' });
    this.itemFrame.animate(POP, { duration: 420, easing: 'ease-out' });
  }

  _setCount(item, count, pop) {
    const multi = ITEM_INFO[item] && ITEM_INFO[item].uses > 1;
    const show = multi && count > 1;
    this.itemCount.classList.toggle('on', show);
    if (show) {
      this.itemCount.textContent = `×${count}`;
      if (pop) this.itemCount.animate(POP, { duration: 360, easing: 'ease-out' });
    }
  }

  _clearItem() {
    const st = this._item;
    const had = st.shown;
    st.shown = null;
    st.count = 0;
    this.itemCount.classList.remove('on');
    this.itemName.classList.remove('on');
    if (!had) {
      this.itemEl.classList.remove('has');
      this.itemGlyph.textContent = '';
      return;
    }
    // used: puff the icon away
    const anim = this.itemIcon.animate([
      { transform: 'scale(1)', opacity: 1 },
      { transform: 'scale(1.5)', opacity: 0 },
    ], { duration: 260, easing: 'ease-out' });
    anim.onfinish = () => {
      if (!this._item.shown && !this._item.rolling) {
        this.itemGlyph.textContent = '';
        this.itemEl.classList.remove('has');
      }
    };
  }

  // ------------------------------------------------------------------ minimap

  _layoutMap() {
    const rect = this.mapEl.getBoundingClientRect();
    // Root not laid out yet (e.g. a display:none parent): retry next frame.
    if (rect.width < 4 || rect.height < 4) { this._mapBg = null; return; }
    this._mapDirty = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(16, Math.round(rect.width * dpr));
    const H = Math.max(16, Math.round(rect.height * dpr));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    this._mapW = W; this._mapH = H;
    this._mapBg = null;
    const track = this.track;
    if (!track || !track.samples || !track.samples.length) return;

    // fit the rotated track into the canvas
    const c = Math.cos(MAP_ROT), s = Math.sin(MAP_ROT);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const smp of track.samples) {
      const X = smp.pos.x * c - smp.pos.z * s, Y = smp.pos.x * s + smp.pos.z * c;
      const m = smp.halfWidth;
      minX = Math.min(minX, X - m); maxX = Math.max(maxX, X + m);
      minY = Math.min(minY, Y - m); maxY = Math.max(maxY, Y + m);
    }
    const pad = Math.min(W, H) * 0.09;
    const scale = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const ox = W / 2 - ((minX + maxX) / 2) * scale;
    const oy = H / 2 - ((minY + maxY) / 2) * scale;
    this._mapXf = { c, s, scale, ox, oy };

    // pre-render outline, road, bridge tint and the start line
    const bg = document.createElement('canvas');
    bg.width = W; bg.height = H;
    const g = bg.getContext('2d');
    const P = (x, z) => [ox + (x * c - z * s) * scale, oy + (x * s + z * c) * scale];
    const path = (from = 0, to = track.samples.length, close = true) => {
      g.beginPath();
      for (let i = from; i <= to; i++) {
        const smp = track.samples[i % track.samples.length];
        const [x, y] = P(smp.pos.x, smp.pos.z);
        i === from ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      if (close) g.closePath();
    };
    const roadW = Math.max(3, Math.min(W, H) * 0.052);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    path();
    g.strokeStyle = 'rgba(16, 8, 40, 0.9)';
    g.lineWidth = roadW + Math.max(3, roadW * 0.7);
    g.stroke();
    g.strokeStyle = '#f3f1ff';
    g.lineWidth = roadW;
    g.stroke();
    // inner lane hint
    g.strokeStyle = 'rgba(160, 150, 210, 0.55)';
    g.lineWidth = Math.max(1, roadW * 0.14);
    g.setLineDash([roadW * 0.6, roadW * 0.7]);
    g.stroke();
    g.setLineDash([]);
    // bridge sections tinted like water
    for (const z of track.zones || []) {
      if (z.type !== 'bridge') continue;
      const i0 = Math.floor(z.s0 / track.spacing), i1 = Math.ceil(z.s1 / track.spacing);
      path(i0, i1, false);
      g.strokeStyle = '#9fdcff';
      g.lineWidth = roadW * 0.62;
      g.stroke();
    }
    // checkered start line across the road
    const f0 = track.samples[0];
    const hw = f0.halfWidth * 1.15;
    const [ax, ay] = P(f0.pos.x - f0.right.x * hw, f0.pos.z - f0.right.z * hw);
    const [bx, by] = P(f0.pos.x + f0.right.x * hw, f0.pos.z + f0.right.z * hw);
    g.lineCap = 'butt';
    g.strokeStyle = '#1a1030';
    g.lineWidth = roadW * 0.55;
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    g.strokeStyle = '#ffffff';
    g.lineWidth = roadW * 0.42;
    const len = Math.hypot(bx - ax, by - ay);
    g.setLineDash([len / 6, len / 6]);
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    g.setLineDash([]);
    this._mapBg = bg;
    this._roadW = roadW;
  }

  _drawMap(karts, player) {
    if (this._mapDirty) this._layoutMap();
    if (!this._mapBg || !this._mapXf) return;
    const g = this.ctx2d, W = this._mapW, H = this._mapH;
    g.clearRect(0, 0, W, H);
    g.drawImage(this._mapBg, 0, 0);
    if (!karts || !karts.length) return;
    const { c, s, scale, ox, oy } = this._mapXf;
    const base = Math.max(3, this._roadW * 0.58);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        if (!k || !k.position) continue;
        const isPlayer = k === player || (!player && k.isPlayer);
        if ((pass === 1) !== isPlayer) continue;   // CPUs first, player on top
        const x = ox + (k.position.x * c - k.position.z * s) * scale;
        const y = oy + (k.position.x * s + k.position.z * c) * scale;
        // the kart's own paint (its loadout), falling back to the character color
        const color = k.cssColor || (k.character && k.character.cssColor) || '#ffffff';
        if (isPlayer) {
          const r = base * 1.45;
          // heading wedge
          const yaw = k.yaw || 0;
          const fx = Math.sin(yaw), fz = Math.cos(yaw);
          const hx = fx * c - fz * s, hy = fx * s + fz * c;
          g.beginPath();
          g.moveTo(x + hx * r * 2.1, y + hy * r * 2.1);
          g.lineTo(x - hy * r * 0.95, y + hx * r * 0.95);
          g.lineTo(x + hy * r * 0.95, y - hx * r * 0.95);
          g.closePath();
          g.fillStyle = '#ffffff';
          g.fill();
          g.lineWidth = Math.max(1.5, r * 0.28);
          g.strokeStyle = 'rgba(16, 8, 40, 0.95)';
          g.stroke();
          g.beginPath();
          g.arc(x, y, r + r * 0.42, 0, Math.PI * 2);
          g.fillStyle = '#ffffff';
          g.fill();
          g.lineWidth = Math.max(1.5, r * 0.3);
          g.stroke();
          g.beginPath();
          g.arc(x, y, r * 0.95, 0, Math.PI * 2);
          g.fillStyle = color;
          g.fill();
        } else {
          g.beginPath();
          g.arc(x, y, base, 0, Math.PI * 2);
          g.fillStyle = color;
          g.fill();
          g.lineWidth = Math.max(1.2, base * 0.38);
          g.strokeStyle = 'rgba(16, 8, 40, 0.95)';
          g.stroke();
        }
      }
    }
  }
}
