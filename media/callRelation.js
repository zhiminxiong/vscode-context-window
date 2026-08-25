//@ts-check

const NODE_W = 168;
const NODE_H = 52;
const COMPACT_H = 38;
const MORE_H = 36;
const NAME_H = 22;
const NAME_ROOT_H = 26;
const NAME_MIN_W = 24;
const COL_GAP = 88;
const ROW_GAP = 14;
const COMPACT_GAP = 8;
const PAD = 40;
const ARROW_LEN = 8;
const TIP_GAP = 6;

/** @type {{ postMessage: (msg: any) => void, getState: () => any, setState: (s: any) => void }} */
const vscode = acquireVsCodeApi();

const titleEl = document.getElementById('cr-title');
const stage = document.getElementById('cr-stage');
const emptyEl = document.getElementById('cr-empty');
const pinBtn = document.getElementById('cr-pin');
const refreshBtn = document.getElementById('cr-refresh');
const styleBtn = document.getElementById('cr-style');

/** @type {any} */
let lastGraph = null;
/** @type {string} */
let selectedKey = '';
/** @type {'elbow' | 'direct' | 'arc'} */
let edgeStyle = 'elbow';
/** @type {Set<string>} */
let nameOnlyIds = new Set();
try {
    const saved = vscode.getState();
    if (saved && (saved.edgeStyle === 'direct' || saved.edgeStyle === 'arc')) {
        edgeStyle = saved.edgeStyle;
    }
    if (saved && Array.isArray(saved.nameOnlyIds)) {
        nameOnlyIds = new Set(saved.nameOnlyIds);
    }
} catch (_) { /* noop */ }

function normalizeEdgeStyle(value) {
    return value === 'direct' || value === 'arc' ? value : 'elbow';
}

function nextEdgeStyle(value) {
    if (value === 'elbow') {
        return 'direct';
    }
    if (value === 'direct') {
        return 'arc';
    }
    return 'elbow';
}

function isSpreadStyle(value) {
    return value === 'direct' || value === 'arc';
}

function nodeHeight(node, rootId) {
    const names = nameOnlyIds.has(node.id);
    if (node.kind === 'more') {
        return node.compact ? 30 : MORE_H;
    }
    if (node.id === rootId) {
        return names ? NAME_ROOT_H : 64;
    }
    if (names) {
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
    if (!nameOnlyIds.has(node.id)) {
        return NODE_W;
    }
    const root = node.id === rootId;
    const fontSize = root ? 16 : 13;
    const textW = measureNameWidth(node.name, fontSize, true);
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

function layout(graph) {
    /** @type {Record<string, { x: number, y: number, h: number, w: number }>} */
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
    let centerY = 0;
    for (const n of orderedCenters) {
        const h = nodeHeight(n, graph.rootId);
        const w = nodeWidth(n, graph.rootId);
        pos[n.id] = { x: 0, y: centerY, h, w };
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
        let prevBottom = -Infinity;
        for (const group of groups) {
            const block = group.kids.reduce((sum, n) => sum + nodeHeight(n, graph.rootId) + nodeGap(n), 0)
                - (group.kids.length ? nodeGap(group.kids[group.kids.length - 1]) : 0);
            const parentY = group.parent && pos[group.parent.id] ? pos[group.parent.id].y : 0;
            const parentH = group.parent && pos[group.parent.id] ? pos[group.parent.id].h : NODE_H;
            let y = parentY + parentH / 2 - block / 2;
            if (prevBottom > -Infinity) {
                y = Math.max(y, prevBottom + ROW_GAP);
            }
            for (const kid of group.kids) {
                const h = nodeHeight(kid, graph.rootId);
                const w = nodeWidth(kid, graph.rootId);
                const colX = hop * (NODE_W + COL_GAP);
                pos[kid.id] = {
                    x: hop < 0 ? colX + (NODE_W - w) : colX,
                    y,
                    h,
                    w
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

    let minX = 0;
    let minY = 0;
    let maxX = NODE_W;
    let maxY = NODE_H;
    for (const p of Object.values(pos)) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + nodeW(p));
        maxY = Math.max(maxY, p.y + p.h);
    }
    const dx = PAD - minX;
    const dy = PAD - minY;
    for (const p of Object.values(pos)) {
        p.x += dx;
        p.y += dy;
    }
    return {
        pos,
        width: maxX - minX + PAD * 2,
        height: maxY - minY + PAD * 2
    };
}

function nodeById(graph, id) {
    return graph.nodes.find(n => n.id === id);
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

function addThumb(el, head, node) {
    const names = nameOnlyIds.has(node.id);
    if (names) {
        el.classList.add('is-names');
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cr-thumb' + (names ? ' is-on' : '');
    btn.textContent = names ? '>' : '<';
    btn.title = names ? 'Restore file and line' : 'Show name only';
    btn.setAttribute('aria-label', btn.title);
    btn.addEventListener('pointerdown', ev => ev.stopPropagation());
    btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        toggleNameOnly(node);
    });
    head.appendChild(btn);
}

function persistEdgeStyle() {
    persistViewState();
}

function syncStyleBtn() {
    if (!styleBtn) {
        return;
    }
    styleBtn.classList.toggle('is-on', isSpreadStyle(edgeStyle));
    styleBtn.textContent = edgeStyle === 'direct' ? 'Direct' : edgeStyle === 'arc' ? 'Arc' : 'Elbow';
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
        x: ev.clientX - r.left,
        y: ev.clientY - r.top
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
    canvas.appendChild(menu);
    const pad = 8;
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    let left = x + 10;
    let top = y + 10;
    if (left + mw + pad > cw) {
        left = Math.max(pad, x - mw - 10);
    }
    if (top + mh + pad > ch) {
        top = Math.max(pad, y - mh - 10);
    }
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
}

function render(graph) {
    lastGraph = graph;
    if (!stage) {
        return;
    }
    if (titleEl) {
        titleEl.textContent = graph.title ? `Call Relation — ${graph.title}` : 'Call Relation';
    }
    if (!graph.nodes || !graph.nodes.length) {
        stage.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'cr-empty';
        empty.textContent = graph.empty || 'No call hierarchy at this position.';
        stage.appendChild(empty);
        return;
    }

    const { pos, width, height } = layout(graph);
    hideSiteMenu();
    stage.innerHTML = '';
    const canvas = document.createElement('div');
    canvas.className = 'cr-canvas' + (isSpreadStyle(edgeStyle) ? ' is-direct' : '');
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

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
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        el.style.width = nodeW(p) + 'px';
        el.style.height = p.h + 'px';
        el.addEventListener('pointerenter', () => {
            setHoverPaths(edgesByNode.get(node.id) || []);
        });
        el.addEventListener('pointerleave', () => {
            setHoverPaths([]);
        });
        el.title = node.kind === 'more'
            ? 'Show more siblings'
            : node.kind === 'group'
                ? `${node.name} — ${node.detail || 'library symbols'}`
                : `${node.name}\n${node.path}:${node.line}`;

        if (node.kind === 'more') {
            el.textContent = node.name;
            el.addEventListener('click', ev => {
                ev.stopPropagation();
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
                vscode.postMessage({ type: 'toggleGroup', nodeId: node.id });
            });
            addThumb(el, head, node);
        } else {
            const head = document.createElement('div');
            head.className = 'cr-node-head';
            const name = document.createElement('div');
            name.className = 'cr-node-name';
            name.textContent = node.name;
            head.appendChild(name);
            el.appendChild(head);
            const meta = document.createElement('div');
            meta.className = 'cr-node-meta';
            meta.textContent = node.file ? `${node.file}:${node.line}` : '';
            el.appendChild(meta);
            let clickTimer = 0;
            el.addEventListener('click', () => {
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
                vscode.postMessage({ type: 'focusNode', nodeId: node.id });
            });
            const hasKids = graph.nodes.some(n => n.parentId === node.id);
            const collapse = !!(node.expanded || hasKids);
            if ((node.expandable || collapse) && node.id !== graph.rootId) {
                el.classList.add(node.hop < 0 ? 'has-toggle-left' : 'has-toggle-right');
                const exp = document.createElement('button');
                exp.type = 'button';
                exp.className = 'cr-toggle ' + (node.hop < 0 ? 'is-left' : 'is-right') + (collapse ? ' is-collapse' : '');
                exp.setAttribute('aria-label', collapse ? 'Collapse' : 'Expand');
                exp.title = collapse
                    ? (node.hop < 0 ? 'Collapse callers' : 'Collapse callees')
                    : (node.hop < 0 ? 'Expand callers' : 'Expand callees');
                exp.addEventListener('click', ev => {
                    ev.stopPropagation();
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
    stage.appendChild(canvas);
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

styleBtn?.addEventListener('click', () => {
    const next = nextEdgeStyle(edgeStyle);
    applyEdgeStyle(next);
    vscode.postMessage({ type: 'setEdgeStyle', value: next });
});

refreshBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
});

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
        applyEdgeStyle(normalizeEdgeStyle(msg.edgeStyle));
    } else if (msg.type === 'loading' && msg.value && titleEl) {
        titleEl.textContent = 'Call Relation — loading…';
    }
});

if (stage) {
    bindPan(stage);
    stage.addEventListener('click', e => {
        const hit = e.target;
        if (hit && hit.closest && hit.closest('.cr-edge-group, .cr-site-menu')) {
            return;
        }
        hideSiteMenu();
    });
}

syncStyleBtn();
vscode.postMessage({ type: 'ready' });
