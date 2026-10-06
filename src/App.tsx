import { useEffect, useState } from "react";
import { GraphCanvas } from "./graph/GraphCanvas";
import type { Graph } from "./graph/types";

/**
 * Loads a graph file from public/ and draws it. `graph.json` by default;
 * `?graph=large-2000.json` loads a synthetic one from scripts/generate-large.mjs.
 */
export function App() {
  const file = new URLSearchParams(window.location.search).get("graph") ?? "graph.json";
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only a bare file name, so the query string cannot point the app anywhere else.
    if (!/^[\w.-]+\.json$/.test(file)) {
      setError(`Not a graph file name: ${file}`);
      return;
    }
    fetch(`${import.meta.env.BASE_URL}${file}`)
      .then((r) => (r.ok ? (r.json() as Promise<Graph>) : Promise.reject(new Error(`${file}: HTTP ${r.status}`))))
      .then(setGraph)
      .catch((e: Error) => setError(e.message));
  }, [file]);

  if (error)
    return (
      <div className="kg-message">
        <p>Could not load the graph. {error}</p>
        <p className="kg-muted">
          Build one with <code>npm run graph -- path/to/vault</code>, or <code>npm run generate:large</code> for the synthetic ones.
        </p>
      </div>
    );
  if (!graph) return <div className="kg-message kg-muted">Loading {file}…</div>;
  return <GraphCanvas graph={graph} />;
}
