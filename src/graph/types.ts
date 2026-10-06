/** One markdown file as read from disk. `path` is relative to the vault root, with forward slashes. */
export type NoteFile = { path: string; content: string };

export type GraphNode = {
  /** The note's path without `.md`, e.g. "Processes/Onboarding". Unique. */
  id: string;
  /** Frontmatter `title`, else the first `# ` heading, else the file name. */
  label: string;
  /** Top-level folder ("Root" for notes at the top of the vault). Drives colour and the legend. */
  group: string;
  /** Number of distinct notes this one is linked with, in either direction. */
  degree: number;
  /** Drawing size, derived from degree. */
  weight: number;
  /** The first few hundred characters of the body, for the side panel. Optional. */
  excerpt?: string;
};

/** Undirected: a link from A to B and one from B to A are one edge. */
export type GraphLink = { source: string; target: string };

export type Graph = {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Every group, sorted. */
  groups: string[];
  /** Wikilinks that did not match any note, for reporting. */
  unresolved: number;
};
