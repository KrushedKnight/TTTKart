// Procedural canvas textures for the world (browser only).
//
// Every creator draws into a fresh <canvas>, wraps it in a THREE.CanvasTexture
// and returns it. Nothing is cached: the caller owns the texture and must
// dispose() it (world.js tracks every texture it creates).
//
// Color textures are tagged SRGBColorSpace; data textures (normal maps) are
// left linear. Randomness is seeded (utils.makeRng) so the look is identical
// on every load.
//
// UV conventions used by world.js:
//   * road / curb / grass strip / boost pads: u = across the strip (0 = left),
//     v = along the driving direction (canvas TOP = +v = "forward" because
//     CanvasTexture.flipY is true).
//   * wall atlas: 4 horizontal bands (see WALL_BANDS), u repeats along the wall.

import * as THREE from 'three';
import { makeRng, clamp, lerp } from './utils.js';

// ------------------------------------------------------------------ helpers

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function finish(canvas, { srgb = true, repeat = true, aniso = 1, mipmaps = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso;
  tex.generateMipmaps = mipmaps;
  tex.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// Tileable value noise on a size×size grid. `cells` lattice cells per tile
// (must divide nicely into the size for best results). Returns Float32Array in [0,1].
export function tileNoise(size, cells, rng) {
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells, y0 = Math.floor(fy), ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const ya = y0 % cells, yb = (y0 + 1) % cells;
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, x0 = Math.floor(fx), tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const xa = x0 % cells, xb = (x0 + 1) % cells;
      const a = lat[ya * cells + xa], b = lat[ya * cells + xb];
      const c = lat[yb * cells + xa], d = lat[yb * cells + xb];
      out[y * size + x] = lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
    }
  }
  return out;
}

// Tileable fractal noise: sum of tileNoise octaves (normalized to [0,1]).
export function tileFbm(size, baseCells, octaves, rng, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0, cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const n = tileNoise(size, cells, rng);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp; amp *= gain; cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// Draw a shape that wraps around the tile edges (for seamless speckles).
function wrapDraw(size, x, y, r, fn) {
  fn(x, y);
  if (x < r) fn(x + size, y); else if (x > size - r) fn(x - size, y);
  if (y < r) fn(x, y + size); else if (y > size - r) fn(x, y - size);
}

// ------------------------------------------------------------------ road

// Asphalt for the full road width: u 0..1 spans edge to edge, v tiles along
// the track (one tile = `tileMeters` meters; the caller sets UVs to match).
// White edge lines + a dashed center line are painted in.
export function createAsphaltTexture({ size = 1024, aniso = 1, seed = 11 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const blot = tileFbm(size, 8, 4, rng, 0.55);
  const base = [86, 90, 100];
  for (let i = 0; i < size * size; i++) {
    const fine = (rng() - 0.5) * 22;
    const b = (blot[i] - 0.5) * 26;
    let v = fine + b;
    if (rng() < 0.012) v += 30 + rng() * 25;        // light aggregate specks
    else if (rng() < 0.01) v -= 22;                 // dark pits
    d[i * 4] = clamp(base[0] + v, 0, 255);
    d[i * 4 + 1] = clamp(base[1] + v, 0, 255);
    d[i * 4 + 2] = clamp(base[2] + v * 1.05, 0, 255);
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);

  // Faint darker tyre-polish band down the middle third.
  const grad = g.createLinearGradient(0, 0, size, 0);
  grad.addColorStop(0.0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.3, 'rgba(20,22,30,0.10)');
  grad.addColorStop(0.5, 'rgba(20,22,30,0.04)');
  grad.addColorStop(0.7, 'rgba(20,22,30,0.10)');
  grad.addColorStop(1.0, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, size, size);

  // Edge lines (slightly worn: alpha noise).
  const line = (x0, w, alpha) => {
    for (let y = 0; y < size; y += 2) {
      g.fillStyle = `rgba(250,250,244,${alpha * (0.82 + rng() * 0.18)})`;
      g.fillRect(x0, y, w, 2);
    }
  };
  const ew = Math.round(size * 0.012);
  line(Math.round(size * 0.016), ew, 0.95);
  line(size - Math.round(size * 0.016) - ew, ew, 0.95);
  // Center dashes: 2 per tile.
  const cw = Math.round(size * 0.008);
  for (let k = 0; k < 2; k++) {
    const y0 = Math.round(size * (k * 0.5 + 0.06)), len = Math.round(size * 0.26);
    for (let y = y0; y < y0 + len; y += 2) {
      g.fillStyle = `rgba(250,248,235,${0.75 * (0.8 + rng() * 0.2)})`;
      g.fillRect(Math.round(size / 2 - cw / 2), y, cw, 2);
    }
  }
  return finish(c, { aniso });
}

// Red / white curb stripes. u across the 1 m curb, v along: one tile = one
// red + one white block.
export function createCurbTexture({ aniso = 1 } = {}) {
  const w = 64, h = 256;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#e8322b'; g.fillRect(0, 0, w, h / 2);
  g.fillStyle = '#f7f5ef'; g.fillRect(0, h / 2, w, h / 2);
  // soft shading toward the outer edge + a thin dark inner seam
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.22)');
  grad.addColorStop(0.08, 'rgba(0,0,0,0)');
  grad.addColorStop(0.85, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.18)');
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  // block seams
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(0, 0, w, 2); g.fillRect(0, h / 2 - 1, w, 2);
  return finish(c, { aniso });
}

// Light grayscale detail with grass speckles; multiplied with vertex colors.
// `stripes` adds mowing bands along v (used by the off-road strip).
export function createGrassTexture({ size = 512, aniso = 1, stripes = false, seed = 21 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 4, 5, rng, 0.55);
  for (let y = 0; y < size; y++) {
    // mowing stripes: two bands per tile along v (canvas y)
    const band = stripes ? (y < size / 2 ? 1.0 : 0.9) : 1;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const v = (0.8 + n[i] * 0.22 + (rng() - 0.5) * 0.08) * band;
      d[i * 4] = clamp(v * 236, 0, 255);
      d[i * 4 + 1] = clamp(v * 248, 0, 255);
      d[i * 4 + 2] = clamp(v * 226, 0, 255);
      d[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // blade strokes (dark + light), wrapped so the tile is seamless
  for (let k = 0; k < size * 7; k++) {
    const x = rng() * size, y = rng() * size;
    const len = 2 + rng() * 5, ang = -Math.PI / 2 + (rng() - 0.5) * 0.9;
    const dark = rng() < 0.55;
    g.strokeStyle = dark ? `rgba(30,60,20,${0.10 + rng() * 0.12})` : `rgba(255,255,230,${0.10 + rng() * 0.12})`;
    g.lineWidth = 1;
    wrapDraw(size, x, y, 8, (px, py) => {
      g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len); g.stroke();
    });
  }
  return finish(c, { aniso });
}

// Generic soft grayscale detail noise (terrain). Values ~0.78..1.0.
export function createDetailTexture({ size = 512, aniso = 1, seed = 31 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 4, 6, rng, 0.6);
  for (let i = 0; i < size * size; i++) {
    const v = 0.78 + n[i] * 0.2 + (rng() - 0.5) * 0.06;
    d[i * 4] = clamp(v * 250, 0, 255);
    d[i * 4 + 1] = clamp(v * 252, 0, 255);
    d[i * 4 + 2] = clamp(v * 244, 0, 255);
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, { aniso });
}

// Packed dirt (light brown) for paths / pit areas.
export function createDirtTexture({ size = 256, aniso = 1, seed = 41 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 4, 5, rng, 0.55);
  for (let i = 0; i < size * size; i++) {
    const v = 0.75 + n[i] * 0.3 + (rng() - 0.5) * 0.12;
    d[i * 4] = clamp(v * 196, 0, 255);
    d[i * 4 + 1] = clamp(v * 158, 0, 255);
    d[i * 4 + 2] = clamp(v * 112, 0, 255);
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  for (let k = 0; k < 220; k++) {
    const x = rng() * size, y = rng() * size, r = 0.8 + rng() * 2.2;
    g.fillStyle = rng() < 0.5 ? 'rgba(90,64,40,0.35)' : 'rgba(250,230,200,0.35)';
    wrapDraw(size, x, y, 4, (px, py) => { g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill(); });
  }
  return finish(c, { aniso });
}

// Light rock detail (grayscale with cracks); tinted by vertex/instance color.
export function createRockTexture({ size = 256, aniso = 1, seed = 51 } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const n = tileFbm(size, 4, 5, rng, 0.6);
  const m = tileFbm(size, 16, 2, rng, 0.5);
  for (let i = 0; i < size * size; i++) {
    const v = 0.68 + n[i] * 0.3 + (m[i] - 0.5) * 0.12 + (rng() - 0.5) * 0.06;
    d[i * 4] = clamp(v * 240, 0, 255);
    d[i * 4 + 1] = clamp(v * 236, 0, 255);
    d[i * 4 + 2] = clamp(v * 230, 0, 255);
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(40,36,32,0.35)'; g.lineWidth = 1.2;
  for (let k = 0; k < 14; k++) {
    let x = rng() * size, y = rng() * size;
    g.beginPath(); g.moveTo(x, y);
    for (let j = 0; j < 6; j++) { x += (rng() - 0.5) * 30; y += rng() * 18; g.lineTo(x, y); }
    g.stroke();
  }
  return finish(c, { aniso });
}

// Black / white checker, 2×2 squares per tile (start/finish strip).
export function createCheckerTexture({ aniso = 1 } = {}) {
  const s = 128;
  const c = makeCanvas(s, s), g = c.getContext('2d');
  g.fillStyle = '#f6f6f2'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#16161c'; g.fillRect(0, 0, s / 2, s / 2); g.fillRect(s / 2, s / 2, s / 2, s / 2);
  return finish(c, { aniso });
}

// Boost pad: glowing chevrons pointing toward +v, framed by orange rails.
// One tile is square; world.js scrolls texture.offset.y for animation.
export function createChevronTexture({ aniso = 1 } = {}) {
  const w = 256, h = 256;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, w, 0);
  bg.addColorStop(0, '#2a1260'); bg.addColorStop(0.5, '#3c1d8a'); bg.addColorStop(1, '#2a1260');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // two chevrons per tile (pointing up = forward)
  const chev = (yTip, color, glow) => {
    g.save();
    g.shadowColor = glow; g.shadowBlur = 18;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(w * 0.5, yTip);
    g.lineTo(w * 0.86, yTip + h * 0.25);
    g.lineTo(w * 0.86, yTip + h * 0.37);
    g.lineTo(w * 0.5, yTip + h * 0.12);
    g.lineTo(w * 0.14, yTip + h * 0.37);
    g.lineTo(w * 0.14, yTip + h * 0.25);
    g.closePath(); g.fill();
    g.restore();
  };
  for (const off of [-h, 0, h]) {   // draw wrapped copies so the tile is seamless vertically
    chev(off + h * 0.06, '#ffe14a', '#ff9a1a');
    chev(off + h * 0.56, '#ffb627', '#ff6a00');
  }
  // side rails
  g.fillStyle = '#ff7a1a'; g.fillRect(0, 0, w * 0.06, h); g.fillRect(w * 0.94, 0, w * 0.06, h);
  g.fillStyle = '#fff3a0'; g.fillRect(w * 0.06, 0, w * 0.012, h); g.fillRect(w * 0.928, 0, w * 0.012, h);
  return finish(c, { aniso });
}

// Diagonal yellow / black hazard stripes (ramp sides & lip).
export function createHazardTexture({ aniso = 1 } = {}) {
  const s = 128;
  const c = makeCanvas(s, s), g = c.getContext('2d');
  g.fillStyle = '#ffcc1a'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#1b1b22';
  for (let k = -2; k < 3; k++) {
    const x = k * s / 2;
    g.beginPath();
    g.moveTo(x, s); g.lineTo(x + s / 4, s); g.lineTo(x + s / 4 + s, 0); g.lineTo(x + s, 0);
    g.closePath(); g.fill();
  }
  return finish(c, { aniso });
}

// Ramp top: bright blue deck with white grip ridges and a hazard lip at +v.
// v 0 = ramp start (road level), v 1 = lip. u repeats across the road.
export function createRampTopTexture({ aniso = 1 } = {}) {
  const w = 256, h = 512;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const bg = g.createLinearGradient(0, h, 0, 0);
  bg.addColorStop(0, '#1f7fe0'); bg.addColorStop(1, '#3fb4ff');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // grip ridges across
  for (let y = h * 0.12; y < h; y += h / 14) {
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(0, y, w, 6);
    g.fillStyle = 'rgba(0,30,80,0.25)'; g.fillRect(0, y + 6, w, 3);
  }
  // big up-arrow
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.beginPath();
  g.moveTo(w * 0.5, h * 0.18); g.lineTo(w * 0.8, h * 0.42); g.lineTo(w * 0.62, h * 0.42);
  g.lineTo(w * 0.62, h * 0.82); g.lineTo(w * 0.38, h * 0.82); g.lineTo(w * 0.38, h * 0.42); g.lineTo(w * 0.2, h * 0.42);
  g.closePath(); g.fill();
  // hazard lip band at the top (= +v, the drop edge)
  const bandH = h * 0.1;
  g.fillStyle = '#ffcc1a'; g.fillRect(0, 0, w, bandH);
  g.fillStyle = '#1b1b22';
  for (let x = -bandH; x < w + bandH; x += bandH) {
    g.beginPath(); g.moveTo(x, bandH); g.lineTo(x + bandH * 0.5, bandH); g.lineTo(x + bandH, 0); g.lineTo(x + bandH * 0.5, 0); g.closePath(); g.fill();
  }
  return finish(c, { aniso });
}

// Wall atlas: four 128 px bands stacked vertically. u repeats along the wall
// (one tile = WALL_TILE_METERS). Bands (v ranges include 6 px padding):
export const WALL_BANDS = {
  redWhite: 3,   // top band
  blueWhite: 2,
  stone: 1,
  hazard: 0,     // bottom band
};
export function wallBandV(band) {
  // returns [v0, v1] inside the band, padded to limit mip bleeding
  const v0 = band / 4, pad = 6 / 512;
  return [v0 + pad, v0 + 0.25 - pad];
}
export function createWallAtlasTexture({ aniso = 1, seed = 61 } = {}) {
  const rng = makeRng(seed);
  const w = 512, h = 512, bh = 128;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  // canvas row 0 is the TOP = v 1 → band 3 lives at canvas y 0..128
  const bandY = (band) => (3 - band) * bh;

  // red / white blocks with a top highlight
  let y = bandY(WALL_BANDS.redWhite);
  for (let k = 0; k < 4; k++) { g.fillStyle = k % 2 ? '#f7f5ef' : '#e5302a'; g.fillRect(k * w / 4, y, w / 4, bh); }
  g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(0, y, w, 14);
  g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, y + bh - 18, w, 18);

  // blue / white panels with a stylised wave logo
  y = bandY(WALL_BANDS.blueWhite);
  g.fillStyle = '#1f6fd6'; g.fillRect(0, y, w, bh);
  for (let k = 0; k < 2; k++) {
    const x0 = k * w / 2;
    g.fillStyle = '#f4f8ff'; g.fillRect(x0 + 10, y + 18, w / 2 - 20, bh - 36);
    g.strokeStyle = '#1f6fd6'; g.lineWidth = 9;
    g.beginPath();
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const px = x0 + 30 + t * (w / 2 - 60), py = y + bh / 2 + Math.sin(t * Math.PI * 3) * 16;
      if (t === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.stroke();
    g.fillStyle = '#ffcf33';
    g.beginPath(); g.arc(x0 + w / 4, y + bh / 2 - 2, 10, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(0, y + bh - 12, w, 12);

  // stone wall
  y = bandY(WALL_BANDS.stone);
  g.fillStyle = '#7d7468'; g.fillRect(0, y, w, bh);
  const rows = 4, rh = bh / rows;
  for (let r = 0; r < rows; r++) {
    let x = r % 2 ? -30 : 0;
    while (x < w) {
      const sw = 40 + rng() * 40;
      const shade = 150 + Math.floor(rng() * 50);
      g.fillStyle = `rgb(${shade + 8},${shade},${shade - 14})`;
      // draw with wrap so the band tiles seamlessly in u
      const draw = (xx) => g.fillRect(xx + 2, y + r * rh + 2, sw - 4, rh - 4);
      draw(x); if (x + sw > w) draw(x - w);
      x += sw;
    }
  }
  g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(0, y, w, 6);

  // hazard stripes
  y = bandY(WALL_BANDS.hazard);
  g.save(); g.beginPath(); g.rect(0, y, w, bh); g.clip();
  g.fillStyle = '#ffcc1a'; g.fillRect(0, y, w, bh);
  g.fillStyle = '#1b1b22';
  for (let x = -bh; x < w + bh; x += 64) {
    g.beginPath(); g.moveTo(x, y + bh); g.lineTo(x + 32, y + bh); g.lineTo(x + 32 + bh, y); g.lineTo(x + bh, y); g.closePath(); g.fill();
  }
  g.restore();
  return finish(c, { aniso });
}

// Start/finish gantry banner: "KRISHIV KART" with a checkered border. The
// title is shrunk (never stretched) to fit between the checkered end caps.
export function createBannerTexture(text = 'KRISHIV KART', { aniso = 1 } = {}) {
  const w = 1024, h = 128;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#2b7cff'); bg.addColorStop(1, '#1546b8');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // checkered end caps
  const sq = h / 4;
  for (const x0 of [0, w - sq * 2]) {
    for (let r = 0; r < 4; r++) for (let k = 0; k < 2; k++) {
      g.fillStyle = (r + k) % 2 ? '#111' : '#fff';
      g.fillRect(x0 + k * sq, r * sq, sq, sq);
    }
  }
  g.fillStyle = '#ffd23a'; g.fillRect(sq * 2, 0, w - sq * 4, 7); g.fillRect(sq * 2, h - 7, w - sq * 4, 7);
  const family = '"Arial Black", "Lilita One", Impact, sans-serif';
  const maxW = w - sq * 4 - 64;            // clear of the end caps, incl. the 14 px outline
  let size = 88;
  g.font = `900 ${size}px ${family}`;
  const measured = g.measureText(text).width;
  if (measured > maxW) { size = Math.max(40, Math.floor(size * maxW / measured)); g.font = `900 ${size}px ${family}`; }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 14; g.strokeStyle = '#7a1408'; g.strokeText(text, w / 2, h / 2 + 4);
  const tg = g.createLinearGradient(0, 20, 0, h - 20);
  tg.addColorStop(0, '#fff27a'); tg.addColorStop(1, '#ff9b1f');
  g.fillStyle = tg; g.fillText(text, w / 2, h / 2 + 4);
  return finish(c, { aniso, repeat: false });
}

// Corner warning sign: white chevrons on red pointing RIGHT. A board rotated
// 180° about its normal shows the arrows pointing left.
export function createTurnSignTexture({ aniso = 1 } = {}) {
  const w = 256, h = 128;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#e3241c'; g.fillRect(8, 8, w - 16, h - 16);
  g.fillStyle = '#ffffff';
  for (let k = 0; k < 3; k++) {
    const x = 34 + k * 66;
    g.beginPath();
    g.moveTo(x, 22); g.lineTo(x + 26, 22); g.lineTo(x + 62, h / 2); g.lineTo(x + 26, h - 22); g.lineTo(x, h - 22); g.lineTo(x + 36, h / 2);
    g.closePath(); g.fill();
  }
  return finish(c, { aniso, repeat: false });
}

// Tileable water normal map (linear data). Built from integer-frequency sine
// sums + tile noise so it repeats seamlessly. b channel carries a foam mask.
export function createWaterNormalTexture({ size = 256, seed = 71 } = {}) {
  const rng = makeRng(seed);
  const hgt = new Float32Array(size * size);
  const n = tileFbm(size, 8, 4, rng, 0.55);
  const waves = [];
  for (let k = 0; k < 7; k++) waves.push({ fx: Math.floor(rng() * 7) - 3, fy: 1 + Math.floor(rng() * 5), ph: rng() * Math.PI * 2, a: 0.3 + rng() * 0.6 });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = n[y * size + x] * 1.4;
    for (const w of waves) v += Math.sin(((x * w.fx + y * w.fy) / size) * Math.PI * 2 + w.ph) * w.a * 0.25;
    hgt[y * size + x] = v;
  }
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size), d = img.data;
  const foam = tileFbm(size, 16, 3, rng, 0.5);
  const k = 2.4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const xl = hgt[y * size + ((x - 1 + size) % size)], xr = hgt[y * size + ((x + 1) % size)];
    const yu = hgt[((y - 1 + size) % size) * size + x], yd = hgt[((y + 1) % size) * size + x];
    let nx = (xl - xr) * k, ny = (yu - yd) * k, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * size + x) * 4;
    d[i] = (nx * 0.5 + 0.5) * 255;
    d[i + 1] = (ny * 0.5 + 0.5) * 255;
    d[i + 2] = foam[y * size + x] * 255;   // foam/noise mask (not z: shader rebuilds z)
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, { srgb: false });
}
