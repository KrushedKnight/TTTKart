// Chase camera with intro flyover, orbit and look-back modes (SPEC §6).
//
//   const cam = new ChaseCamera(perspectiveCamera);
//   cam.setTarget(playerKart);
//   cam.startIntro(track, 4);      // sweeping flyover ending behind the target
//   cam.update(dt);                // every frame
//
// The chase rig follows a damped heading that blends the kart's velocity
// direction with its nose, so drifts swing the view. The offset is applied in
// the kart's frame (no speed-dependent lag), height is damped separately so
// bumps and jumps feel weighty, FOV kicks out while boosting and short shakes
// play on wall hits / hard landings.

import * as THREE from 'three';
import { bus } from './bus.js';
import { clamp, damp, dampAngle, angleDiff, smoothstep, lerp } from './utils.js';

const CHASE = {
  distance: 5.6,          // a touch closer than SPEC's ~6.5 m so the kart has screen presence
  height: 2.3,
  lookAhead: 3.2,
  lookHeight: 1.05,
  headingRate: 5.5,       // 1/s heading follow
  velocityBlend: 0.7,     // 0 = follow nose, 1 = follow velocity direction
  heightRate: 7,
  baseFov: 70,
  boostFov: 82,
  starFov: 78,
  speedFov: 4,            // extra FOV at top speed
  fovRate: 4,
  minClearance: 1.0,      // camera stays this far above the road
};

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.target = null;
    this.track = null;
    this.lookBack = false;
    this.params = { ...CHASE };

    this.heading = 0;
    this.camY = 0;
    this.fov = CHASE.baseFov;
    this.shakeAmt = 0;
    this.shakeT = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this._proj = {};
    this._hint = -1;
    this._intro = null;
    this._orbitAngle = 0;
    this._initialized = false;

    // Shake on the target's wall hits / big landings / hits.
    this._offs = [
      bus.on('kart:wallHit', (e) => { if (e.kart === this.target) this.shake(0.22 * (e.intensity || 0.5)); }),
      bus.on('kart:land', (e) => { if (e.kart === this.target) this.shake(Math.min(0.2, 0.12 * (e.airTime || 0))); }),
      bus.on('kart:tumble', (e) => { if (e.kart === this.target) this.shake(0.25); }),
      bus.on('kart:bump', (e) => { if (e.a === this.target || e.b === this.target) this.shake(0.12 * (e.intensity || 0.5)); }),
    ];
  }

  setTarget(kart) {
    this.target = kart;
    if (kart && kart.track) this.track = kart.track;
    this._hint = -1;
    if (!this._initialized && kart) this.snap();
  }

  shake(amount) { this.shakeAmt = Math.max(this.shakeAmt, amount); }

  // Desired chase heading for the target.
  _targetHeading() {
    const k = this.target;
    const v = k.velocity;
    const hs = Math.hypot(v.x, v.z);
    const fwdSpeed = v.x * Math.sin(k.yaw) + v.z * Math.cos(k.yaw);
    if (hs < 2 || fwdSpeed < 0.5) return k.yaw;
    const velYaw = Math.atan2(v.x, v.z);
    const w = this.params.velocityBlend * smoothstep((hs - 2) / 6);
    return k.yaw + angleDiff(k.yaw, velYaw) * w;
  }

  // Ideal chase pose for the current heading (writes pos/look outputs).
  _chasePose(heading, outPos, outLook, camY = null) {
    const k = this.target, P = this.params;
    const back = this.lookBack && this.mode === 'chase';
    const h = back ? heading + Math.PI : heading;
    const fx = Math.sin(h), fz = Math.cos(h);
    const dist = back ? P.distance * 0.92 : P.distance;
    outPos.set(k.position.x - fx * dist, camY !== null ? camY : k.position.y + P.height, k.position.z - fz * dist);
    outLook.set(k.position.x + fx * P.lookAhead, k.position.y + P.lookHeight, k.position.z + fz * P.lookAhead);
  }

  // Jump to the ideal chase pose immediately (cancels an intro in progress).
  snap() {
    const k = this.target;
    if (!k) return;
    this._initialized = true;
    if (this.mode === 'intro') { this._intro = null; this.mode = 'chase'; }
    this.heading = k.yaw;
    this.camY = k.position.y + this.params.height;
    this.fov = this.params.baseFov;
    this._chasePose(this.heading, this.pos, this.look);
    this._applyCamera(0);
  }

  // Sweeping flyover: high overview -> down the start straight -> behind the
  // target's grid slot. Ends exactly on the chase pose, then hands over.
  startIntro(track, duration = 4) {
    this.track = track || this.track;
    const tr = this.track;
    if (!tr || !this.target) { this.snap(); return; }
    const k = this.target;
    const b = tr.bounds;
    const center = new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const start = tr.frameAt(0);
    // final pose (chase, using kart yaw)
    const endPos = new THREE.Vector3(), endLook = new THREE.Vector3();
    this.heading = k.yaw;
    this._chasePose(k.yaw, endPos, endLook);
    const sKart = k.proj && isFinite(k.proj.s) ? k.proj.s : tr.wrapS(-20);
    const lateralSide = k.proj && k.proj.lateral < 0 ? -1 : 1;
    // control points
    const toStart = new THREE.Vector3().subVectors(start.position, center).setY(0).normalize();
    const p0 = center.clone().addScaledVector(toStart, span * 0.2).add(new THREE.Vector3(0, span * 0.42, 0));
    const p1 = tr.pointAt(115, -20 * lateralSide).add(new THREE.Vector3(0, 32, 0));
    const p2 = tr.pointAt(40, 12 * lateralSide).add(new THREE.Vector3(0, 10, 0));
    const p3 = tr.pointAt(sKart + 18, 6 * lateralSide).add(new THREE.Vector3(0, 4, 0));
    const l0 = center.clone().add(new THREE.Vector3(0, 0, 0));
    const l1 = tr.pointAt(10, 0);
    const l2 = k.position.clone().add(new THREE.Vector3(0, 0.8, 0));
    const l3 = l2.clone();
    this._intro = {
      t: 0,
      duration: Math.max(0.5, duration),
      path: new THREE.CatmullRomCurve3([p0, p1, p2, p3, endPos.clone()], false, 'centripetal', 0.5),
      lookPath: new THREE.CatmullRomCurve3([l0, l1, l2, l3, endLook.clone()], false, 'centripetal', 0.5),
      fov0: 58,
    };
    this.mode = 'intro';
    this._initialized = true;
    this._updateIntro(0);
  }

  // Slow orbit around the target (after finishing).
  startOrbit() {
    if (!this.target) return;
    const k = this.target;
    this._orbitAngle = Math.atan2(this.pos.x - k.position.x, this.pos.z - k.position.z);
    if (!isFinite(this._orbitAngle)) this._orbitAngle = k.yaw + Math.PI;
    this.mode = 'orbit';
  }

  _updateIntro(dt) {
    const I = this._intro;
    I.t += dt;
    const u = clamp(I.t / I.duration, 0, 1);
    // ease: linger on the overview, glide down, settle softly
    const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    I.path.getPointAt(e, this.pos);
    I.lookPath.getPointAt(Math.min(1, e * 1.05), this.look);
    // the target may have been re-placed; keep the last segment glued to it
    if (u > 0.75) {
      const endPos = _v, endLook = _fwd;
      this._chasePose(this.target.yaw, endPos, endLook);
      const w = smoothstep((u - 0.75) / 0.25);
      this.pos.lerp(endPos, w);
      this.look.lerp(endLook, w);
    }
    this.fov = lerp(I.fov0, this.params.baseFov, smoothstep(u));
    if (u >= 1) {
      this.mode = 'chase';
      this._intro = null;
      this.heading = this.target.yaw;
      this.camY = this.pos.y;
    }
  }

  get introProgress() { return this._intro ? clamp(this._intro.t / this._intro.duration, 0, 1) : 1; }

  update(dt) {
    if (!(dt >= 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    if (this.mode === 'free') return;
    const k = this.target;
    if (!k) return;
    const P = this.params;

    if (this.mode === 'intro' && this._intro) {
      this._updateIntro(dt);
    } else if (this.mode === 'orbit') {
      this._orbitAngle += dt * 0.35;
      const r = 7.5;
      this.pos.set(k.position.x + Math.sin(this._orbitAngle) * r, k.position.y + 2.6, k.position.z + Math.cos(this._orbitAngle) * r);
      this.look.set(k.position.x, k.position.y + 0.9, k.position.z);
      this.fov = damp(this.fov, 60, 2, dt);
    } else {
      this.mode = 'chase';
      // heading + look-back
      this.heading = dampAngle(this.heading, this._targetHeading(), P.headingRate, dt);
      // height: damped, but never too far from the kart (big jumps)
      const wantY = k.position.y + P.height;
      this.camY = damp(this.camY, wantY, P.heightRate, dt);
      this.camY = clamp(this.camY, wantY - 1.6, wantY + 1.6);
      this._chasePose(this.heading, this.pos, this.look, this.camY);
      // FOV: boost / star kick + a little speed feel
      const top = k.stats ? k.stats.topSpeed : 30;
      const sp = clamp(Math.abs(k.speed) / top, 0, 1.4);
      let fov = P.baseFov + P.speedFov * sp;
      if (k.boostTimer > 0) fov = Math.max(fov, P.boostFov);
      if (k.starTimer > 0) fov = Math.max(fov, P.starFov);
      this.fov = damp(this.fov, fov, P.fovRate, dt);
    }

    // never below the road surface
    if (this.track) {
      this.track.project(this.pos, this._hint, this._proj);
      this._hint = this._proj.index;
      const minY = this._proj.height + P.minClearance;
      if (this.pos.y < minY) { this.pos.y = minY; if (this.mode === 'chase') this.camY = Math.max(this.camY, minY); }
    }
    this._applyCamera(dt);
  }

  _applyCamera(dt) {
    const cam = this.camera;
    cam.position.copy(this.pos);
    // shake: smooth pseudo-noise offsets, decaying
    if (this.shakeAmt > 0.001) {
      this.shakeT += dt;
      const t = this.shakeT * 38;
      const a = this.shakeAmt;
      cam.position.x += (Math.sin(t * 1.3) + Math.sin(t * 2.9 + 1.7) * 0.5) * a * 0.5;
      cam.position.y += (Math.sin(t * 1.7 + 0.5) + Math.sin(t * 3.3) * 0.5) * a * 0.5;
      cam.position.z += Math.sin(t * 2.1 + 2.2) * a * 0.3;
      this.shakeAmt *= Math.exp(-7 * dt);
    } else {
      this.shakeAmt = 0;
    }
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs = [];
  }
}
