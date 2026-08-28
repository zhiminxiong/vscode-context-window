//@ts-check

const NODE_W = 168;
const NODE_H = 52;
const COMPACT_H = 38;
const MORE_H = 36;
const NAME_H = 22;
const NAME_MIN_W = 24;
const COL_GAP = 88;
const ROW_GAP = 14;
const COMPACT_GAP = 8;
const PAD = 40;

/** @type {{ rootId: string, ox: number, oy: number } | null} */
let savedView = null;
/** @type {Record<string, { x: number, y: number, h: number, w: number, hop?: number, parentId?: string }> | null} */
let lastPos = null;
const ARROW_LEN = 8;
const TIP_GAP = 6;

/** @type {{ postMessage: (msg: any) => void, getState: () => any, setState: (s: any) => void }} */
const vscode = acquireVsCodeApi();

const titleEl = document.getElementById('cr-title');
const stage = document.getElementById('cr-stage');
const emptyEl = document.getElementById('cr-empty');
const pinBtn = document.getElementById('cr-pin');
const updateBtn = document.getElementById('cr-update');
const styleBtn = document.getElementById('cr-style');
const zoomInBtn = document.getElementById('cr-zoom-in');
const zoomOutBtn = document.getElementById('cr-zoom-out');
const zoomLabel = document.getElementById('cr-zoom-label');

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.15;
let zoom = 1;
let layoutW = 0;
let layoutH = 0;
/** @type {HTMLElement | null} */
let canvasEl = null;
/** @type {HTMLElement | null} */
let zoomWrap = null;

/** @type {any} */
let lastGraph = null;
/** @type {string} */
let selectedKey = '';
/** Alt+click 钉住的节点 id；空串表示未钉路径。 */
let pinnedNodeId = '';
/** @type {'elbow' | 'direct' | 'arc'} */
let edgeStyle = 'arc';
/** @type {Set<string>} */
let nameOnlyIds = new Set();
try {
    const saved = vscode.getState();
    if (saved && (saved.edgeStyle === 'direct' || saved.edgeStyle === 'arc' || saved.edgeStyle === 'elbow')) {
        edgeStyle = saved.edgeStyle;
    }
    if (saved && Array.isArray(saved.nameOnlyIds)) {
        nameOnlyIds = new Set(saved.nameOnlyIds);
    }
    if (saved && typeof saved.zoom === 'number' && saved.zoom > 0) {
        zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, saved.zoom));
    }
} catch (_) { /* noop */ }

function normalizeEdgeStyle(value) {
    return value === 'direct' || value === 'elbow' ? value : 'arc';
}

function isSpreadStyle(value) {
    return value === 'direct' || value === 'arc';
}

/** AAAA.bbbb / ns::foo / foo() → 只留最末一段标识符。 */
function shortSymbolName(name) {
    const ident = String(name || '').replace(/\(.*\)$/, '').trim();
    if (!ident) {
        return name || '';
    }
    const last = ident.split(/::|\./).filter(Boolean).pop();
    return last || ident;
}

function nodeLabel(node) {
    if (!node || node.kind !== 'symbol') {
        return (node && node.name) || '';
    }
    return shortSymbolName(node.name);
}

function nodeHeight(node, rootId) {
    if (node.kind === 'more') {
        return node.compact ? 30 : MORE_H;
    }
    if (node.id === rootId) {
        return 64;
    }
    if (nameOnlyIds.has(node.id)) {
        return NAME_H;
    }
    return node.compact ? COMPACT_H : NODE_H;
}

let measureEl = null;
function measureNameWidth(text, fontSize, bold) {
    if (!measureEl) {
        measureEl = document.createElement('span');
        measureEl.setAttribute('aria-hidden', 'true');
        measureEl.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;';
        document.body.appendChild(measureEl);
    }
    const style = getComputedStyle(document.body);
    measureEl.style.fontFamily = style.fontFamily || 'sans-serif';
    measureEl.style.fontSize = fontSize + 'px';
    measureEl.style.fontWeight = bold ? '700' : '600';
    measureEl.textContent = text || '';
    return measureEl.getBoundingClientRect().width;
}

function nodeWidth(node, rootId) {
    if (node.id === rootId) {
        const textW = measureNameWidth(nodeLabel(node), 16, true);
        const padX = 20;
        const borderX = 2;
        const slack = 8;
        return Math.max(NODE_W, Math.ceil(textW + padX + borderX + slack));
    }
    if (!nameOnlyIds.has(node.id)) {
        return NODE_W;
    }
    const fontSize = 13;
    const textW = measureNameWidth(nodeLabel(node), fontSize, true);
    const padX = 16;
    const borderX = 2;
    const thumb = 12;
    const gap = 4;
    return Math.min(NODE_W, Math.max(NAME_MIN_W, Math.ceil(textW + padX + borderX + thumb + gap)));
}

function nodeW(p) {
    return p && p.w ? p.w : NODE_W;
}

function nodeGap(node) {
    return node.compact ? COMPACT_GAP : ROW_GAP;
}

function layout(graph, viewW, viewH) {
    /** @type {Record<string, { x: number, y: number, h: number, w: number, hop?: number, parentId?: string }>} */
    const pos = {};
    const byHop = new Map();
    for (const node of graph.nodes) {
        if (!byHop.has(node.hop)) {
            byHop.set(node.hop, []);
        }
        byHop.get(node.hop).push(node);
    }
    const hops = [...byHop.keys()].sort((a, b) => a - b);
    const centers = (byHop.get(0) || []).filter(n => n.kind === 'symbol');
    const root = graph.nodes.find(n => n.id === graph.rootId);
    const orderedCenters = [];
    if (root) {
        orderedCenters.push(root);
    }
    for (const n of centers) {
        if (!orderedCenters.some(c => c.id === n.id)) {
            orderedCenters.push(n);
        }
    }
    const rootW = root ? nodeWidth(root, graph.rootId) : NODE_W;
    const rootExtra = Math.max(0, rootW - NODE_W);
    const prevRoot = lastPos && graph.rootId ? lastPos[graph.rootId] : null;
    let centerY = 0;
    for (const n of orderedCenters) {
        const h = nodeHeight(n, graph.rootId);
        const w = nodeWidth(n, graph.rootId);
        pos[n.id] = { x: 0, y: centerY, h, w, hop: n.hop, parentId: n.parentId };
        centerY += h + ROW_GAP;
    }

    function placeHop(hop) {
        const col = byHop.get(hop) || [];
        const parentHop = hop < 0 ? hop + 1 : hop - 1;
        const parents = (byHop.get(parentHop) || [])
            .filter(n => pos[n.id])
            .sort((a, b) => pos[a.id].y - pos[b.id].y);
        const groups = [];
        const assigned = new Set();
        for (const parent of parents) {
            const kids = col.filter(n => n.parentId === parent.id);
            if (kids.length) {
                groups.push({ parent, kids });
                for (const kid of kids) {
                    assigned.add(kid.id);
                }
            }
        }
        const orphans = col.filter(n => !assigned.has(n.id));
        if (orphans.length) {
            groups.push({ parent: null, kids: orphans });
        }
        const prevAtHop = lastPos
            ? Object.values(lastPos).filter(p => p.hop === hop).length
            : 0;
        // Keep first-child Y only when this column grew (expand / show more).
        // On collapse the column shrinks; sticky Y would leave holes and stale arrows.
        const columnGrew = col.length >= prevAtHop;
        let prevBottom = -Infinity;
        for (const group of groups) {
            const block = group.kids.reduce((sum, n) => sum + nodeHeight(n, graph.rootId) + nodeGap(n), 0)
                - (group.kids.length ? nodeGap(group.kids[group.kids.length - 1]) : 0);
            const parentY = group.parent && pos[group.parent.id] ? pos[group.parent.id].y : 0;
            const parentH = group.parent && pos[group.parent.id] ? pos[group.parent.id].h : NODE_H;
            const first = group.kids[0];
            const prevFirst = first && prevRoot && lastPos[first.id];
            const sameSlot = !!(columnGrew
                && prevFirst
                && prevFirst.hop === first.hop
                && prevFirst.parentId === first.parentId);
            let y = sameSlot
                ? lastPos[first.id].y - prevRoot.y
                : parentY + parentH / 2 - block / 2;
            if (prevBottom > -Infinity) {
                y = Math.max(y, prevBottom + ROW_GAP);
            }
            for (const kid of group.kids) {
                const h = nodeHeight(kid, graph.rootId);
                const w = nodeWidth(kid, graph.rootId);
                const colX = hop * (NODE_W + COL_GAP) + (hop > 0 ? rootExtra : 0);
                pos[kid.id] = {
                    x: colX,
                    y,
                    h,
                    w,
                    hop: kid.hop,
                    parentId: kid.parentId
                };
                y += h + nodeGap(kid);
            }
            const last = group.kids[group.kids.length - 1];
            prevBottom = pos[last.id].y + pos[last.id].h;
        }
    }

    for (let hop = -1; hop >= hops[0]; hop--) {
        placeHop(hop);
    }
    for (let hop = 1; hop <= hops[hops.length - 1]; hop++) {
        placeHop(hop);
    }

    const rootPos = root ? pos[root.id] : null;
    const rootCX = rootPos ? rootPos.x + nodeW(rootPos) / 2 : 0;
    const rootCY = rootPos ? rootPos.y + rootPos.h / 2 : 0;
    let left = 0;
    let right = NODE_W / 2;
    let top = 0;
    let bottom = NODE_H / 2;
    for (const p of Object.values(pos)) {
        left = Math.max(left, rootCX - p.x);
        right = Math.max(right, p.x + nodeW(p) - rootCX);
        top = Math.max(top, rootCY - p.y);
        bottom = Math.max(bottom, p.y + p.h - rootCY);
    }
    const marginX = Math.max(PAD, viewW / 2);
    const marginY = Math.max(PAD, viewH / 2);
    const width = left + right + marginX * 2;
    const height = top + bottom + marginY * 2;
    const dx = marginX + left - rootCX;
    const dy = marginY + top - rootCY;
    for (const p of Object.values(pos)) {
        p.x += dx;
        p.y += dy;
    }
    return {
        pos,
        width,
        height
    };
}

function nodeById(graph, id) {
    return graph.nodes.find(n => n.id === id);
}

function drawGroupFrames(canvas, graph, pos) {
    const padX = 10;
    const stroke = 2;
    for (const group of graph.nodes) {
        if (group.kind !== 'group' || !group.expanded) {
            continue;
        }
        const boxed = graph.nodes.filter(n => (
            n.id === group.id
            || (n.kind === 'symbol'
                && n.parentId === group.parentId
                && n.hop === group.hop
                && n.file === group.file)
        ));
        const boxedIds = new Set(boxed.map(n => n.id));
        let left = Infinity;
        let boxTop = Infinity;
        let right = -Infinity;
        let boxBottom = -Infinity;
        for (const n of boxed) {
            const p = pos[n.id];
            if (!p) {
                continue;
            }
            left = Math.min(left, p.x);
            boxTop = Math.min(boxTop, p.y);
            right = Math.max(right, p.x + nodeW(p));
            boxBottom = Math.max(boxBottom, p.y + p.h);
        }
        if (!isFinite(left) || boxed.length < 2) {
            continue;
        }
        let aboveBottom = -Infinity;
        let belowTop = Infinity;
        for (const n of graph.nodes) {
            if (boxedIds.has(n.id) || n.hop !== group.hop) {
                continue;
            }
            const p = pos[n.id];
            if (!p) {
                continue;
            }
            const nBottom = p.y + p.h;
            const nTop = p.y;
            if (nBottom <= boxTop && nBottom > aboveBottom) {
                aboveBottom = nBottom;
            }
            if (nTop >= boxBottom && nTop < belowTop) {
                belowTop = nTop;
            }
        }
        const midTop = aboveBottom > -Infinity
            ? (aboveBottom + boxTop) / 2
            : boxTop - ROW_GAP / 2;
        const midBottom = belowTop < Infinity
            ? (boxBottom + belowTop) / 2
            : boxBottom + ROW_GAP / 2;
        const top = midTop - stroke / 2;
        const bottom = midBottom + stroke / 2;
        const frame = document.createElement('div');
        frame.className = 'cr-group-frame';
        frame.style.left = (left - padX) + 'px';
        frame.style.top = top + 'px';
        frame.style.width = (right - left + padX * 2) + 'px';
        frame.style.height = (bottom - top) + 'px';
        canvas.appendChild(frame);
    }
}

function edgeHubId(graph, edge) {
    const from = nodeById(graph, edge.from);
    const to = nodeById(graph, edge.to);
    return Math.abs(to?.hop || 0) > Math.abs(from?.hop || 0) ? edge.from : edge.to;
}

function arrowMarker(id, className) {
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', id);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '0');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', String(ARROW_LEN));
    marker.setAttribute('markerHeight', String(ARROW_LEN));
    marker.setAttribute('markerUnits', 'userSpaceOnUse');
    marker.setAttribute('orient', 'auto');
    marker.setAttribute('overflow', 'visible');
    const tip = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tip.setAttribute('d', 'M 0 1.2 L 10 5 L 0 8.8 z');
    tip.setAttribute('class', className);
    marker.appendChild(tip);
    return marker;
}

function persistViewState() {
    try {
        const saved = vscode.getState() || {};
        saved.edgeStyle = edgeStyle;
        saved.nameOnlyIds = [...nameOnlyIds];
        saved.zoom = zoom;
        vscode.setState(saved);
    } catch (_) { /* noop */ }
}

function dropDescendants(graph, nodeId) {
    const drop = new Set([nodeId]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const n of graph.nodes) {
            if (n.parentId && drop.has(n.parentId) && !drop.has(n.id)) {
                drop.add(n.id);
                grew = true;
            }
        }
    }
    drop.delete(nodeId);
    return {
        ...graph,
        nodes: graph.nodes.filter(n => !drop.has(n.id)),
        edges: (graph.edges || []).filter(e => !drop.has(e.from) && !drop.has(e.to))
    };
}

function toggleNameOnly(node) {
    if (lastGraph && node.id === lastGraph.rootId) {
        return;
    }
    const on = !nameOnlyIds.has(node.id);
    if (on) {
        nameOnlyIds.add(node.id);
        if (lastGraph) {
            lastGraph = dropDescendants(lastGraph, node.id);
        }
        if (node.kind === 'group' && node.expanded) {
            vscode.postMessage({ type: 'toggleGroup', nodeId: node.id });
        } else {
            vscode.postMessage({ type: 'collapseHop', nodeId: node.id });
        }
    } else {
        nameOnlyIds.delete(node.id);
    }
    persistViewState();
    if (lastGraph) {
        render(lastGraph);
    }
}

function bindControlTip(node, nodeEl, btn, label) {
    btn.addEventListener('pointerenter', ev => {
        ev.stopPropagation();
        tipMoveX = ev.clientX;
        tipMoveY = ev.clientY;
        hideNodeTip();
        armLabelTip(label, btn, node.hop);
    });
    btn.addEventListener('pointermove', ev => {
        ev.stopPropagation();
        onTipMove(ev, { label, el: btn, hop: node.hop });
    });
    btn.addEventListener('pointerleave', ev => {
        ev.stopPropagation();
        tipHover = null;
        hideNodeTip();
        const next = ev.relatedTarget;
        if (next && nodeEl.contains(next) && !(next.closest && next.closest('.cr-thumb, .cr-toggle'))) {
            tipMoveX = ev.clientX;
            tipMoveY = ev.clientY;
            if (usesNodeTip(node)) {
                armNodeTip(node, nodeEl);
            }
        }
    });
}

function addThumb(el, head, node) {
    if (lastGraph && node.id === lastGraph.rootId) {
        return;
    }
    const names = nameOnlyIds.has(node.id);
    if (names) {
        el.classList.add('is-names');
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cr-thumb' + (names ? ' is-on' : '');
    btn.textContent = names ? '>' : '<';
    const label = names ? 'Restore file and line' : 'Show name only';
    btn.setAttribute('aria-label', label);
    btn.addEventListener('pointerdown', ev => ev.stopPropagation());
    bindControlTip(node, el, btn, label);
    btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        hideNodeTip();
        toggleNameOnly(node);
    });
    head.appendChild(btn);
}

function persistEdgeStyle() {
    persistViewState();
}

function pathFocusIds(graph, nodeId) {
    if (!graph || !nodeId) {
        return null;
    }
    const byId = new Map();
    for (const n of graph.nodes) {
        byId.set(n.id, n);
    }
    if (!byId.has(nodeId)) {
        return null;
    }
    const ids = new Set();
    let cur = byId.get(nodeId);
    while (cur) {
        ids.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    for (const n of graph.nodes) {
        if (n.parentId === nodeId) {
            ids.add(n.id);
        }
    }
    return ids;
}

function createPathPinBadge() {
    const badge = document.createElement('span');
    badge.className = 'cr-path-pin';
    badge.setAttribute('aria-hidden', 'true');
    badge.title = 'Path pinned — Alt+click to unpin';
    badge.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 1a4.2 4.2 0 0 0-4.2 4.2c0 3.1 3.5 8.3 4.2 9.1.7-.8 4.2-6 4.2-9.1A4.2 4.2 0 0 0 8 1zm0 5.8A1.6 1.6 0 1 1 8 3.6a1.6 1.6 0 0 1 0 3.2z"/></svg>';
    return badge;
}

function applyPathFocus() {
    const canvas = canvasEl;
    if (!canvas) {
        return;
    }
    if (pinnedNodeId && lastGraph && pinnedNodeId === lastGraph.rootId) {
        pinnedNodeId = '';
    }
    let ids = pinnedNodeId && lastGraph ? pathFocusIds(lastGraph, pinnedNodeId) : null;
    if (pinnedNodeId && !ids) {
        pinnedNodeId = '';
        ids = null;
    }
    const focus = !!(pinnedNodeId && ids);
    canvas.classList.toggle('is-focus', focus);
    canvas.querySelectorAll('.cr-node').forEach(el => {
        const id = el.dataset.nodeId || '';
        const onPath = !!(focus && ids && ids.has(id));
        const isPin = !!(focus && id === pinnedNodeId);
        el.classList.toggle('is-on-path', onPath);
        el.classList.toggle('is-path-pin', isPin);
        const badge = el.querySelector('.cr-path-pin');
        if (isPin) {
            if (!badge) {
                el.appendChild(createPathPinBadge());
            }
        } else if (badge) {
            badge.remove();
        }
    });
    canvas.querySelectorAll('.cr-edge-group').forEach(g => {
        const from = g.getAttribute('data-from') || '';
        const to = g.getAttribute('data-to') || '';
        g.classList.toggle('is-on-path', !!(focus && ids && ids.has(from) && ids.has(to)));
    });
}

function togglePathPin(nodeId) {
    if (!nodeId || (lastGraph && nodeId === lastGraph.rootId)) {
        clearPathPin();
        return;
    }
    pinnedNodeId = pinnedNodeId === nodeId ? '' : nodeId;
    applyPathFocus();
}

function clearPathPin() {
    if (!pinnedNodeId) {
        return;
    }
    pinnedNodeId = '';
    applyPathFocus();
}

const EDGE_STYLE_ITEMS = [
    { id: 'arc', label: 'Arc' },
    { id: 'direct', label: 'Direct' },
    { id: 'elbow', label: 'Elbow' }
];

function edgeStyleLabel(value) {
    const item = EDGE_STYLE_ITEMS.find(s => s.id === value);
    return item ? item.label : 'Arc';
}

function syncStyleBtn() {
    if (!styleBtn) {
        return;
    }
    styleBtn.classList.add('is-on');
    styleBtn.textContent = edgeStyleLabel(edgeStyle);
}

function applyEdgeStyle(next) {
    const value = normalizeEdgeStyle(next);
    if (value === edgeStyle) {
        syncStyleBtn();
        return;
    }
    edgeStyle = value;
    persistEdgeStyle();
    syncStyleBtn();
    if (lastGraph) {
        render(lastGraph);
    }
}

function spreadY(y, h, index, count) {
    const pad = Math.min(14, Math.max(7, h * 0.18));
    if (count <= 1) {
        return y + h / 2;
    }
    const usable = Math.max(h - pad * 2, 4);
    return y + pad + usable * (index / (count - 1));
}

function edgeKey(edge) {
    return edge.from + '\0' + edge.to;
}

function edgePorts(graph, pos) {
    /** @type {Record<string, { sameCol: boolean, x1: number, y1: number, x2: number, y2: number }>} */
    const ports = {};
    /** @type {Map<string, any[]>} */
    const outgoing = new Map();
    /** @type {Map<string, any[]>} */
    const incoming = new Map();
    for (const edge of graph.edges) {
        const a = pos[edge.from];
        const b = pos[edge.to];
        if (!a || !b) {
            continue;
        }
        if (Math.abs(a.x - b.x) < 1) {
            ports[edgeKey(edge)] = columnEnds(a, b);
            continue;
        }
        if (!outgoing.has(edge.from)) {
            outgoing.set(edge.from, []);
        }
        outgoing.get(edge.from).push(edge);
        if (!incoming.has(edge.to)) {
            incoming.set(edge.to, []);
        }
        incoming.get(edge.to).push(edge);
    }
    const rank = (map, otherId) => {
        const ranked = new Map();
        for (const [id, list] of map) {
            list.sort((e1, e2) => {
                const p1 = pos[e1[otherId]];
                const p2 = pos[e2[otherId]];
                return (p1?.y ?? 0) - (p2?.y ?? 0);
            });
            list.forEach((edge, i) => {
                ranked.set(edgeKey(edge), { i, n: list.length });
            });
        }
        return ranked;
    };
    const outRank = rank(outgoing, 'to');
    const inRank = rank(incoming, 'from');
    for (const edge of graph.edges) {
        const key = edgeKey(edge);
        if (ports[key]) {
            continue;
        }
        const a = pos[edge.from];
        const b = pos[edge.to];
        if (!a || !b) {
            continue;
        }
        const leftToRight = a.x <= b.x;
        const fromPort = outRank.get(key) || { i: 0, n: 1 };
        const toPort = inRank.get(key) || { i: 0, n: 1 };
        ports[key] = {
            sameCol: false,
            x1: leftToRight ? a.x + nodeW(a) : a.x,
            y1: spreadY(a.y, a.h, fromPort.i, fromPort.n),
            x2: leftToRight ? b.x - TIP_GAP : b.x + nodeW(b) + TIP_GAP,
            y2: spreadY(b.y, b.h, toPort.i, toPort.n)
        };
    }
    return ports;
}

function columnEnds(a, b) {
    const x = a.x + nodeW(a) / 2;
    const down = a.y <= b.y;
    return {
        sameCol: true,
        x1: x,
        y1: down ? a.y + a.h : a.y,
        x2: x,
        y2: down ? b.y - TIP_GAP : b.y + b.h + TIP_GAP
    };
}

function stopBeforeTip(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const back = Math.min(ARROW_LEN, len * 0.45);
    return {
        x: x2 - dx / len * back,
        y: y2 - dy / len * back
    };
}

function directPath(x1, y1, x2, y2) {
    const end = stopBeforeTip(x1, y1, x2, y2);
    return `M ${x1} ${y1} L ${end.x} ${end.y}`;
}

function arcPath(x1, y1, x2, y2) {
    const dir = x2 >= x1 ? 1 : -1;
    const xBase = x2 - dir * ARROW_LEN;
    const span = xBase - x1;
    const pull = Math.max(28, Math.abs(span) * 0.48);
    const c1x = x1 + dir * pull;
    const c2x = xBase - dir * pull;
    return `M ${x1} ${y1} C ${c1x} ${y1} ${c2x} ${y2} ${xBase} ${y2}`;
}

function centerEnds(a, b) {
    if (Math.abs(a.x - b.x) < 1) {
        return columnEnds(a, b);
    }
    const leftToRight = a.x <= b.x;
    return {
        sameCol: false,
        x1: leftToRight ? a.x + nodeW(a) : a.x,
        y1: a.y + a.h / 2,
        x2: leftToRight ? b.x - TIP_GAP : b.x + nodeW(b) + TIP_GAP,
        y2: b.y + b.h / 2
    };
}

function edgePath(graph, edge, pos, ports) {
    const a = pos[edge.from];
    const b = pos[edge.to];
    if (!a || !b) {
        return '';
    }
    if (isSpreadStyle(edgeStyle)) {
        const p = ports[edgeKey(edge)];
        if (!p) {
            return '';
        }
        return edgeStyle === 'arc'
            ? arcPath(p.x1, p.y1, p.x2, p.y2)
            : directPath(p.x1, p.y1, p.x2, p.y2);
    }
    const p = centerEnds(a, b);
    if (p.sameCol) {
        const end = stopBeforeTip(p.x1, p.y1, p.x2, p.y2);
        return `M ${p.x1} ${p.y1} L ${end.x} ${end.y}`;
    }
    const hubId = edgeHubId(graph, edge);
    const hubPos = pos[hubId] || a;
    const childPos = hubId === edge.from ? b : a;
    return orthoPath(p.x1, p.y1, p.x2, p.y2, busXForHub(hubPos, childPos));
}

function busXForHub(hubPos, childPos) {
    const gap = 28;
    if (childPos.x >= hubPos.x) {
        return hubPos.x + nodeW(hubPos) + gap;
    }
    return hubPos.x - gap;
}

function orthoPath(x1, y1, x2, y2, busX) {
    const dir = x2 >= x1 ? 1 : -1;
    const xEnd = x2 - dir * ARROW_LEN;
    if (Math.abs(y1 - y2) < 0.5) {
        return `M ${x1} ${y1} L ${xEnd} ${y2}`;
    }
    const r = Math.min(7, Math.abs(busX - x1), Math.abs(xEnd - busX), Math.abs(y2 - y1) / 2);
    if (r < 1.5) {
        return `M ${x1} ${y1} L ${busX} ${y1} L ${busX} ${y2} L ${xEnd} ${y2}`;
    }
    const down = y2 > y1;
    const toRight = xEnd > busX;
    const fromRight = x1 > busX;
    const yCorner1 = down ? y1 + r : y1 - r;
    const yCorner2 = down ? y2 - r : y2 + r;
    const xEnter = fromRight ? busX + r : busX - r;
    const xLeave = toRight ? busX + r : busX - r;
    return `M ${x1} ${y1} L ${xEnter} ${y1} Q ${busX} ${y1} ${busX} ${yCorner1} L ${busX} ${yCorner2} Q ${busX} ${y2} ${xLeave} ${y2} L ${xEnd} ${y2}`;
}

function hideSiteMenu() {
    const old = document.querySelector('.cr-site-menu');
    if (old && old.parentNode) {
        old.parentNode.removeChild(old);
    }
}

/** 与 VS Code workbench.hover.delay 对齐；Windows 默认 500ms，macOS 1500ms。 */
let tipDelayMs = 500;
let nodeTipEl = null;
let nodeTipTimer = 0;
let nodeTipAnchor = null;
let lastTipNodeId = '';
let tipHover = null;
let tipMoveX = 0;
let tipMoveY = 0;

function hideNodeTip() {
    if (nodeTipTimer) {
        clearTimeout(nodeTipTimer);
        nodeTipTimer = 0;
    }
    if (nodeTipEl && nodeTipEl.parentNode) {
        nodeTipEl.parentNode.removeChild(nodeTipEl);
    }
    nodeTipEl = null;
    nodeTipAnchor = null;
    lastTipNodeId = '';
}

function armTip(spec) {
    if (nodeTipTimer) {
        clearTimeout(nodeTipTimer);
    }
    tipHover = spec;
    nodeTipTimer = setTimeout(() => {
        nodeTipTimer = 0;
        if (tipHover && tipHover.el === spec.el) {
            showTip(spec);
        }
    }, tipDelayMs);
}

function armNodeTip(node, el) {
    armTip({ node, el });
}

function armLabelTip(label, el, hop) {
    armTip({ label, el, hop });
}

function onTipMove(ev, spec) {
    if (ev.clientX === tipMoveX && ev.clientY === tipMoveY) {
        return;
    }
    tipMoveX = ev.clientX;
    tipMoveY = ev.clientY;
    if (nodeTipEl) {
        hideNodeTip();
    }
    armTip(spec);
}

function onNodeTipMove(ev, node, el) {
    onTipMove(ev, { node, el });
}

function usesNodeTip(node) {
    return !!node && (node.kind === 'symbol' || node.kind === 'group' || node.kind === 'more');
}

function fillNodeTip(tip, node) {
    while (tip.firstChild) {
        tip.removeChild(tip.firstChild);
    }
    const name = document.createElement('div');
    name.className = 'cr-node-tip-name';
    name.textContent = node.name || '';
    tip.appendChild(name);
    if (node.kind === 'more') {
        const detail = document.createElement('div');
        detail.className = 'cr-node-tip-detail';
        const n = node.moreCount || 0;
        detail.textContent = n
            ? `Show ${n} more sibling${n === 1 ? '' : 's'}`
            : 'Show more siblings';
        tip.appendChild(detail);
        return;
    }
    if (node.kind === 'group') {
        const detail = document.createElement('div');
        detail.className = 'cr-node-tip-detail';
        const n = node.moreCount || 0;
        detail.textContent = node.expanded
            ? `Hide ${n} library symbol${n === 1 ? '' : 's'}`
            : (node.detail || `${n} library symbols`);
        tip.appendChild(detail);
        return;
    }
    if (node.detail) {
        const detail = document.createElement('div');
        detail.className = 'cr-node-tip-detail';
        detail.textContent = node.detail;
        tip.appendChild(detail);
    }
    if (node.file || node.path) {
        const sep = document.createElement('div');
        sep.className = 'cr-node-tip-sep';
        tip.appendChild(sep);
        const file = document.createElement('div');
        file.className = 'cr-node-tip-file';
        file.textContent = node.file
            ? `${node.file}:${node.line}`
            : `${node.path}:${node.line}`;
        tip.appendChild(file);
        if (node.path) {
            const loc = document.createElement('div');
            loc.className = 'cr-node-tip-path';
            loc.textContent = node.path;
            tip.appendChild(loc);
        }
    }
}

function placeNodeTip(tip, anchorEl, hop) {
    const r = anchorEl.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const pad = 8;
    const caret = 7;
    const gap = 6;
    const needV = th + gap + caret;
    const needH = tw + gap + caret;
    const spaceAbove = r.top - pad;
    const spaceBelow = window.innerHeight - r.bottom - pad;
    const spaceLeft = r.left - pad;
    const spaceRight = window.innerWidth - r.right - pad;
    /** @type {'above' | 'below' | 'left' | 'right'} */
    let side = 'below';
    if (spaceAbove >= needV) {
        side = 'above';
    } else if (spaceBelow >= needV) {
        side = 'below';
    } else if (hop < 0 && spaceLeft >= needH) {
        side = 'left';
    } else if (hop > 0 && spaceRight >= needH) {
        side = 'right';
    } else if (spaceLeft >= needH) {
        side = 'left';
    } else if (spaceRight >= needH) {
        side = 'right';
    } else {
        side = spaceAbove >= spaceBelow ? 'above' : 'below';
    }
    let left = r.left;
    let top = r.top;
    if (side === 'above') {
        left = r.left + r.width / 2 - tw / 2;
        top = r.top - gap - caret - th;
    } else if (side === 'below') {
        left = r.left + r.width / 2 - tw / 2;
        top = r.bottom + gap + caret;
    } else if (side === 'left') {
        left = r.left - gap - caret - tw;
        top = r.top + r.height / 2 - th / 2;
    } else {
        left = r.right + gap + caret;
        top = r.top + r.height / 2 - th / 2;
    }
    left = Math.min(Math.max(pad, left), window.innerWidth - tw - pad);
    top = Math.min(Math.max(pad, top), window.innerHeight - th - pad);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.classList.remove('is-above', 'is-below', 'is-left', 'is-right');
    tip.classList.add('is-' + side);
    if (side === 'above' || side === 'below') {
        const x = Math.min(Math.max(14, r.left + r.width / 2 - left), tw - 14);
        tip.style.setProperty('--cr-tip-caret', x + 'px');
    } else {
        const y = Math.min(Math.max(14, r.top + r.height / 2 - top), th - 14);
        tip.style.setProperty('--cr-tip-caret', y + 'px');
    }
}

function fillLabelTip(tip, text) {
    while (tip.firstChild) {
        tip.removeChild(tip.firstChild);
    }
    const name = document.createElement('div');
    name.className = 'cr-node-tip-label';
    name.textContent = text;
    tip.appendChild(name);
}

function showTip(spec) {
    if (nodeTipTimer) {
        clearTimeout(nodeTipTimer);
        nodeTipTimer = 0;
    }
    nodeTipAnchor = spec.el;
    lastTipNodeId = spec.node ? spec.node.id : '';
    if (!nodeTipEl) {
        nodeTipEl = document.createElement('div');
        nodeTipEl.className = 'cr-node-tip';
        document.body.appendChild(nodeTipEl);
    }
    nodeTipEl.classList.toggle('is-label', !!spec.label);
    if (spec.label) {
        fillLabelTip(nodeTipEl, spec.label);
        placeNodeTip(nodeTipEl, spec.el, spec.hop);
    } else {
        fillNodeTip(nodeTipEl, spec.node);
        placeNodeTip(nodeTipEl, spec.el, spec.node.hop);
    }
}

function showNodeTip(node, anchorEl) {
    showTip({ node, el: anchorEl });
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function identName(name) {
    return (name || '').replace(/\(.*\)$/, '').split(/::|\./).pop() || name || '';
}

function snippetHtml(site) {
    const raw = site.snippet || '';
    const ident = identName(site.name);
    if (!raw) {
        return '<span class="cr-site-snippet is-empty">No preview</span>';
    }
    const idx = ident ? raw.indexOf(ident) : -1;
    if (idx < 0) {
        return `<span class="cr-site-snippet">${escapeHtml(raw)}</span>`;
    }
    return `<span class="cr-site-snippet">${escapeHtml(raw.slice(0, idx))}<em>${escapeHtml(ident)}</em>${escapeHtml(raw.slice(idx + ident.length))}</span>`;
}

function eventOnCanvas(ev, canvas) {
    const r = canvas.getBoundingClientRect();
    return {
        x: (ev.clientX - r.left) / zoom,
        y: (ev.clientY - r.top) / zoom
    };
}

function openCallSite(edge, index) {
    vscode.postMessage({
        type: 'openCallSite',
        fromId: edge.from,
        toId: edge.to,
        index
    });
}

function showSitePicker(canvas, x, y, edge) {
    hideSiteMenu();
    const sites = edge.sites || [];
    const menu = document.createElement('div');
    menu.className = 'cr-site-menu';
    const head = document.createElement('div');
    head.className = 'cr-site-head';
    head.textContent = `${sites.length} call site${sites.length === 1 ? '' : 's'}`;
    menu.appendChild(head);
    sites.forEach((site, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'cr-site-item';
        const loc = document.createElement('div');
        loc.className = 'cr-site-loc';
        loc.textContent = `${site.file || 'file'}:${site.line + 1}`;
        item.appendChild(loc);
        const snip = document.createElement('div');
        snip.className = 'cr-site-preview';
        snip.innerHTML = snippetHtml(site);
        item.appendChild(snip);
        item.addEventListener('click', e2 => {
            e2.stopPropagation();
            menu.querySelectorAll('.cr-site-item.is-on').forEach(el => {
                el.classList.remove('is-on');
            });
            item.classList.add('is-on');
            openCallSite(edge, index);
        });
        menu.appendChild(item);
    });
    menu.addEventListener('click', ev => ev.stopPropagation());
    document.body.appendChild(menu);
    const pad = 8;
    const cr = canvas.getBoundingClientRect();
    const sr = (stage || document.body).getBoundingClientRect();
    const maxH = Math.max(120, sr.height - pad * 2);
    menu.style.maxHeight = maxH + 'px';
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = cr.left + x * zoom + 10;
    let top = cr.top + y * zoom + 10;
    if (left + mw + pad > sr.right) {
        left = Math.max(sr.left + pad, sr.right - mw - pad);
    }
    if (left < sr.left + pad) {
        left = sr.left + pad;
    }
    if (top + mh + pad > sr.bottom) {
        top = Math.max(sr.top + pad, sr.bottom - mh - pad);
    }
    if (top < sr.top + pad) {
        top = sr.top + pad;
    }
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
}

function captureView() {
    if (!stage || !lastGraph?.rootId || !lastPos || !lastPos[lastGraph.rootId]) {
        return null;
    }
    const root = lastPos[lastGraph.rootId];
    return {
        rootId: lastGraph.rootId,
        ox: stage.scrollLeft / zoom - root.x,
        oy: stage.scrollTop / zoom - root.y
    };
}

function applyView(graph, pos) {
    if (!stage || !pos[graph.rootId]) {
        return;
    }
    const root = pos[graph.rootId];
    if (savedView && savedView.rootId === graph.rootId) {
        stage.scrollLeft = (root.x + savedView.ox) * zoom;
        stage.scrollTop = (root.y + savedView.oy) * zoom;
        return;
    }
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    stage.scrollLeft = (root.x + nodeW(root) / 2) * zoom - vw / 2;
    stage.scrollTop = (root.y + root.h / 2) * zoom - vh / 2;
}

function render(graph) {
    savedView = captureView();
    lastGraph = graph;
    if (graph.rootId && nameOnlyIds.delete(graph.rootId)) {
        persistViewState();
    }
    if (!stage) {
        return;
    }
    if (titleEl) {
        titleEl.textContent = graph.title ? `Call Relation — ${graph.title}` : 'Call Relation';
    }
    if (!graph.nodes || !graph.nodes.length) {
        lastPos = null;
        canvasEl = null;
        zoomWrap = null;
        stage.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'cr-empty';
        empty.textContent = graph.empty || 'No call hierarchy at this position.';
        stage.appendChild(empty);
        return;
    }

    const viewW = stage.clientWidth || 800;
    const viewH = stage.clientHeight || 600;
    const { pos, width, height } = layout(graph, viewW, viewH);
    lastPos = pos;
    hideSiteMenu();
    stage.innerHTML = '';
    layoutW = width;
    layoutH = height;
    zoomWrap = document.createElement('div');
    zoomWrap.className = 'cr-zoom';
    const canvas = document.createElement('div');
    canvasEl = canvas;
    canvas.className = 'cr-canvas' + (isSpreadStyle(edgeStyle) ? ' is-direct' : '');
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.style.transform = `scale(${zoom})`;
    zoomWrap.style.width = (width * zoom) + 'px';
    zoomWrap.style.height = (height * zoom) + 'px';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'cr-edges');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.appendChild(arrowMarker('cr-arrow', 'cr-arrow'));
    defs.appendChild(arrowMarker('cr-arrow-hover', 'cr-arrow cr-arrow-hover'));
    svg.appendChild(defs);
    const hoverLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    hoverLayer.setAttribute('class', 'cr-edge-hover-layer');
    hoverLayer.setAttribute('pointer-events', 'none');
    const setHoverPaths = (pathDs) => {
        while (hoverLayer.firstChild) {
            hoverLayer.removeChild(hoverLayer.firstChild);
        }
        for (const pathD of pathDs) {
            if (!pathD) {
                continue;
            }
            const hoverPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            hoverPath.setAttribute('class', 'cr-edge cr-edge-hover');
            hoverPath.setAttribute('d', pathD);
            hoverPath.setAttribute('marker-end', 'url(#cr-arrow-hover)');
            hoverLayer.appendChild(hoverPath);
        }
    };
    const ports = isSpreadStyle(edgeStyle) ? edgePorts(graph, pos) : {};
    /** @type {Map<string, string[]>} */
    const edgesByNode = new Map();
    for (const edge of graph.edges) {
        const a = pos[edge.from];
        const b = pos[edge.to];
        if (!a || !b) {
            continue;
        }
        const d = edgePath(graph, edge, pos, ports);
        if (!d) {
            continue;
        }
        if (!edgesByNode.has(edge.from)) {
            edgesByNode.set(edge.from, []);
        }
        if (!edgesByNode.has(edge.to)) {
            edgesByNode.set(edge.to, []);
        }
        edgesByNode.get(edge.from).push(d);
        edgesByNode.get(edge.to).push(d);
        const live = !!(edge.sites && edge.sites.length) && edge.style !== 'anchor';
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'cr-edge-group' + (live ? ' is-live' : ''));
        g.setAttribute('data-from', edge.from);
        g.setAttribute('data-to', edge.to);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'cr-edge' + (edge.style === 'anchor' ? ' is-anchor' : ''));
        path.setAttribute('d', d);
        path.setAttribute('marker-end', 'url(#cr-arrow)');
        g.appendChild(path);
        if (live) {
            const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            hit.setAttribute('class', 'cr-edge-hit');
            hit.setAttribute('d', d);
            const n = edge.sites.length;
            hit.setAttribute('title', n > 1
                ? `${n} call sites — click to choose`
                : 'Open call site in Context Window');
            hit.addEventListener('click', ev => {
                ev.stopPropagation();
                const pt = eventOnCanvas(ev, canvas);
                if (n === 1) {
                    hideSiteMenu();
                    openCallSite(edge, 0);
                    return;
                }
                showSitePicker(canvas, pt.x, pt.y, edge);
            });
            g.addEventListener('pointerenter', () => {
                setHoverPaths([d]);
            });
            g.addEventListener('pointerleave', () => {
                setHoverPaths([]);
            });
            g.appendChild(hit);
        }
        svg.appendChild(g);
    }
    svg.appendChild(hoverLayer);

    for (const node of graph.nodes) {
        const p = pos[node.id];
        if (!p) {
            continue;
        }
        const el = document.createElement('div');
        el.className = 'cr-node';
        if (node.id === graph.rootId) {
            el.classList.add('is-root');
        }
        if (node.prevCenter) {
            el.classList.add('is-prev');
        }
        if (node.itemKey && node.itemKey === selectedKey) {
            el.classList.add('is-selected');
        }
        if (node.kind === 'more') {
            el.classList.add('is-more');
        }
        if (node.kind === 'group') {
            el.classList.add('is-group');
        }
        if (node.compact) {
            el.classList.add('is-compact');
        }
        el.dataset.nodeId = node.id;
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        el.style.width = nodeW(p) + 'px';
        el.style.height = p.h + 'px';
        el.addEventListener('pointerenter', ev => {
            setHoverPaths(edgesByNode.get(node.id) || []);
            if (usesNodeTip(node)) {
                tipMoveX = ev.clientX;
                tipMoveY = ev.clientY;
                armNodeTip(node, el);
            }
        });
        el.addEventListener('pointermove', ev => {
            if (usesNodeTip(node)) {
                onNodeTipMove(ev, node, el);
            }
        });
        el.addEventListener('pointerleave', ev => {
            setHoverPaths([]);
            if (usesNodeTip(node)) {
                const next = ev.relatedTarget;
                if (next && el.contains(next)) {
                    return;
                }
                tipHover = null;
                hideNodeTip();
            }
        });

        if (node.kind === 'more') {
            el.textContent = node.name;
            el.addEventListener('click', ev => {
                ev.stopPropagation();
                if (ev.altKey) {
                    togglePathPin(node.id);
                    return;
                }
                vscode.postMessage({ type: 'expandMore', nodeId: node.expandKey || node.id });
            });
        } else if (node.kind === 'group') {
            const head = document.createElement('div');
            head.className = 'cr-node-head';
            const name = document.createElement('div');
            name.className = 'cr-node-name';
            name.textContent = node.name;
            head.appendChild(name);
            el.appendChild(head);
            const meta = document.createElement('div');
            meta.className = 'cr-node-meta';
            meta.textContent = node.expanded
                ? 'Hide library symbols'
                : `${node.moreCount || 0} library symbols`;
            el.appendChild(meta);
            el.addEventListener('click', ev => {
                ev.stopPropagation();
                if (ev.altKey) {
                    togglePathPin(node.id);
                    return;
                }
                vscode.postMessage({ type: 'toggleGroup', nodeId: node.id });
            });
            addThumb(el, head, node);
        } else {
            const head = document.createElement('div');
            head.className = 'cr-node-head';
            const name = document.createElement('div');
            name.className = 'cr-node-name';
            name.textContent = nodeLabel(node);
            head.appendChild(name);
            el.appendChild(head);
            const meta = document.createElement('div');
            meta.className = 'cr-node-meta';
            meta.textContent = node.file ? `${node.file}:${node.line}` : '';
            el.appendChild(meta);
            let clickTimer = 0;
            el.addEventListener('click', ev => {
                if (ev.altKey) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (clickTimer) {
                        clearTimeout(clickTimer);
                        clickTimer = 0;
                    }
                    togglePathPin(node.id);
                    return;
                }
                if (clickTimer) {
                    return;
                }
                clickTimer = setTimeout(() => {
                    clickTimer = 0;
                    selectedKey = node.itemKey || '';
                    document.querySelectorAll('.cr-node.is-selected').forEach(n => {
                        n.classList.remove('is-selected');
                    });
                    el.classList.add('is-selected');
                    vscode.postMessage({ type: 'openNode', nodeId: node.id });
                }, 280);
            });
            el.addEventListener('dblclick', ev => {
                ev.preventDefault();
                ev.stopPropagation();
                if (clickTimer) {
                    clearTimeout(clickTimer);
                    clickTimer = 0;
                }
                selectedKey = node.itemKey || '';
                clearPathPin();
                vscode.postMessage({ type: 'focusNode', nodeId: node.id });
            });
            const hasKids = graph.nodes.some(n => n.parentId === node.id);
            const collapse = !!(node.expanded || hasKids);
            if ((node.expandable || collapse) && node.id !== graph.rootId) {
                el.classList.add(node.hop < 0 ? 'has-toggle-left' : 'has-toggle-right');
                const exp = document.createElement('button');
                exp.type = 'button';
                exp.className = 'cr-toggle ' + (node.hop < 0 ? 'is-left' : 'is-right') + (collapse ? ' is-collapse' : '');
                const expLabel = collapse
                    ? (node.hop < 0 ? 'Collapse callers' : 'Collapse callees')
                    : (node.hop < 0 ? 'Expand callers' : 'Expand callees');
                exp.setAttribute('aria-label', expLabel);
                bindControlTip(node, el, exp, expLabel);
                exp.addEventListener('click', ev => {
                    ev.stopPropagation();
                    hideNodeTip();
                    exp.classList.toggle('is-collapse', !collapse);
                    exp.setAttribute('aria-label', collapse ? 'Expand' : 'Collapse');
                    vscode.postMessage({
                        type: collapse ? 'collapseHop' : 'expandHop',
                        nodeId: node.id
                    });
                });
                el.appendChild(exp);
            }
            addThumb(el, head, node);
        }
        canvas.appendChild(el);
    }
    canvas.appendChild(svg);
    drawGroupFrames(canvas, graph, pos);
    zoomWrap.appendChild(canvas);
    stage.appendChild(zoomWrap);
    applyZoomChrome();
    applyView(graph, pos);
    applyPathFocus();
    if (lastTipNodeId && canvas) {
        const n = graph.nodes.find(x => x.id === lastTipNodeId);
        const el = [...canvas.querySelectorAll('.cr-node')].find(e => e.dataset.nodeId === lastTipNodeId);
        if (usesNodeTip(n) && el) {
            showNodeTip(n, el);
        } else {
            hideNodeTip();
        }
    }
}

function bindPan(el) {
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let sl = 0;
    let st = 0;
    el.addEventListener('pointerdown', e => {
        if (e.button !== 0) {
            return;
        }
        const hit = e.target;
        if (hit && hit.closest && hit.closest('.cr-node, .cr-toggle, .cr-thumb, .cr-edge-group, .cr-site-menu')) {
            return;
        }
        hideNodeTip();
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        sl = el.scrollLeft;
        st = el.scrollTop;
        el.classList.add('is-panning');
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    });
    el.addEventListener('pointermove', e => {
        if (!dragging) {
            return;
        }
        el.scrollLeft = sl - (e.clientX - sx);
        el.scrollTop = st - (e.clientY - sy);
    });
    const endPan = () => {
        dragging = false;
        el.classList.remove('is-panning');
    };
    el.addEventListener('pointerup', endPan);
    el.addEventListener('pointercancel', endPan);
}

pinBtn?.addEventListener('click', () => {
    const next = !pinBtn.classList.contains('is-on');
    vscode.postMessage({ type: 'setPinned', value: next });
});

function applyUpdateMode(value) {
    const sticky = value === 'sticky';
    if (updateBtn) {
        updateBtn.classList.toggle('is-on', sticky);
        updateBtn.title = sticky
            ? 'Update mode: Sticky — keep last graph until new results'
            : 'Update mode: Live — empty graph when no call hierarchy';
        updateBtn.innerHTML = (sticky
            ? '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M10.2 1.5 9.5 2.2l.3 3.5L12 8.2V9H9v5H7V9H4V8.2l2.2-2.5.3-3.5-.7-.7L6.5 1h3.7z"/></svg>'
            : '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 3C4.67 3 1.82 5.07 1 8c.82 2.93 3.67 5 7 5s6.18-2.07 7-5c-.82-2.93-3.67-5-7-5zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.5A1.5 1.5 0 1 0 8 6a1.5 1.5 0 0 0 0 3z"/></svg>')
            + '<span>' + (sticky ? 'Sticky' : 'Live') + '</span>';
    }
}

updateBtn?.addEventListener('click', () => {
    const next = updateBtn.classList.contains('is-on') ? 'live' : 'sticky';
    applyUpdateMode(next);
    vscode.postMessage({ type: 'setUpdateMode', value: next });
});

let styleMenuDocDown = null;

function closeStyleMenu() {
    const menu = document.getElementById('cr-style-menu');
    if (menu) {
        menu.remove();
    }
    styleBtn?.classList.remove('is-open');
    if (styleMenuDocDown) {
        document.removeEventListener('mousedown', styleMenuDocDown, true);
        styleMenuDocDown = null;
    }
}

function openStyleMenu() {
    if (!styleBtn) {
        return;
    }
    if (document.getElementById('cr-style-menu')) {
        closeStyleMenu();
        return;
    }
    const menu = document.createElement('div');
    menu.id = 'cr-style-menu';
    menu.className = 'cr-style-menu';
    EDGE_STYLE_ITEMS.forEach(item => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'cr-style-menu-item' + (item.id === edgeStyle ? ' is-selected' : '');
        el.textContent = (item.id === edgeStyle ? '✔ ' : '') + item.label;
        el.addEventListener('mousedown', e => {
            e.preventDefault();
            e.stopPropagation();
            closeStyleMenu();
            if (item.id === edgeStyle) {
                return;
            }
            applyEdgeStyle(item.id);
            vscode.postMessage({ type: 'setEdgeStyle', value: item.id });
        });
        menu.appendChild(el);
    });
    const wrap = document.getElementById('cr-style-wrap') || styleBtn.parentElement;
    (wrap || document.body).appendChild(menu);
    styleBtn.classList.add('is-open');
    styleMenuDocDown = e => {
        if (styleBtn.contains(e.target) || menu.contains(e.target)) {
            return;
        }
        closeStyleMenu();
    };
    document.addEventListener('mousedown', styleMenuDocDown, true);
}

styleBtn?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    openStyleMenu();
});

function clampZoom(value) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
}

function applyZoomChrome() {
    if (zoomOutBtn) {
        zoomOutBtn.disabled = zoom <= ZOOM_MIN + 0.001;
    }
    if (zoomInBtn) {
        zoomInBtn.disabled = zoom >= ZOOM_MAX - 0.001;
    }
    if (zoomLabel) {
        zoomLabel.textContent = Math.round(zoom * 100) + '%';
    }
}

function applyZoomSize() {
    if (zoomWrap && layoutW && layoutH) {
        zoomWrap.style.width = (layoutW * zoom) + 'px';
        zoomWrap.style.height = (layoutH * zoom) + 'px';
    }
    if (canvasEl) {
        canvasEl.style.transform = `scale(${zoom})`;
    }
    applyZoomChrome();
}

function setZoom(next, origin) {
    hideNodeTip();
    const old = zoom;
    const value = clampZoom(next);
    if (Math.abs(value - old) < 0.001) {
        applyZoomChrome();
        return;
    }
    if (!stage) {
        zoom = value;
        persistViewState();
        applyZoomChrome();
        return;
    }
    const rect = stage.getBoundingClientRect();
    let focusX;
    let focusY;
    if (origin && typeof origin.clientX === 'number') {
        focusX = stage.scrollLeft + (origin.clientX - rect.left);
        focusY = stage.scrollTop + (origin.clientY - rect.top);
    } else {
        focusX = stage.scrollLeft + stage.clientWidth / 2;
        focusY = stage.scrollTop + stage.clientHeight / 2;
    }
    const canvasX = old ? focusX / old : focusX;
    const canvasY = old ? focusY / old : focusY;
    hideSiteMenu();
    zoom = value;
    persistViewState();
    applyZoomSize();
    if (origin && typeof origin.clientX === 'number') {
        stage.scrollLeft = canvasX * zoom - (origin.clientX - rect.left);
        stage.scrollTop = canvasY * zoom - (origin.clientY - rect.top);
    } else {
        stage.scrollLeft = canvasX * zoom - stage.clientWidth / 2;
        stage.scrollTop = canvasY * zoom - stage.clientHeight / 2;
    }
}

zoomOutBtn?.addEventListener('click', () => {
    setZoom(zoom / ZOOM_STEP);
});

zoomInBtn?.addEventListener('click', () => {
    setZoom(zoom * ZOOM_STEP);
});

zoomLabel?.addEventListener('click', () => {
    setZoom(1);
});

function setProgress(on) {
    const el = document.querySelector('.progress-container');
    if (el) {
        el.style.display = on ? 'block' : 'none';
    }
    document.body.classList.toggle('is-loading', !!on);
}

window.addEventListener('message', ev => {
    const msg = ev.data;
    if (!msg) {
        return;
    }
    if (msg.type === 'graph') {
        render(msg.graph || { nodes: [], edges: [], empty: 'No call hierarchy at this position.' });
    } else if (msg.type === 'state') {
        if (pinBtn) {
            pinBtn.classList.toggle('is-on', !!msg.pinned);
            pinBtn.textContent = msg.pinned ? 'Pinned' : 'Pin';
        }
        applyUpdateMode(msg.updateMode);
        applyEdgeStyle(normalizeEdgeStyle(msg.edgeStyle));
        if (typeof msg.hoverDelay === 'number' && Number.isFinite(msg.hoverDelay) && msg.hoverDelay >= 0) {
            tipDelayMs = msg.hoverDelay;
        }
    } else if (msg.type === 'beginProgress') {
        setProgress(true);
    } else if (msg.type === 'endProgress') {
        setProgress(false);
    }
});

if (stage) {
    bindPan(stage);
    stage.addEventListener('wheel', e => {
        if (!e.ctrlKey && !e.metaKey) {
            return;
        }
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
        setZoom(zoom * factor, e);
    }, { passive: false });
    stage.addEventListener('click', e => {
        const hit = e.target;
        if (hit && hit.closest && hit.closest('.cr-edge-group, .cr-site-menu')) {
            return;
        }
        hideSiteMenu();
        if (e.altKey && !(hit && hit.closest && hit.closest('.cr-node'))) {
            clearPathPin();
        }
    });
}

syncStyleBtn();
applyZoomChrome();
vscode.postMessage({ type: 'ready' });
