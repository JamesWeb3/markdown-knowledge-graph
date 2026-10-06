#!/usr/bin/env node
// Read a folder of markdown notes and write public/graph.json.
//
//   npm run graph -- <path-to-vault> [--out public/graph.json] [--no-excerpts]
//
// Hidden folders (.obsidian, .git, .trash) and node_modules are skipped.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative, resolve, dirname, sep } from "node:path";
import { buildGraph } from "../src/graph/buildGraph.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const vault = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
if (!vault) {
  console.error("Usage: npm run graph -- <path-to-vault> [--out public/graph.json] [--no-excerpts]");
  process.exit(1);
}
const root = resolve(vault.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
const out = resolve(option("--out", "public/graph.json"));

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(full)));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) files.push(full);
  }
  return files;
}

const t0 = performance.now();
const paths = await walk(root);
const files = await Promise.all(
  paths.map(async (p) => ({ path: relative(root, p).split(sep).join("/"), content: await readFile(p, "utf8") })),
);
const graph = buildGraph(files, { excerpts: !flag("--no-excerpts") });
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(graph));
const ms = Math.round(performance.now() - t0);
console.log(
  `${graph.nodes.length} notes, ${graph.links.length} links, ${graph.groups.length} folders, ` +
    `${graph.unresolved} unresolved wikilinks -> ${relative(process.cwd(), out)} (${ms} ms)`,
);
