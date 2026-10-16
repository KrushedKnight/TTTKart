// DOM menus for KRISHIV KART (SPEC §12 + §13.7): title, character select (12
// racers + "create your racer"), the garage (racer customization), pause,
// results, controls help, QR / phone panel, toasts and small hints. Styles
// live in css/menus.css. Purely presentational: every user intent (mouse,
// keyboard, gamepad edges fed through handleNav) is reported through ONE
// callback using the same action vocabulary as the phone's `pad:menu`
// (SPEC §11 / §13.8), so main.js treats keyboard, mouse and phone identically:
//
//   const menus = new Menus(document.getElementById('menus'), { audio, onAction });
//   onAction(action, payload)   // 'start' | 'select' {index} | 'difficulty' {value} | 'go' |
//                               // 'back' | 'resume' | 'restart' | 'quit' | 'again' | 'menu' |
//                               // 'mute' | 'help' | 'customize' | 'loadout' {field, value} |
//                               // 'cycle' {field, dir} | 'name' {text} | 'randomize' | 'reset' | 'done'
//   menus.show('title');                       // 'boot'|'title'|'select'|'garage'|'race'|'paused'|'results'
//   menus.setSelected(2); menus.setDifficulty('hard');
//   menus.setCard(i, { name, cssColor, ratings, kart });   // card + detail plate data (saved loadouts)
//   menus.setGarage(view);                     // garage contents (see setGarage)
//   menus.setPhone({ status: 'online', connected: false, room, padUrl, qrSvg });
//   menus.setResults({ rows, playerPlace, subtitle });
//   menus.handleNav(input.menu);              // keyboard / gamepad menu edges, once per frame
//   menus.toast('Phone connected!', { icon: '📱', tone: 'good' });
//
// The DOM is only written when a value changes; nothing here runs per frame
// except handleNav(), which returns immediately when no edge is set.

import { SELECTABLE } from './characters.js';
import { DIFFICULTY, RACE, GAME_TITLE } from './config.js';
import { NAME_MAX, FIELD_GROUPS } from './customize.js';
import { formatTime, ordinal } from './utils.js';

const STAT_KEYS = [['speed', 'Speed', 'Spd'], ['accel', 'Accel', 'Acc'], ['handling', 'Handling', 'Hnd'], ['weight', 'Weight', 'Wgt']];
const STAT_ABBR = { speed: 'SPD', accel: 'ACC', handling: 'HND', weight: 'WGT' };
const DIFF_KEYS = Object.keys(DIFFICULTY);       // easy, normal, hard
const DIFF_BLURB = {
  easy: 'Relaxed rivals — perfect for learning to drift.',
  normal: 'A fair fight. Rivals use items and drift.',
  hard: 'Ruthless rivals. Every mini-turbo counts!',
};
// Select grid: 5 columns; the custom card fills the rest of the last row.
const GRID_COLS = 5;
// Garage bottom buttons (keyboard zone 'btns', left → right).
const GARAGE_BTNS = [['randomize', 'Randomize', 'R'], ['reset', 'Reset', ''], ['done', 'Done', 'Esc'], ['go', 'RACE!', 'Enter']];
const NAME_COMMIT_MS = 600;       // typing pause after which the name is committed (blur / Enter commit at once)

// Inline SVG icons (crisp white on dark buttons; emoji render too small/dark there).
const ICON_SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9h4l5-4.2v14.4l-5-4.2h-4z" fill="currentColor"/>'
  + '<path d="M16 8.6a4.8 4.8 0 0 1 0 6.8M18.8 5.8a8.8 8.8 0 0 1 0 12.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ICON_MUTED = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9h4l5-4.2v14.4l-5-4.2h-4z" fill="currentColor"/>'
  + '<path d="M16.2 9.2l5.6 5.6M21.8 9.2l-5.6 5.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const ICON_WRENCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 3.3a5.2 5.2 0 0 0-6.4 6.6l-5.1 5.1a2.1 2.1 0 0 0 3 3l5.1-5.1a5.2 5.2 0 0 0 6.6-6.4l-3.1 3.1-2.6-.6-.6-2.6z" fill="currentColor"/></svg>';
const ICON_DICE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" stroke-width="2.2"/>'
  + '<circle cx="8.5" cy="8.5" r="1.6" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'
  + '<circle cx="15.5" cy="8.5" r="1.6" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.6" fill="currentColor"/></svg>';
const SCREENS = ['boot', 'title', 'select', 'garage', 'race', 'paused', 'results'];

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function button(cls, parent, label, action) {
  const b = el('button', 'tk-btn ' + cls, parent);
  b.type = 'button';
  if (label != null) b.innerHTML = label;
  if (action) b.dataset.action = action;
  return b;
}

// Splits a logo word into bouncy letters. Each letter is two stacked copies:
// an outlined + extruded back copy and a gradient-filled front copy (gradient
// text and outlines can't share one element: text-shadow would cover the fill).
function logoWord(parent, word, cls, offset = 0) {
  const w = el('span', 'tk-logo-word ' + cls, parent);
  w.setAttribute('aria-hidden', 'true');
  [...word].forEach((ch, i) => {
    const s = el('span', 'tk-logo-ch', w);
    s.style.setProperty('--i', String(i + offset));
    el('span', 'b', s, ch);
    el('span', 'f', s, ch);
  });
  return w;
}

function statBars(parent, ratings, cls = '', short = false) {
  const box = el('div', 'tk-stats ' + cls, parent);
  const fills = {};
  for (const [key, label, abbr] of STAT_KEYS) {
    const row = el('div', 'tk-stat', box);
    row.title = label;
    el('span', 'tk-stat-label', row, short ? abbr : label);
    const bar = el('span', 'tk-stat-bar', row);
    const pips = [];
    for (let k = 0; k < 5; k++) pips.push(el('i', '', bar));
    fills[key] = pips;
    setStat(pips, ratings ? ratings[key] : 0);
  }
  return { el: box, fills };
}

// 5 pips; fractional ratings (0.5 steps from kart parts) light a half pip.
function setStat(pips, value) {
  const v = Math.max(0, Math.min(5, Number(value) || 0));
  const full = Math.floor(v + 1e-6);
  const half = v - full >= 0.5 - 1e-6;
  for (let k = 0; k < pips.length; k++) {
    pips[k].classList.toggle('on', k < full);
    pips[k].classList.toggle('half', k === full && half);
  }
}

// "+1", "−0.5" (real minus sign), "" for 0.
function signed(v, unit = '') {
  if (!v) return '';
  const a = Math.abs(v);
  const txt = (Number.isInteger(a) ? String(a) : a.toFixed(1)) + unit;
  return (v > 0 ? '+' : '−') + txt;
}

/** Minimal full-page error card (used by main.js when WebGL / boot fails). */
export function showFatal(root, title, detail = '') {
  if (!root) return;
  const box = el('div', 'tk-fatal');
  el('div', 'tk-fatal-title', box, title);
  if (detail) el('div', 'tk-fatal-detail', box, detail);
  root.replaceChildren(box);
}

export class Menus {
  constructor(root, { characters = SELECTABLE, audio = null, onAction = () => {}, trackName = '' } = {}) {
    this.root = root;
    this.characters = characters;
    this.audio = audio;
    this.onAction = onAction;
    this.trackName = trackName;
    this.screen = 'boot';
    this.selected = 0;
    this._selInit = false;         // first setSelected() always renders the detail plate
    this.difficulty = 'normal';
    this._zone = 'grid';           // select-screen keyboard focus: 'grid' | 'diff' | 'go' | 'cust'
    this._navCol = 0;              // grid column remembered for ↑/↓ through the wide custom card
    this._pauseIdx = 0;
    this._resIdx = 0;
    this._helpOpen = false;
    this._toastTimer = null;
    this._phone = { status: 'connecting', connected: false, room: null, padUrl: null, qrSvg: null, error: null };
    this._qrKey = null;
    this._thumbs = new Map();
    // per-card data from the saved loadouts (main.js → setCard)
    this._cardData = characters.map((c) => ({ name: c.name, cssColor: c.cssColor, ratings: { ...c.ratings }, kart: '' }));
    // garage state (rows are rebuilt only when the character changes)
    this._gar = { charId: null, view: null, rows: [], tab: FIELD_GROUPS[0].id, zone: 'row', row: 0, btn: 3, commitTimer: null };

    this._build();
    this._onClick = (e) => this._click(e);
    this._onDbl = (e) => this._dblclick(e);
    this._onOver = (e) => this._hover(e);
    this.el.addEventListener('click', this._onClick);
    this.el.addEventListener('dblclick', this._onDbl);
    this.el.addEventListener('pointerover', this._onOver);
    this.setSelected(0);
    this.setDifficulty('normal');
    this._renderPhone();
  }

  // ================================================================== DOM

  _build() {
    const r = el('div', 'tk-menus', this.root);
    this.el = r;
    r.dataset.screen = 'boot';
    this.bootEl = this.root.querySelector('.tk-boot');
    if (this.bootEl) r.appendChild(this.bootEl);

    // ------------------------------------------------ global corner buttons
    const corner = el('div', 'tk-corner', r);
    this.muteBtn = button('tk-icon-btn', corner, '', 'mute');
    this.muteBtn.title = 'Mute / unmute (M)';
    this.muteBtn.setAttribute('aria-label', 'Mute or unmute sound (M)');
    this.helpBtn = button('tk-icon-btn', corner, '<span>?</span>', 'help');
    this.helpBtn.title = 'Controls (H)';
    this.helpBtn.setAttribute('aria-label', 'Show controls (H)');
    this.setMuted(false);

    this._buildTitle(r);
    this._buildSelect(r);
    this._buildGarage(r);

    // ------------------------------------------------ pause
    const pause = el('section', 'tk-screen tk-pause', r);
    this.pauseEl = pause;
    const pp = el('div', 'tk-panel tk-pause-panel', pause);
    el('div', 'tk-h1 tk-pause-title', pp, 'Paused');
    this.pauseBtns = [
      button('tk-btn--menu green', pp, 'Resume', 'resume'),
      button('tk-btn--menu orange', pp, 'Restart', 'restart'),
      button('tk-btn--menu red', pp, 'Quit', 'quit'),
    ];
    const ph = el('div', 'tk-pause-hint', pp);
    ph.innerHTML = '<span class="tk-key">Esc</span> resume &nbsp; <span class="tk-key">M</span> mute &nbsp; <span class="tk-key">H</span> controls';

    // ------------------------------------------------ results
    const res = el('section', 'tk-screen tk-results', r);
    this.resultsEl = res;
    const rp = el('div', 'tk-panel tk-res-panel', res);
    this.resTitle = el('div', 'tk-res-title', rp, 'Results');
    this.resSub = el('div', 'tk-res-sub', rp, '');
    const table = el('div', 'tk-res-table', rp);
    const th = el('div', 'tk-res-row tk-res-headrow', table);
    for (const [cls, text] of [['pl', 'Pos'], ['nm', 'Racer'], ['tm', 'Time'], ['bl', 'Best lap']]) el('span', 'tk-res-' + cls, th, text);
    this.resBody = el('div', 'tk-res-body', table);
    const rb = el('div', 'tk-res-btns', rp);
    this.resBtns = [
      button('tk-btn--menu green', rb, 'Race Again', 'again'),
      button('tk-btn--menu blue', rb, 'Change Character', 'menu'),
    ];

    // ------------------------------------------------ in-race hint (intro skip)
    this.introHint = el('div', 'tk-intro-hint', r);
    this.introHint.innerHTML = '<span class="tk-key">Enter</span> skip intro';

    this._buildHelp(r);

    // ------------------------------------------------ in-race screen flash, dip-to-black curtain, toast, sound hint
    this.fxEl = el('div', 'tk-fx', r);
    this.dipEl = el('div', 'tk-dip', r);
    this.toastEl = el('div', 'tk-toast', r);
    this.toastIcon = el('span', 'tk-toast-icon', this.toastEl);
    this.toastText = el('span', 'tk-toast-text', this.toastEl);
    this.soundHint = el('div', 'tk-sound-hint', r);
    this.soundHint.innerHTML = `${ICON_SPEAKER} Click or press any key for sound`;
  }

  _buildTitle(r) {
    const title = el('section', 'tk-screen tk-title', r);
    this.titleEl = title;
    const logo = el('div', 'tk-logo', title);
    logo.setAttribute('role', 'heading');
    logo.setAttribute('aria-level', '1');
    logo.setAttribute('aria-label', GAME_TITLE);
    // exhaust puffs trailing off the first word
    const puffs = el('div', 'tk-logo-puffs', logo);
    for (let k = 0; k < 4; k++) el('i', 'tk-puff p' + k, puffs);
    const [w1 = GAME_TITLE, w2 = ''] = GAME_TITLE.split(' ');
    logoWord(logo, w1, 'w1', 0);
    if (w2) logoWord(logo, w2, 'w2', w1.length);
    el('div', 'tk-logo-sub', title, 'Phone-steered kart chaos on Breezy Bay');
    const prompt = button('tk-prompt', title, '', 'start');
    prompt.innerHTML = '<span class="tk-key">ENTER</span> Press Enter or tap <b>START</b> on your phone';
    this.titleQR = this._qrPanel(title, 'tk-qr--title');
    const tHelp = el('div', 'tk-title-help', title);
    tHelp.innerHTML = '<span class="tk-key">←</span><span class="tk-key">→</span> steer &nbsp; '
      + '<span class="tk-key">↑</span> gas &nbsp; <span class="tk-key">Space</span> drift &nbsp; '
      + '<span class="tk-key">X</span> item &nbsp; <span class="tk-key">Esc</span> pause';
    const more = button('tk-link', tHelp, 'All controls', 'help');
    more.title = 'Show controls (H)';
  }

  _buildSelect(r) {
    const sel = el('section', 'tk-screen tk-select', r);
    this.selectEl = sel;
    const head = el('div', 'tk-sel-head', sel);
    el('div', 'tk-h1', head, 'Choose your racer');
    el('div', 'tk-sel-sub', head, this.trackName ? `${this.trackName} · ${RACE.laps} laps · ${RACE.racers} racers` : `${RACE.laps} laps · ${RACE.racers} racers`);

    const grid = el('div', 'tk-cards', sel);
    const roster = this.characters.filter((c) => !c.isCustom).length;
    this._cells = [];
    this.cards = this.characters.map((c, i) => {
      const custom = !!c.isCustom;
      const card = el('button', 'tk-card' + (custom ? ' tk-card--custom' : ''), grid);
      card.type = 'button';
      card.dataset.index = String(i);
      card.style.setProperty('--c', c.cssColor);
      const pic = el('div', 'tk-card-pic', card);
      const img = el('img', 'tk-card-img', pic);
      img.alt = '';
      img.decoding = 'async';
      img.hidden = true;
      const initial = el('div', 'tk-card-initial', pic, custom ? '?' : c.name[0]);
      const body = el('div', 'tk-card-body', card);
      let name, sub = null;
      if (custom) {
        el('div', 'tk-card-plus', pic, '✚');
        el('div', 'tk-card-kicker', body, 'Create your racer');
        name = el('div', 'tk-card-name', body, c.name);
        sub = el('div', 'tk-card-hint', body);
        sub.innerHTML = '<span class="tk-key">C</span> customize';
        // the wide card fills the rest of the last grid row
        const col = roster % GRID_COLS;
        const span = GRID_COLS - col;
        card.style.gridColumn = `${col + 1} / span ${span}`;
        this._cells.push({ row: Math.floor(roster / GRID_COLS), c0: col, c1: GRID_COLS - 1 });
      } else {
        el('div', 'tk-card-num', pic, String(i + 1));
        name = el('div', 'tk-card-name', body, c.name);
        this._cells.push({ row: Math.floor(i / GRID_COLS), c0: i % GRID_COLS, c1: i % GRID_COLS });
      }
      card.setAttribute('aria-label', custom ? `Create your racer: ${c.name}` : `${c.name}: ${c.tagline}`);
      return { el: card, img, pic, name, initial, custom };
    });
    this._rows = Math.max(...this._cells.map((c) => c.row)) + 1;

    // detail plate over the 3D turntable
    const detail = el('div', 'tk-detail', sel);
    this.detailEl = detail;
    this.detailKicker = el('div', 'tk-detail-kicker', detail, 'Player 1');
    this.detailName = el('div', 'tk-detail-name', detail, '');
    this.detailTag = el('div', 'tk-detail-tag', detail, '');
    this.detailStats = statBars(detail, null, 'tk-stats--big');
    this.detailKart = el('div', 'tk-detail-kart', detail, '');

    // bottom bar: difficulty + customize + race button
    const bar = el('div', 'tk-sel-bar', sel);
    const diff = el('div', 'tk-diff', bar);
    this.diffEl = diff;
    el('div', 'tk-diff-label', diff, 'Difficulty');
    const seg = el('div', 'tk-seg', diff);
    this.diffBtns = DIFF_KEYS.map((key) => {
      const b = button('tk-seg-btn', seg, DIFFICULTY[key].label, 'difficulty');
      b.dataset.value = key;
      b.dataset.diff = key;
      return b;
    });
    this.diffBlurb = el('div', 'tk-diff-blurb', diff, '');
    const hint = el('div', 'tk-sel-hint', bar);
    hint.innerHTML = '<span class="tk-key">←</span><span class="tk-key">→</span><span class="tk-key">↑</span><span class="tk-key">↓</span> choose &nbsp; '
      + '<span class="tk-key">C</span> customize &nbsp; <span class="tk-key">Enter</span> race &nbsp; <span class="tk-key">Esc</span> back';
    this.custBtn = button('tk-btn--cust', bar, `${ICON_WRENCH}<span>Customize</span>`, 'customize');
    this.custBtn.title = 'Customize this racer: name, look, kart and wheels (C)';
    this.goBtn = button('tk-btn--go', bar, 'RACE!', 'go');
    this.selectQR = this._qrPanel(sel, 'tk-qr--compact');
  }

  // Garage: name box + Driver / Kart / Wheels tabs on a panel at the left, the
  // live 3D preview (main.js turntable) on the right with the final stats.
  _buildGarage(r) {
    const gar = el('section', 'tk-screen tk-garage', r);
    this.garageEl = gar;
    const panel = el('div', 'tk-panel tk-gar-panel', gar);
    const head = el('div', 'tk-gar-head', panel);
    el('div', 'tk-gar-kicker', head, 'Garage');
    this.garBase = el('div', 'tk-gar-base', head, '');

    // name box (always visible above the tabs)
    const nameRow = el('label', 'tk-gar-name', panel);
    this.garNameRow = nameRow;
    el('span', 'tk-gar-label', nameRow, 'Name');
    const input = el('input', 'tk-gar-name-input', nameRow);
    input.type = 'text';
    input.maxLength = NAME_MAX;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'words');
    input.setAttribute('aria-label', `Racer name (up to ${NAME_MAX} characters)`);
    this.garNameInput = input;
    this.garNameCount = el('span', 'tk-gar-name-count', nameRow, '');
    input.addEventListener('focus', () => { this._gar.zone = 'name'; this._renderGarageFocus(); });
    input.addEventListener('input', () => this._nameTyped());
    input.addEventListener('keydown', (e) => {
      // Enter / Tab / Esc leave the box (blur commits); never reaches the game
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') { e.preventDefault(); input.blur(); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => this._commitName());

    const tabs = el('div', 'tk-gar-tabs', panel);
    tabs.setAttribute('role', 'tablist');
    this.garTabs = FIELD_GROUPS.map((g, k) => {
      const b = button('tk-gar-tab', tabs, '', 'tab');
      b.dataset.tab = g.id;
      b.setAttribute('role', 'tab');
      el('span', '', b, g.label);
      return b;
    });
    const tabHint = el('div', 'tk-gar-tabhint', tabs);
    tabHint.innerHTML = '<span class="tk-key">Q</span><span class="tk-key">E</span>';
    tabHint.title = 'Switch tab: Q / E or Tab';

    this.garRowsEl = el('div', 'tk-gar-rows', panel);

    const btns = el('div', 'tk-gar-btns', panel);
    this.garBtns = GARAGE_BTNS.map(([action, label, keyHint]) => {
      const cls = action === 'go' ? 'tk-gar-btn go' : action === 'done' ? 'tk-gar-btn done' : 'tk-gar-btn';
      const icon = action === 'randomize' ? ICON_DICE : '';
      const b = button(cls, btns, `${icon}<span>${label}</span>${keyHint ? `<span class="tk-key">${keyHint}</span>` : ''}`, action);
      if (action === 'reset') b.title = 'Back to this racer\'s original look, kart and wheels (keeps the name)';
      return b;
    });
    const hint = el('div', 'tk-gar-hint', panel);
    hint.innerHTML = '<span class="tk-key">↑</span><span class="tk-key">↓</span> part &nbsp; <span class="tk-key">←</span><span class="tk-key">→</span> change &nbsp; '
      + '<span class="tk-key">Q</span><span class="tk-key">E</span> tab &nbsp; <span class="tk-key">R</span> random';

    // right side: live name + final stats (vs. the character's base)
    const side = el('div', 'tk-gar-side', gar);
    this.garSide = side;
    this.garKicker = el('div', 'tk-detail-kicker', side, 'Your racer');
    this.garName = el('div', 'tk-gar-bigname', side, '');
    const stats = el('div', 'tk-gar-stats', side);
    this.garStats = {};
    for (const [key, label] of STAT_KEYS) {
      const row = el('div', 'tk-gs', stats);
      el('span', 'tk-gs-label', row, label);
      const bar = el('span', 'tk-gs-bar', row);
      const fill = el('i', 'tk-gs-fill', bar);
      const plus = el('i', 'tk-gs-plus', bar);
      const minus = el('i', 'tk-gs-minus', bar);
      const base = el('i', 'tk-gs-base', bar);
      const val = el('span', 'tk-gs-val', row, '');
      const delta = el('span', 'tk-gs-delta', row, '');
      this.garStats[key] = { fill, plus, minus, base, val, delta, last: '' };
    }
    this.garOffroad = el('div', 'tk-gar-offroad', side, '');
  }

  _buildHelp(r) {
    const help = el('div', 'tk-help', r);
    this.helpEl = help;
    const hp = el('div', 'tk-panel tk-help-panel', help);
    el('div', 'tk-h1', hp, 'Controls');
    const cols = el('div', 'tk-help-cols', hp);
    const kb = el('div', 'tk-help-col', cols);
    el('div', 'tk-help-h', kb, '⌨️ Keyboard');
    kb.insertAdjacentHTML('beforeend', `
      <dl class="tk-keys">
        <dt><span class="tk-key">←</span><span class="tk-key">→</span> / <span class="tk-key">A</span><span class="tk-key">D</span></dt><dd>Steer</dd>
        <dt><span class="tk-key">↑</span> / <span class="tk-key">W</span></dt><dd>Gas</dd>
        <dt><span class="tk-key">↓</span> / <span class="tk-key">S</span></dt><dd>Brake / reverse</dd>
        <dt><span class="tk-key">Space</span> / <span class="tk-key">Shift</span></dt><dd>Hop &amp; drift (hold)</dd>
        <dt><span class="tk-key">X</span> <span class="tk-key">E</span> <span class="tk-key">Z</span></dt><dd>Use item</dd>
        <dt><span class="tk-key">C</span></dt><dd>Look back · customize (select)</dd>
        <dt><span class="tk-key">Esc</span> / <span class="tk-key">P</span></dt><dd>Pause</dd>
        <dt><span class="tk-key">M</span></dt><dd>Mute</dd>
      </dl>
      <div class="tk-help-note">🎮 Gamepads work too: stick steers, A gas, B brake, RB drift, LB item.</div>`);
    const phone = el('div', 'tk-help-col', cols);
    el('div', 'tk-help-h', phone, '📱 Phone wheel');
    phone.insertAdjacentHTML('beforeend', `
      <dl class="tk-keys">
        <dt>Turn the phone</dt><dd>Steer like a wheel</dd>
        <dt>Right thumb</dt><dd>GAS (big) · BRAKE</dd>
        <dt>Left thumb</dt><dd>DRIFT (hold) · ITEM</dd>
        <dt>⏸ button</dt><dd>Pause</dd>
        <dt>Center</dt><dd>Re-calibrate straight</dd>
      </dl>
      <div class="tk-help-note">Scan the QR code on the title screen. Phone and computer must be on the same Wi-Fi.</div>`);
    const tips = el('div', 'tk-help-tips', hp);
    tips.innerHTML = '<b>Pro tips:</b> hold drift through corners until the sparks turn '
      + '<span style="color:#38c8ff">blue</span> → <span style="color:#ff9d2e">orange</span> → '
      + '<span style="color:#c45cff">purple</span>, then release for a mini-turbo. '
      + 'Press gas just before <b>GO!</b> for a rocket start — too early and you stall.';
    const close = button('tk-btn--menu blue tk-help-close', hp, 'Got it!', 'help');
    close.dataset.close = '1';
  }

  // One QR / phone panel (title: large, select: compact).
  _qrPanel(parent, variant) {
    const p = el('div', 'tk-qr ' + variant, parent);
    const code = el('div', 'tk-qr-code', p);
    const svg = el('div', 'tk-qr-svg', code);
    const badge = el('div', 'tk-qr-badge', code, '✓');
    const off = el('div', 'tk-qr-off', code, '📵');
    const info = el('div', 'tk-qr-info', p);
    el('div', 'tk-qr-title', info, 'Steer with your phone');
    const scan = el('div', 'tk-qr-scan', info, 'Scan with your phone camera to turn it into a steering wheel');
    const url = el('div', 'tk-qr-url', info, '');
    const status = el('div', 'tk-qr-status', info);
    const dot = el('i', 'tk-dot', status);
    const statusText = el('span', '', status, 'Connecting…');
    const tip = el('div', 'tk-qr-tip', info);
    tip.innerHTML = '<span class="tk-tip-long"><b>Certificate warning?</b> It\'s our self-signed HTTPS — tap <i>Show Details / Advanced</i> → <i>visit / proceed</i>. Same Wi-Fi needed.</span>'
      + '<span class="tk-tip-short"><b>Cert warning?</b> Tap <i>Advanced → Proceed</i>. Same Wi-Fi.</span>';
    return { el: p, svg, badge, off, url, scan, status, dot, statusText, tip };
  }

  // ================================================================== screens

  /** Switch the visible menu screen ('race' = no menu, HUD only). */
  show(name) {
    if (!SCREENS.includes(name)) name = 'race';
    if (name === this.screen) return;
    const prev = this.screen;
    this.screen = name;
    this.el.dataset.screen = name;
    const map = { title: this.titleEl, select: this.selectEl, garage: this.garageEl, paused: this.pauseEl, results: this.resultsEl };
    for (const [key, node] of Object.entries(map)) node.classList.toggle('is-active', key === name);
    if (name === 'select') { this._zone = prev === 'garage' ? 'cust' : 'grid'; this._renderZone(); }
    if (name === 'paused') { this._pauseIdx = 0; this._renderFocusList(this.pauseBtns, 0); }
    if (name === 'results') { this._resIdx = 0; this._renderFocusList(this.resBtns, 0); }
    if (prev === 'garage' && document.activeElement === this.garNameInput) this.garNameInput.blur();
    if (name !== 'race') this.setIntroHint(false);
    if (prev === 'boot' && this.bootEl) {
      const boot = this.bootEl;
      this.bootEl = null;
      boot.classList.add('is-gone');
      setTimeout(() => boot.remove(), 700);
    }
  }

  setBootText(text) {
    const t = this.bootEl && this.bootEl.querySelector('.tk-boot-text');
    if (t) t.textContent = text;
  }

  // ================================================================== select

  setSelected(index) {
    const n = this.characters.length;
    const i = ((Math.round(index) % n) + n) % n;
    const changed = i !== this.selected || !this._selInit;
    this._selInit = true;
    this.selected = i;
    this._navCol = Math.max(this._cells[i].c0, Math.min(this._cells[i].c1, this._navCol));
    if (!this.cards[i].custom) this._navCol = this._cells[i].c0;
    this.cards.forEach((c, k) => {
      c.el.classList.toggle('is-selected', k === i);
      c.el.setAttribute('aria-pressed', k === i ? 'true' : 'false');
    });
    if (!changed) return;
    this._renderDetail();
    this.detailEl.classList.remove('pop');
    void this.detailEl.offsetWidth;            // restart the pop animation (only on change)
    this.detailEl.classList.add('pop');
  }

  /**
   * Card + detail-plate data for one selectable racer, from its saved loadout:
   * { name, cssColor, ratings (final, may be fractional), kart ('Speedster · Racing Slicks') }.
   */
  setCard(index, { name, cssColor, ratings, kart } = {}) {
    const card = this.cards[index];
    const d = this._cardData[index];
    if (!card || !d) return;
    if (name && name !== d.name) {
      d.name = name;
      card.name.textContent = name;
      if (!card.custom) card.initial.textContent = name[0];
      const c = this.characters[index];
      card.el.setAttribute('aria-label', card.custom ? `Create your racer: ${name}` : `${name}: ${c.tagline}`);
    }
    if (cssColor && cssColor !== d.cssColor) { d.cssColor = cssColor; card.el.style.setProperty('--c', cssColor); }
    if (ratings) d.ratings = { ...ratings };
    if (kart != null) d.kart = kart;
    if (index === this.selected) this._renderDetail();
  }

  _renderDetail() {
    const i = this.selected;
    const c = this.characters[i];
    const d = this._cardData[i];
    this.selectEl.style.setProperty('--sel', d.cssColor);
    this.detailKicker.textContent = c.isCustom ? 'Your creation' : d.name !== c.name ? `Player 1 · ${c.name}` : 'Player 1';
    if (this.detailName.textContent !== d.name) this.detailName.textContent = d.name;
    this.detailName.classList.toggle('long', d.name.length > 9);
    this.detailTag.textContent = c.tagline;
    for (const [key] of STAT_KEYS) setStat(this.detailStats.fills[key], d.ratings[key]);
    this.detailKart.textContent = d.kart || '';
  }

  setDifficulty(value) {
    if (!DIFFICULTY[value]) value = 'normal';
    this.difficulty = value;
    for (const b of this.diffBtns) {
      const on = b.dataset.value === value;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this.diffBlurb.textContent = DIFF_BLURB[value] || '';
  }

  /** Card portrait (data URL rendered by main.js); falls back to the initial. */
  setThumbnail(id, url) {
    const i = this.characters.findIndex((c) => c.id === id);
    if (i < 0 || !url) return;
    const card = this.cards[i];
    if (this._thumbs.get(id) === url) return;
    this._thumbs.set(id, url);
    card.img.src = url;
    card.img.hidden = false;
    card.pic.classList.add('has-img');
  }

  _renderZone() {
    this.cards.forEach((c, k) => c.el.classList.toggle('is-focus', this._zone === 'grid' && k === this.selected));
    this.diffEl.classList.toggle('is-focus', this._zone === 'diff');
    this.custBtn.classList.toggle('is-focus', this._zone === 'cust');
    this.goBtn.classList.toggle('is-focus', this._zone === 'go');
  }

  _renderFocusList(list, idx) {
    list.forEach((b, k) => b.classList.toggle('is-focus', k === idx));
  }

  // Card in grid row `row` covering column `col` (the wide custom card spans several).
  _cardAt(row, col) {
    for (let i = 0; i < this._cells.length; i++) {
      const c = this._cells[i];
      if (c.row === row && col >= c.c0 && col <= c.c1) return i;
    }
    // ragged row: nearest card in that row
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this._cells.length; i++) {
      const c = this._cells[i];
      if (c.row !== row) continue;
      const d = col < c.c0 ? c.c0 - col : col - c.c1;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ================================================================== garage

  /**
   * Garage contents (main.js, after every change):
   * { index, charId, baseName, human, name, nameMax, groups, fields: [{ key, label, group,
   *   type: 'color'|'choice'|'part', options: [{ id, label, css?, desc?, mods?, offroad? }], value }],
   *   ratings (final), base (character ratings), offroad (grass bonus), cssColor }
   */
  setGarage(view) {
    const G = this._gar;
    const fresh = view.charId !== G.charId;
    G.view = view;
    if (fresh) {
      G.charId = view.charId;
      this._buildGarageRows(view);
      this.garBase.textContent = view.custom ? 'Build your own racer' : `Customizing ${view.baseName}`;
    }
    for (const row of G.rows) this._renderGarageRow(row, view);
    // name box: never rewritten while the player is typing in it
    if (document.activeElement !== this.garNameInput && this.garNameInput.value !== view.name) this.garNameInput.value = view.name;
    this._renderGarageName(document.activeElement === this.garNameInput ? this.garNameInput.value : view.name);
    this.garageEl.style.setProperty('--sel', view.cssColor || '#ffd23a');
    this.garKicker.textContent = view.custom ? 'Your creation' : view.name !== view.baseName ? `Player 1 · ${view.baseName}` : 'Player 1';
    // final stats with +/- vs the base ratings
    for (const [key] of STAT_KEYS) {
      const s = this.garStats[key];
      const v = Number(view.ratings[key]) || 0, b = Number(view.base[key]) || 0;
      const sig = `${v}|${b}`;
      if (s.last === sig) continue;
      s.last = sig;
      const lo = Math.min(v, b), hi = Math.max(v, b);
      s.fill.style.width = `${(lo / 5) * 100}%`;
      s.plus.style.left = s.minus.style.left = `${(lo / 5) * 100}%`;
      s.plus.style.width = v > b ? `${((hi - lo) / 5) * 100}%` : '0%';
      s.minus.style.width = v < b ? `${((hi - lo) / 5) * 100}%` : '0%';
      s.base.style.left = `${(b / 5) * 100}%`;
      s.val.textContent = Number.isInteger(v) ? String(v) : v.toFixed(1);
      s.delta.textContent = signed(v - b);
      s.delta.className = 'tk-gs-delta' + (v > b ? ' up' : v < b ? ' down' : '');
    }
    const off = Math.round((Number(view.offroad) || 0) * 100);
    this.garOffroad.textContent = off ? `Grass grip ${off > 0 ? '+' : '−'}${Math.abs(off)}%` : '';
    this.garOffroad.className = 'tk-gar-offroad' + (off > 0 ? ' up' : off < 0 ? ' down' : '');
    if (fresh) { this.setGarageTab(FIELD_GROUPS[0].id); G.zone = 'row'; G.row = 0; G.btn = 3; this._renderGarageFocus(); }
  }

  _buildGarageRows(view) {
    const G = this._gar;
    const frag = document.createDocumentFragment();
    G.rows = view.fields.map((f) => {
      const row = el('div', `tk-gar-row t-${f.type}`, frag);
      row.dataset.key = f.key;
      row.dataset.group = f.group;
      el('div', 'tk-gar-label', row, f.label);
      const ctl = el('div', 'tk-gar-ctl', row);
      const prev = button('tk-gar-arrow', ctl, '◀', 'cycle');
      prev.dataset.field = f.key; prev.dataset.dir = '-1';
      prev.setAttribute('aria-label', `Previous ${f.label}`);
      const body = el('div', 'tk-gar-val', ctl);
      const valName = el('div', 'tk-gar-valname', body, '');
      const next = button('tk-gar-arrow', ctl, '▶', 'cycle');
      next.dataset.field = f.key; next.dataset.dir = '1';
      next.setAttribute('aria-label', `Next ${f.label}`);
      const out = { key: f.key, group: f.group, type: f.type, el: row, valName, value: null, opts: f.options };
      if (f.type === 'color') {
        const strip = el('div', 'tk-gar-swatches', body);
        out.swatches = f.options.map((o) => {
          const sw = button('tk-sw' + (o.id === 'default' ? ' is-default' : ''), strip, '', 'loadout');
          sw.dataset.field = f.key;
          sw.dataset.value = o.id;
          sw.style.setProperty('--sw', o.css || '#fff');
          sw.title = o.label;
          sw.setAttribute('aria-label', `${f.label}: ${o.label}`);
          return sw;
        });
      } else if (f.type === 'choice') {
        const pips = el('div', 'tk-gar-pips', body);
        out.pips = f.options.map((o) => {
          const p = button('tk-pip', pips, '', 'loadout');
          p.dataset.field = f.key;
          p.dataset.value = o.id;
          p.title = o.label;
          p.setAttribute('aria-label', `${f.label}: ${o.label}`);
          return p;
        });
      } else {
        out.desc = el('div', 'tk-gar-desc', body, '');
        out.mods = el('div', 'tk-gar-mods', body);
      }
      return out;
    });
    this.garRowsEl.replaceChildren(frag);
  }

  _renderGarageRow(row, view) {
    const f = view.fields.find((x) => x.key === row.key);
    if (!f || f.value === row.value) return;
    row.value = f.value;
    const opt = f.options.find((o) => o.id === f.value) || f.options[0];
    row.valName.textContent = opt.label;
    if (row.swatches) for (const sw of row.swatches) sw.classList.toggle('is-on', sw.dataset.value === f.value);
    if (row.pips) for (const p of row.pips) p.classList.toggle('is-on', p.dataset.value === f.value);
    if (row.desc) {
      row.desc.textContent = opt.desc || '';
      const frag = document.createDocumentFragment();
      const mods = opt.mods || {};
      let any = false;
      for (const [key] of STAT_KEYS) {
        const v = mods[key] || 0;
        if (!v) continue;
        any = true;
        el('span', 'tk-mod ' + (v > 0 ? 'up' : 'down'), frag, `${signed(v)} ${STAT_ABBR[key]}`);
      }
      if (opt.offroad) { any = true; el('span', 'tk-mod ' + (opt.offroad > 0 ? 'up' : 'down'), frag, `${signed(Math.round(opt.offroad * 100), '%')} GRASS`); }
      if (!any) el('span', 'tk-mod even', frag, 'No stat changes');
      row.mods.replaceChildren(frag);
    }
  }

  _renderGarageName(text) {
    const t = text || '';
    if (this.garName.textContent !== t) this.garName.textContent = t;
    this.garName.classList.toggle('long', t.length > 9);
    this.garNameCount.textContent = `${Array.from(t).length}/${NAME_MAX}`;
  }

  _nameTyped() {
    const G = this._gar;
    this._renderGarageName(this.garNameInput.value);
    clearTimeout(G.commitTimer);
    G.commitTimer = setTimeout(() => { G.commitTimer = null; this.onAction('name', { text: this.garNameInput.value }); }, NAME_COMMIT_MS);
  }

  _commitName() {
    const G = this._gar;
    clearTimeout(G.commitTimer);
    G.commitTimer = null;
    if (!G.view) return;
    this.onAction('name', { text: this.garNameInput.value });
    // main.js answers with setGarage(); make sure the box shows the cleaned name
    if (G.view && this.garNameInput.value !== G.view.name) this.garNameInput.value = G.view.name;
    this._renderGarageName(G.view.name);
  }

  /** Put the caret in the name box (keyboard: Enter on the Name row). */
  focusName() {
    this.garNameInput.focus();
    this.garNameInput.select();
  }

  get garageTab() { return this._gar.tab; }

  setGarageTab(id) {
    const G = this._gar;
    if (!FIELD_GROUPS.some((g) => g.id === id)) return;
    G.tab = id;
    for (const b of this.garTabs) {
      const on = b.dataset.tab === id;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const row of G.rows) row.el.hidden = row.group !== id;
    G.row = Math.min(G.row, Math.max(0, this._garRows().length - 1));
    this._renderGarageFocus();
  }

  /** Step through the tabs (Tab / Q / E). */
  garageTabStep(dir) {
    const i = FIELD_GROUPS.findIndex((g) => g.id === this._gar.tab);
    const n = FIELD_GROUPS.length;
    this.setGarageTab(FIELD_GROUPS[(i + (dir >= 0 ? 1 : -1) + n) % n].id);
    if (this._gar.zone !== 'btns') { this._gar.zone = 'row'; this._gar.row = 0; }
    this._renderGarageFocus();
    this._sound('menuMove');
  }

  _garRows() { return this._gar.rows.filter((r) => r.group === this._gar.tab); }

  _renderGarageFocus() {
    const G = this._gar;
    const vis = this._garRows();
    for (const r of G.rows) r.el.classList.toggle('is-focus', G.zone === 'row' && vis[G.row] === r);
    this.garNameRow.classList.toggle('is-focus', G.zone === 'name');
    this.garBtns.forEach((b, k) => b.classList.toggle('is-focus', G.zone === 'btns' && k === G.btn));
  }

  _garageNav({ left, right, up, down, confirm, back }) {
    const G = this._gar;
    const vis = this._garRows();
    if (back) { this.onAction('done', {}); return; }
    if (confirm) {
      if (G.zone === 'name') this.focusName();
      else if (G.zone === 'btns') this.onAction(this.garBtns[G.btn].dataset.action, {});
      else this.onAction('go', {});
      return;
    }
    if (up || down) {
      const order = ['name', ...vis.map((_, k) => k), 'btns'];
      const cur = G.zone === 'name' ? 0 : G.zone === 'btns' ? order.length - 1 : 1 + G.row;
      const nxt = Math.max(0, Math.min(order.length - 1, cur + (down ? 1 : -1)));
      if (nxt !== cur) {
        const z = order[nxt];
        if (z === 'name' || z === 'btns') G.zone = z;
        else { G.zone = 'row'; G.row = z; }
        this._renderGarageFocus();
        this._sound('menuMove');
      }
      return;
    }
    if (left || right) {
      const dir = right ? 1 : -1;
      if (G.zone === 'row' && vis[G.row]) this.onAction('cycle', { field: vis[G.row].key, dir });
      else if (G.zone === 'btns') {
        const b = Math.max(0, Math.min(this.garBtns.length - 1, G.btn + dir));
        if (b !== G.btn) { G.btn = b; this._renderGarageFocus(); this._sound('menuMove'); }
      }
    }
  }

  // ================================================================== results

  /**
   * rows: [{ place, name, cssColor, time, finished, bestLap, isPlayer }]
   * playerPlace: number | null; subtitle: string
   */
  setResults({ rows = [], playerPlace = null, subtitle = '' } = {}) {
    const sorted = rows.slice().sort((a, b) => (a.place || 99) - (b.place || 99));
    const frag = document.createDocumentFragment();
    sorted.forEach((r, k) => {
      const row = el('div', 'tk-res-row' + (r.isPlayer ? ' is-player' : ''), frag);
      row.style.setProperty('--c', r.cssColor || '#8890b5');
      row.style.setProperty('--d', `${0.08 + k * 0.06}s`);
      const pl = el('span', 'tk-res-pl', row);
      const badge = el('span', 'tk-place' + (r.place >= 1 && r.place <= 3 ? ' p' + r.place : ''), pl, r.place ? ordinal(r.place) : '–');
      badge.setAttribute('aria-label', r.place ? `${ordinal(r.place)} place` : 'unplaced');
      const nm = el('span', 'tk-res-nm', row);
      el('i', 'tk-chip', nm);
      el('span', 'tk-res-name', nm, r.name || '???');
      if (r.isPlayer) el('span', 'tk-you', nm, 'YOU');
      const est = r.finished === false;
      const tm = el('span', 'tk-res-tm' + (est ? ' est' : ''), row,
        Number.isFinite(r.time) ? `${est ? '~' : ''}${formatTime(r.time)}` : est ? 'DNF' : '--:--.---');
      if (est) tm.title = 'Still racing — estimated time';
      el('span', 'tk-res-bl', row, Number.isFinite(r.bestLap) && r.bestLap > 0 ? formatTime(r.bestLap) : '—');
    });
    this.resBody.replaceChildren(frag);
    const p = Number(playerPlace) || 0;
    this.resTitle.textContent = p ? `You finished ${ordinal(p)}!` : 'Results';
    this.resTitle.className = 'tk-res-title' + (p >= 1 && p <= 3 ? ' p' + p : '');
    this.resSub.textContent = subtitle;
  }

  // ================================================================== phone / QR

  /** Merge phone link state: { status: 'connecting'|'online'|'offline', connected, room, padUrl, qrSvg, error } */
  setPhone(patch = {}) {
    Object.assign(this._phone, patch);
    this._renderPhone();
  }

  _renderPhone() {
    const ph = this._phone;
    const qrKey = ph.status === 'online' ? ph.qrSvg : null;
    for (const q of [this.titleQR, this.selectQR]) {
      if (!q) continue;
      const p = q.el;
      p.classList.toggle('is-online', ph.status === 'online');
      p.classList.toggle('is-offline', ph.status === 'offline');
      p.classList.toggle('is-connecting', ph.status === 'connecting');
      p.classList.toggle('is-connected', ph.status === 'online' && !!ph.connected);
      if (qrKey !== this._qrKey) {
        // qrSvg comes from our own server (qrcode.toString), not from user input.
        q.svg.innerHTML = qrKey || '';
        const svg = q.svg.querySelector('svg');
        if (svg) { svg.removeAttribute('width'); svg.removeAttribute('height'); svg.setAttribute('aria-label', 'QR code for the phone controller'); }
      }
      q.url.textContent = ph.status === 'online' && ph.padUrl ? ph.padUrl : '';
      let text;
      if (ph.status === 'offline') text = 'Offline — keyboard & gamepad still work!';
      else if (ph.status === 'connecting') text = 'Connecting to the game server…';
      else if (ph.connected) text = 'Phone connected — you\'re ready!';
      else text = `Waiting for your phone…${ph.room ? `  Room ${ph.room}` : ''}`;
      q.statusText.textContent = text;
      q.scan.textContent = ph.status === 'offline' ? `Phone steering needs the ${GAME_TITLE} server — start the game with “npm start”.`
        : 'Scan with your phone camera to turn it into a steering wheel';
    }
    this._qrKey = qrKey;
  }

  // ================================================================== small UI bits

  setMuted(muted) {
    this.muted = !!muted;
    this.muteBtn.innerHTML = muted ? ICON_MUTED : ICON_SPEAKER;
    this.muteBtn.classList.toggle('is-muted', !!muted);
  }

  setSoundHint(on) { this.soundHint.classList.toggle('on', !!on); }

  /** Quick dip from black — hides camera cuts between 3D scenes. */
  dip() {
    const d = this.dipEl;
    d.classList.remove('on');
    void d.offsetWidth;
    d.classList.add('on');
  }

  /**
   * Brief full-screen race feedback flash: 'zap' (white-yellow lightning flash),
   * 'hit' (red edge vignette), 'star' (rainbow edge glow).
   */
  screenFlash(kind = 'hit') {
    const f = this.fxEl;
    f.dataset.kind = kind;
    f.classList.remove('on');
    void f.offsetWidth;            // restart the animation
    f.classList.add('on');
  }

  setIntroHint(on) { this.introHint.classList.toggle('on', !!on); }

  get helpOpen() { return this._helpOpen; }

  toggleHelp(force) {
    const on = force === undefined ? !this._helpOpen : !!force;
    if (on === this._helpOpen) return on;
    this._helpOpen = on;
    this.helpEl.classList.toggle('is-open', on);
    return on;
  }

  toast(text, { icon = '', tone = 'info', duration = 2.6 } = {}) {
    const t = this.toastEl;
    this.toastIcon.textContent = icon;
    this.toastIcon.hidden = !icon;
    this.toastText.textContent = text;
    t.dataset.tone = tone;
    t.classList.remove('on');
    void t.offsetWidth;            // restart the enter animation
    t.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('on'), Math.max(0.8, duration) * 1000);
  }

  // ================================================================== input

  _sound(name) { if (this.audio) this.audio.play(name); }

  /**
   * Keyboard / gamepad menu edges for the current screen.
   * menu = { left, right, up, down, confirm, back }. Returns true if consumed.
   */
  handleNav(menu) {
    if (!menu) return false;
    const { left, right, up, down, confirm, back } = menu;
    if (!(left || right || up || down || confirm || back)) return false;

    if (this._helpOpen) {
      if (confirm || back) { this.onAction('help', { close: true }); return true; }
      return true;               // modal: swallow navigation
    }

    switch (this.screen) {
      case 'title':
        if (confirm) { this.onAction('start', {}); return true; }
        return false;

      case 'select': {
        if (back) { this.onAction('back', {}); return true; }
        if (confirm) { this.onAction(this._zone === 'cust' ? 'customize' : 'go', {}); return true; }
        const n = this.characters.length;
        if (this._zone === 'grid') {
          const cell = this._cells[this.selected];
          if (left) this.onAction('select', { index: (this.selected + n - 1) % n });
          else if (right) this.onAction('select', { index: (this.selected + 1) % n });
          else if (up && cell.row > 0) this._gridMove(cell.row - 1);
          else if (down && cell.row < this._rows - 1) this._gridMove(cell.row + 1);
          else if (down) { this._zone = 'diff'; this._sound('menuMove'); }
        } else if (this._zone === 'diff') {
          const i = DIFF_KEYS.indexOf(this.difficulty);
          if (left && i > 0) this.onAction('difficulty', { value: DIFF_KEYS[i - 1] });
          else if (right && i < DIFF_KEYS.length - 1) this.onAction('difficulty', { value: DIFF_KEYS[i + 1] });
          else if (up) { this._zone = 'grid'; this._sound('menuMove'); }
          else if (down) { this._zone = 'go'; this._sound('menuMove'); }
        } else if (this._zone === 'go') {
          if (left) { this._zone = 'cust'; this._sound('menuMove'); }
          else if (up) { this._zone = 'diff'; this._sound('menuMove'); }
        } else if (this._zone === 'cust') {
          if (right || down) { this._zone = 'go'; this._sound('menuMove'); }
          else if (up || left) { this._zone = 'diff'; this._sound('menuMove'); }
        }
        this._renderZone();
        return true;
      }

      case 'garage':
        this._garageNav(menu);
        return true;

      case 'paused': {
        if (back) { this.onAction('resume', {}); return true; }
        if (confirm) { this.onAction(this.pauseBtns[this._pauseIdx].dataset.action, {}); return true; }
        const d = (down || right ? 1 : 0) - (up || left ? 1 : 0);
        if (d) {
          this._pauseIdx = (this._pauseIdx + d + this.pauseBtns.length) % this.pauseBtns.length;
          this._renderFocusList(this.pauseBtns, this._pauseIdx);
          this._sound('menuMove');
        }
        return true;
      }

      case 'results': {
        if (back) { this.onAction('menu', {}); return true; }
        if (confirm) { this.onAction(this.resBtns[this._resIdx].dataset.action, {}); return true; }
        if (left || right || up || down) {
          this._resIdx = 1 - this._resIdx;
          this._renderFocusList(this.resBtns, this._resIdx);
          this._sound('menuMove');
        }
        return true;
      }
      default:
        return false;
    }
  }

  // ↑ / ↓ in the select grid: keep the remembered column (the wide custom card spans several).
  _gridMove(row) {
    const col = this._navCol;
    const i = this._cardAt(row, col);
    if (i < 0) return;
    this.onAction('select', { index: i });
    this._navCol = col;            // passing through the custom card keeps the column
  }

  _click(e) {
    if (e.target === this.helpEl) { this.onAction('help', { close: true }); return; }   // backdrop
    const card = e.target.closest('.tk-card');
    if (card && this.screen === 'select') {
      const i = Number(card.dataset.index);
      const again = i === this.selected && this.characters[i].isCustom;
      this._zone = 'grid';
      this.onAction('select', { index: i });
      this._renderZone();
      if (again) this.onAction('customize', {});          // click the selected "create" card again → garage
      return;
    }
    if (this.screen === 'garage') {
      // clicking a row focuses it for the keyboard too
      const row = e.target.closest('.tk-gar-row');
      if (row) {
        const vis = this._garRows();
        const k = vis.findIndex((r) => r.el === row);
        if (k >= 0) { this._gar.zone = 'row'; this._gar.row = k; this._renderGarageFocus(); }
      }
    }
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const action = b.dataset.action;
    if (action === 'difficulty') {
      this._zone = 'diff';
      this._renderZone();
      this.onAction('difficulty', { value: b.dataset.value });
    } else if (action === 'help') {
      this.onAction('help', b.dataset.close ? { close: true } : {});
    } else if (action === 'tab') {
      if (b.dataset.tab !== this._gar.tab) { this.setGarageTab(b.dataset.tab); this._gar.zone = 'row'; this._gar.row = 0; this._renderGarageFocus(); this._sound('menuMove'); }
    } else if (action === 'cycle') {
      this.onAction('cycle', { field: b.dataset.field, dir: Number(b.dataset.dir) });
    } else if (action === 'loadout') {
      this.onAction('loadout', { field: b.dataset.field, value: b.dataset.value });
    } else {
      if (this.screen === 'garage') {
        const k = this.garBtns.indexOf(b);
        if (k >= 0) { this._gar.zone = 'btns'; this._gar.btn = k; this._renderGarageFocus(); }
      }
      this.onAction(action, {});
    }
    b.blur();                       // keep Enter/Space for the game, not the button
  }

  _dblclick(e) {
    const card = this.screen === 'select' && e.target.closest('.tk-card');
    if (card && !this.characters[Number(card.dataset.index)].isCustom) this.onAction('go', {});
  }

  // Hovering a button moves the keyboard focus ring there (one source of focus).
  _hover(e) {
    const b = e.target.closest('.tk-btn');
    if (!b) return;
    if (this.screen === 'paused') {
      const i = this.pauseBtns.indexOf(b);
      if (i >= 0 && i !== this._pauseIdx) { this._pauseIdx = i; this._renderFocusList(this.pauseBtns, i); }
    } else if (this.screen === 'results') {
      const i = this.resBtns.indexOf(b);
      if (i >= 0 && i !== this._resIdx) { this._resIdx = i; this._renderFocusList(this.resBtns, i); }
    } else if (this.screen === 'select') {
      const z = b === this.goBtn ? 'go' : b === this.custBtn ? 'cust' : null;
      if (z && this._zone !== z) { this._zone = z; this._renderZone(); }
    } else if (this.screen === 'garage') {
      const k = this.garBtns.indexOf(b);
      if (k >= 0 && (this._gar.zone !== 'btns' || this._gar.btn !== k)) { this._gar.zone = 'btns'; this._gar.btn = k; this._renderGarageFocus(); }
    }
  }

  dispose() {
    clearTimeout(this._toastTimer);
    clearTimeout(this._gar.commitTimer);
    this.el.removeEventListener('click', this._onClick);
    this.el.removeEventListener('dblclick', this._onDbl);
    this.el.removeEventListener('pointerover', this._onOver);
    this.el.remove();
  }
}
