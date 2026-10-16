// RACE LOGIC debug: pack shape. For kart pairs within 12 m along the track,
// histogram of lateral separation (a single-file train would pile up near 0).
import { Track } from '../public/js/track.js';
import { Kart, resolveKartCollisions } from '../public/js/kart.js';
import { CHARACTERS } from '../public/js/characters.js';
import { createAIDrivers } from '../public/js/ai.js';
import { ItemSystem } from '../public/js/items.js';
import { Race } from '../public/js/race.js';
import { makeRng } from '../public/js/utils.js';
const track = new Track();
const hist = [0, 0, 0, 0, 0]; let pairs = 0, sum = 0;
for (let seed = 1; seed <= 4; seed++) {
  const karts = CHARACTERS.map((c) => new Kart({ id: c.id, character: c, track }));
  karts.forEach((k, i) => k.placeOnGrid(track.gridSlot(i)));
  const drivers = createAIDrivers(karts, { track, rng: makeRng(seed) });
  const items = new ItemSystem({ track, karts, scene: null, rng: makeRng(seed + 9) });
  const race = new Race({ track, karts, laps: 3 });
  const ctx = { karts, items, race };
  race.skipIntro();
  let n = 0;
  for (let t = 0; t < 120 && !race.over; t += 1 / 120, n++) {
    for (const d of drivers) d.update(1 / 120, ctx);
    items.update(1 / 120, race);
    for (const k of karts) k.update(1 / 120);
    resolveKartCollisions(karts);
    race.update(1 / 120);
    if (race.time > 5 && n % 60 === 0) {
      for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
        const a = karts[i], b = karts[j];
        if (a.finished || b.finished) continue;
        if (Math.abs(track.deltaS(a.proj.s, b.proj.s)) > 12) continue;
        const dl = Math.abs(a.proj.lateral - b.proj.lateral);
        pairs++; sum += dl;
        hist[dl < 1 ? 0 : dl < 2 ? 1 : dl < 3.5 ? 2 : dl < 6 ? 3 : 4]++;
      }
    }
  }
}
console.log(`close pairs ${pairs}, mean lateral separation ${(sum / pairs).toFixed(2)} m`);
console.log(`<1m ${(100 * hist[0] / pairs).toFixed(0)}%  1-2m ${(100 * hist[1] / pairs).toFixed(0)}%  2-3.5m ${(100 * hist[2] / pairs).toFixed(0)}%  3.5-6m ${(100 * hist[3] / pairs).toFixed(0)}%  >6m ${(100 * hist[4] / pairs).toFixed(0)}%`);
