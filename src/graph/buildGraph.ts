import type { Graph, GraphLink, GraphNode, NoteFile } from "./types";

/**
 * Markdown notes to a graph. Pure: no file system, no DOM, so the same code
 * runs in the CLI (scripts/build-graph.mjs), in tests and in the browser.
 *
 * - every note is a node
 * - every [[wikilink]] that resolves to a note is an edge
 * - edges are undirected and de-duplicated, self-links are dropped
 * - a node's group is its top-level folder
 * - a node's size grows with the square root of its link count
 */

/**
 * The targets of every [[wikilink]] in a body, in order, duplicates kept.
 * Handles [[Note]], [[Folder/Note]], [[Note|alias]], [[Note#Heading]] and
 * [[Note#Heading|alias]]. Embeds (![[Note]]) count as links too.
 */
export function wikilinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const target = m[1].trim().replace(/\.md$/i, "");
    if (target) out.push(target);
  }
  return out;
}

/** Split YAML frontmatter from the body. Only `title` is read, so a line reader is enough. */
export function splitFrontmatter(raw: string): { title?: string; body: string } {
  const text = raw.replace(/^﻿/, "");
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { body: text };
  const t = m[1].match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  return { title: t || undefined, body: text.slice(m[0].length) };
}

/** Strip code blocks so a [[link]] inside an example is not counted. */
const withoutCode = (body: string) => body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

const EXCERPT_CHARS = 280;

function excerptOf(body: string): string {
  const text = body
    .replace(/^#.*$/gm, "")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, t: string, alias?: string) => alias ?? t)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > EXCERPT_CHARS ? text.slice(0, EXCERPT_CHARS - 1) + "…" : text;
}

export type BuildOptions = {
  /** Include a short excerpt per node (default true). Turn off to keep graph.json small for big vaults. */
  excerpts?: boolean;
};

export function buildGraph(files: NoteFile[], options: BuildOptions = {}): Graph {
  const { excerpts = true } = options;
  const notes = files
    .filter((f) => /\.md$/i.test(f.path))
    .map((f) => {
      const id = f.path.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\.md$/i, "");
      const { title, body } = splitFrontmatter(f.content);
      const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
      return {
        id,
        label: title || h1 || id.split("/").pop()!,
        group: id.includes("/") ? id.split("/")[0] : "Root",
        body,
        targets: wikilinks(withoutCode(body)),
      };
    });

  // Resolve by exact path first, then by file name (Obsidian's "shortest path"
  // behaviour). When two notes share a file name, the alphabetically first
  // path wins, so the result does not depend on the order files were read in.
  const ids = new Set(notes.map((n) => n.id));
  const byName = new Map<string, string>();
  const byNameFolded = new Map<string, string>();
  for (const id of [...ids].sort()) {
    const name = id.split("/").pop()!;
    if (!byName.has(name)) byName.set(name, id);
    if (!byNameFolded.has(name.toLowerCase())) byNameFolded.set(name.toLowerCase(), id);
  }
  const resolve = (target: string): string | null => {
    if (ids.has(target)) return target;
    const name = target.split("/").pop()!;
    return byName.get(name) ?? byNameFolded.get(name.toLowerCase()) ?? null;
  };

  const seen = new Set<string>();
  const links: GraphLink[] = [];
  const degree = new Map<string, number>();
  let unresolved = 0;
  for (const n of notes) {
    for (const t of n.targets) {
      const to = resolve(t);
      if (!to) {
        unresolved++;
        continue;
      }
      if (to === n.id) continue;
      const key = n.id < to ? `${n.id}\u0000${to}` : `${to}\u0000${n.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: n.id, target: to });
      degree.set(n.id, (degree.get(n.id) ?? 0) + 1);
      degree.set(to, (degree.get(to) ?? 0) + 1);
    }
  }

  const nodes: GraphNode[] = notes.map((n) => {
    const deg = degree.get(n.id) ?? 0;
    const node: GraphNode = { id: n.id, label: n.label, group: n.group, degree: deg, weight: nodeWeight(deg) };
    if (excerpts) node.excerpt = excerptOf(n.body);
    return node;
  });
  const groups = [...new Set(nodes.map((n) => n.group))].sort();
  return { nodes, links, groups, unresolved };
}

/** Size from link count: square root, so hubs stand out without swallowing the map. */
export const nodeWeight = (degree: number) => 1.5 + Math.sqrt(degree) * 0.9;
