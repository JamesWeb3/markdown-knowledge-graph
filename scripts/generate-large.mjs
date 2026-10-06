#!/usr/bin/env node
// Write synthetic graphs to public/large-<n>.json, to see where the renderer slows down.
//
//   npm run generate:large                 # 500, 2000 and 5000 nodes
//   npm run generate:large -- 1000 10000   # any sizes
//
// Shape: notes in 8 folders, each folder split into small communities. Most
// links stay inside a community, some cross folders, and a few hub notes
// attract more links, which is roughly how a real vault looks. About 2.5
// links per note. Seeded, so the same size always gives the same graph.
import { writeFile, mkdir } from "node:fs/promises";

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const SIZES = sizes.length ? sizes : [500, 2000, 5000];
const FOLDERS = ["Roles", "Processes", "Systems", "Decisions", "Projects", "Policies", "Meetings", "Teams"];
const LINKS_PER_NODE = 2.5;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(n) {
  const rand = rng(n);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const communitySize = 25;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const group = FOLDERS[Math.floor(rand() ** 1.3 * FOLDERS.length)];
    nodes.push({ id: `${group}/Note ${i + 1}`, label: `Note ${i + 1}`, group, community: Math.floor(i / communitySize) });
  }
  const byCommunity = new Map();
  for (const node of nodes) (byCommunity.get(node.community) ?? byCommunity.set(node.community, []).get(node.community)).push(node);
  const hubs = nodes.filter(() => rand() < 0.02);

  const seen = new Set();
  const links = [];
  const add = (a, b) => {
    if (a === b) return;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source: a.id, target: b.id });
  };
  const target = Math.round(n * LINKS_PER_NODE);
  let guard = 0;
  while (links.length < target && guard++ < target * 10) {
    const a = pick(nodes);
    const r = rand();
    if (r < 0.75) add(a, pick(byCommunity.get(a.community)));
    else if (r < 0.9 && hubs.length) add(a, pick(hubs));
    else add(a, pick(nodes));
  }

  const degree = new Map();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  return {
    nodes: nodes.map(({ id, label, group }) => {
      const d = degree.get(id) ?? 0;
      return { id, label, group, degree: d, weight: 1.5 + Math.sqrt(d) * 0.9 };
    }),
    links,
    groups: [...new Set(nodes.map((x) => x.group))].sort(),
    unresolved: 0,
  };
}

await mkdir("public", { recursive: true });
for (const n of SIZES) {
  const g = generate(n);
  const file = `public/large-${n}.json`;
  await writeFile(file, JSON.stringify(g));
  console.log(`${file}: ${g.nodes.length} nodes, ${g.links.length} links. Open http://localhost:5173/?graph=large-${n}.json`);
}
