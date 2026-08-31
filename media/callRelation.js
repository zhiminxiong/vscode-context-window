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

/** visualId / itemKey contain \0; HTML data-* truncates at NUL. */
function encodeNodeId(id) {
    return encodeURIComponent(id || '');
}

function decodeNodeId(raw) {
    if (!raw) {
        return '';
    }
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

function elNodeId(el) {
    return decodeNodeId(el && el.dataset ? el.dataset.nodeId : '');
}

function setElNodeId(el, id) {
    el.dataset.nodeId = encodeNodeId(id);
}

function isReferenceGraph(graph) {
    return !!(graph && graph.mode === 'reference');
}

function relationTitle(graph) {
    const name = graph && graph.title;
    const kind = isReferenceGraph(graph) ? 'References' : 'Call';
    return name ? `Relation (${kind}) — ${name}` : `Relation (${kind})`;
}

const titleEl = document.getElementById('cr-title');
const stage = document.getElementById('cr-stage');
const emptyEl = document.getElementById('cr-empty');
const pinBtn = document.getElementById('cr-pin');
const updateBtn = document.getElementById('cr-update');
const slimBtn = document.getElementById('cr-slim');
const slimKindsBtn = document.getElementById('cr-slim-kinds');
const slimWrap = document.getElementById('cr-slim-wrap');
const styleBtn = document.getElementById('cr-style');
const sortBtn = document.getElementById('cr-sort');
const zoomInBtn = document.getElementById('cr-zoom-in');
const zoomOutBtn = document.getElementById('cr-zoom-out');
const zoomLabel = document.getElementById('cr-zoom-label');
const findBar = document.getElementById('cr-find');
const findInput = document.getElementById('cr-find-input');
const findCount = document.getElementById('cr-find-count');
const findCaseBtn = document.getElementById('cr-find-case');
const findWordBtn = document.getElementById('cr-find-word');
const findPrevBtn = document.getElementById('cr-find-prev');
const findNextBtn = document.getElementById('cr-find-next');
const findCloseBtn = document.getElementById('cr-find-close');
const helpBtn = document.getElementById('cr-help');
const tipsBtn = document.getElementById('cr-tips');
const hintEl = document.getElementById('cr-hint');

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
/** 键盘/点击当前节点 id；优先于 selectedKey。 */
let selectedId = '';
/** 换中心后不再沿用旧 itemKey 的选定框。 */
let selectedRootId = '';
/** Alt+click 钉住的节点 id；空串表示未钉路径。 */
let pinnedNodeId = '';
/** @type {'elbow' | 'direct' | 'arc'} */
let edgeStyle = 'arc';
/** @type {'name' | 'order'} */
let childSort = 'name';
/** @type {Set<string>} */
let nameOnlyIds = new Set();
/** Hover tips on by default; off = hold Alt to show. */
let tipsAuto = true;
let altHeld = false;
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
    if (saved && typeof saved.tipsAuto === 'boolean') {
        tipsAuto = saved.tipsAuto;
    }
} catch (_) { /* noop */ }

function normalizeEdgeStyle(value) {
    return value === 'direct' || value === 'elbow' ? value : 'arc';
}

function normalizeChildSort(value) {
    return value === 'order' ? 'order' : 'name';
}

function isSpreadStyle(value) {
    return value === 'direct' || value === 'arc';
}

/** AAAA.bbbb / ns::foo / foo() → 只留最末一段标识符。 */
function shortSymbolName(name) {
    let ident = String(name || '').replace(/^\((?:get|set)\)\s+/i, '').replace(/^(?:get|set)\s+/i, '').trim();
    ident = ident.replace(/\(.*\)$/, '').trim();
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

function fillNodeName(el, node) {
    const full = (node && node.name) || '';
    const shown = nodeLabel(node);
    el.textContent = full;
    if (shown && shown !== full) {
        el.classList.add('has-short');
        el.setAttribute('data-short', shown);
    }
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
            let prevColumnFirstId = '';
            if (first && lastPos) {
                let bestY = Infinity;
                for (const [id, p] of Object.entries(lastPos)) {
                    if (p.hop === hop && p.parentId === first.parentId && p.y < bestY) {
                        bestY = p.y;
                        prevColumnFirstId = id;
                    }
                }
            }
            // Sticky Y is for expand / show more (same first child). Reorder (sort)
            // changes who is first; keep centering on the parent or the column drops.
            const sameSlot = !!(columnGrew
                && prevFirst
                && prevFirst.hop === first.hop
                && prevFirst.parentId === first.parentId
                && prevColumnFirstId === first.id);
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
    const marginX = Math.max(PAD, viewW * 1.5);
    const marginY = Math.max(PAD, viewH * 1.5);
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
            if (boxedIds.has(n.id) || n.hop !== group.hop || n.parentId !== group.parentId) {
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
        const hug = ROW_GAP / 2;
        const near = ROW_GAP * 2 + 8;
        const midTop = aboveBottom > -Infinity && (boxTop - aboveBottom) <= near
            ? (aboveBottom + boxTop) / 2
            : boxTop - hug;
        const midBottom = belowTop < Infinity && (belowTop - boxBottom) <= near
            ? (boxBottom + belowTop) / 2
            : boxBottom + hug;
        const top = midTop - stroke / 2;
        const bottom = midBottom + stroke / 2;
        const frame = document.createElement('div');
        frame.className = 'cr-group-frame';
        frame.style.left = (left - padX) + 'px';
        frame.style.top = top + 'px';
        frame.style.width = (right - left + padX * 2) + 'px';
        frame.style.height = (bottom - top) + 'px';
        canvas.insertBefore(frame, canvas.firstChild);
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
        saved.tipsAuto = tipsAuto;
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
        if (nodeTipEl) {
            hideNodeTip();
            markTipUsed(nodeEl);
        } else {
            hideNodeTip();
        }
        armLabelTip(label, btn, node.hop, ev);
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
                armNodeTip(node, nodeEl, ev);
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

function isCyclicNode(graph, node) {
    if (!node || node.kind !== 'symbol' || !node.itemKey) {
        return false;
    }
    if (node.cyclic) {
        return true;
    }
    if (!node.parentId) {
        return false;
    }
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    let cur = byId.get(node.parentId);
    while (cur) {
        if (cur.itemKey === node.itemKey) {
            return true;
        }
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return false;
}

function createCycleBadge() {
    const badge = document.createElement('span');
    badge.className = 'cr-cycle';
    badge.setAttribute('aria-hidden', 'true');
    badge.title = 'Repeats an ancestor on this path';
    badge.textContent = '↻';
    return badge;
}

/** @type {string} */
let hoverTwinKey = '';
/** @type {any} */
let hoverNode = null;
let refreshHover = () => {};

function symbolTwins(key) {
    if (!lastGraph || !key) {
        return [];
    }
    return lastGraph.nodes.filter(n => n.kind === 'symbol' && n.itemKey === key);
}

function twinFocusKey() {
    return hoverTwinKey || '';
}

function isTwinHighlight(node) {
    if (!altHeld) {
        return false;
    }
    const key = twinFocusKey();
    return !!(node && node.kind === 'symbol' && node.itemKey && key && node.itemKey === key);
}

function paintTwins() {
    const canvas = canvasEl;
    if (!canvas) {
        return;
    }
    canvas.querySelectorAll('.cr-node').forEach(el => {
        const n = graphNode(elNodeId(el));
        el.classList.toggle('is-twin', isTwinHighlight(n));
    });
}

function setHoverTwin(node) {
    hoverNode = node || null;
    hoverTwinKey = node && node.kind === 'symbol' && node.itemKey ? node.itemKey : '';
    refreshHover();
}

function createTwinBadge(node, twins) {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'cr-twin';
    const n = twins.length;
    badge.textContent = '×' + (n > 99 ? '99+' : String(n));
    badge.setAttribute('aria-label', n === 2
        ? 'Same function on another call path — click to jump'
        : `Same function on ${n} call paths — click to jump to the next`);
    badge.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const list = twins.slice().sort(sortByLayout);
        const i = list.findIndex(t => t.id === node.id);
        const next = list[(i < 0 ? 0 : i + 1) % list.length];
        if (!next || next.id === node.id) {
            return;
        }
        const r = badge.getBoundingClientRect();
        const ox = ev.clientX - r.left;
        const oy = ev.clientY - r.top;
        const fromEl = badge.closest('.cr-node');
        selectNode(next, false);
        scrollKeepPointer(next.id, ev.clientX, ev.clientY, ox, oy, '.cr-twin');
        if (fromEl) {
            fromEl.dispatchEvent(new PointerEvent('pointerleave', {
                bubbles: true,
                clientX: ev.clientX,
                clientY: ev.clientY
            }));
        }
        const toEl = nodeElById(next.id);
        if (toEl) {
            toEl.dispatchEvent(new PointerEvent('pointerenter', {
                bubbles: true,
                clientX: ev.clientX,
                clientY: ev.clientY
            }));
            hideNodeTip();
            markTipUsed(toEl);
        }
    });
    return badge;
}

function formatSiteCount(count) {
    const n = Math.max(0, Number(count) || 0);
    return n > 99 ? '99+' : String(n);
}

function addSiteCountLabel(g, pathEl, count, nearTail, nodePos) {
    if (count <= 1) {
        return;
    }
    const text = formatSiteCount(count);
    const rx = Math.max(7, 3.6 + text.length * 3.4);
    const ry = 6.5;
    const gap = 4;
    let x = 0;
    let y = 0;
    try {
        const len = pathEl.getTotalLength();
        if (!(len > 0)) {
            return;
        }
        const pt = pathEl.getPointAtLength(nearTail ? 0 : len);
        y = pt.y - (ry + 4);
        if (nodePos) {
            const w = nodeW(nodePos);
            x = nearTail
                ? nodePos.x + w + gap + rx
                : nodePos.x - gap - rx;
        } else {
            x = nearTail ? pt.x + gap + rx : pt.x - gap - rx;
        }
    } catch (_) {
        return;
    }
    const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    wrap.setAttribute('class', 'cr-edge-count');
    wrap.setAttribute('transform', `translate(${x} ${y})`);
    wrap.setAttribute('pointer-events', 'none');
    const oval = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    oval.setAttribute('cx', '0');
    oval.setAttribute('cy', '0');
    oval.setAttribute('rx', String(rx));
    oval.setAttribute('ry', String(ry));
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', '0');
    label.setAttribute('y', '0');
    label.textContent = text;
    wrap.appendChild(oval);
    wrap.appendChild(label);
    g.appendChild(wrap);
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
        const id = elNodeId(el);
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
        const from = decodeNodeId(g.getAttribute('data-from') || '');
        const to = decodeNodeId(g.getAttribute('data-to') || '');
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

let findQuery = '';
/** @type {string[]} */
let findHits = [];
let findIndex = 0;
let findOpen = false;
let findMatchCase = false;
let findWholeWord = false;

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameMatches(name, query) {
    const raw = String(name || '');
    const q = String(query || '');
    if (!q) {
        return false;
    }
    if (findWholeWord) {
        try {
            return new RegExp(`\\b${escapeRegExp(q)}\\b`, findMatchCase ? '' : 'i').test(raw);
        } catch (_) {
            return false;
        }
    }
    if (findMatchCase) {
        return raw.includes(q);
    }
    return raw.toLowerCase().includes(q.toLowerCase());
}

function findable(node) {
    return !!node && (node.kind === 'symbol' || node.kind === 'group');
}

function collectFindHits(query) {
    if (!String(query || '').trim() || !lastGraph || !Array.isArray(lastGraph.nodes)) {
        return [];
    }
    const hits = [];
    for (const n of lastGraph.nodes) {
        if (!findable(n)) {
            continue;
        }
        if (nameMatches(n.name, query)) {
            hits.push(n.id);
        }
    }
    if (lastPos) {
        hits.sort((a, b) => {
            const pa = lastPos[a];
            const pb = lastPos[b];
            if (!pa || !pb) {
                return 0;
            }
            return pa.y - pb.y || pa.x - pb.x;
        });
    }
    return hits;
}

function scrollToNode(id) {
    if (!stage || !lastPos || !lastPos[id]) {
        return;
    }
    const p = lastPos[id];
    stage.scrollLeft = (p.x + nodeW(p) / 2) * zoom - stage.clientWidth / 2;
    stage.scrollTop = (p.y + p.h / 2) * zoom - stage.clientHeight / 2;
}

function nodeElById(id) {
    if (!canvasEl || !id) {
        return null;
    }
    return [...canvasEl.querySelectorAll('.cr-node')].find(e => elNodeId(e) === id) || null;
}

/** 平移画布，让目标节点（或子控件）上的同一点击点仍落在指针下。 */
function scrollKeepPointer(id, clientX, clientY, offsetX, offsetY, childSel) {
    if (!stage) {
        return;
    }
    const host = nodeElById(id);
    const el = (host && childSel && host.querySelector(childSel)) || host;
    if (!el) {
        scrollToNode(id);
        return;
    }
    const r = el.getBoundingClientRect();
    stage.scrollLeft += (r.left + offsetX) - clientX;
    stage.scrollTop += (r.top + offsetY) - clientY;
}

function graphNode(id) {
    return lastGraph && id ? lastGraph.nodes.find(n => n.id === id) : undefined;
}

function nodeSide(node) {
    if (!node) {
        return 0;
    }
    return node.hop < 0 ? -1 : node.hop > 0 ? 1 : 0;
}

function siblingNodes(node) {
    if (!lastGraph || !node) {
        return [];
    }
    const side = nodeSide(node);
    const list = lastGraph.nodes.filter(n => {
        if (node.parentId) {
            return n.parentId === node.parentId && nodeSide(n) === side;
        }
        return n.id === lastGraph.rootId;
    });
    list.sort((a, b) => {
        const pa = lastPos && lastPos[a.id];
        const pb = lastPos && lastPos[b.id];
        if (!pa || !pb) {
            return 0;
        }
        return pa.y - pb.y || pa.x - pb.x;
    });
    return list;
}

function resolveSelection() {
    const rootId = lastGraph && lastGraph.rootId ? lastGraph.rootId : '';
    if (rootId && selectedRootId && selectedRootId !== rootId) {
        selectedId = '';
        selectedKey = '';
        selectedRootId = rootId;
    } else if (rootId && !selectedRootId) {
        selectedRootId = rootId;
    }
    if (selectedId && graphNode(selectedId)) {
        return;
    }
    selectedId = '';
    if (selectedKey && lastGraph) {
        const hit = lastGraph.nodes.find(n => n.itemKey === selectedKey && n.id !== lastGraph.rootId);
        if (hit) {
            selectedId = hit.id;
        }
    }
}

function isNodeSelected(node) {
    resolveSelection();
    if (selectedId) {
        return node.id === selectedId;
    }
    return !!(node.itemKey && node.itemKey === selectedKey);
}

function paintSelection() {
    const canvas = canvasEl;
    if (!canvas) {
        return;
    }
    resolveSelection();
    canvas.querySelectorAll('.cr-node').forEach(el => {
        const n = graphNode(elNodeId(el));
        el.classList.toggle('is-selected', !!(n && isNodeSelected(n)));
    });
    paintTwins();
}

function selectNode(node, scroll) {
    if (!node) {
        return;
    }
    selectedId = node.id;
    selectedKey = node.itemKey || '';
    if (lastGraph && lastGraph.rootId) {
        selectedRootId = lastGraph.rootId;
    }
    paintSelection();
    if (scroll) {
        scrollToNode(node.id);
    }
}

function ensureSelection() {
    const cur = graphNode(selectedId);
    if (cur) {
        return cur;
    }
    if (selectedKey && lastGraph) {
        const hit = lastGraph.nodes.find(n => n.itemKey === selectedKey);
        if (hit) {
            selectedId = hit.id;
            return hit;
        }
    }
    if (lastGraph) {
        const root = graphNode(lastGraph.rootId);
        if (root) {
            selectedId = root.id;
            selectedKey = root.itemKey || '';
            paintSelection();
            return root;
        }
    }
    return undefined;
}

function sortByLayout(a, b) {
    const pa = lastPos && lastPos[a.id];
    const pb = lastPos && lastPos[b.id];
    if (!pa || !pb) {
        return 0;
    }
    return pa.y - pb.y || pa.x - pb.x;
}

function childrenOf(node, side) {
    if (!lastGraph || !node) {
        return [];
    }
    const list = lastGraph.nodes.filter(n => {
        if (n.parentId !== node.id) {
            return false;
        }
        return side == null || nodeSide(n) === side;
    });
    list.sort(sortByLayout);
    return list;
}

function moveSibling(dir) {
    const cur = ensureSelection();
    if (!cur) {
        return;
    }
    const list = siblingNodes(cur);
    if (!list.length) {
        return;
    }
    const i = list.findIndex(n => n.id === cur.id);
    const idx = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + dir));
    selectNode(list[idx], true);
}

/** 展开后跳到该侧第一个子节点（方向键走路，而不是停在原地）。 */
let pendingHop = null;

function requestExpand(node, side) {
    if (!node) {
        return;
    }
    if (node.kind === 'more') {
        pendingHop = { parentId: node.parentId, side };
        vscode.postMessage({ type: 'expandMore', nodeId: node.expandKey || node.id });
        return;
    }
    if (node.kind === 'group') {
        if (!node.expanded) {
            pendingHop = { parentId: node.id, side };
            vscode.postMessage({ type: 'toggleGroup', nodeId: node.id });
        }
        return;
    }
    if (node.expandable) {
        pendingHop = { parentId: node.id, side };
        vscode.postMessage({ type: 'expandHop', nodeId: node.id });
    }
}

function applyPendingHop() {
    if (!pendingHop || !lastGraph) {
        return;
    }
    const { parentId, side } = pendingHop;
    pendingHop = null;
    const parent = graphNode(parentId);
    const kids = parent ? childrenOf(parent, side) : [];
    if (kids[0]) {
        selectNode(kids[0], true);
    }
}

function hopMove(dir) {
    const cur = ensureSelection();
    if (!cur || !lastGraph) {
        return;
    }
    const side = nodeSide(cur);
    if (cur.id === lastGraph.rootId || side === 0) {
        const kids = childrenOf(cur, dir);
        if (kids[0]) {
            selectNode(kids[0], true);
            return;
        }
        requestExpand(cur, dir);
        return;
    }
    if (dir === side) {
        const kids = childrenOf(cur);
        if (kids[0]) {
            selectNode(kids[0], true);
            return;
        }
        requestExpand(cur, side);
        return;
    }
    const parent = cur.parentId ? graphNode(cur.parentId) : undefined;
    if (parent) {
        selectNode(parent, true);
    }
}

function toggleExpandSelected() {
    const cur = ensureSelection();
    if (!cur || !lastGraph || cur.id === lastGraph.rootId) {
        return;
    }
    if (cur.kind === 'more') {
        vscode.postMessage({ type: 'expandMore', nodeId: cur.expandKey || cur.id });
        return;
    }
    if (cur.kind === 'group') {
        vscode.postMessage({ type: 'toggleGroup', nodeId: cur.id });
        return;
    }
    const opened = !!(cur.expanded || lastGraph.nodes.some(n => n.parentId === cur.id));
    if (opened) {
        vscode.postMessage({ type: 'collapseHop', nodeId: cur.id });
        return;
    }
    if (cur.expandable) {
        vscode.postMessage({ type: 'expandHop', nodeId: cur.id });
    }
}

function openSelected() {
    const cur = ensureSelection();
    if (!cur) {
        return;
    }
    if (cur.kind === 'more') {
        vscode.postMessage({ type: 'expandMore', nodeId: cur.expandKey || cur.id });
        return;
    }
    if (cur.kind === 'group') {
        vscode.postMessage({ type: 'toggleGroup', nodeId: cur.id });
        return;
    }
    vscode.postMessage({ type: 'openNode', nodeId: cur.id });
}

/** @type {{ items: any[], index: number } | null} */
let lastCenterTrail = null;
let centerTrailResize = 0;

function hideCtxMenu() {
    const old = document.getElementById('cr-ctx-menu');
    if (old && old.parentNode) {
        old.parentNode.removeChild(old);
    }
}

function formatCallChain() {
    const items = (lastCenterTrail && lastCenterTrail.items) || [];
    if (!items.length) {
        return '';
    }
    const current = Math.max(0, Math.min(lastCenterTrail.index, items.length - 1));
    const lines = items.map((item, i) => {
        const file = item.file || '';
        const line = item.line > 0 ? item.line : 0;
        let loc = '';
        if (file && line) {
            loc = ` — ${file}:${line}`;
        } else if (file) {
            loc = ` — ${file}`;
        } else if (line) {
            loc = `:${line}`;
        }
        const mark = i === current ? '  ← current' : '';
        return `${i + 1}. ${item.name || '?'}${loc}${mark}`;
    });
    return `Call chain below:\n${lines.join('\n')}`;
}

function copyCallChain() {
    const text = formatCallChain();
    if (!text) {
        return;
    }
    vscode.postMessage({ type: 'copyToClipboard', text, notify: 'Call chain copied' });
}

function showCtxMenu(e, items) {
    hideCtxMenu();
    hideCenterOverflow();
    hideSiteMenu();
    closeStyleMenu();
    if (!items.length) {
        return;
    }
    const menu = document.createElement('div');
    menu.id = 'cr-ctx-menu';
    menu.className = 'cr-ctx-menu';
    menu.style.visibility = 'hidden';
    menu.addEventListener('mousedown', ev => ev.stopPropagation());
    for (const entry of items) {
        const item = document.createElement('div');
        item.className = 'cr-ctx-menu-item';
        item.textContent = entry.label;
        item.addEventListener('click', () => {
            hideCtxMenu();
            entry.run();
        });
        menu.appendChild(item);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const pad = 4;
    let left = e.clientX;
    let top = e.clientY;
    if (left + rect.width > window.innerWidth - pad) {
        left = window.innerWidth - rect.width - pad;
    }
    if (top + rect.height > window.innerHeight - pad) {
        top = window.innerHeight - rect.height - pad;
    }
    menu.style.left = Math.max(pad, left) + 'px';
    menu.style.top = Math.max(pad, top) + 'px';
    menu.style.visibility = 'visible';
}

function showCallChainMenu(e) {
    const trail = (lastCenterTrail && lastCenterTrail.items) || [];
    if (trail.length < 2) {
        return;
    }
    showCtxMenu(e, [{ label: 'Copy Call Chain', run: copyCallChain }]);
}

function resetView() {
    if (!lastGraph || !lastGraph.rootId) {
        return;
    }
    savedView = null;
    scrollToNode(lastGraph.rootId);
}

function showCanvasMenu(e) {
    if (!lastGraph || !lastGraph.rootId) {
        return;
    }
    /** @type {{ label: string, run: () => void }[]} */
    const items = [
        { label: 'Expand All', run: () => vscode.postMessage({ type: 'expandAll' }) },
        { label: 'Collapse All', run: () => vscode.postMessage({ type: 'collapseAll' }) },
        { label: 'Reset View', run: resetView }
    ];
    const trail = (lastCenterTrail && lastCenterTrail.items) || [];
    if (trail.length >= 2) {
        items.push({ label: 'Copy Call Chain', run: copyCallChain });
    }
    showCtxMenu(e, items);
}

function hideCenterOverflow() {
    const old = document.querySelector('.cr-centers-drop');
    if (old && old.parentNode) {
        old.parentNode.removeChild(old);
    }
}

function centerItemTitle(item) {
    const name = (item && item.name) || '?';
    const loc = item && item.file
        ? `${item.file}${item.line ? ':' + item.line : ''}`
        : '';
    return loc ? `${name} — ${loc}` : name;
}

function makeCenterSep() {
    const sep = document.createElement('span');
    sep.className = 'cr-centers-sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z"/></svg>';
    return sep;
}

function centerContentWidth(el) {
    const style = getComputedStyle(el);
    const pl = parseFloat(style.paddingLeft) || 0;
    const pr = parseFloat(style.paddingRight) || 0;
    return Math.max(0, el.clientWidth - pl - pr);
}

function centerOverflows(el) {
    const last = el.lastElementChild;
    if (!last) {
        return false;
    }
    const style = getComputedStyle(el);
    const padR = parseFloat(style.paddingRight) || 0;
    const limit = el.getBoundingClientRect().right - padR;
    return last.getBoundingClientRect().right > limit + 0.5;
}

function dropFarthestCenter(visible, current) {
    let drop = -1;
    let bestDist = -1;
    for (const i of visible) {
        if (i === 0 || i === current) {
            continue;
        }
        const dist = Math.abs(i - current);
        if (dist > bestDist || (dist === bestDist && i < drop)) {
            drop = i;
            bestDist = dist;
        }
    }
    if (drop < 0) {
        return false;
    }
    visible.delete(drop);
    return true;
}

function usedCenterWidth(visible, widths, n, sepW, overflowW) {
    let w = 0;
    let needSep = false;
    let i = 0;
    while (i < n) {
        if (visible.has(i)) {
            if (needSep) {
                w += sepW;
            }
            w += widths[i];
            needSep = true;
            i++;
        } else {
            if (needSep) {
                w += sepW;
            }
            w += overflowW;
            needSep = true;
            while (i < n && !visible.has(i)) {
                i++;
            }
        }
    }
    return w;
}

function pickVisibleCenters(widths, current, avail, sepW, overflowW) {
    const n = widths.length;
    const cap = 8;
    const all = new Set(Array.from({ length: n }, (_, i) => i));
    if (n <= 2) {
        return all;
    }
    const fits = set => usedCenterWidth(set, widths, n, sepW, overflowW) <= avail;
    const underCap = set => set.size <= cap;
    if (n <= cap && fits(all)) {
        return all;
    }
    const visible = new Set([0, current]);
    if (!fits(visible)) {
        return visible;
    }
    for (let i = current - 1; i >= 1; i--) {
        visible.add(i);
        if (!fits(visible) || !underCap(visible)) {
            visible.delete(i);
            break;
        }
    }
    for (let i = n - 1; i > current; i--) {
        visible.add(i);
        if (!fits(visible) || !underCap(visible)) {
            visible.delete(i);
            break;
        }
    }
    return visible;
}

function measureCenterPieces(el, items, current) {
    const box = document.createElement('div');
    box.className = 'cr-centers-measure';
    const sep = makeCenterSep();
    const overflow = document.createElement('span');
    overflow.className = 'cr-centers-overflow';
    overflow.textContent = '…';
    box.appendChild(sep);
    box.appendChild(overflow);
    const nodes = items.map((item, i) => {
        const node = document.createElement('span');
        node.className = 'cr-centers-item' + (i === current ? ' is-current' : '');
        node.textContent = item.name || '?';
        box.appendChild(node);
        return node;
    });
    el.appendChild(box);
    const sepW = Math.ceil(sep.getBoundingClientRect().width);
    const overflowW = Math.ceil(overflow.getBoundingClientRect().width);
    const widths = nodes.map(n => Math.ceil(n.getBoundingClientRect().width));
    el.removeChild(box);
    return { sepW, overflowW, widths };
}

function paintCenters(el, items, current, visible) {
    el.innerHTML = '';
    const n = items.length;
    let i = 0;
    let needSep = false;
    while (i < n) {
        if (visible.has(i)) {
            if (needSep) {
                el.appendChild(makeCenterSep());
            }
            const crumb = document.createElement('span');
            crumb.className = 'cr-centers-item' + (i === current ? ' is-current' : '');
            crumb.textContent = items[i].name || '?';
            crumb.title = centerItemTitle(items[i]);
            if (i !== current && !isReferenceGraph(lastGraph)) {
                const index = i;
                crumb.addEventListener('click', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    hideCenterOverflow();
                    clearPathPin();
                    vscode.postMessage({ type: 'focusTrail', index });
                });
            }
            el.appendChild(crumb);
            needSep = true;
            i++;
        } else {
            const hidden = [];
            while (i < n && !visible.has(i)) {
                hidden.push({ item: items[i], index: i });
                i++;
            }
            if (needSep) {
                el.appendChild(makeCenterSep());
            }
            const btn = document.createElement('span');
            btn.className = 'cr-centers-overflow';
            btn.textContent = '…';
            btn.title = hidden.map(h => h.item.name || '?').join(' › ');
            btn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                if (document.querySelector('.cr-centers-drop')) {
                    hideCenterOverflow();
                    return;
                }
                hideCenterOverflow();
                const menu = document.createElement('div');
                menu.className = 'cr-centers-drop';
                hidden.forEach(h => {
                    const row = document.createElement('div');
                    row.className = 'cr-centers-drop-item';
                    row.textContent = h.item.name || '?';
                    row.addEventListener('click', ev => {
                        ev.stopPropagation();
                        hideCenterOverflow();
                        if (isReferenceGraph(lastGraph)) {
                            return;
                        }
                        clearPathPin();
                        vscode.postMessage({ type: 'focusTrail', index: h.index });
                    });
                    menu.appendChild(row);
                });
                document.body.appendChild(menu);
                const r = btn.getBoundingClientRect();
                let left = r.left;
                const maxLeft = window.innerWidth - menu.offsetWidth - 8;
                if (left > maxLeft) {
                    left = Math.max(8, maxLeft);
                }
                const top = Math.max(4, r.bottom + 4);
                menu.style.left = left + 'px';
                menu.style.top = top + 'px';
            });
            el.appendChild(btn);
            needSep = true;
        }
    }
}

function renderNotice(graph) {
    const host = document.getElementById('cr-notice');
    if (!host) {
        return;
    }
    const text = (graph && graph.notice) || '';
    host.textContent = text;
    host.hidden = !text;
}

function renderCenters(graph) {
    const host = document.getElementById('cr-centers');
    if (!host) {
        return;
    }
    hideCenterOverflow();
    const items = (graph && graph.centerTrail) || [];
    const index = graph && typeof graph.centerIndex === 'number' ? graph.centerIndex : items.length - 1;
    lastCenterTrail = { items, index };
    const show = items.length > 1;
    host.hidden = !show;
    if (!show) {
        host.innerHTML = '';
        return;
    }
    const current = Math.max(0, Math.min(index, items.length - 1));
    host.innerHTML = '';
    const { sepW, overflowW, widths } = measureCenterPieces(host, items, current);
    const avail = Math.max(0, centerContentWidth(host) - 8);
    const visible = pickVisibleCenters(widths, current, avail, sepW, overflowW);
    paintCenters(host, items, current, visible);
    while (items.length > 2 && centerOverflows(host) && dropFarthestCenter(visible, current)) {
        paintCenters(host, items, current, visible);
    }
}

function focusPrevCenter() {
    if (!lastGraph || isReferenceGraph(lastGraph)) {
        return;
    }
    const trail = lastGraph.centerTrail || [];
    const idx = typeof lastGraph.centerIndex === 'number' ? lastGraph.centerIndex : trail.length - 1;
    if (idx > 0) {
        clearPathPin();
        vscode.postMessage({ type: 'focusTrail', index: idx - 1 });
        return;
    }
    const prev = lastGraph.nodes.find(n => n.prevCenter);
    if (!prev) {
        return;
    }
    selectNode(prev, false);
    clearPathPin();
    vscode.postMessage({ type: 'focusNode', nodeId: prev.id });
}

function clearNavSelection() {
    selectedId = '';
    selectedKey = '';
    paintSelection();
}

function isTypingTarget(el) {
    if (!el || !el.closest) {
        return false;
    }
    return !!el.closest('input, textarea, select, [contenteditable="true"]');
}

function syncFindToggles() {
    if (findCaseBtn) {
        findCaseBtn.classList.toggle('is-on', findMatchCase);
        findCaseBtn.setAttribute('aria-pressed', findMatchCase ? 'true' : 'false');
    }
    if (findWordBtn) {
        findWordBtn.classList.toggle('is-on', findWholeWord);
        findWordBtn.setAttribute('aria-pressed', findWholeWord ? 'true' : 'false');
    }
}

function updateFindChrome() {
    if (findBar) {
        findBar.classList.toggle('is-open', findOpen);
    }
    syncFindToggles();
    if (findCount) {
        if (!findHits.length) {
            findCount.textContent = 'No results';
            findCount.classList.add('is-empty');
        } else {
            findCount.textContent = `${findIndex + 1} of ${findHits.length}`;
            findCount.classList.remove('is-empty');
        }
    }
    if (findPrevBtn) {
        findPrevBtn.disabled = !findHits.length;
    }
    if (findNextBtn) {
        findNextBtn.disabled = !findHits.length;
    }
}

function paintFindClasses() {
    const canvas = canvasEl;
    if (!canvas) {
        return;
    }
    const current = findHits[findIndex] || '';
    const hitSet = new Set(findHits);
    canvas.classList.toggle('is-find', findHits.length > 0);
    canvas.querySelectorAll('.cr-node').forEach(el => {
        const id = elNodeId(el);
        const hit = hitSet.has(id);
        el.classList.toggle('is-find-hit', hit);
        el.classList.toggle('is-find-current', hit && id === current);
    });
}

function applyFind(opts) {
    const scroll = !!(opts && opts.scroll);
    const keepIndex = !!(opts && opts.keepIndex);
    const prevId = findHits[findIndex] || '';
    findHits = findOpen && findQuery.trim() ? collectFindHits(findQuery) : [];
    if (!keepIndex) {
        findIndex = 0;
    } else if (prevId) {
        const i = findHits.indexOf(prevId);
        findIndex = i >= 0 ? i : 0;
    }
    if (findIndex >= findHits.length) {
        findIndex = 0;
    }
    paintFindClasses();
    updateFindChrome();
    if (scroll && findHits.length) {
        scrollToNode(findHits[findIndex]);
        const hit = graphNode(findHits[findIndex]);
        if (hit) {
            selectNode(hit, false);
        }
    }
}

function postFindState() {
    vscode.postMessage({ type: 'findState', open: findOpen });
}

function openFind() {
    findOpen = true;
    postFindState();
    if (findInput) {
        findQuery = findInput.value;
    }
    applyFind({ scroll: !!findQuery.trim(), keepIndex: true });
    if (findInput) {
        findInput.focus();
        findInput.select();
    }
}

function closeFind() {
    if (!findOpen) {
        return;
    }
    findOpen = false;
    postFindState();
    applyFind({ scroll: false });
}

function stepFind(dir) {
    if (!findOpen) {
        openFind();
        return;
    }
    if (findInput) {
        findQuery = findInput.value;
    }
    applyFind({ keepIndex: true });
    if (!findHits.length) {
        return;
    }
    findIndex = (findIndex + dir + findHits.length) % findHits.length;
    paintFindClasses();
    updateFindChrome();
    scrollToNode(findHits[findIndex]);
    const hit = graphNode(findHits[findIndex]);
    if (hit) {
        selectNode(hit, false);
    }
}

function onFindInput() {
    findQuery = findInput ? findInput.value : '';
    applyFind({ scroll: true });
}

function toggleFindCase() {
    findMatchCase = !findMatchCase;
    applyFind({ scroll: true, keepIndex: true });
}

function toggleFindWord() {
    findWholeWord = !findWholeWord;
    applyFind({ scroll: true, keepIndex: true });
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

const CHILD_SORT_ITEMS = [
    { id: 'name', label: 'Name', title: 'Sort children A–Z by symbol name' },
    { id: 'order', label: 'Order', title: 'Callees: first call in the function. Callers: same file by call line, different files by file name' }
];

function childSortItem(value) {
    return CHILD_SORT_ITEMS.find(s => s.id === value) || CHILD_SORT_ITEMS[0];
}

function syncSortBtn() {
    if (!sortBtn) {
        return;
    }
    const item = childSortItem(childSort);
    const text = sortBtn.querySelector('.cr-sort-text');
    if (text) {
        text.textContent = item.label;
    } else {
        sortBtn.textContent = item.label;
    }
    sortBtn.title = item.title;
}

function applyChildSort(next) {
    const value = normalizeChildSort(next);
    if (value === childSort) {
        syncSortBtn();
        return;
    }
    childSort = value;
    syncSortBtn();
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

function stopBeforeTip(x1, y1, x2, y2, toTip) {
    if (toTip) {
        return { x: x2, y: y2 };
    }
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const back = Math.min(ARROW_LEN, len * 0.45);
    return {
        x: x2 - dx / len * back,
        y: y2 - dy / len * back
    };
}

function directPath(x1, y1, x2, y2, toTip) {
    const end = stopBeforeTip(x1, y1, x2, y2, toTip);
    return `M ${x1} ${y1} L ${end.x} ${end.y}`;
}

function arcPath(x1, y1, x2, y2, toTip) {
    const dir = x2 >= x1 ? 1 : -1;
    const xBase = toTip ? x2 : x2 - dir * ARROW_LEN;
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

function edgePath(graph, edge, pos, ports, toTip) {
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
            ? arcPath(p.x1, p.y1, p.x2, p.y2, toTip)
            : directPath(p.x1, p.y1, p.x2, p.y2, toTip);
    }
    const p = centerEnds(a, b);
    if (p.sameCol) {
        const end = stopBeforeTip(p.x1, p.y1, p.x2, p.y2, toTip);
        return `M ${p.x1} ${p.y1} L ${end.x} ${end.y}`;
    }
    const hubId = edgeHubId(graph, edge);
    const hubPos = pos[hubId] || a;
    const childPos = hubId === edge.from ? b : a;
    return orthoPath(p.x1, p.y1, p.x2, p.y2, busXForHub(hubPos, childPos), toTip);
}

function busXForHub(hubPos, childPos) {
    const gap = 28;
    if (childPos.x >= hubPos.x) {
        return hubPos.x + nodeW(hubPos) + gap;
    }
    return hubPos.x - gap;
}

function orthoPath(x1, y1, x2, y2, busX, toTip) {
    const dir = x2 >= x1 ? 1 : -1;
    const xEnd = toTip ? x2 : x2 - dir * ARROW_LEN;
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
/** `.cr-node` of the current pointer visit; once a tip shows, no more until leave. */
let tipVisitNode = null;
let tipVisitUsed = false;

function tipHost(el) {
    if (!el) {
        return null;
    }
    return (el.closest && el.closest('.cr-node')) || el;
}

function beginTipVisit(nodeEl) {
    if (tipVisitNode !== nodeEl) {
        tipVisitNode = nodeEl;
        tipVisitUsed = false;
    }
}

function endTipVisit(nodeEl) {
    if (tipVisitNode === nodeEl) {
        tipVisitNode = null;
        tipVisitUsed = false;
    }
}

function markTipUsed(el) {
    const host = tipHost(el);
    if (host) {
        tipVisitNode = host;
        tipVisitUsed = true;
    }
}

function tipVisitBlocked(el) {
    const host = tipHost(el);
    return !!(host && tipVisitNode === host && tipVisitUsed);
}

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

function noteAlt(ev) {
    if (ev && typeof ev.altKey === 'boolean') {
        altHeld = ev.altKey;
    }
}

function tipsEnabled() {
    return tipsAuto || altHeld;
}

function armTip(spec, ev) {
    if (ev) {
        noteAlt(ev);
    }
    if (tipVisitBlocked(spec.el)) {
        return;
    }
    tipHover = spec;
    if (!tipsEnabled()) {
        if (nodeTipTimer) {
            clearTimeout(nodeTipTimer);
            nodeTipTimer = 0;
        }
        return;
    }
    if (nodeTipTimer) {
        clearTimeout(nodeTipTimer);
    }
    nodeTipTimer = setTimeout(() => {
        nodeTipTimer = 0;
        if (tipHover && tipHover.el === spec.el && !tipVisitBlocked(spec.el) && tipsEnabled()) {
            showTip(spec);
        }
    }, tipDelayMs);
}

function armNodeTip(node, el, ev) {
    armTip({ node, el }, ev);
}

function armLabelTip(label, el, hop, ev) {
    armTip({ label, el, hop }, ev);
}

function onTipMove(ev, spec) {
    noteAlt(ev);
    if (ev.clientX === tipMoveX && ev.clientY === tipMoveY) {
        return;
    }
    tipMoveX = ev.clientX;
    tipMoveY = ev.clientY;
    if (nodeTipEl) {
        hideNodeTip();
        markTipUsed(spec.el);
        tipHover = null;
        return;
    }
    armTip(spec, ev);
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
    if (node.typeName) {
        const typeEl = document.createElement('div');
        typeEl.className = 'cr-node-tip-type';
        typeEl.textContent = `type: ${node.typeName}`;
        tip.appendChild(typeEl);
    }
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
    if (lastGraph && isCyclicNode(lastGraph, node)) {
        const cycle = document.createElement('div');
        cycle.className = 'cr-node-tip-detail cr-node-tip-cycle';
        cycle.textContent = 'Repeats an ancestor on this path';
        tip.appendChild(cycle);
    }
    if (lastGraph && node.kind === 'symbol' && node.itemKey) {
        const others = symbolTwins(node.itemKey).filter(t => t.id !== node.id);
        if (others.length) {
            const alias = document.createElement('div');
            alias.className = 'cr-node-tip-detail cr-node-tip-twin';
            const vias = [];
            const seen = new Set();
            for (const t of others) {
                const parent = t.parentId ? graphNode(t.parentId) : undefined;
                const via = parent
                    ? (nodeLabel(parent) || parent.name)
                    : (t.file ? `${t.file}:${t.line}` : t.name);
                if (!via || seen.has(via)) {
                    continue;
                }
                seen.add(via);
                vias.push(via);
            }
            const total = others.length + 1;
            alias.textContent = vias.length === 1
                ? `Same function on ${total} call paths — also under ${vias[0]}. Click ×${total} to jump.`
                : `Same function on ${total} call paths — also under ${vias.join(', ')}. Click ×${total} to jump.`;
            tip.appendChild(alias);
        }
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
    markTipUsed(spec.el);
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
    if (graph.rootId && selectedRootId && selectedRootId !== graph.rootId) {
        selectedId = '';
        selectedKey = '';
        selectedRootId = graph.rootId;
    } else if (graph.rootId && !selectedRootId) {
        selectedRootId = graph.rootId;
    }
    resolveSelection();
    if (graph.rootId && nameOnlyIds.delete(graph.rootId)) {
        persistViewState();
    }
    if (!stage) {
        return;
    }
    if (titleEl) {
        titleEl.textContent = relationTitle(graph);
    }
    renderCenters(graph);
    renderNotice(graph);
    if (!graph.nodes || !graph.nodes.length) {
        lastPos = null;
        canvasEl = null;
        zoomWrap = null;
        stage.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'cr-empty';
        empty.textContent = graph.empty || 'No call hierarchy at this position.';
        stage.appendChild(empty);
        applyFind({ keepIndex: true });
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
    refreshHover = () => {
        if (!hoverNode) {
            setHoverPaths([]);
            paintTwins();
            return;
        }
        const twinIds = (altHeld && hoverNode.itemKey)
            ? symbolTwins(hoverNode.itemKey).map(t => t.id)
            : [hoverNode.id];
        const hoverDs = [];
        for (const id of twinIds) {
            const list = edgesByNode.get(id);
            if (list) {
                hoverDs.push(...list);
            }
        }
        setHoverPaths(hoverDs);
        paintTwins();
    };
    const ports = isSpreadStyle(edgeStyle) ? edgePorts(graph, pos) : {};
    /** @type {Map<string, string[]>} */
    const edgesByNode = new Map();
    const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
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
        g.setAttribute('data-from', encodeNodeId(edge.from));
        g.setAttribute('data-to', encodeNodeId(edge.to));
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'cr-edge' + (edge.style === 'anchor' ? ' is-anchor' : ''));
        path.setAttribute('d', d);
        path.setAttribute('marker-end', 'url(#cr-arrow)');
        g.appendChild(path);
        if (live) {
            const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            hit.setAttribute('class', 'cr-edge-hit');
            hit.setAttribute('d', edgePath(graph, edge, pos, ports, true) || d);
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
        if (live && edge.sites.length > 1) {
            const from = nodeById.get(edge.from);
            const nearTail = !!(from && from.parentId === edge.to);
            addSiteCountLabel(g, path, edge.sites.length, nearTail, pos[nearTail ? edge.from : edge.to]);
        }
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
        if (isNodeSelected(node)) {
            el.classList.add('is-selected');
        }
        if (isTwinHighlight(node)) {
            el.classList.add('is-twin');
        }
        if (node.kind === 'more') {
            el.classList.add('is-more');
        }
        if (node.kind === 'group') {
            el.classList.add('is-group');
            if (node.expanded) {
                el.classList.add('is-expanded');
            }
        }
        if (node.compact) {
            el.classList.add('is-compact');
        }
        if (isCyclicNode(graph, node)) {
            el.classList.add('is-cycle');
        }
        setElNodeId(el, node.id);
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        el.style.width = nodeW(p) + 'px';
        el.style.height = p.h + 'px';
        el.addEventListener('pointerenter', ev => {
            setHoverTwin(node);
            beginTipVisit(el);
            if (ev.target && ev.target.closest && ev.target.closest('.cr-toggle, .cr-thumb')) {
                return;
            }
            if (usesNodeTip(node)) {
                tipMoveX = ev.clientX;
                tipMoveY = ev.clientY;
                armNodeTip(node, el, ev);
            }
        });
        el.addEventListener('pointermove', ev => {
            if (ev.target && ev.target.closest && ev.target.closest('.cr-toggle')) {
                if (tipHover && tipHover.el === el) {
                    tipHover = null;
                    hideNodeTip();
                }
                return;
            }
            if (usesNodeTip(node)) {
                onNodeTipMove(ev, node, el);
            }
        });
        el.addEventListener('pointerleave', ev => {
            setHoverTwin(undefined);
            if (usesNodeTip(node)) {
                const next = ev.relatedTarget;
                if (next && el.contains(next)) {
                    return;
                }
                tipHover = null;
                endTipVisit(el);
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
                selectNode(node, false);
                vscode.postMessage({ type: 'expandMore', nodeId: node.expandKey || node.id });
            });
        } else if (node.kind === 'group') {
            const head = document.createElement('div');
            head.className = 'cr-node-head';
            const name = document.createElement('div');
            name.className = 'cr-node-name';
            fillNodeName(name, node);
            const caret = document.createElement('span');
            caret.className = 'cr-group-caret';
            caret.setAttribute('aria-hidden', 'true');
            head.appendChild(caret);
            head.appendChild(name);
            el.appendChild(head);
            const meta = document.createElement('div');
            meta.className = 'cr-node-meta';
            const n = node.moreCount || 0;
            meta.textContent = `${n} library symbol${n === 1 ? '' : 's'}`;
            el.appendChild(meta);
            el.addEventListener('click', ev => {
                ev.stopPropagation();
                if (ev.altKey) {
                    togglePathPin(node.id);
                    return;
                }
                selectNode(node, false);
                vscode.postMessage({ type: 'toggleGroup', nodeId: node.id });
            });
            addThumb(el, head, node);
        } else {
            const head = document.createElement('div');
            head.className = 'cr-node-head';
            const name = document.createElement('div');
            name.className = 'cr-node-name';
            fillNodeName(name, node);
            head.appendChild(name);
            el.appendChild(head);
            const meta = document.createElement('div');
            meta.className = 'cr-node-meta';
            meta.textContent = node.file ? `${node.file}:${node.line}` : '';
            el.appendChild(meta);
            el.addEventListener('pointerdown', ev => {
                if (ev.button !== 0) {
                    return;
                }
                if (ev.target && ev.target.closest && ev.target.closest('.cr-toggle, .cr-thumb')) {
                    return;
                }
                selectNode(node, false);
            });
            el.addEventListener('click', ev => {
                if (ev.altKey) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    togglePathPin(node.id);
                    return;
                }
                if (ev.detail > 1) {
                    return;
                }
                vscode.postMessage({ type: 'openNode', nodeId: node.id });
            });
            el.addEventListener('dblclick', ev => {
                ev.preventDefault();
                ev.stopPropagation();
                if (isReferenceGraph(graph)) {
                    return;
                }
                selectNode(node, false);
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
                exp.addEventListener('pointerenter', ev => {
                    ev.stopPropagation();
                    tipHover = null;
                    if (nodeTipEl) {
                        hideNodeTip();
                        markTipUsed(el);
                    } else {
                        hideNodeTip();
                    }
                });
                exp.addEventListener('pointerleave', ev => {
                    ev.stopPropagation();
                    const next = ev.relatedTarget;
                    if (next && el.contains(next) && !(next.closest && next.closest('.cr-thumb, .cr-toggle'))) {
                        tipMoveX = ev.clientX;
                        tipMoveY = ev.clientY;
                        if (usesNodeTip(node)) {
                            armNodeTip(node, el, ev);
                        }
                    }
                });
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
        if (el.classList.contains('is-cycle')) {
            el.appendChild(createCycleBadge());
        } else if (node.kind === 'symbol' && node.itemKey) {
            const twins = symbolTwins(node.itemKey);
            if (twins.length > 1) {
                el.classList.add('is-alias');
                el.appendChild(createTwinBadge(node, twins));
            }
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
    applyFind({ keepIndex: true });
    applyPendingHop();
    if (lastTipNodeId && canvas) {
        const n = graph.nodes.find(x => x.id === lastTipNodeId);
        const el = [...canvas.querySelectorAll('.cr-node')].find(e => elNodeId(e) === lastTipNodeId);
        if (usesNodeTip(n) && el) {
            showNodeTip(n, el);
        } else {
            hideNodeTip();
        }
    }
}

const PAN_SLOP = 5;

function bindPan(el) {
    let dragging = false;
    let pending = false;
    let suppressClick = false;
    let sx = 0;
    let sy = 0;
    let sl = 0;
    let st = 0;
    const suppressTipAt = (clientX, clientY) => {
        const hit = document.elementFromPoint(clientX, clientY);
        const node = hit && hit.closest && hit.closest('.cr-node');
        if (!node) {
            return;
        }
        markTipUsed(node);
        tipHover = null;
        hideNodeTip();
    };
    const beginDrag = e => {
        dragging = true;
        pending = false;
        tipHover = null;
        hideNodeTip();
        el.classList.add('is-panning');
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    };
    el.addEventListener('pointerdown', e => {
        if (e.button !== 0) {
            return;
        }
        const hit = e.target;
        if (hit && hit.closest && hit.closest('.cr-toggle, .cr-thumb, .cr-twin, .cr-edge-group, .cr-site-menu')) {
            return;
        }
        const onNode = !!(hit && hit.closest && hit.closest('.cr-node'));
        pending = onNode;
        dragging = !onNode;
        sx = e.clientX;
        sy = e.clientY;
        sl = el.scrollLeft;
        st = el.scrollTop;
        if (dragging) {
            beginDrag(e);
        }
    });
    el.addEventListener('pointermove', e => {
        if (pending && !dragging) {
            if (Math.hypot(e.clientX - sx, e.clientY - sy) < PAN_SLOP) {
                return;
            }
            suppressClick = true;
            beginDrag(e);
        }
        if (!dragging) {
            return;
        }
        el.scrollLeft = sl - (e.clientX - sx);
        el.scrollTop = st - (e.clientY - sy);
    });
    const endPan = e => {
        const moved = dragging;
        const x = e && typeof e.clientX === 'number' ? e.clientX : sx;
        const y = e && typeof e.clientY === 'number' ? e.clientY : sy;
        dragging = false;
        pending = false;
        el.classList.remove('is-panning');
        if (suppressClick) {
            setTimeout(() => {
                suppressClick = false;
            }, 0);
        }
        if (moved) {
            requestAnimationFrame(() => suppressTipAt(x, y));
        }
    };
    el.addEventListener('pointerup', endPan);
    el.addEventListener('pointercancel', endPan);
    el.addEventListener('click', e => {
        if (!suppressClick) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
    }, true);
}

pinBtn?.addEventListener('click', () => {
    const next = !pinBtn.classList.contains('is-on');
    vscode.postMessage({ type: 'setPinned', value: next });
});

function syncTipsBtn() {
    if (!tipsBtn) {
        return;
    }
    tipsBtn.classList.toggle('is-on', tipsAuto);
    tipsBtn.setAttribute('aria-pressed', tipsAuto ? 'true' : 'false');
    tipsBtn.setAttribute('aria-label', tipsAuto ? 'Node tips on' : 'Node tips off, hold Alt to show');
    tipsBtn.title = tipsAuto
        ? 'Tips on — hover to show. Click to show only while holding Alt.'
        : 'Tips off — hold Alt to show. Click to show on hover.';
}

function applyTipsAuto(next) {
    tipsAuto = !!next;
    persistViewState();
    syncTipsBtn();
    if (!tipsEnabled()) {
        hideNodeTip();
    } else if (tipHover) {
        armTip(tipHover);
    }
}

syncTipsBtn();
tipsBtn?.addEventListener('click', () => {
    applyTipsAuto(!tipsAuto);
});

function isAltKey(e) {
    return e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight';
}

let altSteal = false;
let altStealTimer = 0;

function keepWebviewFocus() {
    if (isTypingTarget(document.activeElement)) {
        return;
    }
    const el = document.body;
    if (el && el.tabIndex < 0) {
        el.tabIndex = -1;
    }
    try {
        el.focus({ preventScroll: true });
    } catch (_) {
        el?.focus();
    }
    vscode.postMessage({ type: 'keepFocus' });
}

function markAltSteal() {
    altSteal = true;
    if (altStealTimer) {
        clearTimeout(altStealTimer);
    }
    altStealTimer = setTimeout(() => {
        altStealTimer = 0;
        altSteal = false;
    }, 200);
}

window.addEventListener('keydown', e => {
    if (!isAltKey(e)) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    markAltSteal();
    if (e.repeat) {
        return;
    }
    altHeld = true;
    refreshHover();
    if (!tipsAuto && tipHover && !isTypingTarget(e.target)) {
        armTip(tipHover);
    }
}, true);
window.addEventListener('keyup', e => {
    if (!isAltKey(e)) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    markAltSteal();
    altHeld = false;
    refreshHover();
    if (!tipsAuto) {
        hideNodeTip();
    }
    keepWebviewFocus();
}, true);
window.addEventListener('blur', () => {
    altHeld = false;
    refreshHover();
    if (!tipsAuto) {
        hideNodeTip();
    }
    if (altSteal) {
        keepWebviewFocus();
    }
});

helpBtn?.addEventListener('click', () => {
    if (!hintEl) {
        return;
    }
    const open = hintEl.hidden;
    hintEl.hidden = !open;
    helpBtn.classList.toggle('is-on', open);
    helpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    helpBtn.setAttribute('aria-label', open ? 'Hide help' : 'Show help');
    helpBtn.title = open ? 'Hide help' : 'Show help';
});

function applyUpdateMode(value) {
    const sticky = value === 'sticky';
    if (updateBtn) {
        updateBtn.classList.toggle('is-on', sticky);
        updateBtn.title = sticky
            ? 'Update mode: Sticky — keep last graph until new results'
            : 'Update mode: Live — empty graph when no call hierarchy';
        updateBtn.innerHTML = (sticky
            ? '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10.2 1.5 9.5 2.2l.3 3.5L12 8.2V9H9v5H7V9H4V8.2l2.2-2.5.3-3.5-.7-.7L6.5 1h3.7z"/></svg>'
            : '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 3C4.67 3 1.82 5.07 1 8c.82 2.93 3.67 5 7 5s6.18-2.07 7-5c-.82-2.93-3.67-5-7-5zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.5A1.5 1.5 0 1 0 8 6a1.5 1.5 0 0 0 0 3z"/></svg>')
            + '<span class="cr-update-label">'
            + '<span class="cr-update-sizer" aria-hidden="true">Sticky</span>'
            + '<span class="cr-update-text">' + (sticky ? 'Sticky' : 'Live') + '</span>'
            + '</span>';
    }
}

updateBtn?.addEventListener('click', () => {
    const next = updateBtn.classList.contains('is-on') ? 'live' : 'sticky';
    applyUpdateMode(next);
    vscode.postMessage({ type: 'setUpdateMode', value: next });
});

const SLIM_KIND_ITEMS = [
    { id: 'function', label: 'Function' },
    { id: 'method', label: 'Method' },
    { id: 'constructor', label: 'Constructor' },
    { id: 'class', label: 'Class' },
    { id: 'struct', label: 'Struct' },
    { id: 'variable', label: 'Variable' },
    { id: 'constant', label: 'Constant' },
    { id: 'property', label: 'Property' },
    { id: 'file', label: 'File' },
    { id: 'module', label: 'Module' },
    { id: 'namespace', label: 'Namespace' },
    { id: 'package', label: 'Package' },
    { id: 'field', label: 'Field' },
    { id: 'enum', label: 'Enum' },
    { id: 'interface', label: 'Interface' },
    { id: 'string', label: 'String' },
    { id: 'number', label: 'Number' },
    { id: 'boolean', label: 'Boolean' },
    { id: 'array', label: 'Array' },
    { id: 'object', label: 'Object' },
    { id: 'key', label: 'Key' },
    { id: 'null', label: 'Null' },
    { id: 'enumMember', label: 'EnumMember' },
    { id: 'event', label: 'Event' },
    { id: 'operator', label: 'Operator' },
    { id: 'typeParameter', label: 'TypeParameter' }
];

const DEFAULT_SLIM_KIND_IDS = [
    'function',
    'method',
    'constructor',
    'class',
    'struct',
    'variable',
    'constant',
    'property'
];

/** @type {string[]} */
let compactKinds = DEFAULT_SLIM_KIND_IDS.slice();

function normalizeCompactKinds(value) {
    if (!Array.isArray(value)) {
        return DEFAULT_SLIM_KIND_IDS.slice();
    }
    const allowed = new Set(SLIM_KIND_ITEMS.map(item => item.id));
    const ids = [];
    const seen = new Set();
    for (const entry of value) {
        if (typeof entry !== 'string' || !allowed.has(entry) || seen.has(entry)) {
            continue;
        }
        seen.add(entry);
        ids.push(entry);
    }
    return ids;
}

function applyCompactFilter(on) {
    const slim = !!on;
    slimWrap?.classList.toggle('is-on', slim);
    if (slimBtn) {
        slimBtn.classList.remove('is-on');
        slimBtn.setAttribute('aria-pressed', slim ? 'true' : 'false');
        slimBtn.title = slim
            ? 'Slim filter on — keep the kinds checked in the list'
            : 'Slim filter off — show every symbol the language server returns';
    }
    slimKindsBtn?.classList.remove('is-on');
}

function applyCompactKinds(value, fromHost) {
    if (fromHost && document.getElementById('cr-slim-menu')) {
        return;
    }
    compactKinds = normalizeCompactKinds(value);
    syncSlimKindMenu();
}

function slimKindChecked(id) {
    return compactKinds.indexOf(id) >= 0;
}

function toggleSlimKind(id) {
    const next = compactKinds.slice();
    const index = next.indexOf(id);
    if (index >= 0) {
        next.splice(index, 1);
    } else {
        const order = SLIM_KIND_ITEMS.map(item => item.id);
        next.push(id);
        next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    }
    applyCompactKinds(next);
    vscode.postMessage({ type: 'setCompactKinds', value: next });
}

function syncSlimKindMenu() {
    const menu = document.getElementById('cr-slim-menu');
    if (!menu) {
        return;
    }
    menu.querySelectorAll('[data-kind]').forEach(el => {
        const id = el.getAttribute('data-kind');
        const on = slimKindChecked(id);
        el.classList.toggle('is-checked', on);
        el.setAttribute('aria-checked', on ? 'true' : 'false');
        const box = el.querySelector('input[type="checkbox"]');
        if (box) {
            box.checked = on;
        }
    });
}

let slimMenuClose = null;

function closeSlimMenu() {
    const menu = document.getElementById('cr-slim-menu');
    if (menu) {
        menu.remove();
    }
    slimKindsBtn?.classList.remove('is-open');
    slimKindsBtn?.setAttribute('aria-expanded', 'false');
    if (slimMenuClose) {
        document.removeEventListener('mousedown', slimMenuClose, true);
        slimMenuClose = null;
    }
}

function openSlimMenu() {
    if (!slimKindsBtn) {
        return;
    }
    if (document.getElementById('cr-slim-menu')) {
        closeSlimMenu();
        return;
    }
    closeStyleMenu();
    const menu = document.createElement('div');
    menu.id = 'cr-slim-menu';
    menu.className = 'cr-style-menu cr-slim-menu';
    SLIM_KIND_ITEMS.forEach(item => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'cr-slim-menu-item' + (slimKindChecked(item.id) ? ' is-checked' : '');
        el.setAttribute('data-kind', item.id);
        el.setAttribute('role', 'menuitemcheckbox');
        el.setAttribute('aria-checked', slimKindChecked(item.id) ? 'true' : 'false');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.tabIndex = -1;
        box.checked = slimKindChecked(item.id);
        const label = document.createElement('span');
        label.textContent = item.label;
        el.appendChild(box);
        el.appendChild(label);
        el.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            toggleSlimKind(item.id);
        });
        menu.appendChild(el);
    });
    const wrap = document.getElementById('cr-slim-wrap') || slimKindsBtn.parentElement;
    (wrap || document.body).appendChild(menu);
    slimKindsBtn.classList.add('is-open');
    slimKindsBtn.setAttribute('aria-expanded', 'true');
    slimMenuClose = e => {
        if ((slimBtn && slimBtn.contains(e.target))
            || slimKindsBtn.contains(e.target)
            || menu.contains(e.target)) {
            return;
        }
        closeSlimMenu();
    };
    document.addEventListener('mousedown', slimMenuClose, true);
}

slimBtn?.addEventListener('click', () => {
    const next = !(slimWrap && slimWrap.classList.contains('is-on'));
    applyCompactFilter(next);
    vscode.postMessage({ type: 'setCompactFilter', value: next });
});

slimKindsBtn?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    openSlimMenu();
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
    closeSlimMenu();
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

sortBtn?.addEventListener('click', () => {
    const next = childSort === 'name' ? 'order' : 'name';
    applyChildSort(next);
    vscode.postMessage({ type: 'setChildSort', value: next });
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

window.addEventListener('resize', () => {
    if (!lastCenterTrail || lastCenterTrail.items.length < 2) {
        return;
    }
    if (centerTrailResize) {
        clearTimeout(centerTrailResize);
    }
    centerTrailResize = setTimeout(() => {
        centerTrailResize = 0;
        renderCenters({
            centerTrail: lastCenterTrail.items,
            centerIndex: lastCenterTrail.index
        });
    }, 80);
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
        }
        applyUpdateMode(msg.updateMode);
        applyCompactFilter(!!msg.compactFilter);
        applyCompactKinds(msg.compactKinds, true);
        applyEdgeStyle(normalizeEdgeStyle(msg.edgeStyle));
        applyChildSort(normalizeChildSort(msg.childSort));
        if (typeof msg.hoverDelay === 'number' && Number.isFinite(msg.hoverDelay) && msg.hoverDelay >= 0) {
            tipDelayMs = msg.hoverDelay;
        }
    } else if (msg.type === 'find') {
        if (msg.action === 'next') {
            stepFind(1);
        } else if (msg.action === 'prev') {
            stepFind(-1);
        } else if (msg.action === 'close') {
            closeFind();
        } else {
            openFind();
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

findInput?.addEventListener('input', onFindInput);
findInput?.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        toggleFindCase();
        return;
    }
    if (e.altKey && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        toggleFindWord();
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        closeFind();
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        stepFind(e.shiftKey ? -1 : 1);
    }
});
findCaseBtn?.addEventListener('click', () => {
    toggleFindCase();
});
findWordBtn?.addEventListener('click', () => {
    toggleFindWord();
});
findPrevBtn?.addEventListener('click', () => {
    stepFind(-1);
});
findNextBtn?.addEventListener('click', () => {
    stepFind(1);
});
findCloseBtn?.addEventListener('click', () => {
    closeFind();
});
document.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    const t = e.target;
    if (t && t.closest && t.closest('#cr-stage')) {
        showCanvasMenu(e);
        return;
    }
    if (t && t.closest && t.closest('#cr-centers')) {
        showCallChainMenu(e);
    }
}, true);
document.addEventListener('mousedown', e => {
    const drop = document.querySelector('.cr-centers-drop');
    if (drop && e.target && !drop.contains(e.target) && !(e.target.closest && e.target.closest('.cr-centers-overflow'))) {
        hideCenterOverflow();
    }
    const ctx = document.getElementById('cr-ctx-menu');
    if (ctx && e.target && !ctx.contains(e.target)) {
        hideCtxMenu();
    }
});
document.addEventListener('keydown', e => {
    if (isTypingTarget(e.target)) {
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        if (findOpen) {
            closeFind();
            return;
        }
        if (document.querySelector('.cr-site-menu')) {
            hideSiteMenu();
            return;
        }
        if (document.getElementById('cr-style-menu')) {
            closeStyleMenu();
            return;
        }
        if (document.getElementById('cr-slim-menu')) {
            closeSlimMenu();
            return;
        }
        if (document.getElementById('cr-ctx-menu')) {
            hideCtxMenu();
            return;
        }
        if (document.querySelector('.cr-centers-drop')) {
            hideCenterOverflow();
            return;
        }
        if (pinnedNodeId) {
            clearPathPin();
            return;
        }
        if (selectedId || selectedKey) {
            clearNavSelection();
        }
        return;
    }
    if (e.key === 'Enter') {
        if (findOpen) {
            return;
        }
        e.preventDefault();
        if (e.shiftKey) {
            toggleExpandSelected();
        } else {
            openSelected();
        }
        return;
    }
    if (e.key === 'Backspace') {
        e.preventDefault();
        focusPrevCenter();
        return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveSibling(e.key === 'ArrowDown' ? 1 : -1);
        return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        hopMove(e.key === 'ArrowRight' ? 1 : -1);
    }
});

syncStyleBtn();
applyZoomChrome();
vscode.postMessage({ type: 'ready' });
