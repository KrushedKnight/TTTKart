// Pooled particle effects. Two THREE.Points pools (additive glow + normal
// alpha blended) driven by one custom ShaderMaterial each, so every particle
// in the game costs exactly two draw calls total.
//
// Per-particle attributes: color, alpha, size (world meters, perspective
// scaled), velocity + stretch (motion-streaked sparks are drawn as ellipses
// along their screen-space velocity *relative to the camera*, still inside a
// single point sprite, so sparks streak correctly under a moving chase cam).
//
//   const fx = new Effects(scene);
//   fx.emit('spark', pos, { color: 0x38c8ff, count: 6, velocity, spread: 3 });
//   fx.update(dt, camera);
//
// Types: spark dust grass smoke flame sparkle confetti explosion stink zap splash
// opts: { color (hex | '#css' | THREE.Color | 'rainbow' | 'grass'), count,
//         velocity (Vector3), spread (m/s random velocity), size (m), life (s),
//         radius (spawn jitter, m), alpha (0..1) }
// extra opts: { from (Vector3: spawn spread evenly along from→position, for
//         continuous trails from fast emitters), color2 (end color), gravity,
//         drag, stretch }

import * as THREE from 'three';

// Per-type defaults. color2 = end-of-life color (defaults to color); hot =
// fraction the birth color is pushed toward white; sub = extra particles
// spawned with each emit: [type, count fraction, inherit color, spread mult].
const TYPES = {
  spark:     { pool: 'add', count: 6, life: 0.32, size: 0.12, sizeEnd: 0.03, speed: 5, gravity: 16, drag: 1.6, stretch: 0.045, color: 0xffd36b, color2: 0xff7a1a, hot: 0.55, radius: 0.05 },
  // fire: an over-bright additive body (intensity > 1 keeps the faded edges a
  // saturated orange instead of a washed-out salmon) + a white-hot core
  flame:     { pool: 'add', count: 4, life: 0.2, size: 0.4, sizeEnd: 0.2, speed: 1.0, gravity: -2, drag: 2.5, color: 0xff9a2a, color2: 0x7a1200, hot: 0.08, intensity: 1.3, fastFade: true, radius: 0.04, sub: [['flamecore', 0.4, true, 0.6]] },
  flamecore: { pool: 'add', count: 3, life: 0.08, size: 0.22, sizeEnd: 0.08, speed: 0.6, gravity: 0, drag: 2.5, color: 0xffeeb0, color2: 0xffa040, hot: 0.2, intensity: 1.0, radius: 0.03 },
  glow:      { pool: 'add', count: 3, life: 0.12, size: 0.45, sizeEnd: 0.15, speed: 0.5, gravity: -1, drag: 2, color: 0xffffff, hot: 0.15, radius: 0.06 },
  sparkle:   { pool: 'add', count: 8, life: 0.6, size: 0.24, sizeEnd: 0.0, speed: 1.5, gravity: -0.6, drag: 2.5, twinkle: true, color: 0xffffff, hot: 0.5, radius: 0.5 },
  zap:       { pool: 'add', count: 14, life: 0.3, size: 0.3, sizeEnd: 0.04, speed: 7, gravity: 0, drag: 6, stretch: 0.04, jitter: 26, color: 0xffffff, color2: 0xffe600, hot: 0.3, radius: 0.4 },
  explosion: { pool: 'add', count: 24, life: 0.55, size: 1.1, sizeEnd: 2.6, speed: 9, gravity: -2, drag: 4, color: 0xfff3b0, color2: 0xff3b10, hot: 0.3, radius: 0.5, sub: [['smoke', 0.6, false, 1.6], ['spark', 1.2, false, 1.6]] },
  dust:      { pool: 'norm', count: 6, life: 0.7, size: 0.45, sizeEnd: 1.4, speed: 1.4, gravity: -0.8, drag: 3, color: 0xe2d2ae, alpha: 0.55, radius: 0.2 },
  grass:     { pool: 'norm', count: 6, life: 0.55, size: 0.15, sizeEnd: 0.1, speed: 3.5, gravity: 15, drag: 1.2, color: 'grass', radius: 0.15 },
  smoke:     { pool: 'norm', count: 6, life: 1.3, size: 0.7, sizeEnd: 2.6, speed: 1.2, gravity: -1.6, drag: 1.8, color: 0x8d8d94, color2: 0x5a5a62, alpha: 0.5, radius: 0.3 },
  confetti:  { pool: 'norm', count: 30, life: 2.2, size: 0.16, sizeEnd: 0.14, speed: 6, gravity: 4, drag: 2.2, flutter: true, color: 'rainbow', radius: 0.5 },
  stink:     { pool: 'norm', count: 6, life: 1.5, size: 0.8, sizeEnd: 2.4, speed: 1.0, gravity: -0.9, drag: 2, color: 0x9be15d, color2: 0x5f8f2e, alpha: 0.5, radius: 0.5 },
  splash:    { pool: 'norm', count: 14, life: 0.8, size: 0.16, sizeEnd: 0.08, speed: 5, upBias: 4, gravity: 18, drag: 0.8, color: 0xeaf8ff, alpha: 0.9, radius: 0.4 },
};

// grass clippings (lighter / yellower than the turf so they read against it) + dirt clods
const GRASS_COLORS = [0xa6e35c, 0xc9ec6e, 0x8fd84f, 0x7a5a32, 0x5e4426, 0xb5e866].map((h) => new THREE.Color(h));

const VERT = /* glsl */`
uniform float uScale;
uniform vec2 uViewport;
uniform vec3 uCamVel;
attribute vec3 aColor;
attribute float aAlpha;
attribute float aSize;
attribute vec3 aVel;
attribute float aStretch;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vDir;
varying float vElong;
#include <fog_pars_vertex>
void main() {
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  float depth = max(0.05, -mvPosition.z);
  // fade out particles right in front of the lens (a rival's exhaust between the
  // chase camera and the player otherwise blooms into big additive blobs)
  vAlpha = aAlpha * smoothstep(1.2, 4.0, depth);
  float px = max(aSize * uScale / depth, 0.0);
  // Pull the sprite toward the camera along its view ray by half its size:
  // same screen position and size, but it is no longer cut in half by the
  // ground / tire it is sitting on.
  float pull = min(aSize * 0.5, max(0.0, depth - 0.2));
  if (pull > 0.0) mvPosition.xyz -= normalize(mvPosition.xyz) * pull;
  vec4 clip = projectionMatrix * mvPosition;
  vDir = vec2(1.0, 0.0);
  vElong = 1.0;
  if (aStretch > 0.0 && px > 0.0) {
    // streak tail = where the particle was aStretch seconds ago, as seen by
    // a camera that was moving with uCamVel (true motion blur direction)
    vec4 mv2 = modelViewMatrix * vec4(position - (aVel - uCamVel) * aStretch, 1.0);
    if (-mv2.z > 0.05 && clip.w > 0.0) {
      vec4 c2 = projectionMatrix * mv2;
      vec2 a = clip.xy / clip.w;
      vec2 b = c2.xy / c2.w;
      vec2 dpx = (b - a) * 0.5 * uViewport;
      float len = length(dpx);
      if (len > 0.75) {
        vDir = dpx / len;
        len = min(len, 140.0);
        // sprite centered halfway along the streak
        clip.xy += vDir * len * 0.5 * 2.0 / uViewport * clip.w;
        float total = len + px;
        vElong = total / px;
        px = total;
      }
    }
  }
  gl_PointSize = clamp(px, 0.0, 400.0);
  gl_Position = clip;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
uniform float uAdditive;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vDir;
varying float vElong;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y = -p.y;
  vec2 q = vec2(dot(p, vDir), dot(p, vec2(-vDir.y, vDir.x)) * vElong);
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float a = 1.0 - r2;
  a *= a;
  vec3 col = vColor;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #else
    float fogFactor = 0.0;
  #endif
  float alpha = a * vAlpha;
  if (uAdditive > 0.5) {
    alpha *= 1.0 - fogFactor;
  } else {
    #ifdef USE_FOG
      col = mix(col, fogColor, fogFactor);
    #endif
  }
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// One pool = one THREE.Points + struct-of-arrays particle state. Alive
// particles are kept dense in [0, count) (swap-remove), so updates and the
// GPU upload only touch live data.
class Pool {
  constructor(scene, capacity, additive, camVel) {
    this.capacity = capacity;
    this.count = 0;
    this.additive = additive;
    const n = capacity;
    // simulation state
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.age = new Float32Array(n); this.life = new Float32Array(n);
    this.s0 = new Float32Array(n); this.s1 = new Float32Array(n);
    this.c0 = new Float32Array(n * 3); this.c1 = new Float32Array(n * 3);
    this.a0 = new Float32Array(n);
    this.grav = new Float32Array(n); this.drag = new Float32Array(n);
    this.stretch = new Float32Array(n);
    this.flags = new Uint8Array(n);      // 1 twinkle, 2 flutter, 4 jitter, 8 fast fade
    this.jit = new Float32Array(n);
    this.seed = new Float32Array(n);
    // GPU buffers
    this.gPos = new Float32Array(n * 3);
    this.gCol = new Float32Array(n * 3);
    this.gAlpha = new Float32Array(n);
    this.gSize = new Float32Array(n);
    this.gVel = new Float32Array(n * 3);
    this.gStretch = new Float32Array(n);
    const geo = new THREE.BufferGeometry();
    const attr = (arr, size) => { const a = new THREE.BufferAttribute(arr, size); a.setUsage(THREE.DynamicDrawUsage); return a; };
    geo.setAttribute('position', attr(this.gPos, 3));
    geo.setAttribute('aColor', attr(this.gCol, 3));
    geo.setAttribute('aAlpha', attr(this.gAlpha, 1));
    geo.setAttribute('aSize', attr(this.gSize, 1));
    geo.setAttribute('aVel', attr(this.gVel, 3));
    geo.setAttribute('aStretch', attr(this.gStretch, 1));
    geo.setDrawRange(0, 0);
    this.geometry = geo;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uScale: { value: 600 }, uViewport: { value: new THREE.Vector2(1280, 720) }, uAdditive: { value: additive ? 1 : 0 } },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
      // particle colors are picked as display colors: skip ACES (it would
      // darken/desaturate fire and dust)
      toneMapped: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    // shared (not cloned) so both pools see the same camera velocity
    this.material.uniforms.uCamVel = { value: camVel };
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 11 : 10;
    this.points.name = additive ? 'fx-additive' : 'fx-normal';
    const uniforms = this.material.uniforms;
    const vp = new THREE.Vector2();
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(vp);
      uniforms.uViewport.value.copy(vp);
      const fov = camera.isPerspectiveCamera ? camera.fov : 60;
      const zoom = camera.zoom || 1;
      uniforms.uScale.value = (vp.y * zoom) / (2 * Math.tan((fov * Math.PI) / 360));
    };
    scene.add(this.points);
  }

  // Returns the index of a fresh particle, or -1 when the pool is full.
  alloc() {
    if (this.count >= this.capacity) return -1;
    return this.count++;
  }

  kill(i) {
    const j = --this.count;
    if (i === j) return;
    this.px[i] = this.px[j]; this.py[i] = this.py[j]; this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
    this.age[i] = this.age[j]; this.life[i] = this.life[j];
    this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j];
    const i3 = i * 3, j3 = j * 3;
    this.c0[i3] = this.c0[j3]; this.c0[i3 + 1] = this.c0[j3 + 1]; this.c0[i3 + 2] = this.c0[j3 + 2];
    this.c1[i3] = this.c1[j3]; this.c1[i3 + 1] = this.c1[j3 + 1]; this.c1[i3 + 2] = this.c1[j3 + 2];
    this.a0[i] = this.a0[j]; this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j];
    this.stretch[i] = this.stretch[j]; this.flags[i] = this.flags[j];
    this.jit[i] = this.jit[j]; this.seed[i] = this.seed[j];
  }

  update(dt) {
    let i = 0;
    const gPos = this.gPos, gCol = this.gCol, gVel = this.gVel;
    while (i < this.count) {
      const age = this.age[i] + dt;
      const life = this.life[i];
      if (age >= life) { this.kill(i); continue; }
      this.age[i] = age;
      const dk = Math.exp(-this.drag[i] * dt);
      let vx = this.vx[i] * dk, vy = this.vy[i] * dk - this.grav[i] * dt, vz = this.vz[i] * dk;
      const fl = this.flags[i];
      if (fl & 2) {
        // confetti flutter: sideways sway + capped fall speed
        const ph = age * 7 + this.seed[i] * 6.283;
        vx += Math.sin(ph) * 7 * dt;
        vz += Math.cos(ph * 0.8) * 7 * dt;
        if (vy < -2.2) vy = -2.2;
      }
      if (fl & 4) {
        const j = this.jit[i] * dt;
        vx += (Math.random() - 0.5) * j; vy += (Math.random() - 0.5) * j; vz += (Math.random() - 0.5) * j;
      }
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      const x = (this.px[i] += vx * dt);
      const y = (this.py[i] += vy * dt);
      const z = (this.pz[i] += vz * dt);
      const u = age / life;
      let size = this.s0[i] + (this.s1[i] - this.s0[i]) * u;
      if (fl & 1) size *= 0.55 + 0.45 * Math.sin(age * 26 + this.seed[i] * 40);
      // fade in quickly, fade out over life
      const fade = Math.min(1, age * 30) * (fl & 8 ? (1 - u) * (1 - u) : this.additive ? (1 - u) : (1 - u * u));
      const i3 = i * 3;
      gPos[i3] = x; gPos[i3 + 1] = y; gPos[i3 + 2] = z;
      gCol[i3] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * u;
      gCol[i3 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * u;
      gCol[i3 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * u;
      gVel[i3] = vx; gVel[i3 + 1] = vy; gVel[i3 + 2] = vz;
      this.gAlpha[i] = this.a0[i] * fade;
      this.gSize[i] = size > 0 ? size : 0;
      this.gStretch[i] = this.stretch[i];
      i++;
    }
    const n = this.count;
    const geo = this.geometry;
    geo.setDrawRange(0, n);
    if (n > 0) {
      for (const name of ['position', 'aColor', 'aAlpha', 'aSize', 'aVel', 'aStretch']) {
        const a = geo.attributes[name];
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    }
  }

  dispose(scene) {
    scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);

function toColor(value, out) {
  if (value && value.isColor) return out.copy(value);
  return out.set(value);
}

export class Effects {
  constructor(scene, { capacityAdd = 3000, capacityNorm = 2000 } = {}) {
    this.scene = scene;
    this.camVel = new THREE.Vector3();        // smoothed camera velocity (motion streaks)
    this._camPrev = new THREE.Vector3();
    this._camNow = new THREE.Vector3();
    this._camValid = false;
    this.add = new Pool(scene, capacityAdd, true, this.camVel);
    this.norm = new Pool(scene, capacityNorm, false, this.camVel);
    this.enabled = true;
    this.intensity = 1;          // global emission multiplier (quality setting)
    // reused option object for sub-emitters (no allocations per emit)
    this._subOpts = { count: 0, velocity: null, from: null, radius: null, spread: null, size: null, color: null, color2: null, drag: null, _sub: true };
    this._subColor = new THREE.Color();
  }

  get count() { return this.add.count + this.norm.count; }
  get capacity() { return this.add.capacity + this.norm.capacity; }

  emit(type, position, opts = {}) {
    const def = TYPES[type];
    if (!def || !this.enabled || !position) return;
    const pool = def.pool === 'add' ? this.add : this.norm;
    let n = opts.count != null ? opts.count : def.count;
    n = Math.round(n * this.intensity);
    if (!(n > 0)) return;
    const radius = opts.radius != null ? opts.radius : def.radius;
    const spread = opts.spread != null ? opts.spread : def.speed;
    const baseLife = opts.life != null ? opts.life : def.life;
    const baseSize = opts.size != null ? opts.size : def.size;
    const endRatio = def.size > 0 ? def.sizeEnd / def.size : 1;
    const alpha = opts.alpha != null ? opts.alpha : def.alpha != null ? def.alpha : 1;
    const gravity = opts.gravity != null ? opts.gravity : def.gravity;
    const drag = opts.drag != null ? opts.drag : def.drag;
    const stretch = opts.stretch != null ? opts.stretch : def.stretch || 0;
    const hot = opts.hot != null ? opts.hot : def.hot || 0;
    const inten = opts.intensity != null ? opts.intensity : def.intensity || 1;
    const vel = opts.velocity;
    const from = opts.from;
    const colorOpt = opts.color != null ? opts.color : def.color;
    const flags = (def.twinkle ? 1 : 0) | (def.flutter ? 2 : 0) | (def.jitter ? 4 : 0) | (def.fastFade ? 8 : 0);
    for (let k = 0; k < n; k++) {
      const i = pool.alloc();
      if (i < 0) break;
      // base point: the emitter position, or spread along from -> position
      let bx = position.x, by = position.y, bz = position.z;
      if (from) {
        const t = (k + Math.random()) / n;
        bx = from.x + (bx - from.x) * t; by = from.y + (by - from.y) * t; bz = from.z + (bz - from.z) * t;
      }
      // position jitter in a sphere
      let rx = Math.random() * 2 - 1, ry = Math.random() * 2 - 1, rz = Math.random() * 2 - 1;
      const rl = Math.hypot(rx, ry, rz) || 1;
      const rr = Math.cbrt(Math.random()) * radius / rl;
      pool.px[i] = bx + rx * rr;
      pool.py[i] = by + ry * rr;
      pool.pz[i] = bz + rz * rr;
      // random direction velocity
      let dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
      const dl = Math.hypot(dx, dy, dz) || 1;
      const sp = spread * (0.35 + 0.65 * Math.random()) / dl;
      pool.vx[i] = dx * sp + (vel ? vel.x : 0);
      pool.vy[i] = dy * sp + (vel ? vel.y : 0) + (def.upBias || 0) * (0.6 + 0.4 * Math.random());
      pool.vz[i] = dz * sp + (vel ? vel.z : 0);
      pool.age[i] = 0;
      pool.life[i] = baseLife * (0.7 + 0.6 * Math.random());
      const s = baseSize * (0.75 + 0.5 * Math.random());
      pool.s0[i] = s;
      pool.s1[i] = s * endRatio;
      // colors (linear)
      if (colorOpt === 'rainbow') {
        _c.setHSL(Math.random(), 0.95, 0.6);
        _c2.copy(_c);
      } else if (colorOpt === 'grass') {
        _c.copy(GRASS_COLORS[(Math.random() * GRASS_COLORS.length) | 0]);
        _c2.copy(_c).multiplyScalar(0.8);
      } else {
        toColor(colorOpt, _c);
        if (opts.color2 != null) toColor(opts.color2, _c2);
        else if (opts.color != null) _c2.copy(_c).multiplyScalar(def.pool === 'add' ? 0.75 : 0.85);
        else if (def.color2 != null) _c2.set(def.color2);
        else _c2.copy(_c);
        if (hot > 0) _c.lerp(_white, hot);
      }
      if (inten !== 1) { _c.multiplyScalar(inten); _c2.multiplyScalar(inten); }
      const i3 = i * 3;
      pool.c0[i3] = _c.r; pool.c0[i3 + 1] = _c.g; pool.c0[i3 + 2] = _c.b;
      pool.c1[i3] = _c2.r; pool.c1[i3 + 1] = _c2.g; pool.c1[i3 + 2] = _c2.b;
      pool.a0[i] = alpha;
      pool.grav[i] = gravity;
      pool.drag[i] = drag;
      pool.stretch[i] = stretch;
      pool.flags[i] = flags;
      pool.jit[i] = def.jitter || 0;
      pool.seed[i] = Math.random();
    }
    if (def.sub && !opts._sub) {
      const sizeScale = opts.size != null && def.size > 0 ? opts.size / def.size : 1;
      const spreadScale = opts.spread != null && def.speed > 0 ? opts.spread / def.speed : 1;
      const so = this._subOpts;
      for (let s = 0; s < def.sub.length; s++) {
        const [sub, frac, inherit, spreadMult] = def.sub[s];
        const sd = TYPES[sub];
        so.count = Math.max(1, Math.round((opts.count != null ? opts.count : def.count) * frac));
        so.velocity = vel || null;
        so.from = from || null;
        so.radius = radius;
        so.spread = sd.speed * (spreadMult || 1) * spreadScale;
        so.size = sd.size * sizeScale;
        so.drag = opts.drag != null ? opts.drag : null;
        so.color = null;
        so.color2 = null;
        if (inherit && opts.color != null && opts.color !== 'rainbow' && opts.color !== 'grass') {
          so.color = toColor(opts.color, this._subColor).lerp(_white, 0.5);
        }
        this.emit(sub, position, so);
      }
    }
  }

  // Same as emit with a larger default count.
  burst(type, position, opts = {}) {
    const def = TYPES[type];
    if (!def) return;
    this.emit(type, position, opts.count != null ? opts : { ...opts, count: def.count * 3 });
  }

  // Advance all particles. `camera` (optional) is tracked so motion streaks
  // are drawn relative to the camera's own movement.
  update(dt, camera = null) {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    if (camera && dt > 0) {
      camera.getWorldPosition(this._camNow);
      if (this._camValid) {
        const inv = 1 / dt;
        const vx = (this._camNow.x - this._camPrev.x) * inv;
        const vy = (this._camNow.y - this._camPrev.y) * inv;
        const vz = (this._camNow.z - this._camPrev.z) * inv;
        if (vx * vx + vy * vy + vz * vz > 120 * 120) this.camVel.set(0, 0, 0);   // camera cut / snap
        else {
          const k = 1 - Math.exp(-18 * dt);
          this.camVel.x += (vx - this.camVel.x) * k;
          this.camVel.y += (vy - this.camVel.y) * k;
          this.camVel.z += (vz - this.camVel.z) * k;
        }
      }
      this._camPrev.copy(this._camNow);
      this._camValid = true;
    } else if (!camera) {
      this.camVel.set(0, 0, 0);
      this._camValid = false;
    }
    this.add.update(dt);
    this.norm.update(dt);
  }

  clear() {
    this.add.count = 0;
    this.norm.count = 0;
    this.add.geometry.setDrawRange(0, 0);
    this.norm.geometry.setDrawRange(0, 0);
    this.camVel.set(0, 0, 0);
    this._camValid = false;
  }

  dispose() {
    this.add.dispose(this.scene);
    this.norm.dispose(this.scene);
  }
}

export const EFFECT_TYPES = Object.keys(TYPES);
