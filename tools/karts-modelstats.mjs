// KARTS: quick model stats (triangles / meshes per character). node tools/karts-modelstats.mjs
import { CHARACTERS, buildKartModel } from '../public/js/characters.js';
for (const lod of ['high', 'low']) {
  let total = 0;
  for (const c of CHARACTERS) {
    const m = buildKartModel(c, { lod });
    let tris = 0, meshes = 0;
    const parts = [];
    m.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      const n = (g.index ? g.index.count / 3 : g.attributes.position.count / 3) * (o.isInstancedMesh ? o.count : 1);
      tris += n;
      parts.push(`${o.name || o.parent.name}:${n}`);
    });
    total += tris;
    console.log(`${lod} ${c.id.padEnd(6)} meshes ${meshes} tris ${tris}  [${parts.join(' ')}]`);
  }
  console.log(`${lod} total 8 karts: ${total} tris`);
}
