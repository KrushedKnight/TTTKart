// RACE LOGIC debug: single-kart AI trace (speed / lateral / inputs every N meters).
import { Track } from '../public/js/track.js';
import { Kart } from '../public/js/kart.js';
import { getCharacter } from '../public/js/characters.js';
import { AIDriver } from '../public/js/ai.js';
import { bus } from '../public/js/bus.js';
import { makeRng } from '../public/js/utils.js';
const [,, id = 'gus', from = '0', to = '2000', every = '10'] = process.argv;
const track = new Track();
const k = new Kart({ id, character: getCharacter(id), track });
k.placeOnGrid(track.gridSlot(0));
const ai = new AIDriver(k, { track, skill: 0.9, rng: makeRng(3) });
bus.on('kart:wallHit', (e) => console.log(`  WALL s=${k.proj.s.toFixed(0)} int=${e.intensity.toFixed(2)}`));
bus.on('kart:land', (e) => console.log(`  LAND s=${k.proj.s.toFixed(0)} air=${e.airTime.toFixed(2)}`));
let t = 0, dist = 0, prevS = k.proj.s, nextMark = +from;
while (t < 80) {
  ai.update(1 / 120, { karts: [k] });
  k.update(1 / 120);
  dist += track.deltaS(prevS, k.proj.s); prevS = k.proj.s;
  if (dist >= nextMark && dist <= +to) {
    nextMark += +every;
    console.log(`d=${dist.toFixed(0)} s=${k.proj.s.toFixed(0)} v=${k.speed.toFixed(1)} max=${k.maxSpeed.toFixed(1)} lat=${k.proj.lateral.toFixed(1)} rl=${track.frameAt(k.proj.s).racingLine.toFixed(1)} hw=${k.proj.halfWidth.toFixed(1)} surf=${k.surface} st=${k.input.steer.toFixed(2)} th=${k.input.throttle.toFixed(1)} br=${k.input.brake.toFixed(1)} dr=${k.drift.active ? k.drift.dir : 0}/${ai.driftState} gr=${k.grounded} boost=${k.boostTimer.toFixed(2)}`);
  }
  t += 1 / 120;
}
