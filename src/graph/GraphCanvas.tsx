import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { Graph, GraphNode } from "./types";

/**
 * A knowledge graph on a 2D canvas, laid out by d3-force.
 *
 * Every frame: step the simulation once (while it is still warm), then redraw
 * every link and node. React only renders the panels around the canvas; the
 * canvas itself is drawn imperatively from refs, so hovering or a simulation
 * tick never re-renders the component tree.
 */

type SimNode = SimulationNodeDatum & GraphNode;
type SimLink = SimulationLinkDatum<SimNode>;

/** Folder colours, assigned in sorted-folder order. Muted so labels stay readable. */
export const GROUP_COLOURS = [
  "#5f6f52",
  "#b8775a",
  "#7d6b9e",
  "#d66641",
  "#4f7ca8",
  "#dab65e",
  "#899ab1",
  "#6b6357",
  "#3f9a8a",
  "#a8577e",
  "#9caa8e",
  "#c9a36b",
];
const OFF = "#c4bfb5";

/** At or below this many nodes, every node keeps its label and the layout spreads out. */
const SMALL_GRAPH = 50;

/** Performance figures, published on `window.__graphPerf` for the benchmark script. */
export type PerfSample = {
  nodes: number;
  links: number;
  /** Frames per second over the last second. */
  fps: number;
  /** Mean milliseconds per simulation tick over the last second (0 once cooled). */
  tickMs: number;
  /** Mean milliseconds to draw one frame over the last second. */
  drawMs: number;
  /** Simulation ticks so far. */
  ticks: number;
  /** Milliseconds from mount until the simulation cooled, or null while it is running. */
  settledMs: number | null;
};

declare global {
  interface Window {
    __graphPerf?: PerfSample;
  }
}

/** Lighten (t > 0) or darken (t < 0) a #rrggbb colour. */
function shade(colour: string, t: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (!m) return colour;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => Math.round(t > 0 ? v + (255 - v) * t : v * (1 + t));
  const r = ch(n >> 16);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export type GraphCanvasProps = {
  graph: Graph;
  /** Show the frames-per-second readout. */
  showPerf?: boolean;
};

export function GraphCanvas({ graph, showPerf = true }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [perf, setPerf] = useState<PerfSample | null>(null);

  const colours = useMemo(
    () => Object.fromEntries(graph.groups.map((g, i) => [g, GROUP_COLOURS[i % GROUP_COLOURS.length]])) as Record<string, string>,
    [graph.groups],
  );

  // Fresh objects for d3 to mutate (it writes x, y, vx, vy onto them).
  const nodes = useMemo<SimNode[]>(() => graph.nodes.map((n) => ({ ...n })), [graph]);
  const links = useMemo<SimLink[]>(() => graph.links.map((l) => ({ source: l.source, target: l.target })), [graph]);

  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of graph.links) {
      (m.get(l.source) ?? m.set(l.source, new Set()).get(l.source)!).add(l.target);
      (m.get(l.target) ?? m.set(l.target, new Set()).get(l.target)!).add(l.source);
    }
    return m;
  }, [graph]);

  /**
   * Which nodes carry a permanent label: all of them on a small graph, else
   * the best-connected few. Everything else is labelled on hover, selection
   * or search. Text is the most expensive thing on the canvas per item.
   */
  const labelled = useMemo(() => {
    if (graph.nodes.length <= SMALL_GRAPH) return new Set(graph.nodes.map((n) => n.id));
    const top = Math.round(Math.min(60, Math.max(15, graph.nodes.length * 0.04)));
    return new Set([...graph.nodes].sort((a, b) => b.degree - a.degree).slice(0, top).map((n) => n.id));
  }, [graph]);

  // The draw loop reads UI state through a ref so it never has to restart.
  const stateRef = useRef({ selected, hover, query, hidden, colours });
  useEffect(() => {
    stateRef.current = { selected, hover, query, hidden, colours };
  }, [selected, hover, query, hidden, colours]);

  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const controlsRef = useRef<{ zoom: (f: number) => void; fit: () => void }>({ zoom: () => {}, fit: () => {} });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;
    const started = performance.now();
    let raf = 0;
    let userMoved = false;

    const paint = { ink: "#333333", paper: "#ffffff" };
    const resize = () => {
      const cs = getComputedStyle(wrap);
      paint.ink = cs.color || paint.ink;
      paint.paper = cs.getPropertyValue("--kg-paper").trim() || paint.paper;
      // Draw at device pixels so lines stay sharp on high-DPI screens.
      const dpr = window.devicePixelRatio || 1;
      canvas.width = wrap.clientWidth * dpr;
      canvas.height = wrap.clientHeight * dpr;
      canvas.style.width = `${wrap.clientWidth}px`;
      canvas.style.height = `${wrap.clientHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!userMoved) viewRef.current = { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2, k: viewRef.current.k };
    };
    viewRef.current = { x: 0, y: 0, k: 1 };
    resize();

    // A small graph spreads out more; at 60 nodes and above the factor is 1.
    const spread = Math.min(3, Math.max(1, Math.sqrt(60 / Math.max(nodes.length, 1))));
    const small = nodes.length <= SMALL_GRAPH;

    // The simulation is stepped by hand from the draw loop (stop() removes
    // d3's own timer), so layout time and draw time can be measured apart and
    // ticking ends for certain once the layout has cooled.
    const sim = forceSimulation<SimNode>(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(52 * spread).strength(0.35))
      .force("charge", forceManyBody<SimNode>().strength(-140 * spread))
      .force("collide", forceCollide<SimNode>().radius((d) => 4 + d.weight * 2.2))
      .force("center", forceCenter(0, 0))
      .alphaDecay(0.03)
      .stop();

    const radius = (n: SimNode) => 3 + n.weight * 1.5;

    // Gradients are built at the origin and drawn after a translate, so one
    // gradient serves every node of the same colour and size. Radii are
    // rounded to half a pixel to keep the cache small.
    const gradients = new Map<string, CanvasGradient>();
    const sphere = (colour: string, r: number) => {
      const rr = Math.round(r * 2) / 2;
      const key = `${colour}|${rr}`;
      let g = gradients.get(key);
      if (!g) {
        g = ctx.createRadialGradient(-rr * 0.35, -rr * 0.35, rr * 0.1, 0, 0, rr);
        g.addColorStop(0, shade(colour, 0.45));
        g.addColorStop(0.55, colour);
        g.addColorStop(1, shade(colour, -0.32));
        gradients.set(key, g);
      }
      return g;
    };

    // ── Perf counters ──────────────────────────────────────────────────────
    let frames = 0;
    let ticks = 0;
    let tickTotal = 0;
    let tickCount = 0;
    let drawTotal = 0;
    let windowStart = performance.now();
    let settledMs: number | null = null;
    let fitted = false;

    const frame = (now: number) => {
      // 1. Layout: one tick per frame while the simulation is warm.
      if (sim.alpha() >= sim.alphaMin()) {
        const t0 = performance.now();
        sim.tick();
        tickTotal += performance.now() - t0;
        tickCount++;
        ticks++;
        settledMs = null;
      } else if (settledMs === null) {
        settledMs = now - started;
        if (!userMoved && !fitted) {
          fit();
          fitted = true;
        }
      }
      // Frame the graph once early, so a big layout is not drawn off screen while it settles.
      if (!fitted && !userMoved && ticks === 60) fit();

      // 2. Draw.
      const d0 = performance.now();
      draw();
      drawTotal += performance.now() - d0;

      // 3. Publish the numbers once a second.
      frames++;
      if (now - windowStart >= 1000) {
        const sample: PerfSample = {
          nodes: nodes.length,
          links: links.length,
          fps: Math.round((frames * 1000) / (now - windowStart)),
          tickMs: tickCount ? +(tickTotal / tickCount).toFixed(2) : 0,
          drawMs: +(drawTotal / frames).toFixed(2),
          ticks,
          settledMs: settledMs === null ? null : Math.round(settledMs),
        };
        window.__graphPerf = sample;
        setPerf(sample);
        frames = 0;
        tickTotal = 0;
        tickCount = 0;
        drawTotal = 0;
        windowStart = now;
      }
      raf = requestAnimationFrame(frame);
    };

    const draw = () => {
      const { selected, hover, query, hidden, colours } = stateRef.current;
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      const v = viewRef.current;
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(v.x, v.y);
      ctx.scale(v.k, v.k);

      const focus = selected ?? hover;
      const focusSet = focus ? new Set([focus, ...(neighbours.get(focus) ?? [])]) : null;
      const q = query.trim().toLowerCase();
      const visible = (n: SimNode) => !hidden.has(n.group);

      // Links: two batched paths (background and focused) instead of one stroke per link.
      ctx.strokeStyle = paint.ink;
      ctx.lineCap = "round";
      ctx.globalAlpha = focusSet ? 0.05 : 0.14;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      const focused: [SimNode, SimNode][] = [];
      for (const l of links) {
        const s = l.source as SimNode;
        const t = l.target as SimNode;
        if (!visible(s) || !visible(t)) continue;
        if (focus && (s.id === focus || t.id === focus)) {
          focused.push([s, t]);
          continue;
        }
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
      }
      ctx.stroke();
      if (focused.length) {
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (const [s, t] of focused) {
          ctx.moveTo(s.x!, s.y!);
          ctx.lineTo(t.x!, t.y!);
        }
        ctx.stroke();
      }

      // Nodes, then labels on top.
      const labels: { n: SimNode; r: number }[] = [];
      for (const n of nodes) {
        if (!visible(n)) continue;
        const r = radius(n);
        const matches = q ? n.label.toLowerCase().includes(q) : true;
        const dim = (focusSet && !focusSet.has(n.id)) || !matches;
        ctx.globalAlpha = dim ? 0.18 : 1;
        ctx.save();
        ctx.translate(n.x!, n.y!);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = sphere(colours[n.group], r);
        ctx.fill();
        if (n.id === selected) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = paint.ink;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.restore();
        const showLabel = labelled.has(n.id) || n.id === focus || (focusSet?.has(n.id) ?? false) || (q !== "" && matches);
        if (showLabel && !dim) labels.push({ n, r });
      }
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = paint.ink;
      ctx.textBaseline = "middle";
      ctx.font = `${Math.max(3, 11 / v.k)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      // A search that matches thousands of nodes would spend the frame on text: cap it.
      for (const { n, r } of labels.slice(0, 400)) {
        const text = n.label.length > 34 ? n.label.slice(0, 32) + "…" : n.label;
        ctx.fillText(text, n.x! + r + 4 / v.k, n.y!);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    };

    // ── Interaction: drag a node, pan the canvas, wheel to zoom, click to select ──
    let drag: SimNode | null = null;
    let panning = false;
    let last = { x: 0, y: 0 };
    let moved = false;

    const toWorld = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const v = viewRef.current;
      return { x: (e.clientX - rect.left - v.x) / v.k, y: (e.clientY - rect.top - v.y) / v.k };
    };
    /** Linear scan. Fine to a few thousand nodes; a quadtree (d3-quadtree) is the next step. */
    const pick = (p: { x: number; y: number }) => {
      const k = viewRef.current.k;
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const n of nodes) {
        if (stateRef.current.hidden.has(n.group)) continue;
        const d = Math.hypot(n.x! - p.x, n.y! - p.y);
        if (d < radius(n) + 3 / k && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };

    const onDown = (e: MouseEvent) => {
      const n = pick(toWorld(e));
      moved = false;
      if (n) {
        drag = n;
        n.fx = n.x;
        n.fy = n.y;
        sim.alphaTarget(0.2).alpha(Math.max(sim.alpha(), 0.2));
      } else {
        panning = true;
      }
      last = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: MouseEvent) => {
      if (drag) {
        const p = toWorld(e);
        drag.fx = p.x;
        drag.fy = p.y;
        moved = true;
      } else if (panning) {
        viewRef.current.x += e.clientX - last.x;
        viewRef.current.y += e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
        moved = true;
        userMoved = true;
      } else if (e.target === canvas) {
        const n = pick(toWorld(e));
        setHover(n?.id ?? null);
        canvas.style.cursor = n ? "pointer" : "grab";
      }
    };
    const onUp = () => {
      if (drag) {
        const n = drag;
        drag = null;
        n.fx = null;
        n.fy = null;
        sim.alphaTarget(0);
        if (!moved) setSelected((s) => (s === n.id ? null : n.id));
      } else if (panning) {
        panning = false;
        if (!moved) setSelected(null);
      }
    };
    const zoomAt = (mx: number, my: number, factor: number) => {
      const v = viewRef.current;
      const k = Math.min(8, Math.max(0.03, v.k * factor));
      v.x = mx - ((mx - v.x) / v.k) * k;
      v.y = my - ((my - v.y) / v.k) * k;
      v.k = k;
      userMoved = true;
    };
    /** Scale and centre so every node is on screen. Capped so a tiny graph is not drawn huge. */
    const fit = () => {
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      if (!nodes.length || W === 0 || H === 0) return;
      // On a big graph, unlinked notes drift far out and would shrink the
      // whole map to a dot, so frame the middle 98% instead of every node.
      const xs = nodes.map((n) => n.x!).filter(Number.isFinite).sort((a, b) => a - b);
      const ys = nodes.map((n) => n.y!).filter(Number.isFinite).sort((a, b) => a - b);
      if (!xs.length) return;
      const trim = small ? 0 : Math.floor(xs.length * 0.01);
      const pad = 12;
      const minX = xs[trim] - pad, maxX = xs[xs.length - 1 - trim] + pad;
      const minY = ys[trim] - pad, maxY = ys[ys.length - 1 - trim] + pad;
      const k = Math.min(small ? 1.6 : 1.2, Math.max(0.03, 0.85 * Math.min(W / Math.max(maxX - minX, 1), H / Math.max(maxY - minY, 1))));
      viewRef.current = { x: W / 2 - ((minX + maxX) / 2) * k, y: H / 2 - ((minY + maxY) / 2) * k, k };
    };
    controlsRef.current = {
      zoom: (f) => zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, f),
      fit: () => {
        fit();
        userMoved = false;
      },
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.002));
    };

    raf = requestAnimationFrame(frame);
    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      sim.stop();
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", resize);
    };
  }, [nodes, links, neighbours, labelled]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of graph.nodes) c[n.group] = (c[n.group] ?? 0) + 1;
    return c;
  }, [graph]);

  const toggleGroup = (g: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const selectedNode = selected ? byId.get(selected) : undefined;
  const selectedNeighbours = selectedNode
    ? [...(neighbours.get(selectedNode.id) ?? [])].map((id) => byId.get(id)!).sort((a, b) => b.degree - a.degree)
    : [];

  return (
    <div ref={wrapRef} className="kg-wrap">
      <canvas ref={canvasRef} className="kg-canvas" />

      <div className="kg-top-left">
        <label className="kg-search">
          <span aria-hidden className="kg-muted">⌕</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a note…" />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="kg-icon">
              ×
            </button>
          )}
        </label>
      </div>

      <div className="kg-top-right kg-card kg-controls" role="toolbar" aria-label="Map controls">
        <button type="button" className="kg-icon" onClick={() => controlsRef.current.zoom(1.25)} title="Zoom in">+</button>
        <button type="button" className="kg-icon" onClick={() => controlsRef.current.zoom(0.8)} title="Zoom out">−</button>
        <button type="button" className="kg-icon kg-fit" onClick={() => controlsRef.current.fit()} title="Fit to screen">Fit</button>
      </div>

      <div className="kg-bottom-left kg-card kg-stats">
        <div>
          <div className="kg-figure">{graph.nodes.length.toLocaleString()}</div>
          <div className="kg-muted">Notes</div>
        </div>
        <div>
          <div className="kg-figure">{graph.links.length.toLocaleString()}</div>
          <div className="kg-muted">Links</div>
        </div>
        {showPerf && perf && (
          <div title="Frames per second, and milliseconds per frame spent on layout and on drawing">
            <div className="kg-figure">{perf.fps} fps</div>
            <div className="kg-muted">
              layout {perf.tickMs} ms · draw {perf.drawMs} ms{perf.settledMs !== null ? " · settled" : ""}
            </div>
          </div>
        )}
      </div>

      <div className="kg-bottom-right kg-legend">
        {graph.groups.map((g) => (
          <button type="button" key={g} onClick={() => toggleGroup(g)} className={`kg-chip${hidden.has(g) ? " kg-off" : ""}`}>
            <span className="kg-dot" style={{ background: hidden.has(g) ? OFF : colours[g] }} />
            {g}
            <span className="kg-muted">{counts[g]}</span>
          </button>
        ))}
      </div>

      {selectedNode && (
        <aside className="kg-panel kg-card">
          <div className="kg-panel-head">
            <span className="kg-dot kg-dot-lg" style={{ background: colours[selectedNode.group] }} />
            <div className="kg-grow">
              <div className="kg-muted">{selectedNode.group}</div>
              <h2>{selectedNode.label}</h2>
              <code className="kg-muted">{selectedNode.id}.md</code>
            </div>
            <button type="button" className="kg-icon" onClick={() => setSelected(null)} aria-label="Close">×</button>
          </div>
          {selectedNode.excerpt && <p className="kg-excerpt">{selectedNode.excerpt}</p>}
          <div className="kg-muted kg-section">{selectedNeighbours.length} linked notes</div>
          <ul className="kg-links">
            {selectedNeighbours.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => setSelected(n.id)}>
                  <span className="kg-dot" style={{ background: colours[n.group] }} />
                  {n.label}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
