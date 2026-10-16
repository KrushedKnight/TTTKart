// KRISHIV KART game server (SPEC §11, §13.8).
//
//   npm start            (= node server.js)
//
// * HTTP  on PORT       (default 3000): the desktop game at http://localhost:3000
// * HTTPS on HTTPS_PORT (default 3443): the phone controller. Motion sensors need
//   a secure context, so we generate a self-signed certificate on first start
//   (SAN = localhost, 127.0.0.1 and every LAN IPv4), cache it in .certs/ and
//   only replace it when it no longer covers the host in the phone URL (a
//   phone's certificate exception is for that one certificate).
// * ONE Socket.IO server is attached to both, so a desktop on http and a phone
//   on https share the same rooms.
//
// Environment:
//   PORT, HTTPS_PORT   listening ports
//   NO_OPEN=1          do not open the desktop URL in the default browser
//   PAD_HOST=<ip|name> force the host used in the phone URL / QR code
//   ROOM_GRACE_MS      how long a room survives without its desktop (default 60000)
//   KRISHIVKART_CERT_DIR  where the certificate is cached (default .certs/; tests).
//                      The old name TOOTKART_CERT_DIR still works.
//
// Rooms: one desktop "host" + at most one phone "pad". A new pad replaces the
// old one (which gets `pad:kicked`). If the host disconnects, the room is kept
// reserved for ROOM_GRACE_MS so the desktop can reclaim it (same code, same
// paired phone) after a reload or a network blip. Every client payload is
// validated and clamped before it is relayed.

import express from 'express';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import selfsigned from 'selfsigned';
import { NET, ITEM_IDS, DIFFICULTY, GAME_TITLE } from './public/js/config.js';
import { ROOM_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } from './public/js/net.js';

// ---------------------------------------------------------------- settings

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const CERT_DIR_ENV = process.env.KRISHIVKART_CERT_DIR || process.env.TOOTKART_CERT_DIR;
const CERT_DIR = CERT_DIR_ENV ? path.resolve(CERT_DIR_ENV) : path.join(ROOT, '.certs');
// Bump to force regeneration after changing cert options. (Not bumped for the
// KRISHIV KART rename: the subject name is cosmetic, and a new certificate
// would make every phone accept the warning again. New certs get the new name.)
const CERT_VERSION = 2;
const CERT_MAX_IPS = 24;                  // SAN cap when old + new addresses are merged
const DAY_MS = 24 * 3600 * 1000;
// Answers /api/info in a response header, so startup can tell whether
// localhost really reaches this process (see checkLoopback).
const INSTANCE = crypto.randomBytes(9).toString('base64url');
const INSTANCE_HEADER = 'X-Krishiv-Kart-Instance';
const TITLE = GAME_TITLE || 'KRISHIV KART';

const HTTP_PORT = envPort('PORT', NET.httpPort);
const HTTPS_PORT = envPort('HTTPS_PORT', NET.httpsPort);
const NO_OPEN = /^(1|true|yes)$/i.test(process.env.NO_OPEN || '');
const ROOM_GRACE_MS = Math.max(1000, Number(process.env.ROOM_GRACE_MS) || 60_000);
const MAX_ROOMS = 500;
const NETWORK_POLL_MS = 10_000;

function envPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`  ${name}=${raw} is not a valid port number.`);
    process.exit(1);
  }
  return n;
}

// ---------------------------------------------------------------- console output

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'),
  blue: paint('34'), magenta: paint('35'), cyan: paint('36'), gray: paint('90'),
};

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`${c.gray(t)} ${msg}`);
}

// ---------------------------------------------------------------- network discovery

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Name of the interface carrying the default route (the network this computer
// is actually using), or null. Cached per interface set: it spawns a process.
let defaultRouteCache = { key: '', name: null };
function defaultRouteInterface(key) {
  if (defaultRouteCache.key === key) return defaultRouteCache.name;
  let name = null;
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    if (process.platform === 'darwin') name = /interface:\s*(\S+)/.exec(run('route', ['-n', 'get', 'default']))?.[1] || null;
    else if (process.platform === 'linux') name = /\bdev\s+(\S+)/.exec(run('ip', ['route', 'show', 'default']))?.[1] || null;
  } catch {
    // no default route / tool missing: fall back to name heuristics
  }
  defaultRouteCache = { key, name };
  return name;
}

// Higher score = more likely the address a phone on the same Wi-Fi can reach.
function scoreAddress(name, ip, routeIf) {
  let score = 0;
  if (routeIf && name === routeIf) score += 50;                 // the interface we are online through
  if (ip.startsWith('169.254.')) score -= 1000;                 // link-local (no DHCP lease)
  if (isPrivateIPv4(ip)) {
    score += 100;
    if (ip.startsWith('192.168.')) score += 6;
    else if (ip.startsWith('10.')) score += 4;
    else score += 2;
  }
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) score -= 40;   // CGNAT / Tailscale
  if (/^(en0|wlan0|wi-?fi)$/i.test(name)) score += 30;          // primary Wi-Fi (macOS / Linux / Windows)
  else if (/^(en\d|eth|eno|enp|ens|wlp|wlan|wl|ethernet)/i.test(name)) score += 20;
  if (/^(utun|tun|tap|ppp|ipsec|gif|stf|bridge|vmnet|vboxnet|docker|br-|veth|virbr|zt|tailscale|llw|awdl|anpi|ap\d|vethernet)/i.test(name)) score -= 60;
  return score;
}

function getNetworkInfo() {
  const list = [];
  const seen = new Set();
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const family = typeof a.family === 'string' ? a.family : a.family === 4 ? 'IPv4' : 'IPv6';
      if (family !== 'IPv4' || a.internal || seen.has(a.address)) continue;
      seen.add(a.address);
      list.push({ name, ip: a.address, score: 0 });
    }
  }
  const routeIf = list.length > 1 ? defaultRouteInterface(list.map((e) => `${e.name}=${e.ip}`).sort().join(',')) : null;
  for (const e of list) e.score = scoreAddress(e.name, e.ip, routeIf);
  list.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name, 'en', { numeric: true }));
  const override = (process.env.PAD_HOST || '').trim();
  return {
    interfaces: list,
    lanIps: list.map((e) => e.ip),
    primary: override || (list[0] ? list[0].ip : 'localhost'),
    override: override || null,
  };
}

const networkKey = (n) => `${[...n.lanIps].sort().join(',')}|${n.primary}`;
const urlHost = (h) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

// ---------------------------------------------------------------- TLS certificate

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOSTNAME_RE = /^[a-z0-9.-]{1,253}$/i;

// Names a certificate made right now should cover: every LAN IPv4, this
// machine's hostname(s) and PAD_HOST.
function certNames(network) {
  const ips = [...new Set(network.lanIps)];
  const hosts = [];
  const hostname = os.hostname();
  if (HOSTNAME_RE.test(hostname)) {
    hosts.push(hostname);
    if (!hostname.includes('.')) hosts.push(`${hostname}.local`);
  }
  if (network.override) {
    if (IPV4_RE.test(network.override)) { if (!ips.includes(network.override)) ips.push(network.override); }
    else if (HOSTNAME_RE.test(network.override)) hosts.push(network.override);
  }
  return { ips, hosts };
}

// { ips, hosts } from X509Certificate.subjectAltName
// ("DNS:localhost, DNS:Mac.lan, IP Address:127.0.0.1, IP Address:192.168.1.20").
function parseSan(san) {
  const out = { ips: [], hosts: [] };
  for (const part of String(san || '').split(/,\s*/)) {
    const m = /^(DNS|IP Address):(.+)$/.exec(part.trim());
    if (!m) continue;
    if (m[1] === 'DNS') out.hosts.push(m[2].toLowerCase());
    else out.ips.push(m[2]);
  }
  return out;
}

const certCovers = (san, host) => (IPV4_RE.test(host) ? san.ips.includes(host) : san.hosts.includes(String(host).toLowerCase()));
const union = (a, b) => [...new Set([...a, ...b])];

// Returns { key, cert, regenerated }. The cached certificate is kept while it
// is valid for the host the phone URL uses (the primary LAN IP or PAD_HOST),
// is not about to expire and was made with the current options. A phone's
// "visit this website" exception holds for that exact certificate, so a VPN,
// VM bridge, hotspot or hostname change must not replace it. When it has to
// be replaced, the new one keeps every address the old one had, so moving back
// to an earlier network does not need yet another certificate.
async function ensureCertificate(network) {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const metaFile = path.join(CERT_DIR, 'meta.json');
  let previous = { ips: [], hosts: [] };

  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const key = fs.readFileSync(keyFile, 'utf8');
    const cert = fs.readFileSync(certFile, 'utf8');
    const x509 = new crypto.X509Certificate(cert);   // throws if corrupt
    if (!x509.checkPrivateKey(crypto.createPrivateKey(key))) throw new Error('key does not match');
    previous = parseSan(x509.subjectAltName);
    const fresh = Date.parse(x509.validTo) - Date.now() > 7 * DAY_MS;
    // (A PAD_HOST no certificate can name, e.g. an IPv6 literal, must not force a new one on every start.)
    const needed = IPV4_RE.test(network.primary) || HOSTNAME_RE.test(network.primary) ? network.primary : 'localhost';
    if (meta.version === CERT_VERSION && fresh && certCovers(previous, needed)) return { key, cert, regenerated: false };
  } catch {
    // missing or corrupt cache → regenerate below
  }

  const want = certNames(network);
  const ips = union(want.ips, previous.ips.filter((ip) => ip !== '127.0.0.1')).slice(0, CERT_MAX_IPS);
  const extraHosts = union(want.hosts, previous.hosts.filter((h) => h !== 'localhost')).slice(0, 16);
  const ident = { ips, hosts: extraHosts };
  const notBefore = new Date(Date.now() - DAY_MS);              // slack for phone clock skew
  const notAfter = new Date(notBefore.getTime() + 730 * DAY_MS); // < 825 days: iOS rejects longer-lived TLS certs
  const altNames = [
    { type: 2, value: 'localhost' },
    ...extraHosts.map((value) => ({ type: 2, value })),
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: `${TITLE} local server` }, { name: 'organizationName', value: TITLE }],
    {
      keyType: 'rsa',
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: notBefore,
      notAfterDate: notAfter,
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    },
  );
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(metaFile, JSON.stringify({
    version: CERT_VERSION, ...ident, created: new Date().toISOString(),
    notAfter: notAfter.toISOString(), fingerprint: pems.fingerprint,
  }, null, 2));
  return { key: pems.private, cert: pems.cert, regenerated: true, names: ['localhost', ...extraHosts, '127.0.0.1', ...ips] };
}

// ---------------------------------------------------------------- payload sanitizers

const SCREENS = new Set(['title', 'select', 'garage', 'race', 'results', 'paused', 'loading']);
const RACE_STATES = new Set(['intro', 'countdown', 'racing', 'finished']);
const ITEMS = new Set(ITEM_IDS);
const DIFFICULTIES = new Set(Object.keys(DIFFICULTY));
const MENU_ACTIONS = new Set([
  'start', 'select', 'difficulty', 'go', 'pause', 'resume', 'restart', 'quit', 'again', 'menu',
  // racer customization (SPEC §13.8)
  'customize', 'loadout', 'cycle', 'name', 'randomize', 'reset', 'done',
]);
const MAX_SEQ = 2 ** 31 - 1;
// Highest select / customize index: 12 roster racers + the custom slot (SPEC §13.2).
const SELECT_MAX = 12;
const FIELD_RE = /^[a-zA-Z]{1,16}$/;          // loadout field key ('body', 'hairColor', …)
const VALUE_RE = /^[a-z0-9_]{1,24}$/;         // loadout option id ('rocket', 'cap_back', 's4', …)
const NAME_TEXT_MAX = 24;                     // raw name text relayed (the host applies sanitizeName)
// C0 / C1 control characters, zero-width / bidi marks and line separators.
const NAME_JUNK_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function num(v, lo, hi, def = 0) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? (n < lo ? lo : n > hi ? hi : n) : def;
}
const int = (v, lo, hi, def = 0) => Math.round(num(v, lo, hi, def));
const bit = (v) => (v === true || num(v, 0, 1, 0) >= 0.5 ? 1 : 0);
const str = (v, max, def = '') => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : def);
const cssColor = (v) => (typeof v === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : '#8890b5');

// Copies up to `max` extra primitive fields (forward compatibility for host
// state additions) with bounded sizes.
function copyExtras(src, dst, known, max = 12) {
  let n = 0;
  for (const k of Object.keys(src)) {
    if (n >= max) break;
    if (known.has(k) || k.length > 32 || !/^[a-zA-Z_][\w]*$/.test(k)) continue;
    const v = src[k];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) dst[k] = v;
    else if (typeof v === 'string') dst[k] = v.slice(0, 120);
    else continue;
    n++;
  }
}

function sanitizeInput(p) {
  if (!isObj(p)) return null;
  return {
    s: Math.round(num(p.s, -1, 1) * 10000) / 10000,
    g: bit(p.g),
    b: bit(p.b),
    d: bit(p.d),
    i: int(p.i, 0, MAX_SEQ),
    p: int(p.p, 0, MAX_SEQ),
    t: num(p.t, 0, 1e15),
  };
}

// A racer index in 0..SELECT_MAX, or NaN (missing / junk / out of range).
function selectIndex(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  const i = Number.isFinite(n) ? Math.round(n) : NaN;
  return i >= 0 && i <= SELECT_MAX ? i : NaN;
}

// Name text from the phone keyboard: a string with the junk characters
// removed, at most NAME_TEXT_MAX characters (whole code points). May be ''
// (the field was cleared: the host falls back to the default name).
function nameText(v) {
  if (typeof v !== 'string') return null;
  return Array.from(v.slice(0, NAME_TEXT_MAX * 4).replace(NAME_JUNK_RE, '')).slice(0, NAME_TEXT_MAX).join('');
}

// Whitelisted pad:menu actions with only their own (validated) fields.
function sanitizeMenu(p) {
  if (!isObj(p) || !MENU_ACTIONS.has(p.action)) return null;
  const out = { action: p.action };
  switch (p.action) {
    case 'select': {
      const index = selectIndex(p.index);
      if (!Number.isFinite(index)) return null;
      out.index = index;
      break;
    }
    case 'customize': {                 // optional index: select that racer first
      if (p.index === undefined || p.index === null) break;
      const index = selectIndex(p.index);
      if (!Number.isFinite(index)) return null;
      out.index = index;
      break;
    }
    case 'difficulty':
      if (!DIFFICULTIES.has(p.value)) return null;
      out.value = p.value;
      break;
    case 'loadout':
      if (typeof p.field !== 'string' || !FIELD_RE.test(p.field)) return null;
      if (typeof p.value !== 'string' || !VALUE_RE.test(p.value)) return null;
      out.field = p.field;
      out.value = p.value;
      break;
    case 'cycle': {
      if (typeof p.field !== 'string' || !FIELD_RE.test(p.field)) return null;
      const dir = typeof p.dir === 'number' ? p.dir : typeof p.dir === 'string' && p.dir.trim() !== '' ? Number(p.dir) : NaN;
      if (dir !== 1 && dir !== -1) return null;
      out.field = p.field;
      out.dir = dir;
      break;
    }
    case 'name': {
      const text = nameText(p.text);
      if (text === null) return null;
      out.text = text;
      break;
    }
    default:
      break;
  }
  return out;
}

const STATE_KEYS = new Set(['screen', 'characters', 'selected', 'difficulty', 'race', 'results', 'garage']);

// ---- garage (racer customization) state, SPEC §13.8
// Realistic payloads are 5–8 KB; the caps below bound a hostile one to ~40 KB
// (Socket.IO's maxHttpBufferSize already rejects anything over 64 KB).
const GARAGE_MAX_GROUPS = 8;
const GARAGE_MAX_FIELDS = 24;
const GARAGE_MAX_OPTIONS = 32;
const FIELD_TYPES = new Set(['color', 'choice', 'part']);
const STAT_NAMES = ['speed', 'accel', 'handling', 'weight'];
const ID_RE = /^[a-z0-9_-]{1,24}$/i;

const ident = (v, def = '') => (typeof v === 'string' && ID_RE.test(v) ? v : def);

// { speed, accel, handling, weight } clamped to lo..hi (0.5-star steps are kept).
function statBlock(v, lo, hi, def) {
  const src = isObj(v) ? v : {};
  const out = {};
  for (const k of STAT_NAMES) out[k] = Math.round(num(src[k], lo, hi, def) * 100) / 100;
  return out;
}

function sanitizeOption(o) {
  if (!isObj(o)) return null;
  const id = typeof o.id === 'string' && VALUE_RE.test(o.id) ? o.id : null;
  if (!id) return null;
  const out = { id, label: str(o.label, 24) || id };
  if (typeof o.css === 'string') out.css = cssColor(o.css);
  if (typeof o.desc === 'string') out.desc = o.desc.slice(0, 80);
  if (isObj(o.mods)) out.mods = statBlock(o.mods, -5, 5, 0);
  if (o.offroad !== undefined) out.offroad = Math.round(num(o.offroad, -1, 1, 0) * 1000) / 1000;
  return out;
}

function sanitizeField(f) {
  if (!isObj(f) || typeof f.key !== 'string' || !FIELD_RE.test(f.key)) return null;
  const options = Array.isArray(f.options) ? f.options.slice(0, GARAGE_MAX_OPTIONS).map(sanitizeOption).filter(Boolean) : [];
  if (!options.length) return null;
  return {
    key: f.key,
    label: str(f.label, 24) || f.key,
    group: ident(f.group, 'kart'),
    type: FIELD_TYPES.has(f.type) ? f.type : 'choice',
    value: typeof f.value === 'string' && VALUE_RE.test(f.value) ? f.value : options[0].id,
    options,
  };
}

function sanitizeGarage(g) {
  if (!isObj(g)) return null;
  const groups = Array.isArray(g.groups)
    ? g.groups.slice(0, GARAGE_MAX_GROUPS).filter((x) => isObj(x) && ident(x.id)).map((x) => ({ id: x.id, label: str(x.label, 24) || x.id }))
    : [];
  const fields = Array.isArray(g.fields) ? g.fields.slice(0, GARAGE_MAX_FIELDS).map(sanitizeField).filter(Boolean) : [];
  return {
    index: int(g.index, 0, 63),
    charId: ident(g.charId, ''),
    human: !!g.human,
    name: str(g.name, NAME_TEXT_MAX),
    nameMax: int(g.nameMax, 1, NAME_TEXT_MAX, 12),
    groups,
    fields,
    ratings: statBlock(g.ratings, 0, 10, 3),
    base: statBlock(g.base, 0, 10, 3),
    offroad: Math.round(num(g.offroad, -1, 1, 0) * 1000) / 1000,
  };
}
const RACE_KEYS = new Set(['state', 'lap', 'laps', 'place', 'racers', 'item', 'itemCount', 'rolling', 'countdown', 'finished']);

function sanitizeState(p) {
  if (!isObj(p)) return null;
  const out = {
    screen: SCREENS.has(p.screen) ? p.screen : 'loading',
    characters: Array.isArray(p.characters)
      ? p.characters.slice(0, 16).map((ch) => ({
        id: str(ch?.id, 24), name: str(ch?.name, 24), cssColor: cssColor(ch?.cssColor), custom: ch?.custom === true,
      }))
      : [],
    selected: int(p.selected, 0, 63),
    difficulty: DIFFICULTIES.has(p.difficulty) ? p.difficulty : 'normal',
    race: null,
    results: null,
    garage: null,
  };
  if (isObj(p.race)) {
    const r = p.race;
    out.race = {
      state: RACE_STATES.has(r.state) ? r.state : 'racing',
      lap: int(r.lap, 0, 99),
      laps: int(r.laps, 1, 99, 3),
      place: int(r.place, 0, 16),
      racers: int(r.racers, 0, 16, 8),
      item: ITEMS.has(r.item) ? r.item : null,
      itemCount: int(r.itemCount, 0, 9),
      rolling: !!r.rolling,
      countdown: Math.round(num(r.countdown, 0, 60) * 100) / 100,
      finished: !!r.finished,
    };
    copyExtras(r, out.race, RACE_KEYS);
  }
  if (Array.isArray(p.results)) {
    out.results = p.results.slice(0, 16).filter(isObj).map((r) => {
      const time = num(r.time, 0, 360000, NaN);
      return {
        name: str(r.name, 24), cssColor: cssColor(r.cssColor), place: int(r.place, 0, 16),
        time: Number.isFinite(time) ? Math.round(time * 1000) / 1000 : null,
        isPlayer: !!r.isPlayer,
        ...(typeof r.finished === 'boolean' ? { finished: r.finished } : {}),
      };
    });
  }
  if (isObj(p.garage)) out.garage = sanitizeGarage(p.garage);
  copyExtras(p, out, STATE_KEYS);
  return out;
}

function sanitizeEvent(p) {
  if (!isObj(p)) return null;
  if (p.type === 'vibrate') {
    const raw = Array.isArray(p.pattern) ? p.pattern : [p.pattern ?? p.ms ?? 40];
    const pattern = raw.slice(0, 16).map((v) => int(v, 0, 1000)).filter((v, i) => i > 0 || v > 0);
    return pattern.length ? { type: 'vibrate', pattern } : null;
  }
  if (p.type === 'toast') {
    const text = str(p.text, 80).trim();
    return text ? { type: 'toast', text } : null;
  }
  return null;
}

const sanitizePadId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(v) ? v : null);

// ---------------------------------------------------------------- rooms

/** @type {Map<string, Room>} */
const rooms = new Map();

// Short blocklist so random codes never spell something rude on the big screen.
// (Only letters from ROOM_ALPHABET can occur, so words with I/L/O are omitted.)
const BLOCKED_CODES = new Set(['ANUS', 'ARSE', 'CRAP', 'CUNT', 'DAMN', 'DUMB', 'DYKE', 'FAGS', 'FUCK', 'FUCT', 'HATE',
  'JERK', 'KKKK', 'MUFF', 'NAZI', 'PUKE', 'PUSS', 'RAPE', 'SCUM', 'SEXY', 'SHAG', 'SHAT', 'SMEG', 'SPAZ', 'TARD', 'TURD',
  'TWAT', 'WANK', 'XXXX']);

function generateCode() {
  for (let attempt = 0; attempt < 500; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
    if (!rooms.has(code) && !BLOCKED_CODES.has(code)) return code;
  }
  throw new Error('No free room codes');
}

class Room {
  constructor(code) {
    this.code = code;
    this.key = crypto.randomBytes(12).toString('base64url');   // lets the host reclaim this room
    this.host = null;
    this.pad = null;
    this.padId = null;
    this.state = null;                // last sanitized host:state (sent to pads on join)
    this.lastInput = null;            // last pad:input relayed to the host (edge detection)
    this.graceTimer = null;
    this.createdAt = Date.now();
  }
}

function createRoom(code) {
  const room = new Room(code);
  rooms.set(code, room);
  log(`${c.cyan(`[${code}]`)} room opened`);
  return room;
}

function attachHost(room, socket) {
  clearTimeout(room.graceTimer);
  room.graceTimer = null;
  const old = room.host;
  if (old && old !== socket) {
    old.data.room = null;
    old.data.role = null;
    old.emit('host:replaced', {});
  }
  const hadHost = !!old;
  room.host = socket;
  socket.data.role = 'host';
  socket.data.room = room.code;
  if (room.pad && !hadHost) room.pad.emit('host:join', {});
}

function hostGone(room) {
  room.host = null;
  if (room.pad) room.pad.emit('host:leave', {});
  log(`${c.cyan(`[${room.code}]`)} desktop disconnected — holding the room for ${Math.round(ROOM_GRACE_MS / 1000)} s`);
  clearTimeout(room.graceTimer);
  room.graceTimer = setTimeout(() => closeRoom(room, 'expired'), ROOM_GRACE_MS);
}

function closeRoom(room, reason) {
  if (rooms.get(room.code) !== room || room.host) return;
  clearTimeout(room.graceTimer);
  if (room.pad) {
    room.pad.emit('room:closed', { reason });
    room.pad.data.room = null;
  }
  rooms.delete(room.code);
  log(`${c.cyan(`[${room.code}]`)} room closed (${reason})`);
}

// The room this socket is the active pad of, or null.
function padRoom(socket) {
  if (socket.data.role !== 'pad' || !socket.data.room) return null;
  const room = rooms.get(socket.data.room);
  return room && room.pad === socket ? room : null;
}

// The room this socket hosts, or null.
function hostRoom(socket) {
  if (socket.data.role !== 'host' || !socket.data.room) return null;
  const room = rooms.get(socket.data.room);
  return room && room.host === socket ? room : null;
}

function detachPad(socket, notifyHost = true) {
  const room = padRoom(socket);
  socket.data.room = null;
  if (!room) return;
  room.pad = null;
  room.padId = null;
  room.lastInput = null;
  if (notifyHost && room.host) room.host.emit('pad:leave', { padId: socket.data.padId });
  log(`${c.cyan(`[${room.code}]`)} phone left`);
}

// ---------------------------------------------------------------- shared server state

let network = getNetworkInfo();
let httpsReady = false;
const qrCache = new Map();

function padBaseUrl() {
  return httpsReady
    ? `https://${urlHost(network.primary)}:${HTTPS_PORT}/pad`
    : `http://${urlHost(network.primary)}:${HTTP_PORT}/pad`;
}

async function qrFor(url) {
  let svg = qrCache.get(url);
  if (!svg) {
    svg = await QRCode.toString(url, { type: 'svg', margin: 1 });
    if (qrCache.size > 64) qrCache.clear();
    qrCache.set(url, svg);
  }
  return svg;
}

async function roomInfo(room) {
  const padUrl = `${padBaseUrl()}?room=${room.code}`;
  return { room: room.code, padUrl, qrSvg: await qrFor(padUrl), lanIps: network.lanIps.slice() };
}

// ---------------------------------------------------------------- express app

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/info', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set(INSTANCE_HEADER, INSTANCE);
    res.json({
      lanIps: network.lanIps,
      httpPort: HTTP_PORT,
      httpsPort: HTTPS_PORT,
      padBaseUrl: padBaseUrl(),
      primaryIp: network.primary,
      https: httpsReady,
      title: GAME_TITLE,
    });
  });

  app.get('/pad', (req, res) => {
    // A phone that typed the plain-http URL is bounced to HTTPS (motion sensors
    // need a secure context). Loopback http is already a secure context.
    const host = String(req.hostname || '');
    if (!req.secure && httpsReady && !isLoopbackHost(host) && /^[a-z0-9.-]+$/i.test(host)) {
      const q = req.originalUrl.indexOf('?');
      res.redirect(302, `https://${host}:${HTTPS_PORT}/pad${q >= 0 ? req.originalUrl.slice(q) : ''}`);
      return;
    }
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'pad.html'));
  });

  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.use('/vendor/three', express.static(THREE_DIR, { index: false, maxAge: '1h', fallthrough: false }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  return app;
}

// ---------------------------------------------------------------- socket.io

const RATE_LIMITS = {
  'host:create': 10, 'host:state': 90, 'host:event': 40,
  'pad:hello': 10, 'pad:input': 150, 'pad:menu': 30, 'net:ping': 10,
};
// pad:input button / sequence edges get their own, separate budget: a pad
// flushing a backlog after a Wi-Fi stall must never lose its last release.
const PAD_EDGE_LIMIT = 60;

function allow(socket, event) {
  const t = Date.now();
  const rate = socket.data.rate || (socket.data.rate = {});
  let bucket = rate[event];
  if (!bucket || t - bucket.t >= 1000) bucket = rate[event] = { t, n: 0 };
  return ++bucket.n <= RATE_LIMITS[event];
}

// Registers a handler with rate limiting, ack normalization and error safety.
function handle(socket, event, fn) {
  socket.on(event, (...args) => {
    let ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const payload = args[0];
    const reply = (v) => { if (ack) { const a = ack; ack = null; a(v); } };
    if (!allow(socket, event)) { reply({ ok: false, error: 'Too many requests', code: 'rate' }); return; }
    try {
      const r = fn(payload, reply);
      if (r && typeof r.catch === 'function') {
        r.catch((err) => { log(c.red(`${event} failed: ${err?.message || err}`)); reply({ ok: false, error: 'Server error' }); });
      }
    } catch (err) {
      log(c.red(`${event} failed: ${err?.message || err}`));
      reply({ ok: false, error: 'Server error' });
    }
  });
}

const isEdge = (last, inp) => !last || last.g !== inp.g || last.b !== inp.b || last.d !== inp.d || last.i !== inp.i || last.p !== inp.p;

function emitPadInput(room, inp, reliable) {
  room.lastInput = inp;
  if (reliable) room.host.emit('pad:input', inp);
  else room.host.volatile.emit('pad:input', inp);
}

// Relays one sanitized pad:input to the host. Button / sequence edges (against
// the last RELAYED sample) go reliably, steady-state samples volatile. Past the
// per-second budget nothing is lost: only the newest sample is kept and relayed
// (reliably) when the window resets, so a burst of queued samples after a
// network stall still ends on the pad's latest state.
function relayPadInput(socket, room, inp) {
  const rl = socket.data.inputRate || (socket.data.inputRate = { t: 0, n: 0, edges: 0, pending: null, timer: null });
  const t = Date.now();
  if (t - rl.t >= 1000) { rl.t = t; rl.n = 0; rl.edges = 0; }
  rl.n++;
  const edge = isEdge(room.lastInput, inp);
  if (edge ? rl.edges < PAD_EDGE_LIMIT : rl.n <= RATE_LIMITS['pad:input']) {
    if (edge) rl.edges++;
    rl.pending = null;                 // superseded by this newer sample
    emitPadInput(room, inp, edge);
    return;
  }
  rl.pending = inp;
  if (rl.timer) return;
  rl.timer = setTimeout(() => {
    rl.timer = null;
    const p = rl.pending;
    rl.pending = null;
    const r = padRoom(socket);
    if (!p || !r || !r.host) return;
    rl.t = Date.now();
    rl.n = 1;
    rl.edges = isEdge(r.lastInput, p) ? 1 : 0;
    emitPadInput(r, p, true);
  }, Math.max(1, rl.t + 1000 - t));
}

function setupSockets(io) {
  io.on('connection', (socket) => {
    socket.data.role = null;
    socket.data.room = null;

    // ---- desktop (host) ----

    handle(socket, 'host:create', async (payload, reply) => {
      if (socket.data.role === 'pad') { reply({ error: 'This connection is a controller' }); return; }
      let room = hostRoom(socket);
      let reclaimed = false;
      const wanted = normalizeRoomCode(isObj(payload) ? payload.room : null);
      if (!room || (wanted && wanted !== room.code)) {
        if (room) { room.host = null; closeRoom(room, 'abandoned'); }
        room = null;
        if (wanted) {
          // A free code is re-created on request (desktop reloaded after the
          // room expired, or the server restarted). An existing room — live or
          // held during the grace period — needs the host key handed out when
          // it was created, so nobody else can take over a paired phone.
          // `vacantOnly`: a newly opened tab found the code another tab stored;
          // it may take the room back from a closed tab, never from a live one.
          const existing = rooms.get(wanted);
          const key = isObj(payload) && typeof payload.key === 'string' ? payload.key : '';
          const vacantOnly = isObj(payload) && payload.vacantOnly === true;
          if (!existing) {
            if (rooms.size < MAX_ROOMS) { room = createRoom(wanted); reclaimed = true; }
          } else if (key && key === existing.key && !(vacantOnly && existing.host)) {
            room = existing;
            reclaimed = true;
          }
        }
        if (!room) {
          if (rooms.size >= MAX_ROOMS) { reply({ error: 'Server is full' }); return; }
          room = createRoom(generateCode());
        }
        attachHost(room, socket);
        if (reclaimed) log(`${c.cyan(`[${room.code}]`)} desktop connected (reclaimed)`);
        else log(`${c.cyan(`[${room.code}]`)} desktop connected`);
      }
      const info = await roomInfo(room);
      if (!socket.connected || room.host !== socket) return;
      reply({ ...info, key: room.key, padConnected: !!room.pad, reclaimed, padBaseUrl: padBaseUrl() });
      if (room.pad) socket.emit('pad:join', { padId: room.padId });
    });

    handle(socket, 'host:state', (payload) => {
      const room = hostRoom(socket);
      if (!room) return;
      const state = sanitizeState(payload);
      if (!state) return;
      room.state = state;
      if (room.pad) room.pad.emit('host:state', state);
    });

    handle(socket, 'host:event', (payload) => {
      const room = hostRoom(socket);
      if (!room || !room.pad) return;
      const ev = sanitizeEvent(payload);
      if (ev) room.pad.emit('host:event', ev);
    });

    // ---- phone (pad) ----

    handle(socket, 'pad:hello', (payload, reply) => {
      if (socket.data.role === 'host') { reply({ ok: false, error: 'This connection is the game host', code: 'role' }); return; }
      const code = normalizeRoomCode(isObj(payload) ? payload.room : null);
      if (!code) { reply({ ok: false, error: 'That room code is not valid.', code: 'bad_code' }); return; }
      const room = rooms.get(code);
      if (!room) { reply({ ok: false, error: `Room ${code} is not open.`, code: 'no_room' }); return; }

      if (socket.data.room && socket.data.room !== code) detachPad(socket);
      const padId = sanitizePadId(isObj(payload) ? payload.id : null) || socket.id;
      socket.data.role = 'pad';
      socket.data.room = code;
      socket.data.padId = padId;

      const old = room.pad;
      const samePhone = old && old.data.padId === padId;
      if (old && old !== socket) {
        old.data.room = null;
        old.emit('pad:kicked', { reason: samePhone ? 'reconnected' : 'replaced' });
        if (room.host && !samePhone) room.host.emit('pad:leave', { padId: old.data.padId });
      }
      room.pad = socket;
      room.padId = padId;
      room.lastInput = null;
      if (old !== socket) log(`${c.cyan(`[${code}]`)} phone ${old && !samePhone ? 'replaced the previous phone' : 'joined'} ${c.gray(`(${socket.handshake.address})`)}`);

      reply({ ok: true, room: code, hostConnected: !!room.host });
      if (room.host) room.host.emit('pad:join', { padId });
      if (room.state) socket.emit('host:state', room.state);
      if (!room.host) socket.emit('host:leave', {});
    });

    // Not registered through handle(): over its rate limit pad:input is
    // coalesced, not dropped (see relayPadInput).
    socket.on('pad:input', (payload) => {
      try {
        const room = padRoom(socket);
        if (!room || !room.host) return;
        const inp = sanitizeInput(payload);
        if (inp) relayPadInput(socket, room, inp);
      } catch (err) {
        log(c.red(`pad:input failed: ${err?.message || err}`));
      }
    });

    handle(socket, 'pad:menu', (payload) => {
      const room = padRoom(socket);
      if (!room || !room.host) return;
      const menu = sanitizeMenu(payload);
      if (menu) room.host.emit('pad:menu', menu);
    });

    handle(socket, 'net:ping', (payload, reply) => reply({ t: Date.now() }));

    socket.on('disconnect', () => {
      clearTimeout(socket.data.inputRate?.timer);
      const code = socket.data.room;
      const room = code ? rooms.get(code) : null;
      if (!room) return;
      if (room.host === socket) hostGone(room);
      else if (room.pad === socket) detachPad(socket);
    });
  });
}

// ---------------------------------------------------------------- startup

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); err.label = label; err.port = port; reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

// Another program can hold our port on a loopback address only (e.g. a dev
// server bound to localhost:3000). On macOS the wildcard listen above still
// succeeds, but http://localhost:PORT then reaches that program while the
// phone (LAN IP) reaches us. Ask both loopback addresses who answers.
// Resolves the first loopback address served by someone else, or null.
async function checkLoopback(port, secure) {
  for (const host of ['127.0.0.1', '::1']) {
    if ((await probeLoopback(host, port, secure)) === 'other') return host;
  }
  return null;
}

// 'us' | 'other' | 'none' (nothing listening / no IPv6 loopback / no answer).
function probeLoopback(host, port, secure) {
  return new Promise((resolve) => {
    const mod = secure ? https : http;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = mod.get({ hostname: host, port, path: '/api/info', agent: false, rejectUnauthorized: false, timeout: 2000 }, (res) => {
      res.resume();
      finish(res.headers[INSTANCE_HEADER.toLowerCase()] === INSTANCE ? 'us' : 'other');
    });
    req.on('timeout', () => { finish('none'); req.destroy(); });
    req.on('error', (err) => {
      // Refused / unreachable: nobody there. Anything else (TLS or protocol
      // errors, resets) means some other program answered.
      finish(/^(ECONNREFUSED|EADDRNOTAVAIL|ENETUNREACH|EHOSTUNREACH|EAFNOSUPPORT|ENOTFOUND)$/.test(err.code || '') ? 'none' : 'other');
    });
  });
}

function explainPortInUse(port, label, where = '') {
  console.error('');
  console.error(c.red(`  ✖ Port ${port} (${label}) is already in use${where ? ` on ${where}` : ''}.`));
  console.error(`    ${TITLE} may already be running — try ${c.cyan(`http://localhost:${HTTP_PORT}`)}.`);
  console.error(`    Otherwise stop the other program, or pick other ports:`);
  console.error(`      ${c.bold(`PORT=${HTTP_PORT + 1} HTTPS_PORT=${HTTPS_PORT + 1} npm start`)}`);
  console.error('');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser launcher available */ });
    child.unref();
  } catch { /* ignore */ }
}

function printBanner() {
  const desktop = `http://localhost:${HTTP_PORT}`;
  const line = c.yellow('━'.repeat(62));
  const ipList = network.interfaces.length
    ? network.interfaces.map((e) => `${e.ip}${c.gray(` (${e.name})`)}`).join(', ')
    : c.red('none found — connect this computer to Wi-Fi');
  console.log('');
  console.log(line);
  console.log(`  ${c.bold(c.yellow(TITLE))}  ${c.gray('· kart racing with a phone steering wheel')}`);
  console.log(line);
  console.log(`  ${c.bold('Desktop game')}   ${c.cyan(desktop)}`);
  console.log(`  ${c.bold('Phone wheel')}    ${c.cyan(`${padBaseUrl()}?room=XXXX`)}  ${c.gray('(scan the QR code in the game)')}`);
  console.log(`  ${c.bold('LAN IPs')}        ${ipList}`);
  if (network.override) console.log(`  ${c.bold('PAD_HOST')}       ${network.override}`);
  console.log('');
  if (httpsReady) {
    console.log(`  ${c.yellow('Tip:')} the phone will warn about the self-signed certificate — that's expected.`);
    console.log(`       iPhone: ${c.bold('Show Details → visit this website')}   Android: ${c.bold('Advanced → Proceed')}`);
  } else {
    console.log(`  ${c.red('HTTPS is unavailable')} — phones can only use touch steering (motion needs HTTPS).`);
  }
  console.log(`       Phone and computer must be on the same Wi-Fi. If macOS asks, allow incoming connections for node.`);
  console.log(line);
  console.log('');
}

async function main() {
  let tls = null;
  try {
    tls = await ensureCertificate(network);
    if (tls.regenerated) log(`generated a new HTTPS certificate for ${tls.names.join(', ')}`);
  } catch (err) {
    log(c.red(`could not create an HTTPS certificate (${err?.message || err}); continuing with HTTP only`));
  }

  const app = buildApp();
  const httpServer = http.createServer(app);
  const httpsServer = tls ? https.createServer({ key: tls.key, cert: tls.cert }, app) : null;

  // Short heartbeat: a phone that locks or loses Wi-Fi keeps its TCP socket
  // "open", so this is how long the room keeps a vanished pad (≤ 6 s). The game
  // itself pauses sooner: the pad sends a pause when its page is hidden, and
  // PhoneLink notices a silent input stream after ~1 s.
  const io = new Server(httpServer, {
    pingInterval: 3000,
    pingTimeout: 3000,
    maxHttpBufferSize: 64 * 1024,
  });
  const httpEngine = io.engine;
  if (httpsServer) io.attach(httpsServer);
  setupSockets(io);

  try {
    await listen(httpServer, HTTP_PORT, 'HTTP');
    if (httpsServer) await listen(httpsServer, HTTPS_PORT, 'HTTPS');
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      explainPortInUse(err.port, err.label);
    } else if (err.code === 'EACCES') {
      console.error(c.red(`  ✖ No permission to listen on port ${err.port}. Use a port above 1024 (PORT=3000).`));
    } else {
      console.error(c.red(`  ✖ Could not start the ${err.label} server: ${err.message}`));
    }
    process.exit(1);
  }
  for (const [port, label, secure] of [[HTTP_PORT, 'HTTP', false], ...(httpsServer ? [[HTTPS_PORT, 'HTTPS', true]] : [])]) {
    const clash = await checkLoopback(port, secure);
    if (clash) {
      explainPortInUse(port, label, clash === '::1' ? '[::1] (localhost)' : `${clash} (localhost)`);
      process.exit(1);
    }
  }
  httpsReady = !!httpsServer;
  for (const s of [httpServer, httpsServer]) s?.on('error', (err) => log(c.red(`server error: ${err.message}`)));

  printBanner();
  if (!NO_OPEN) openBrowser(`http://localhost:${HTTP_PORT}`);

  // Follow network changes (Wi-Fi switch, DHCP renew): new phone URL / QR for
  // every desktop; a new certificate only if the cached one does not cover it.
  let checking = false;
  setInterval(async () => {
    if (checking) return;
    const next = getNetworkInfo();
    if (networkKey(next) === networkKey(network)) return;
    checking = true;
    try {
      network = next;
      qrCache.clear();
      log(`network changed — LAN IPs: ${network.lanIps.join(', ') || 'none'}; phone URL is now ${padBaseUrl()}`);
      if (httpsServer) {
        const creds = await ensureCertificate(network);
        if (creds.regenerated) {
          httpsServer.setSecureContext({ key: creds.key, cert: creds.cert });
          log(`HTTPS certificate regenerated for ${creds.names.join(', ')} — phones must reload the pad page and accept it again`);
        }
      }
      for (const room of rooms.values()) {
        if (room.host) room.host.emit('host:info', await roomInfo(room));
      }
    } catch (err) {
      log(c.red(`network update failed: ${err?.message || err}`));
    } finally {
      checking = false;
    }
  }, NETWORK_POLL_MS).unref();

  let closing = false;
  const shutdown = () => {
    if (closing) process.exit(0);
    closing = true;
    log('shutting down…');
    // Close the transports without Socket.IO "disconnect" packets: clients then
    // see a plain connection loss and auto-reconnect when the server is back
    // (the desktop reclaims its room code, the phone re-joins it).
    try { httpEngine.close(); } catch { /* ignore */ }
    io.close();
    httpServer.close();
    httpServer.closeAllConnections?.();
    httpsServer?.close();
    httpsServer?.closeAllConnections?.();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(c.red(`  ✖ ${err?.stack || err}`));
  process.exit(1);
});
