import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, Background, Controls, Handle, Position, MiniMap, applyNodeChanges, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphDocument } from "../../modules/graphs/document.js";
import { groupDepth, projectGraph, revealPath, type ViewNode } from "./model.js";
import { arrangeGraph, avoidOverlaps, nodeSize, type Point } from "./layout.js";
import "./styles.css";

interface Snapshot { graphId: string; document: GraphDocument; updatedAt: number; lock: { holderAddress: string | null; laneId: string; lockId: string } | null }
function GraphCard({ data, selected }: NodeProps) {
  const node = data.item as ViewNode;
  return <div className={`graph-card ${node.group ? "group" : "concept"} ${selected ? "selected" : ""}`} style={{ "--accent": node.color } as CSSProperties}>
    <Handle type="target" position={Position.Left} isConnectable={false}/>
    <div className="card-meta"><span>{node.group ? "◈ 分组" : "◇ 节点"}</span>{node.group && <span>{node.children} 项 · {node.internalEdges} 条内部关系</span>}</div>
    <strong title={node.label}>{node.label}</strong><p>{node.summary || (node.group ? "双击聚焦分组" : "点击查看详情")}</p>
    <Handle type="source" position={Position.Right} isConnectable={false}/>
  </div>;
}
const nodeTypes = { graph: GraphCard };
function Canvas(props: { graph: GraphDocument; expanded: Set<string>; focus: string | null; selected: string | null;
  select: (id: string | null) => void; focusGroup: (id: string) => void; zoom: (zoom: number) => void; layoutRequest: number; fitRequest: number }) {
  const view = useMemo(() => projectGraph(props.graph, props.expanded, props.focus), [props.graph, props.expanded, props.focus]);
  const remembered = useRef(new Map<string, Point>()); const previous = useRef(new Set<string>());
  const lastLayout = useRef(props.layoutRequest); const [nodes, setNodes] = useState<Node[]>([]);
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);
  useEffect(() => {
    const fullLayout = props.layoutRequest !== lastLayout.current; lastLayout.current = props.layoutRequest;
    const positions = arrangeGraph(view, remembered.current, fullLayout ? new Set() : previous.current);
    for (const [id, point] of positions) remembered.current.set(id, point);
    previous.current = new Set(view.nodes.map(node => node.id));
    setNodes(current => {
      const existing = new Map(current.map(node => [node.id, node]));
      return view.nodes.map(node => ({ ...existing.get(node.id), id: node.id, type: "graph", position: positions.get(node.id)!, origin: [0.5, 0.5],
        data: { item: node }, ...nodeSize(node), style: nodeSize(node) }));
    });
  }, [view, props.layoutRequest]);
  useEffect(() => {
    if (!instance || !props.fitRequest) return;
    const frame = requestAnimationFrame(() => { void instance.fitView({ padding: 0.18, duration: 250 }); });
    return () => cancelAnimationFrame(frame);
  }, [instance, props.fitRequest]);
  useEffect(() => {
    if (!instance || !props.selected) return;
    const node = instance.getNode(props.selected);
    if (node) void instance.setCenter(node.position.x, node.position.y, { zoom: Math.max(instance.getZoom(), 0.85), duration: 250 });
  }, [instance, props.selected, nodes.length]);
  const edges = view.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, selectable: false,
    label: !edge.hierarchy && (edge.source === props.selected || edge.target === props.selected) ? `${edge.type}${edge.realIds.length > 1 ? ` ×${edge.realIds.length}` : ""}` : edge.realIds.length > 1 ? String(edge.realIds.length) : undefined,
    style: { stroke: edge.hierarchy ? "#42616f" : "#61bcb6", strokeWidth: edge.hierarchy ? 1.3 : Math.min(4, 1.4 + Math.sqrt(edge.realIds.length)), strokeDasharray: edge.hierarchy ? "5 7" : undefined,
      opacity: props.selected && edge.source !== props.selected && edge.target !== props.selected ? 0.15 : 0.65 },
    labelStyle: { fill: "#c9eeee", fontSize: 13 }, labelBgStyle: { fill: "#132330", fillOpacity: 0.95 },
  }));
  const finishDrag = (id: string, point: Point) => {
    const proposed = new Map(nodes.map(node => [node.id, node.position])); proposed.set(id, point);
    const positions = avoidOverlaps(view, proposed, new Set(view.nodes.filter(node => node.id !== id).map(node => node.id)));
    for (const [nodeId, position] of positions) remembered.current.set(nodeId, position);
    setNodes(current => current.map(node => ({ ...node, position: positions.get(node.id) ?? node.position })));
  };
  return <ReactFlow nodes={nodes.map(node => ({ ...node, selected: node.id === props.selected }))} edges={edges} nodeTypes={nodeTypes}
    onInit={setInstance} onNodesChange={changes => setNodes(current => applyNodeChanges(changes, current))}
    onNodeClick={(_, node) => props.select(node.id)} onPaneClick={() => props.select(null)} onNodeDoubleClick={(_, node) => props.focusGroup(node.id)} zoomOnDoubleClick={false}
    onNodeDragStop={(_, node) => finishDrag(node.id, node.position)} onMove={(_, viewport) => props.zoom(viewport.zoom)}
    nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} selectionOnDrag={false} minZoom={0.08} maxZoom={3} fitView fitViewOptions={{ padding: 0.18 }} colorMode="dark">
    <Background color="#27414d" gap={32} size={1}/><Controls showInteractive={false} showFitView={false}/><MiniMap pannable zoomable nodeColor="#3e827f" maskColor="#09131cbf"/>
    {nodes.length === 0 && <div className="empty-canvas">这里还没有节点。<br/>回到 lane，让它为这张图添加内容。</div>}
  </ReactFlow>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0); const [selected, setSelected] = useState<string | null>(null);
  const [manualExpanded, setExpanded] = useState(new Set<string>()); const [focus, setFocus] = useState<string | null>(null);
  const [query, setQuery] = useState(""); const [auto, setAuto] = useState(false); const [threshold, setThreshold] = useState(0.75); const [step, setStep] = useState(0.5);
  const [zoom, setZoom] = useState(1); const [layoutRequest, layout] = useState(0); const [fitRequest, fit] = useState(0);
  const graphId = decodeURIComponent(location.pathname.split("/")[2] ?? "");
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    fetch(`/graphs/api/${encodeURIComponent(graphId)}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? `请求失败 (${response.status})`);
      setSnapshot(body.result); setSelected(current => [...body.result.document.nodes, ...body.result.document.groups].some((item: { id: string }) => item.id === current) ? current : null);
    }).catch(reason => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "无法加载图"); setSnapshot(null); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [graphId, refresh]);
  useEffect(() => { const clear = (event: KeyboardEvent) => { if (event.key === "Escape") { setSelected(null); setQuery(""); } }; window.addEventListener("keydown", clear); return () => window.removeEventListener("keydown", clear); }, []);
  const graph = snapshot?.document;
  const expanded = useMemo(() => {
    // Moving the camera in manual mode must not rebuild or remeasure the graph.
    return auto && graph ? new Set(graph.groups.filter(group => zoom >= threshold + groupDepth(graph, group.id) * step).map(group => group.id)) : manualExpanded;
  }, [auto, graph, zoom, threshold, step, manualExpanded, focus]);
  const toggle = useCallback((id: string) => { if (!graph?.groups.some(group => group.id === id)) return; setAuto(false); setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }, [graph]);
  const reveal = (id: string) => { if (!graph) return; setAuto(false); setFocus(null); setExpanded(revealPath(graph, id)); setSelected(id); setQuery(""); };
  const focusGroup = (id: string) => { if (!graph?.groups.some(group => group.id === id)) return; setFocus(id); setAuto(false); setExpanded(new Set([id])); setSelected(null); fit(value => value + 1); };
  const item = graph ? [...graph.nodes, ...graph.groups].find(node => node.id === selected) : undefined;
  const group = graph?.groups.find(group => group.id === selected);
  const matches = graph && query.trim() ? [...graph.groups, ...graph.nodes].filter(node => `${node.label} ${node.summary ?? ""} ${node.description ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 30) : [];
  const breadcrumbs = graph && focus ? [...revealPath(graph, focus)].reverse().concat(focus) : [];
  return <div className="atlas-app">
    <header><a className="brand" href="/">◈ <span>LANE ROUTER <b>GRAPH ATLAS</b></span></a><div className="graph-heading"><h1>{graph?.title ?? "图资源"}</h1><span className="readonly">只读查看</span></div>
      <button onClick={() => setRefresh(value => value + 1)} disabled={loading}>{loading ? "加载中…" : "刷新图数据"}</button></header>
    <div className="workspace"><aside className="inspector">
      <div className="search"><label htmlFor="graph-search">搜索整个知识网络</label><input id="graph-search" placeholder="节点、分组、描述…" value={query} onChange={event => setQuery(event.target.value)}/>
        {query.trim() && <div className="search-results">{matches.map(node => <button key={node.id} onClick={() => reveal(node.id)}>{node.label}<small>{node.summary}</small></button>)}{matches.length === 0 && <p>没有匹配结果</p>}</div>}</div>
      {item ? <section className="details"><div className="section-label">{group ? "分组详情" : "节点详情"}<button aria-label="取消选择" onClick={() => setSelected(null)}>×</button></div><h2>{item.label}</h2><p className="summary">{item.summary}</p><p className="description">{item.description || "暂无详细描述。可以回到 lane 继续补充。"}</p>
        {group && <div className="actions"><button onClick={() => toggle(group.id)}>{expanded.has(group.id) ? "收起分组" : "展开分组"}</button><button onClick={() => focusGroup(group.id)}>聚焦分组</button></div>}
        {"tags" in item && item.tags?.length ? <div className="tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</div> : null}
        {"sources" in item && item.sources?.map(source => <a className="source" key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">↗ {source.title}</a>)}
        {!group && <div className="relationships"><h3>关联关系</h3>{graph?.edges.filter(edge => edge.source === item.id || edge.target === item.id).map(edge => {
          const other = graph.nodes.find(node => node.id === (edge.source === item.id ? edge.target : edge.source));
          return <div className="relation" key={edge.id}><small>{edge.source === item.id ? "→" : "←"} {edge.type}</small><button onClick={() => other && reveal(other.id)}>{other?.label}</button>{edge.description && <p>{edge.description}</p>}</div>;
        })}</div>}
        <code className="item-id">{item.id}</code></section> : <section className="details"><div className="section-label">网络概览</div><h2>{graph?.title ?? "正在打开图…"}</h2><p className="description">{graph?.description || "从全景发现关系，展开分组探索细节。"}</p><div className="stats"><div><b>{graph?.nodes.length ?? "—"}</b>节点</div><div><b>{graph?.edges.length ?? "—"}</b>关系</div><div><b>{graph?.groups.length ?? "—"}</b>分组</div></div><p className="hint">点击查看详情 · 双击聚焦分组<br/>侧栏展开/收起分组<br/>拖动只调整本次视图<br/>点画布空白处或 Esc 取消选择</p></section>}
      <footer><span className="status-dot"/>{snapshot?.lock ? `写锁：${snapshot.lock.holderAddress ?? snapshot.lock.laneId}` : "当前没有写锁"}<p>内容由 lane 更新。刷新后查看最新保存结果。</p>{snapshot && <small>更新于 {new Date(snapshot.updatedAt).toLocaleString()}</small>}{snapshot?.lock && <details><summary>锁恢复命令</summary><code>lane-router-lane graph force-unlock --id {graphId} --expected-lock {snapshot.lock.lockId}</code></details>}</footer>
    </aside><main className="graph-main"><nav className="view-toolbar"><div className="breadcrumbs"><button onClick={() => { setFocus(null); setExpanded(new Set()); setAuto(false); setSelected(null); fit(value => value + 1); }}>全景</button>{breadcrumbs.map(id => <button key={id} onClick={() => focusGroup(id)}> / {graph?.groups.find(g => g.id === id)?.label}</button>)}</div><div><button onClick={() => layout(value => value + 1)}>自动排版</button><button onClick={() => fit(value => value + 1)}>适应画布</button></div></nav>
      <div className="canvas">{error ? <div role="alert" className="error">无法打开这张图<p>{error}</p><button onClick={() => setRefresh(value => value + 1)}>重试</button></div> : graph ? <Canvas graph={graph} expanded={expanded} focus={focus} selected={selected} select={setSelected} focusGroup={focusGroup} zoom={setZoom} layoutRequest={layoutRequest} fitRequest={fitRequest}/> : <div className="empty-canvas">加载图数据…</div>}</div>
      <div className="view-settings"><label><input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)}/>缩放自动展开</label><label>首层 <input aria-label="首层展开缩放" type="number" min="0.1" max="3" step="0.05" value={threshold} onChange={event => setThreshold(Math.max(0.1, Math.min(3, Number(event.target.value) || 0.75)))}/></label><label>每层增加 <input aria-label="每层缩放增量" type="number" min="0.1" max="2" step="0.1" value={step} onChange={event => setStep(Math.max(0.1, Math.min(2, Number(event.target.value) || 0.5)))}/></label><span>{Math.round(zoom * 100)}%</span></div>
    </main></div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
