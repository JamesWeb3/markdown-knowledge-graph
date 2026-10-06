#!/usr/bin/env node
// Time the d3-force layout on its own, with no drawing, using the same forces
// and constants as src/graph/GraphCanvas.tsx.
//
//   npm run generate:large && npm run bench:layout
//   npm run bench:layout -- public/graph.json public/large-2000.json
import { readFile } from "node:fs/promises";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";

const files = process.argv.slice(2);
const FILES = files.length ? files : ["public/graph.json", "public/large-500.json", "public/large-2000.json", "public/large-5000.json"];

console.log("file                      nodes   links   ms/tick   ticks to cool   total s");
for (const file of FILES) {
  let graph;
  try {
    graph = JSON.parse(await readFile(file, "utf8"));
  } catch {
    console.log(`${file}: missing (run npm run generate:large)`);
    continue;
  }
  const nodes = graph.nodes.map((n) => ({ ...n }));
  const links = graph.links.map((l) => ({ ...l }));
  const spread = Math.min(3, Math.max(1, Math.sqrt(60 / Math.max(nodes.length, 1))));
  const sim = forceSimulation(nodes)
    .force("link", forceLink(links).id((d) => d.id).distance(52 * spread).strength(0.35))
    .force("charge", forceManyBody().strength(-140 * spread))
    .force("collide", forceCollide().radius((d) => 4 + d.weight * 2.2))
    .force("center", forceCenter(0, 0))
    .alphaDecay(0.03)
    .stop();
  let ticks = 0;
  const t0 = performance.now();
  while (sim.alpha() >= sim.alphaMin()) {
    sim.tick();
    ticks++;
  }
  const total = performance.now() - t0;
  console.log(
    `${file.padEnd(26)}${String(nodes.length).padStart(5)}${String(links.length).padStart(8)}` +
      `${(total / ticks).toFixed(2).padStart(10)}${String(ticks).padStart(16)}${(total / 1000).toFixed(2).padStart(10)}`,
  );
}
