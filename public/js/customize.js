// Racer customization: catalogs, loadout validation, stat math and
// persistence. Node-safe (localStorage access is guarded) — used by the
// desktop menus, the 3D model builder, kart physics and the server-relayed
// phone garage (SPEC §13).
//
// A *loadout* is everything the player can choose for one racer:
//   {
//     v: 1,
//     name,                  // display name (1..NAME_MAX chars)
//     body, wheels,          // KART_BODIES / WHEELS ids (affect stats)
//     paint, trim, rim,      // PALETTE ids: kart main color, trim/accent, wheel rims
//     // driver appearance — humans (def.human):
//     skin, hair, hairColor, headwear, eyewear, outfit,
//     // driver appearance — animals/robots/aliens (not human):
//     driverColor,           // 'default' (original colors) or a PALETTE id
//   }
// Every field is always present after sanitizeLoadout(); fields that don't
// apply to the character are kept at their defaults and ignored.

import { clamp } from './utils.js';

export const LOADOUT_VERSION = 1;
export const NAME_MAX = 12;
export const CUSTOM_ID = 'custom';

// ------------------------------------------------------------------ palettes

// Shared color palette for kart paint / trim / rims / outfits / fur tints.
export const PALETTE = [
  { id: 'red',    label: 'Red',    hex: 0xe8344e },
  { id: 'orange', label: 'Orange', hex: 0xff7a1f },
  { id: 'yellow', label: 'Yellow', hex: 0xffc21f },
  { id: 'gold',   label: 'Gold',   hex: 0xd9a514 },
  { id: 'lime',   label: 'Lime',   hex: 0x9be15d },
  { id: 'green',  label: 'Green',  hex: 0x35c64a },
  { id: 'teal',   label: 'Teal',   hex: 0x15c9b0 },
  { id: 'sky',    label: 'Sky',    hex: 0x38c8ff },
  { id: 'blue',   label: 'Blue',   hex: 0x2f6bff },
  { id: 'purple', label: 'Purple', hex: 0x8b5cff },
  { id: 'pink',   label: 'Pink',   hex: 0xff7fc0 },
  { id: 'brown',  label: 'Brown',  hex: 0x7a4a24 },
  { id: 'white',  label: 'White',  hex: 0xf4f4f4 },
  { id: 'silver', label: 'Silver', hex: 0xb9c3cf },
  { id: 'black',  label: 'Black',  hex: 0x2a2a33 },
];

export const SKIN_TONES = [
  { id: 's1', label: 'Tone 1', hex: 0xf8dcc8 },
  { id: 's2', label: 'Tone 2', hex: 0xeec3a1 },
  { id: 's3', label: 'Tone 3', hex: 0xd6a27a },
  { id: 's4', label: 'Tone 4', hex: 0xb47b53 },
  { id: 's5', label: 'Tone 5', hex: 0x8d5a3a },
  { id: 's6', label: 'Tone 6', hex: 0x5f3b26 },
];

export const HAIR_STYLES = [
  { id: 'short',    label: 'Short' },
  { id: 'spiky',    label: 'Spiky' },
  { id: 'curly',    label: 'Curly' },
  { id: 'long',     label: 'Long' },
  { id: 'ponytail', label: 'Ponytail' },
  { id: 'mohawk',   label: 'Mohawk' },
  { id: 'afro',     label: 'Afro' },
  { id: 'buzz',     label: 'Buzz Cut' },
  { id: 'bald',     label: 'Bald' },
];

export const HAIR_COLORS = [
  { id: 'black',  label: 'Black',  hex: 0x1e1a1a },
  { id: 'dark',   label: 'Dark Brown', hex: 0x3b2618 },
  { id: 'brown',  label: 'Brown',  hex: 0x6b4428 },
  { id: 'auburn', label: 'Auburn', hex: 0x8e3b1f },
  { id: 'blonde', label: 'Blonde', hex: 0xe2c06a },
  { id: 'ginger', label: 'Ginger', hex: 0xd2691e },
  { id: 'gray',   label: 'Gray',   hex: 0xa3a3a8 },
  { id: 'blue',   label: 'Blue',   hex: 0x2f6bff },
  { id: 'pink',   label: 'Pink',   hex: 0xff7fc0 },
  { id: 'green',  label: 'Green',  hex: 0x35c64a },
];

export const HEADWEAR = [
  { id: 'none',     label: 'None' },
  { id: 'helmet',   label: 'Race Helmet' },
  { id: 'cap',      label: 'Cap' },
  { id: 'cap_back', label: 'Backwards Cap' },
  { id: 'beanie',   label: 'Beanie' },
  { id: 'headband', label: 'Headband' },
  { id: 'crown',    label: 'Crown' },
];

export const EYEWEAR = [
  { id: 'none',       label: 'None' },
  { id: 'glasses',    label: 'Glasses' },
  { id: 'sunglasses', label: 'Shades' },
  { id: 'goggles',    label: 'Goggles' },
];

// --------------------------------------------------------- kart parts (stats)

// Stat modifiers are in rating "stars" (the 1..5 scale of character
// ratings). Every body and wheel set trades one stat for another, so no part
// is strictly better. `offroad` adds to KART.offroadSpeedMult (grass grip).
export const KART_BODIES = [
  { id: 'standard',  label: 'Classic',       mods: { speed: 0,    accel: 0,    handling: 0,    weight: 0 },
    desc: 'Balanced all-rounder.' },
  { id: 'speedster', label: 'Speedster',     mods: { speed: 1,    accel: -0.5, handling: -0.5, weight: 0 },
    desc: 'Low wedge with a big wing. Fast but twitchy.' },
  { id: 'buggy',     label: 'Bubble Buggy',  mods: { speed: -0.5, accel: 1,    handling: 0,    weight: -0.5 },
    desc: 'Bouncy and quick off the line.' },
  { id: 'tank',      label: 'Thunder Truck', mods: { speed: 0.5,  accel: -1,   handling: -0.5, weight: 1 },
    desc: 'Heavy bruiser that shoves rivals aside.' },
  { id: 'feather',   label: 'Featherlite',   mods: { speed: -0.5, accel: 0.5,  handling: 1,    weight: -1 },
    desc: 'Bare frame go-kart. Corners on rails.' },
  { id: 'rocket',    label: 'Rocket Sled',   mods: { speed: 1.5,  accel: -0.5, handling: -1,   weight: 0 },
    desc: 'Jet fins and raw top speed.' },
];

export const WHEELS = [
  { id: 'standard', label: 'Standard',       mods: { speed: 0,    accel: 0,    handling: 0,    weight: 0 },   offroad: 0,
    desc: 'Reliable everyday tires.' },
  { id: 'slick',    label: 'Racing Slicks',  mods: { speed: 0.5,  accel: -0.5, handling: 0,    weight: 0 },   offroad: -0.05,
    desc: 'Smooth tread for top speed.' },
  { id: 'offroad',  label: 'Mud Grippers',   mods: { speed: -0.5, accel: 0,    handling: 0,    weight: 0.5 }, offroad: 0.15,
    desc: 'Chunky tread — barely slows on grass.' },
  { id: 'tiny',     label: 'Mini Rollers',   mods: { speed: -0.5, accel: 1,    handling: 0,    weight: -0.5 }, offroad: 0,
    desc: 'Small and zippy.' },
  { id: 'monster',  label: 'Monster Wheels', mods: { speed: 0,    accel: -0.5, handling: -0.5, weight: 1 },   offroad: 0.1,
    desc: 'Huge tires, huge presence.' },
  { id: 'neon',     label: 'Neon Rings',     mods: { speed: -0.5, accel: 0,    handling: 0.5,  weight: 0 },   offroad: 0,
    desc: 'Glowing rims that grip the corners.' },
];

export const STAT_KEYS = ['speed', 'accel', 'handling', 'weight'];
export const RATING_MIN = 1;
export const RATING_MAX = 5;

// ------------------------------------------------------------------ helpers

const byId = (list) => new Map(list.map((o) => [o.id, o]));
const MAPS = {
  palette: byId(PALETTE), skin: byId(SKIN_TONES), hair: byId(HAIR_STYLES), hairColor: byId(HAIR_COLORS),
  headwear: byId(HEADWEAR), eyewear: byId(EYEWEAR), body: byId(KART_BODIES), wheels: byId(WHEELS),
};

export const paletteHex = (id, fallback = 0xffffff) => (MAPS.palette.get(id) || { hex: fallback }).hex;
export const skinHex = (id) => (MAPS.skin.get(id) || SKIN_TONES[2]).hex;
export const hairHex = (id) => (MAPS.hairColor.get(id) || HAIR_COLORS[0]).hex;
export const getBody = (id) => MAPS.body.get(id) || KART_BODIES[0];
export const getWheels = (id) => MAPS.wheels.get(id) || WHEELS[0];
export const hexToCss = (hex) => '#' + (hex >>> 0).toString(16).padStart(6, '0').slice(-6);

// Nearest palette id for an arbitrary hex color (used to derive defaults
// from a character's color/accent).
export function nearestPaletteId(hex) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  let best = PALETTE[0].id, bestD = Infinity;
  for (const p of PALETTE) {
    const pr = (p.hex >> 16) & 255, pg = (p.hex >> 8) & 255, pb = p.hex & 255;
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestD) { bestD = d; best = p.id; }
  }
  return best;
}

// Control chars, zero-width/bidi marks, line separators and angle brackets.
const UNSAFE_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff<>]', 'g');

// Clean a display name: printable characters only, collapsed spaces,
// at most NAME_MAX characters. Returns '' if nothing usable is left.
export function sanitizeName(text) {
  if (typeof text !== 'string') return '';
  let s = text.normalize ? text.normalize('NFC') : text;
  s = s.replace(UNSAFE_CHARS, '');
  s = s.replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, NAME_MAX).join('').trim();
}

// ------------------------------------------------------------ loadout logic

// Default loadout for a character def. Character defs (characters.js) may
// carry `signature` ({ body, wheels, paint, trim, rim }) and, for humans,
// `look` ({ skin, hair, hairColor, headwear, eyewear, outfit }).
export function defaultLoadout(def) {
  const sig = (def && def.signature) || {};
  const look = (def && def.look) || {};
  const paint = sig.paint || nearestPaletteId(def && def.color != null ? def.color : 0xe8344e);
  const trim = sig.trim || nearestPaletteId(def && def.accent != null ? def.accent : 0xf4f4f4);
  return {
    v: LOADOUT_VERSION,
    name: (def && def.name) || 'Racer',
    body: sig.body || 'standard',
    wheels: sig.wheels || 'standard',
    paint,
    trim,
    rim: sig.rim || 'silver',
    skin: look.skin || 's3',
    hair: look.hair || 'short',
    hairColor: look.hairColor || 'brown',
    headwear: look.headwear || 'none',
    eyewear: look.eyewear || 'none',
    outfit: look.outfit || paint,
    driverColor: 'default',
  };
}

const FIELD_SOURCES = {
  body: MAPS.body, wheels: MAPS.wheels, paint: MAPS.palette, trim: MAPS.palette, rim: MAPS.palette,
  skin: MAPS.skin, hair: MAPS.hair, hairColor: MAPS.hairColor, headwear: MAPS.headwear,
  eyewear: MAPS.eyewear, outfit: MAPS.palette,
};

// Validate any (possibly hostile / stale) object into a complete loadout.
export function sanitizeLoadout(def, raw) {
  const out = defaultLoadout(def);
  if (!raw || typeof raw !== 'object') return out;
  const name = sanitizeName(raw.name);
  if (name) out.name = name;
  for (const [key, map] of Object.entries(FIELD_SOURCES)) {
    if (typeof raw[key] === 'string' && map.has(raw[key])) out[key] = raw[key];
  }
  if (raw.driverColor === 'default' || (typeof raw.driverColor === 'string' && MAPS.palette.has(raw.driverColor))) {
    out.driverColor = raw.driverColor;
  }
  return out;
}

// Set one field (returns a NEW sanitized loadout; invalid values are ignored).
export function setLoadoutField(def, loadout, key, value) {
  if (key === 'name') return sanitizeLoadout(def, { ...loadout, name: value });
  return sanitizeLoadout(def, { ...loadout, [key]: value });
}

// Step a choice field forward/backward through its options (wraps).
export function cycleLoadoutField(def, loadout, key, dir = 1) {
  const field = loadoutFields(def).find((f) => f.key === key);
  if (!field) return sanitizeLoadout(def, loadout);
  const ids = field.options.map((o) => o.id);
  const i = Math.max(0, ids.indexOf(loadout[key]));
  const next = ids[(i + (dir >= 0 ? 1 : -1) + ids.length) % ids.length];
  return setLoadoutField(def, loadout, key, next);
}

// Final 1..5 ratings for a character with a loadout (fractional, 0.5 steps).
export function computeRatings(def, loadout) {
  const base = (def && def.ratings) || {};
  const body = getBody(loadout && loadout.body);
  const wheels = getWheels(loadout && loadout.wheels);
  const r = {};
  for (const k of STAT_KEYS) {
    const v = (Number(base[k]) || 3) + (body.mods[k] || 0) + (wheels.mods[k] || 0);
    r[k] = clamp(v, RATING_MIN, RATING_MAX);
  }
  return r;
}

// Extra grass grip from the wheels (added to KART.offroadSpeedMult).
export function offroadBonus(loadout) {
  return getWheels(loadout && loadout.wheels).offroad || 0;
}

// Main display color (CSS) of a racer with this loadout: the kart paint.
export function loadoutCssColor(loadout) { return hexToCss(paletteHex(loadout && loadout.paint)); }

const opt = (list, withHex = false) => list.map((o) => (withHex && o.hex != null ? { id: o.id, label: o.label, css: hexToCss(o.hex) } : { id: o.id, label: o.label }));

// The editable fields for a character, grouped for the garage UI (desktop
// and phone). Option entries carry `css` for color swatches and `mods` /
// `desc` for parts so UIs can show stat effects.
export function loadoutFields(def) {
  const human = !!(def && def.human);
  const fields = [];
  if (human) {
    fields.push(
      { key: 'skin', label: 'Skin', group: 'driver', type: 'color', options: opt(SKIN_TONES, true) },
      { key: 'hair', label: 'Hair', group: 'driver', type: 'choice', options: opt(HAIR_STYLES) },
      { key: 'hairColor', label: 'Hair Color', group: 'driver', type: 'color', options: opt(HAIR_COLORS, true) },
      { key: 'headwear', label: 'Headwear', group: 'driver', type: 'choice', options: opt(HEADWEAR) },
      { key: 'eyewear', label: 'Eyewear', group: 'driver', type: 'choice', options: opt(EYEWEAR) },
      { key: 'outfit', label: 'Outfit', group: 'driver', type: 'color', options: opt(PALETTE, true) },
    );
  } else {
    fields.push({ key: 'driverColor', label: 'Color', group: 'driver', type: 'color',
      options: [{ id: 'default', label: 'Original', css: def && def.cssColor ? def.cssColor : '#ffffff' }, ...opt(PALETTE, true)] });
  }
  fields.push(
    { key: 'body', label: 'Kart Body', group: 'kart', type: 'part',
      options: KART_BODIES.map((b) => ({ id: b.id, label: b.label, desc: b.desc, mods: { ...b.mods } })) },
    { key: 'paint', label: 'Paint', group: 'kart', type: 'color', options: opt(PALETTE, true) },
    { key: 'trim', label: 'Trim', group: 'kart', type: 'color', options: opt(PALETTE, true) },
    { key: 'wheels', label: 'Wheels', group: 'wheels', type: 'part',
      options: WHEELS.map((w) => ({ id: w.id, label: w.label, desc: w.desc, mods: { ...w.mods }, offroad: w.offroad })) },
    { key: 'rim', label: 'Rims', group: 'wheels', type: 'color', options: opt(PALETTE, true) },
  );
  return fields;
}

export const FIELD_GROUPS = [
  { id: 'driver', label: 'Driver' },
  { id: 'kart', label: 'Kart' },
  { id: 'wheels', label: 'Wheels' },
];

// Random (but complete) loadout; keeps the current name.
export function randomLoadout(def, rng = Math.random, keepName = null) {
  const pick = (list) => list[Math.floor(rng() * list.length) % list.length].id;
  const raw = {
    name: keepName || (def && def.name),
    body: pick(KART_BODIES), wheels: pick(WHEELS),
    paint: pick(PALETTE), trim: pick(PALETTE), rim: pick(PALETTE),
    skin: pick(SKIN_TONES), hair: pick(HAIR_STYLES), hairColor: pick(HAIR_COLORS),
    headwear: pick(HEADWEAR), eyewear: pick(EYEWEAR), outfit: pick(PALETTE),
    driverColor: rng() < 0.4 ? 'default' : pick(PALETTE),
  };
  return sanitizeLoadout(def, raw);
}

// --------------------------------------------------------------- persistence

const STORE_KEY = 'krishivkart.loadouts.v1';

function storage() {
  // Browser only: Node 26 exposes a warning-emitting localStorage getter, so check for window first.
  try { return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null; }
  catch { return null; }
}

// Returns { [characterId]: rawLoadout } (unsanitized; run sanitizeLoadout per def).
export function loadSavedLoadouts() {
  const s = storage();
  if (!s) return {};
  try {
    const data = JSON.parse(s.getItem(STORE_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

export function saveLoadouts(map) {
  const s = storage();
  if (!s) return false;
  try { s.setItem(STORE_KEY, JSON.stringify(map || {})); return true; } catch { return false; }
}
