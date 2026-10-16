# TTTKart — Architecture & Module Contracts

A 3D kart racer that runs in the desktop browser (Three.js, no build step) plus a
phone controller page: the phone scans a QR code, connects over the LAN, and
becomes a steering wheel (rotate phone to steer; on-screen GAS / BRAKE / DRIFT /
ITEM buttons).

**All characters, names, items and art are ORIGINAL.** Never use Nintendo (or
any other) IP: no Mario/Luigi/Yoshi/Bowser/etc. names or likenesses, no
"Mushroom", "Green Shell", "Blue Shell", "Bullet Bill", "Rainbow Road". Use the
names defined here.

This document records the original module interfaces and subsequent extensions.
Section 13 describes the current roster, customization system, and in-game title
and supersedes earlier descriptions where they differ. The runtime code is the
source of truth; update affected callers and this reference when interfaces change.

---------------------------------------------------------------------------

## 0. Runtime / tooling

* Node 22.12+ (developed on Node 26); the project root contains this file. `package.json`
  has `"type": "module"` → all `.js` files are ES modules (server too).
* Deps: `express@5`, `socket.io@4`, `qrcode`, `selfsigned@5` (async API:
  `await selfsigned.generate(attrs, opts)`), `three@0.186`. Dev: `puppeteer-core`,
  `socket.io-client`.
* Browser imports use an import map in every HTML page:
  ```html
  <script type="importmap">{"imports":{"three":"/vendor/three/build/three.module.js","three/addons/":"/vendor/three/examples/jsm/"}}</script>
  ```
  Modules import three as `import * as THREE from 'three'` and each other with
  relative paths **including `.js`** (`import { bus } from './bus.js'`). In Node,
  `'three'` resolves to node_modules/three, so the same modules run headless.
* Socket.IO browser client: classic script `<script src="/socket.io/socket.io.js"></script>`
  (exposes `window.io`), loaded before module scripts.
* **Node-safe modules** (must not touch `window`/`document`/`navigator`/canvas at
  import time or in their logic paths): `config.js`, `bus.js`, `utils.js`,
  `track-def.js`, `track.js`, `kart.js`, `ai.js`, `race.js`, `items.js` (when
  constructed with `scene: null`). These power `tools/sim.mjs`, a headless race
  simulation.
* Dev tools (already written):
  * `node tools/devserver.mjs <port>` — static server: `/` → `public/`,
    `/vendor/three/` → `node_modules/three/`. Use a unique port for each running
    instance when opening sandbox pages under `public/dev/`.
  * `node tools/shot.mjs <url> --out file.png --wait 3000 --actions '[...]'` —
    headless Chrome with real GPU WebGL. Prints console logs/errors. View the PNG
    in an image viewer. `--mobile --w 844 --h 390` emulates a landscape phone.
  * `node tools/track-check.mjs` — track sanity checks.
* Install dependencies locally and stop development servers when finished.
  Keep generated screenshots and test artifacts out of commits.

## 1. Module layout

| Path | Purpose |
|---|---|
| `public/js/config.js`, `bus.js`, `utils.js`, `track.js`, `track-def.js` | Shared configuration, events, utilities, and track geometry |
| `server.js`, `public/pad.html`, `public/css/pad.css`, `public/js/pad.js`, `public/js/net.js` | Local server, phone controller, and network protocol |
| `public/js/world.js`, `public/js/textures.js` | Scenery and procedural textures |
| `public/js/kart.js`, `characters.js`, `customize.js`, `kartview.js`, `effects.js`, `camera.js` | Physics, roster, customization, models, effects, and camera |
| `public/js/audio.js`, `input.js`, `hud.js`, `public/css/game.css` | Audio, controls, and race HUD |
| `public/js/items.js`, `ai.js`, `race.js`, `tools/sim.mjs` | Items, CPU drivers, race rules, and simulation |
| `public/index.html`, `public/js/main.js`, `public/js/menus.js`, `public/css/menus.css` | Application state, menus, and race loop |

## 2. Conventions

* Y up, meters, seconds, radians. Track ≈ 978 m loop, laps take ~35–40 s.
* **Heading**: `forward = (sin yaw, 0, cos yaw)`, `right = (-cos yaw, 0, sin yaw)`.
  Increasing yaw turns LEFT; a right turn decreases yaw. `object.rotation.y = yaw`
  makes a model built facing **+Z** face forward. All kart/character models are
  built facing +Z with origin at ground level, centered.
* `steer` input ∈ [-1, 1], **+1 = steer RIGHT**.
* Track coordinates: `s` = arc length from start line in [0, L); `lateral` =
  signed horizontal offset from centerline, **+ = right** of driving direction.
* Colors: hex numbers (0xff3344) in three code, CSS strings in DOM code.
* Use `bus` (bus.js) for cross-module notifications (catalog in §9). Anything that
  subscribes must keep the unsubscribe fns and call them in `dispose()`.
* Performance budget (whole game, 1080p laptop iGPU at 60 fps): ≤ 250 draw calls,
  ≤ 400k triangles, one shadow-casting directional light (2048 map) that follows
  the player, no per-frame allocations in hot paths (reuse Vector3s), no
  per-frame DOM layout thrash (update text only when it changes).

## 3. Track — `track.js` (written) + `track-def.js`

```js
import { Track, getTrack, CURB_WIDTH } from './track.js';
const track = getTrack();          // shared instance (or new Track())
track.length; track.N; track.spacing;          // ~978 m, 978 samples, ~1 m
track.samples[i] = { index, s, pos: Vector3, tangent: Vector3 (horizontal unit),
  right: Vector3, yaw, halfWidth, wallL, wallR, curvature (+ = right turn, 1/m), slope };
// typed arrays: px py pz tx tz rx rz hw wl wr curv slope yawArr racingLine
track.project(pos, hint = -1, out = {}) → out:
  { index (use as next hint), f, s, lateral, height (road y incl. ramps),
    centerY, halfWidth, wallL, wallR, curvature, slope, yaw,
    tangent: Vector3, right: Vector3, surface: 'road'|'boost'|'curb'|'offroad',
    onRamp: bool, boostPad: pad|null }
track.pointAt(s, lateral = 0, out?) → Vector3 (road surface point incl. ramps)
track.frameAt(s, out?) → { index, s, x, y, z, position, tangent, right, yaw,
                           halfWidth, wallL, wallR, curvature, slope, racingLine }
track.wrapS(s); track.deltaS(a, b) /* signed shortest b-a */; track.forwardDistance(a, b)
track.gridSlot(i) → { position: Vector3, yaw, s, lateral }   // i = 0 pole … 7
track.racingLine   // Float32Array lateral offset per sample (inside-cutting line)
track.itemBoxes    // [{ row, s, lateral, position: Vector3 (road surface) }]
track.itemRows     // [{ s, boxes }]
track.boostPads    // [{ s0, s1, length, width, lateral, lat0, lat1, center: Vector3, yaw }]
track.ramps        // [{ s0, s1, length, height, fullWidth, lat0, lat1 }]  (kicker: height rises linearly s0→s1 then drops to 0)
track.zones        // [{ type: 'bridge'|'hill'|'hairpin'|'cliff', s0, s1 }]
track.segments     // def segments + { index, s0, s1 }
track.bounds       // { minX, maxX, minZ, maxZ, minY, maxY } (incl. walls)
track.startLine    // { s: 0, position, yaw, halfWidth }
```
Lateral layout at any s: road `|lateral| ≤ halfWidth`; curb strip
`halfWidth < |lat| ≤ halfWidth + CURB_WIDTH(1.0)`; grass (`offroad`) out to the
wall; walls at `lateral = -wallL` (left) and `lateral = +wallR` (right). Karts can
never pass walls, so the drivable area is exactly between them. The off-road
surface is at the same height as the road at that s.

## 4. Characters — `characters.js`

Eight original characters, all selectable, all appear in every race (player +
7 CPU). Ratings are 1–5.

| id | name | look | speed | accel | handling | weight |
|---|---|---|---|---|---|---|
| `blaze` | Blaze | orange fox, pointy ears, white muzzle, bushy tail | 3 | 3 | 4 | 3 |
| `bolt` | Bolt | chunky silver/blue robot, antenna, glowing visor | 4 | 2 | 3 | 5 |
| `pip` | Pip | small penguin, black/white, orange beak, scarf | 2 | 5 | 4 | 1 |
| `duke` | Duke | big brown bear, round ears, aviator goggles | 5 | 1 | 2 | 5 |
| `nova` | Nova | astronaut kid, purple suit, bubble helmet | 3 | 4 | 4 | 2 |
| `gus` | Gus | green frog, big eyes on top, wide mouth | 2 | 4 | 5 | 2 |
| `mochi` | Mochi | white cat, pink ears, bell collar | 3 | 4 | 3 | 2 |
| `ziggy` | Ziggy | teal alien, three eyes, antenna bobbles | 4 | 3 | 2 | 3 |

```js
export const CHARACTERS = [ { id, name, color /*0xRRGGBB primary*/, accent, cssColor /*'#rrggbb'*/,
  ratings: { speed, accel, handling, weight }, tagline } , ... ];   // order as in the table
export function getCharacter(id) → def
export function statsFromRatings(ratings) → { topSpeed, accel, turnRate, mass }  // uses config KART.*Base/PerStar
export function buildKartModel(def, { lod = 'high' } = {}) → THREE.Group
   // faces +Z, origin at ground center, ~2.2 m long, ~1.5 m wide, ~1.5 m tall with driver.
   // group.userData = { body: Object3D (chassis, tilts/rolls), driver: Object3D, head: Object3D,
   //   wheels: { fl, fr, rl, rr } (Object3D, spin around local X), steerPivots: { fl, fr } (rotate Y),
   //   exhausts: [Object3D] (world positions for boost flames), rearWheelL/R refs for sparks,
   //   tintMaterials: [Material] (for star rainbow tint) }
   // All meshes castShadow = true. Low-poly primitives (Box/Sphere/Cylinder/Cone/Capsule/Torus).
```

## 5. Kart physics — `kart.js` (node-safe)

```js
export class Kart {
  constructor({ id, character /*def*/, track, isPlayer = false })
  id; character; isPlayer; track;
  stats;                          // statsFromRatings(character.ratings)
  position: THREE.Vector3; yaw; velocity: THREE.Vector3 /* world m/s; y = vertical */;
  grounded; airTime;
  input = { steer: 0, throttle: 0, brake: 0, drift: false, useItem: false };
  proj = {};                      // last track.project() result (reused object)
  hint = -1;                      // track index hint
  // read-only-ish state for views/AI/HUD:
  get speed()                     // signed forward speed (m/s)
  get maxSpeed()                  // current effective max (after surface/boost/zap)
  drift = { active, dir /*-1 left, +1 right*/, charge /*s*/, tier /*0..3*/, hopping };
  boostTimer; starTimer; spinTimer; tumbleTimer; slowTimer; invulnTimer; stallTimer;
  frozen = false;                 // true during intro/countdown: no movement
  speedMult = 1;                  // extra max-speed multiplier (AI difficulty / rubber band)
  surface;                        // proj.surface of current frame
  steerVisual;                    // smoothed steer for front-wheel animation
  // race bookkeeping (written by race.js; initialize in constructor):
  distance = 0; lap = 0; place = 0; finished = false; finishTime = null; lapTimes = [];
  lapStartTime = 0; wrongWay = false;
  // item bookkeeping (written by items.js; initialize in constructor):
  item = null /*item id*/; itemCount = 0; rolling = false; rollTimer = 0; rollItem = null;

  placeOnGrid(slot /*track.gridSlot() result*/)   // set pos/yaw, zero velocity, reset states
  update(dt)                      // one physics substep using this.input
  applyBoost(duration, source = 'item')   // stacks to max(remaining, duration); emits kart:boost
  spinOut(cause = 'banana')       // returns false if invincible/invuln; else spin HIT.spinDuration
  tumble(cause = 'rocket')        // shells/rockets/star-ram; HIT.tumbleDuration, little hop
  zap()                           // HIT.zapSpinDuration spin + slowTimer HIT.zapSlowDuration
  startStar(duration = STAR.duration)
  isInvincible()                  // starTimer > 0
  isHittable()                    // !star && invulnTimer <= 0 && spin/tumble not active
  isDisabled()                    // spinning or tumbling (input ignored)
  respawn()                       // put back on the centerline at current s (safety net)
}
export function resolveKartCollisions(karts)   // pairwise circle push-apart + bumps; star rams tumble others
```
Model requirements (tune the feel; these are targets, not exact formulas):

* Velocity model: decompose horizontal velocity into forward (`vF`) and lateral
  (`vR`) components each step. Engine/brake/drag act on `vF`; lateral grip decays
  `vR` quickly (grip ≈ 10/s normal, ≈ 3.5/s while drifting so the kart slides
  outward a bit, ≈ 0.8/s airborne). Bumps/wall impulses add to velocity.
* Acceleration feels snappy: 0→90% top speed in ~2.5 s (accel stat dependent).
  Max speed = stats.topSpeed × surface mult (KART.offroadSpeedMult / curbSpeedMult;
  ignored while boost or star) × KART.boostSpeedMult if boostTimer>0 ×
  KART.starSpeedMult if star × HIT.zapSlowMult if slowTimer>0. If above max
  (e.g. entering grass) decelerate smoothly (~25 m/s²), not instantly.
* Steering: yaw rate = turnRate × steer × speed factor (0 at standstill → 1 by
  ~8 m/s, slightly reduced near top speed). Reversing inverts steering. Target
  minimum non-drift turn radius at top speed ≈ 18–22 m.
* **Drift**: when `input.drift` goes true while grounded with speed ≥
  DRIFT.minSpeed: hop (vy = DRIFT.hopVelocity, emit `kart:hop`). If |steer| > 0.2
  at hop time or on landing, enter drift with dir = sign(steer)
  (`kart:driftStart`). While drifting (button held): the kart always turns
  toward dir; steer modulates tightness (counter-steer = wide, into = tight;
  tight drift radius ≈ 11–13 m at speed); charge += dt (×1.3 when steering into
  the drift); tier rises at DRIFT.tierTimes (`kart:driftTier`). Releasing the
  button: if tier ≥ 1 → applyBoost(DRIFT.boostDurations[tier], 'drift');
  emit `kart:driftEnd` {tier}. Drift cancels (no boost) if speed < 6, on
  spin/tumble, or after >0.6 s airborne. Hop without steering = just a hop.
* Vertical: road height from `track.project(position, hint, proj)`. Snap to the
  road when predicted y ≤ road height; otherwise airborne with KART.gravity.
  While grounded keep `velocity.y` = actual vertical rate (so crests and the
  kicker ramp launch the kart). Emit `kart:land` {airTime} if airTime > 0.25.
* Walls: if lateral > wallR − radius or < −(wallL − radius): clamp back, remove
  the velocity component into the wall, scrub speed proportional to impact angle,
  small bounce; emit `kart:wallHit` {intensity 0..1} (throttle repeats to ≥0.3 s).
* Boost pad: when `proj.surface === 'boost'` → applyBoost(BOOST.padDuration,'pad')
  (re-trigger at most once per 0.5 s).
* Spin: 1 s, input ignored, speed decays to ~30%, yaw unaffected (the view spins
  the model). Tumble: 1.5 s, hop vy ≈ 6, speed decays to ~10%. After either:
  invulnTimer = HIT.invulnAfterHit. Drift cancels; boost cancels.
* Start-of-race stall/boost are triggered by race.js via `stallTimer` (engine
  stalled: no throttle for that time) and `applyBoost(BOOST.startDuration,'start')`.
* `frozen` → velocity zero, position fixed (but still compute proj so height is correct).
* Never produce NaN; clamp dt to ≤ 0.05.

`resolveKartCollisions`: circles of KART.radius (horizontal), only if |Δy| < 1.5.
Push apart weighted by inverse mass; exchange a bump impulse along the normal
(heavier kart pushes lighter more); emit `kart:bump` {a, b, intensity}. If one
kart has a star and the other is hittable → other.tumble('star'), no push on the
star kart.

## 6. Kart view, effects, camera (browser)

```js
// kartview.js
export class KartView {
  constructor(kart, scene, effects)     // builds buildKartModel(kart.character), adds to scene
  update(dt, camera)                    // sync transform & animations from kart state
  dispose()                             // remove from scene, free geometry/materials it owns
  object                                // root THREE.Group
}
```
Visual behaviour: position/yaw from kart; drift slide angle (extra yaw ≈ dir ×
0.35 rad, eased); pitch to track slope, slight roll in turns; wheel spin from
speed; front wheels steer; hop/land squash; spin = model rotates 2 full turns
around Y over spinTimer; tumble = flip around X once while bouncing; star =
rainbow hue cycling on tint materials + sparkle particles; drift sparks from rear
wheels colored by tier (DRIFT.tierColors; tier 0 = small white dust); boost =
flame/exhaust particles + slight FOV kick is done by camera; offroad = grass/dirt
dust; invuln after hit = blink (visible toggling at ~10 Hz); shadow via
castShadow. Character head bobs slightly.

```js
// effects.js — pooled particles, ONE draw call for all (THREE.Points with a custom
// ShaderMaterial: per-particle color, size, alpha; additive or normal blending
// via two pools is fine). Capacity ≥ 3000.
export class Effects {
  constructor(scene)
  emit(type, position, opts = {})   // type: 'spark' | 'dust' | 'grass' | 'smoke' | 'flame' |
                                    //  'sparkle' | 'confetti' | 'explosion' | 'stink' | 'zap' | 'splash'
                                    // opts: { color, count, velocity: Vector3, spread, size, life }
  burst(type, position, opts)       // alias of emit with larger default count
  update(dt, camera)
  clear()
  dispose()
}
```
```js
// camera.js
export class ChaseCamera {
  constructor(camera /*THREE.PerspectiveCamera*/)
  setTarget(kart)
  mode                       // 'chase' | 'intro' | 'orbit' | 'free'
  startIntro(track, duration)   // sweeping flyover ending behind the target kart's grid slot
  startOrbit()               // slow orbit around target (after finishing)
  snap()                     // jump to the ideal chase pose immediately
  lookBack                   // bool: chase camera looks backwards when true
  update(dt)
}
```
Chase: behind & above the kart (~6.5 m back, ~2.6 m up), looks slightly ahead,
yaw follows the kart's *velocity/visual* heading with damping (so drifts swing
the view), FOV 70 → ~82 while boosting, small shake on wall hits / landings.
Never clips under the road (keep camera y ≥ road height + 1).

## 7. World — `world.js`, `textures.js` (browser)

```js
export function buildWorld(scene, track, { renderer, quality = 'high' } = {})
  → { sun: THREE.DirectionalLight, update(dt, focusPosition /*Vector3*/, camera), dispose(),
      itemBoxAnchor?: unused }
```
Must create: sky (gradient dome or shader), fog, hemisphere + sun light (the
sun casts shadows; `update` moves the sun + its shadow camera to follow
`focusPosition` with a ~70 m shadow box), road mesh (textured asphalt, lane
markings), curbs (red/white) along road edges, grass off-road strip to the
walls, walls/barriers at wallL/wallR (tire walls / fences / bridge rails on the
bridge zone), terrain beyond walls (ground, embankments down from elevated
sections, cliffs in the cliff zone), water body under the bridge zone + bay
(animated), the bridge structure, start/finish checkered line + gantry with
banner, starting grid marks, boost pads (animated chevrons, use
`track.boostPads`), kicker ramp wedges (use `track.ramps`; the physics height
rises linearly over the ramp strip then drops), arrow signs on the hairpin,
decorations (instanced trees, rocks, a lighthouse near the hairpin, grandstands
with crowd near the start, flags, hills/mountains in the distance, clouds).
**Item boxes are NOT built here** (items.js owns them). Bright, saturated,
friendly low-poly style. Respect the perf budget (instancing, merged geometry).
Textures: generate with canvas in `textures.js` (asphalt, grass, checker, curb,
dirt, rock, chevron, water normal-ish, item-box "?" not needed). The world module
may tune `track-def.js` (e.g. widths, elevations, pad/ramp/item positions) but
must keep the turtle segment list closed (run `node tools/track-check.mjs`;
closure error must stay < 0.1 m) and keep every API in §3.

## 8. Items, AI, Race (node-safe)

### items.js
```js
export class ItemSystem {
  constructor({ track, karts, scene = null, effects = null, rng = Math.random })
  boxes;        // [{ position: Vector3 (center, ~1.1 m above road), active, respawnTimer, s, lateral }]
  hazards;      // bananas & stink clouds: [{ type, position, owner, radius, life, ... }]
  projectiles;  // bouncers & rockets
  update(dt, race)     // race gives places for roulette odds & rocket targets
  useItem(kart)        // activate held item (no-op if none / rolling)
  rollFor(kart, place) // returns an item id from ITEM_TABLE[place-1] (place 1..8)
  getThreatsNear(kart, radius) → [{ type, position, distance, ahead /*bool*/ }]  // for AI avoidance
  clear()              // remove everything (keep boxes, reactivate them)
  dispose()
}
```
Rules:
* Box pickup: a kart within ITEM.boxRadius of an active box breaks it
  (`item:boxHit`); box respawns after ITEM.boxRespawn. If the kart holds no
  item and isn't rolling, start roulette: `kart.rolling = true`,
  `kart.rollTimer = ITEM.rouletteSeconds` (player) / `aiRouletteSeconds` (CPU),
  result decided at roll start via rollFor (store in `kart.rollItem`), assigned
  to `kart.item`/`kart.itemCount = ITEM_INFO[id].uses` when the timer ends
  (`item:get`). Pressing item during the roll shortens remaining time to ≤ 0.3 s.
* Each substep, for every kart: if `kart.input.useItem` is true → `useItem(kart)`
  and set `kart.input.useItem = false` (pulse consumed). Ignored while disabled.
* `banana`: dropped 2.2 m behind the kart, sits on road (height via project),
  hit → `spinOut('banana')`. Bouncers/rockets destroy bananas.
* `bouncer`: launched forward from the kart front at max(ITEM.bouncerSpeed,
  kartSpeed + 20) m/s along kart heading, follows road height, reflects off walls
  (use track.project lateral vs wallL/wallR), up to bouncerMaxBounces / bouncerLife
  seconds; hit kart → `tumble('bouncer')`. Ignores its shooter for
  ITEM.shooterGrace s.
* `rocket`: targets the kart one place ahead (`race` places). Flies along the
  track (s increasing, lateral easing toward the target's lateral) at
  ITEM.rocketSpeed, then homes directly within rocketHomingRange; hit →
  `tumble('rocket')` + `item:explode`. If user is 1st or no target: flies
  straight like a bouncer without bouncing. Life rocketLife.
* `toot`: `applyBoost(BOOST.tootDuration, 'item')`; `triple_toot`: 3 uses (count
  decrements; the slot keeps the item until count hits 0).
* `stink`: drops a stink cloud 3 m behind: a hazard of radius ITEM.stinkRadius,
  life ITEM.stinkLife; any kart entering (not owner for first 1 s) →
  `spinOut('stink')` once per cloud per kart; slight slow.
* `star`: `startStar()`.
* `zap`: every kart with a better place than the user (and not starred) →
  `zap()`; emit `item:zap`.
* Visuals only when `scene` given: rotating translucent rainbow item boxes with a
  "?" (canvas texture) and a shatter burst; banana mesh; green glossy bouncer
  ball; red rocket with flame trail; green stink cloud (puffy, semi-transparent,
  pulsing); zap flash. All pooled/cheap. Effects via `effects.emit` if given.
* Events: see §9.

### ai.js
```js
export class AIDriver {
  constructor(kart, { track, difficulty = 'normal', skill = 0.7, rng = Math.random, personality = {} })
  update(dt, { karts, items, race, player })   // writes kart.input (steer/throttle/brake/drift/useItem)
}
```
Follows `track.racingLine` + a personal lateral offset (varies slowly over time,
plus avoidance of hazards from `items.getThreatsNear` and other karts), look-ahead
steering (lookahead ~ 6 m + 0.45 × speed), brakes/lifts on sharp curvature,
drifts through long corners (charging tier 1–2 mini-turbos), uses items
smartly (banana/stink when someone is close behind; bouncer when a kart is
straight ahead within ~35 m; rocket when one is ahead; toot on straights; star
immediately; zap when not leading). Difficulty from config DIFFICULTY:
`aiSpeedMult` caps their throttle/top speed (implement by scaling throttle or
via a per-kart `kart.speedMult` field that kart.js multiplies into maxSpeed —
**kart.js must support `kart.speedMult` (default 1)**), rubber banding vs the
player (behind by >60 m → up to +rubberBand, ahead by >60 m → down to
−rubberBand). CPU karts must never get stuck: if speed < 2 m/s for > 2 s while
not disabled/frozen, reverse-and-steer recovery; if still stuck for 5 s →
`kart.respawn()`.

### race.js
```js
export class Race {
  constructor({ track, karts, laps = RACE.laps, player = null })
  state;          // 'intro' | 'countdown' | 'racing' | 'finished'  ('finished' = every kart done or results shown)
  time;           // seconds since GO (0 before)
  countdown;      // seconds remaining in countdown (3 → 0)
  laps;
  standings;      // karts sorted by place (1st first), updated every update()
  playerFinished; // bool
  startIntro()    // state='intro' (karts frozen) for RACE.introSeconds then auto startCountdown()
  startCountdown()// state='countdown' for RACE.countdownSeconds, then GO → 'racing'
  update(dt)      // call AFTER karts move each substep
  getPlace(kart)  // 1..8
  getResults()    // [{ kart, place, time (actual or estimated), finished: bool, bestLap }]
  skipIntro()
}
```
* Grid: race.js does NOT place karts; main places them with `kart.placeOnGrid(track.gridSlot(i))`.
* Karts are `frozen` during intro/countdown; unfrozen at GO (`race:go`).
* Countdown emits `race:countdown` {n:3}, {n:2}, {n:1} at the start of each second.
* Start boost / stall: track each kart's throttle during the countdown. First
  press inside RACE.startBoostWindow (seconds before GO) → at GO
  `applyBoost(BOOST.startDuration, 'start')` + `race:startBoost`; pressing earlier
  than RACE.startStallBefore → `kart.stallTimer = 1.0` at GO + `race:stall`.
* Progress: each kart has continuous `distance` (start = `track.deltaS(0, gridS)`,
  negative on the grid). Each update: `distance += track.deltaS(prevS, proj.s)`.
  `lap = clamp(floor(distance / L) + 1, 1, laps)` for display; a lap completes when
  `floor(distance / L)` increases beyond the max reached (emit `race:lap` {kart,
  lap, lapTime} for lap ≥ 2 and `race:finalLap` when lap === laps). Finish when
  `distance ≥ laps × L` → `finished = true`, `finishTime`, `race:finish` {kart,
  place}. Driving backwards reduces distance; no lap credit for wiggling over
  the line.
* Places: finished karts by finish order, then by distance desc. Write
  `kart.place`. Emit `race:positionChange` for the player when it changes.
* Wrong way: player's forward·tangent < −0.4 and speed > 3 for RACE.wrongWayDelay
  → `kart.wrongWay = true` (`race:wrongWay` {kart, on}).
* After the player finishes, main swaps the player to AI control; when all karts
  finish or RACE.resultsDelay elapses after the player finished →
  `race:over` (once). Unfinished karts get estimated times from remaining
  distance / their average speed.

### tools/sim.mjs (headless)
Builds the track, 8 karts (all characters), AI for all, items (scene null), race;
places on grid; skips intro; simulates at dt = 1/120 for up to 400 s game time
(as fast as possible). Prints per-kart finish time, lap times, items used, hits
taken, max stuck time, wall hits; exits non-zero if any kart fails to finish
within 300 s, any NaN, or any kart stuck > 5 s. `node tools/sim.mjs --seed 3 --laps 3`.

## 9. Event bus catalog (`bus.emit(type, data)`)

| type | data |
|---|---|
| `kart:hop` | { kart } |
| `kart:driftStart` | { kart, dir } |
| `kart:driftTier` | { kart, tier } (1..3) |
| `kart:driftEnd` | { kart, tier } |
| `kart:boost` | { kart, source: 'drift'\|'item'\|'pad'\|'start', duration } |
| `kart:spin` | { kart, cause } |
| `kart:tumble` | { kart, cause } |
| `kart:wallHit` | { kart, intensity } |
| `kart:bump` | { a, b, intensity } |
| `kart:land` | { kart, airTime } |
| `kart:starStart` / `kart:starEnd` | { kart } |
| `kart:respawn` | { kart } |
| `item:boxHit` | { kart, box } |
| `item:rollStart` | { kart } |
| `item:get` | { kart, item } |
| `item:use` | { kart, item } |
| `item:hit` | { kart /*victim*/, by /*kart or null*/, item } |
| `item:explode` | { position } |
| `item:zap` | { kart } |
| `item:blocked` | { kart, item } (projectile destroyed a banana) |
| `race:intro` | {} |
| `race:countdown` | { n } |
| `race:go` | {} |
| `race:startBoost` / `race:stall` | { kart } |
| `race:lap` | { kart, lap, lapTime } |
| `race:finalLap` | { kart } |
| `race:finish` | { kart, place, time } |
| `race:positionChange` | { kart, from, to } |
| `race:wrongWay` | { kart, on } |
| `race:over` | {} |

## 10. Audio, input, HUD (browser)

```js
// audio.js — 100% synthesized with WebAudio (no audio files).
export class AudioEngine {
  constructor()
  unlock()                     // call from any user gesture; creates/resumes AudioContext (idempotent)
  get ready()
  muted; toggleMute(); setMuted(b); setVolume(v /*0..1*/)
  play(name, { volume = 1, pitch = 1, pan = 0 } = {})
     // names: 'menuMove','menuSelect','menuBack','countdown','go','itemBox','roulette'
     //   (short tick),'itemGet','throw','bouncer','rocket','toot' (comedic fart-like
     //   boost toot!),'boost','hit','spin','explode','banana','stink','star','zap',
     //   'lap','finalLap','finish','lose','wall','bump','hop','land','drift1','drift2',
     //   'drift3','stall','startBoost','respawn','join' (phone connected),'leave'
  updateEngine(dt, { speed, maxSpeed, throttle, drifting, boosting, grounded, offroad, active })
     // continuous player engine + drift screech + offroad rumble loops
  setEngineActive(b)
  startMusic(kind /*'menu'|'race'*/), setMusicIntensity(level /*0 normal, 1 final lap*/), stopMusic()
  playJingle(name /*'finish'|'lose'|'start'*/)
}
```
Music: procedural chiptune sequencer (lookahead scheduler on AudioContext time),
catchy original melodies (do not reproduce existing songs), menu + race loops,
final-lap = faster tempo. Master compressor; music quieter than SFX.

```js
// input.js — keyboard + gamepad + phone merge
export class Input {
  constructor({ phone = null /*PhoneLink*/ } = {})
  update(dt)          // call once per frame BEFORE reading
  // race controls (merged across sources):
  steer; throttle; brake; drift /*held*/; itemPressed /*edge this frame*/;
  pausePressed /*edge*/; lookBack /*held*/;
  // menu navigation (edges this frame):
  menu = { left, right, up, down, confirm, back };
  lastSource;         // 'keyboard' | 'gamepad' | 'phone'
  phoneActive;        // phone connected and sending
  dispose()
}
```
Keyboard: ←/→ or A/D steer (smoothed ramp ~7/s, return ~10/s), ↑/W gas, ↓/S
brake/reverse, Space or Shift = drift (held), X / E / Z = item, C = look
back, Esc/P = pause, Enter = confirm, Backspace/Esc = back in menus. Gamepad:
left stick X steer (deadzone .15), A/RT gas, B/LT brake, RB/R1/X drift, LB/Y
item, Start pause, d-pad menus. Phone: `phone.input` (see §11): steer is used
directly (already smoothed on the phone), gas→throttle, brake, drift, item and
pause edges from sequence counters. While the phone is active and sending,
phone steer overrides keyboard steer unless a key is pressed.

```js
// hud.js — DOM overlay (absolutely positioned elements inside a root div)
export class HUD {
  constructor(root /*HTMLElement*/)
  setTrack(track)            // pre-render minimap outline (canvas)
  show(); hide()
  update(dt, { player, race, karts, items, phoneConnected })
     // lap "LAP 2/3", race timer, place badge (1st gold / 2nd silver / 3rd bronze),
     // item slot with roulette animation (cycles ITEM_INFO icons while
     // player.rolling) + count badge for triple_toot, minimap with kart dots
     // (character cssColor; player larger with white ring), speed bar,
     // drift charge indicator, phone-connected icon
  countdown(n)               // big center "3","2","1" then "GO!" (n = 0)
  flash(text, { color, duration = 1.5, size = 'big'|'medium' })  // "LAP 2", "FINAL LAP!", "FINISH!"
  setWrongWay(on)
  showFinish(place)          // "FINISH!" + place
  reset()
}
```
CSS in `public/css/game.css` (HUD + shared base styles, bold rounded game font
via Google Fonts, e.g. "Lilita One" / "Bungee" with system fallbacks, text
outlines/shadows for readability). Must scale for 720p → 4K (use vh/clamp).

## 11. Network protocol — server + phone

`npm start` → `node server.js`:
* HTTP on 3000 (`http://localhost:3000` desktop game), HTTPS on 3443 with a
  self-signed cert generated at first start (selfsigned, SAN = localhost +
  127.0.0.1 + all LAN IPv4s; cached in `.certs/` and kept while it covers the
  host in the phone URL — a phone's exception is for that one certificate;
  when it must be replaced, the new SAN keeps the old addresses). At startup
  the server checks that `localhost` (127.0.0.1 and ::1) really reaches it and
  exits with "port in use" otherwise. Both servers share ONE Socket.IO instance/room state
  (`io.attach(httpsServer)` additionally, or create io on http and attach the
  https server too).
* Static: `/` → `public/index.html`, `/pad` → `public/pad.html`, `/vendor/three/*`
  → `node_modules/three/*`, everything else from `public/`.
* `GET /api/info` → `{ lanIps: [...], httpPort, httpsPort, padBaseUrl }`.
* Prints the desktop URL + phone hint on start; opens the desktop URL in the
  default browser (`open` on macOS) unless `NO_OPEN=1`.
* Rooms: 4-letter codes (no ambiguous letters). One host + at most one active
  pad per room (a new pad replaces the old one, old gets `pad:kicked`).

Socket.IO events:
| direction | event | payload |
|---|---|---|
| host→server | `host:create` (ack) | `{ room?, key?, vacantOnly? }` (reclaim on reconnect; `vacantOnly`: only if no live host has it) → ack `{ room, padUrl, qrSvg, lanIps }` |
| server→host | `pad:join` / `pad:leave` | `{ padId }` |
| server→host | `pad:input` | `{ s, g, b, d, i, p, t }` steer float −1..1 (+right), gas 0/1, brake 0/1, drift 0/1, itemSeq int, pauseSeq int, client ms timestamp |
| server→host | `pad:menu` | `{ action, ... }` actions: `start`, `select` {index}, `difficulty` {value}, `go`, `pause`, `resume`, `restart`, `quit`, `again`, `menu` |
| host→server→pad | `host:state` | see below (server caches the last one per room and sends it to a pad on join) |
| host→server→pad | `host:event` | `{ type: 'vibrate', pattern: [ms...] }` \| `{ type: 'toast', text }` |
| pad→server | `pad:hello` (ack) | `{ room }` → ack `{ ok, error? }` |
| server→pad | `host:leave` | `{}` (desktop disconnected) |

`padUrl` = `https://<primary LAN IP>:3443/pad?room=ABCD`. `qrSvg` = SVG string
from `qrcode.toString(padUrl, { type: 'svg', margin: 1 })`.

`host:state` payload:
```js
{ screen: 'title'|'select'|'race'|'results'|'paused'|'loading',
  characters: [{ id, name, cssColor }], selected: 0, difficulty: 'normal',
  race: { state, lap, laps, place, racers, item, itemCount, rolling, countdown, finished } | null,
  results: [{ name, cssColor, place, time, isPlayer }] | null }
```

### net.js (desktop side)
```js
export class PhoneLink {
  constructor()
  async connect()            // connects socket, emits host:create; resolves { room, padUrl, qrSvg, lanIps }
  room; padUrl; qrSvg; lanIps;
  connected                  // a pad is currently joined
  input = { steer: 0, gas: 0, brake: 0, drift: 0, itemSeq: 0, pauseSeq: 0, lastUpdate: 0 /*performance.now()*/ }
  get active()               // connected && input updated within the last 1500 ms
                             // (shrinks to 400 ms while the pad streams at race rate)
  on(event, fn)              // 'join' | 'leave' | 'menu' (payload) | 'info' → returns unsubscribe
                             // also 'lost' / 'signal': a pad that was driving went silent ≥ 1 s
                             // during a live race → 'lost', then a local 'menu' {action:'pause'}
  sendState(state)           // dedupes; also re-sends at NET.hostStateHz heartbeat
  sendEvent(type, data)      // e.g. sendEvent('vibrate', { pattern: [40] })
}
```
Re-claims its room after a socket reconnect (`host:create {room}`). The room a
phone is paired with is also kept in localStorage, so a closed and reopened
game tab reclaims it (`vacantOnly`) within the grace period.

### pad.html / pad.js / pad.css (phone controller)
* Opens `https://LAN:3443/pad?room=ABCD`; if no/invalid room, shows a 4-letter
  code input. Connects Socket.IO to its own origin, `pad:hello`.
* "Tap to start" gate (needed for iOS): calls
  `DeviceOrientationEvent.requestPermission()` (and DeviceMotionEvent's) when
  present, requests a screen Wake Lock, tries fullscreen +
  `screen.orientation.lock('landscape')` (Android; ignore failures).
* **Always-landscape UI**: the controller layout is landscape. If the page is
  laid out portrait (orientation-locked iPhone held sideways), rotate the whole
  UI container 90° with CSS so it appears landscape; choose ±90° from gravity
  (which way the phone is held) with hysteresis.
* **Steering math** (robust for upright "wheel" grip AND flat tilting):
  from `deviceorientation` β, γ (degrees→radians) compute world-up in device
  coords `up = (-sinγ·cosβ, sinβ, cosγ·cosβ)`. Let `a` = effective UI rotation
  angle in degrees = `screen.orientation.angle ?? window.orientation ?? 0`, plus the CSS
  rotation if applied (so `a` describes how the visible UI is rotated relative to
  the device's natural portrait). Screen-space up: `ux = up.x·cos a − up.y·sin a`,
  `uy = up.x·sin a + up.y·cos a`. Raw steering angle: the in-plane wheel angle
  `θ = atan2(−ux, uy)` while the phone is held like a wheel (in-plane gravity
  `m = hypot(ux, uy) ≥ 0.6`), so steering does not depend on how far the
  screen is tilted back; blended (smoothstep) into `asin(clamp(−ux, −1, 1))` as
  `m` falls to 0.35 (phone lying flat: roll angle) and as `uy → 0`
  (rotating the phone clockwise like a wheel = positive = steer right).
  Verify the sign on both landscape directions and fix if inverted.
  Subtract the calibration offset θ₀ (set by "Center" button and automatically
  at race start), dead zone 2°, full lock at ±32° (sensitivity slider 18°–50°,
  saved in localStorage), mild expo curve, low-pass filter. Fallback if no
  orientation events arrive within 1.5 s after the gate: `devicemotion`
  `accelerationIncludingGravity` (detect iOS sign inversion) and, failing that,
  a touch steering slider. Show a live steering-wheel graphic that rotates with
  the input.
* Race layout (landscape, thumbs on the edges like holding a wheel): left side
  DRIFT (big, hold) and ITEM (shows current item icon from host state, tap);
  right side GAS (big, hold) and BRAKE (hold); top bar: pause button, place,
  lap, connection dot, "Center" button; settings sheet (sensitivity, auto-gas
  toggle, invert steering). Multi-touch with Pointer Events (each button tracks
  its own pointerId; implicit capture; handle pointercancel/lostpointercapture);
  `touch-action: none`, no selection/callouts/zoom, no scroll bounce.
  Pressed state visual feedback; `navigator.vibrate` short buzz on press
  (Android).
* Menu screens mirror `host:state.screen`: title → big "START" button; select →
  scrollable grid of character cards (name + color swatch; tap = `select`
  {index}; highlights `selected`), difficulty segmented control, big "RACE!"
  (`go`); paused → Resume / Restart / Quit; results → standings list + "Race
  Again" (`again`) / "Change Character" (`menu`). Portrait or landscape both OK
  for menus, but the always-landscape container is fine too.
* Sends `pad:input` at NET.padInputHz while screen is race (volatile emits) and
  immediately on any button edge; item/pause presses increment sequence
  counters (never lost). Auto-gas (setting) sends g=1 unless brake held.
  A sample due while the transport is busy goes out when it drains (HTTP
  long-polling); none are queued behind a stalled WebSocket. The server relays
  edges reliably and coalesces samples over its rate limit (newest wins).
* Page hidden mid-race (lock, app switch, call) while the phone is in use →
  `pad:menu {action:'pause'}` right away, buttons released, stream stopped.
* Handles `host:event` vibrate patterns, `host:leave` (show "waiting for game"),
  reconnects (re-`pad:hello`).
* Shows clear help: if not a secure context, explain HTTPS is needed.

## 12. Integration — index.html, main.js, menus.js

* `index.html`: import map, socket.io script, `<canvas id="game">`, `#hud` root,
  `#menus` root, fonts, `css/game.css` + `css/menus.css`, `<script type="module" src="js/main.js">`.
* `main.js`: creates renderer (antialias, pixelRatio ≤ 2, ACES tone mapping,
  sRGB, PCFSoft shadows), scene, camera, `getTrack()`, `buildWorld`, `Effects`,
  `ChaseCamera`, `AudioEngine`, `PhoneLink` (connect; failures must not break
  keyboard play), `Input`, `HUD`, menus. App states: `title` → `select` →
  `race` (intro → countdown → racing) → `results` → (`again` → new race |
  `menu` → select). Pause overlay (Esc / phone pause). Race setup: 8 karts
  (player's character + the other 7), player in grid slot RACE.playerGridSlot,
  CPU in the others, `AIDriver` for each CPU with skill spread around the
  difficulty's aiSkill, `ItemSystem`, `Race`, `KartView` for every kart.
  Teardown fully disposes race objects between races (no leaks, no duplicate
  bus listeners).
* Main loop: `requestAnimationFrame`; frame dt clamped to PHYS.maxFrameDt; split
  into n = ceil(dt / PHYS.maxSubstep) equal substeps. Per substep: AI drivers
  update → `items.update(dt, race)` → `kart.update(dt)` for all →
  `resolveKartCollisions(karts)` → `race.update(dt)`. Per frame: input.update
  (once, before substeps; player input written to player kart; itemPressed sets
  `player.input.useItem = true`), KartViews, effects, camera, world.update,
  HUD, audio (engine + event-driven one-shots for the player and nearby
  karts, distance-attenuated), phone state sync (screen/race fields; vibrate on
  player hit/item get/lap), render.
* After the player finishes: player kart is driven by an AIDriver; camera orbit;
  after `race:over` show results.
* Menus (`menus.js`, DOM): title screen with logo and "Press Enter / tap START on
  your phone", QR panel (always visible on title & select screens: QR SVG,
  "Scan with your phone camera to use it as a steering wheel", the URL in text,
  certificate-warning tip, connection status with the phone), character select
  (8 cards with color, name, stat bars, live 3D preview of the selected kart
  on a turntable — render with the main renderer into the main scene or a
  small dedicated scene; keyboard ←/→/↑/↓ + Enter, phone `select`/`go`),
  difficulty selector, results screen (standings table, times, "Race Again" /
  "Change Character"), pause menu (Resume / Restart / Quit). Keyboard and phone
  can both drive every menu. Mute toggle (M key + button). Controls help.
* `window.__game` debug handle: `{ state, track, race, karts, player, items,
  quickRace(charId = 'blaze', difficulty = 'normal'), setTimeScale(x),
  skipIntro() }` — used by automated tests (tools/shot.mjs).
* AudioContext unlock on the first desktop keydown/pointerdown; show a small
  "click for sound" hint until unlocked.

---------------------------------------------------------------------------

## 13. KRISHIV KART update — rename, 4 new racers, racer customization

### 13.1 Rename
The game is now **KRISHIV KART** (`GAME_TITLE` in config.js; package name
`krishivkart`). Replace every user-facing "TOOT KART" (page `<title>`s, logos,
boot splash, start-gantry banner texture, phone pad, server banner + cert
subject, README, error/help text, aria labels, code header comments). Item
names (Toot Boost, Triple Toot, …) stay as they are.

### 13.2 Roster
`CHARACTERS` (characters.js) grows from 8 to **12**: the 8 existing racers plus
four human kid racers appended in this order. Humans have `human: true`, a
default `look` and a `signature` loadout (see customize.js):

| id | name | ratings spd/acc/hnd/wgt | color / accent | look (default) | signature kart |
|---|---|---|---|---|---|
| `krishiv` | Krishiv | 4 / 4 / 3 / 3 | red 0xe8344e / gold 0xd9a514 | skin s4, spiky black hair, no hat, no eyewear, red outfit | speedster, slick, paint red, trim gold, rim gold |
| `striker_max` | Striker Max | 5 / 2 / 3 / 4 | blue 0x2f6bff / yellow 0xffc21f | skin s3, blonde mohawk, shades, blue outfit | rocket, standard, paint blue, trim yellow, rim silver |
| `rayyaan` | Rayyaan | 3 / 4 / 5 / 2 | green 0x35c64a / white 0xf4f4f4 | skin s4, curly black hair, backwards cap, green outfit | feather, neon, paint green, trim white, rim lime |
| `jordan` | Jordan | 3 / 5 / 3 / 3 | sky 0x38c8ff / orange 0xff7a1f | skin s2, short brown hair, race helmet, goggles, sky outfit | buggy, tiny, paint sky, trim orange, rim white |

Taglines (keep upbeat): Krishiv "The champ this whole Grand Prix is named
after.", Striker Max "Full throttle, zero brakes, all swagger.", Rayyaan
"Smooth lines and silky drifts.", Jordan "Launches off the line like a rocket."
Each of the 8 original characters also gets a `signature` (visual variety for
CPUs) chosen to fit them (e.g. Bolt/Duke → tank or monster wheels, Pip → buggy +
tiny, Gus → feather, Ziggy → rocket, Nova → buggy, Mochi → feather or
standard, Blaze → standard), keeping their current colors.

Plus a 13th selectable slot, the player's own creation:
```js
export const CUSTOM_CHARACTER = { id: 'custom', name: 'My Racer', isCustom: true, human: true,
  ratings: { speed: 3, accel: 3, handling: 3, weight: 3 }, color, accent, cssColor,
  tagline: 'Your racer, your rules.', look: {...}, signature: {...} };
export const SELECTABLE = [...CHARACTERS, CUSTOM_CHARACTER];   // 13, custom last
getCharacter(id)  // resolves 'custom' too
```
`CHARACTERS` (12) is the racing roster used for CPUs and the sim; the custom
slot is only ever the player.

### 13.3 Loadouts — `customize.js` (written by the lead; node-safe)
Read the file: catalogs (`PALETTE`, `SKIN_TONES`, `HAIR_STYLES`,
`HAIR_COLORS`, `HEADWEAR`, `EYEWEAR`, `KART_BODIES`, `WHEELS`,
`FIELD_GROUPS`), `defaultLoadout(def)`, `sanitizeLoadout(def, raw)`,
`setLoadoutField`, `cycleLoadoutField`, `computeRatings(def, loadout)` (base
ratings + body + wheel mods, clamped 1..5, 0.5 steps), `offroadBonus`,
`loadoutFields(def)` (the field list every garage UI renders), `randomLoadout`,
`sanitizeName` / `NAME_MAX` (12), `loadoutCssColor`, `paletteHex`, `skinHex`,
`hairHex`, `getBody`, `getWheels`, `loadSavedLoadouts()` / `saveLoadouts(map)`
(localStorage key `krishivkart.loadouts.v1`, `{ [charId]: loadout }`).
Humans customize skin/hair/hairColor/headwear/eyewear/outfit; non-humans
customize `driverColor` ('default' = original colors, else a palette tint of
the character's main color). Everyone customizes body/paint/trim and
wheels/rim, plus the display name.

### 13.4 Models — `buildKartModel(def, { lod = 'high', loadout = null })`
`loadout` defaults to `defaultLoadout(def)`. Must render: the 6 kart bodies as
clearly different silhouettes (Classic = current chassis; Speedster = low wedge
+ big rear wing; Bubble Buggy = round bubbly tub + roll bar; Thunder Truck =
boxy, tall, chunky bumpers; Featherlite = minimal exposed tube frame; Rocket
Sled = long nose, jet fins, rear thruster nozzle), painted with
paint/trim; the 6 wheel styles (Standard; Racing Slicks = wide smooth; Mud
Grippers = knobby chunky; Mini Rollers = small; Monster Wheels = huge (kart rides
higher — keep the wheel bottoms on the ground at y=0); Neon Rings = emissive
glowing rims) with `rim` color; human drivers from a parametric builder
(head, face with readable eyes + smile, skin tone, 9 hair styles × hair color,
7 headwear, 4 eyewear, outfit-colored suit, arms on the wheel) that look like
cheerful cartoon kids in the same style as the existing cast; non-human
`driverColor` tint. Keep the `userData` contract of §4 (wheels/steerPivots/
exhausts/tintMaterials/body/driver/head) for every body/wheel combo so
kartview.js keeps working; keep ≤ ~14 draw calls per kart (merge static parts);
cache geometries by (body, wheels) and part.

### 13.5 Kart physics — kart.js
`new Kart({ id, character, track, isPlayer = false, loadout = null, useLoadoutStats = isPlayer })`:
`this.loadout = sanitizeLoadout(character, loadout)`, `this.name = this.loadout.name`,
`this.cssColor = loadoutCssColor(this.loadout)`. Stats: `useLoadoutStats ?
statsFromRatings(computeRatings(character, loadout)) : statsFromRatings(character.ratings)`
plus `stats.offroadMult = KART.offroadSpeedMult + (useLoadoutStats ? offroadBonus(loadout) : 0)`
(clamp ≤ 0.8), used by `maxSpeed` instead of the constant. CPU stats therefore
ignore part mods (their signature karts are cosmetic), so AI balance is unchanged.
KartView builds its model from `kart.loadout`. Race results, HUD, phone and
callouts use `kart.name` / `kart.cssColor`.

### 13.6 Race field
8 racers: the player + 7 CPUs. CPUs always include the four human racers
(Krishiv, Striker Max, Rayyaan, Jordan — minus the player's own pick), the rest
random from the other characters; never the player's character twice. CPUs use
their signature loadouts. ai.js gets personalities for the 4 new ids.
tools/sim.mjs must race 8 of the 12 (rotate the subset per seed) and keep passing.

### 13.7 Desktop flow (main.js / menus.js)
* **Select** (13 cards; the custom card shows "CREATE YOUR RACER" + its current
  name, ✚ badge): Enter / RACE! starts a race with the selected character's saved
  loadout; **C / CUSTOMIZE** button opens the garage for the selected character.
  Card portraits reflect saved loadouts and refresh after garage edits.
* **Garage** (new app state `'garage'`): tabs Driver / Kart / Wheels (+ a Name
  field always visible at the top), each field a row with ◀ value ▶ (color fields
  show swatch strips, part fields show name + description + stat deltas), live
  turntable 3D preview rebuilt on every change, stat bars of the FINAL ratings
  with +/− markers vs the character's base, Randomize (R), Reset, Done (Esc →
  select), RACE! (Enter when not typing). Keyboard: ↑/↓ row, ←/→ value, Tab or
  Q/E switch tab, typing into the name box (Input must ignore game keys while an
  `<input>`/`<textarea>` is focused). Mouse/touch on everything. Saved to
  localStorage on change (debounced) per character id.
* Results / pause / phone show `kart.name`.

### 13.8 Phone protocol additions (server.js / net.js / pad.js)
* `pad:menu` new actions: `customize` (optional {index}: select it first, then
  open the garage), `loadout` {field, value}, `cycle` {field, dir: −1|1},
  `name` {text}, `randomize`, `reset`, `done` (garage → select). `go` also works
  from the garage. `select` index range is now 0..12.
* server.js sanitizes them: field `/^[a-zA-Z]{1,16}$/`, value
  `/^[a-z0-9_]{1,24}$/`, dir ∈ {−1, 1}, text = string, control chars stripped,
  ≤ 24 chars (the host applies `sanitizeName`). `host:state` may carry the new
  key `garage` and screen `'garage'`; size caps must allow ~10 KB states.
* `host:state.characters` = 13 entries `{ id, name, cssColor, custom }` (custom
  last; name = saved custom name). `host:state.garage` =
  `{ index, charId, human, name, nameMax, groups: FIELD_GROUPS,
     fields: loadoutFields(def) each with its current `value`,
     ratings (final), base (def.ratings), offroad }` while on the garage screen,
  else null.
* Phone garage UI: same tabs, tappable swatches/chips + ◀ ▶, part stat deltas,
  name text field using the phone keyboard (maxlength NAME_MAX; send on input
  debounced + on Enter/blur; must work on iPhone — do not put the text field in a
  CSS-rotated container; menus may use natural orientation), stat bars,
  Randomize / Reset / Done / RACE!. Select grid shows 13 cards incl. the custom
  card and a CUSTOMIZE button.
