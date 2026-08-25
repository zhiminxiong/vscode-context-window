//@ts-check

const NODE_W = 168;
const NODE_H = 52;
const MORE_H = 36;
const COL_GAP = 88;
const ROW_GAP = 14;
const PAD = 40;

/** @type {{ postMessage: (msg: any) => void }} */
const vscode = acquireVsCodeApi();

const titleEl = document.getElementById('cr-title');
const stage = document.getElementById('cr-stage');
const emptyEl = document.getElementById('cr-empty');
const pinBtn = document.getElementById('cr-pin');
const refreshBtn = document.getElementById('cr-refresh');

/** @type {any} */
let lastGraph = null;

function nodeHeight(node) {
    return node.kind === 'more' ? MORE_H : NODE_H;
}

function layout(graph) {
    /** @type {Record<string, { x: number, y: number, h: number }>} */
    const pos = {};
    const byHop = new Map();
    for (const node of graph.nodes) {
        if (!byHop.has(node.hop)) {
            byHop.set(node.hop, []);
        }
        byHop.get(node.hop).push(node);
    }
    const hops = [...byHop.keys()].sort((a, b) => a - b);
    const root = graph.nodes.find(n => n.id === graph.rootId);
    if (root) {
        pos[root.id] = { x: 0, y: 0, h: NODE_H };
    }

    function placeHop(hop) {
        const col = byHop.get(hop) || [];
        const parentHop = hop < 0 ? hop + 1 : hop - 1;
        const parents = (byHop.get(parentHop) || []).filter(n => n.kind === 'symbol');
        const groups = [];
        if (parents.length) {
            for (const parent of parents) {
                const kids = col.filter(n => n.parentId === parent.id);
                if (kids.length) {
                    groups.push({ parent, kids });
                }
            }
        } else {
            groups.push({ parent: null, kids: col });
        }
        for (const group of groups) {
            const block = group.kids.reduce((sum, n) => sum + nodeHeight(n) + ROW_GAP, 0) - ROW_GAP;
            const parentY = group.parent && pos[group.parent.id] ? pos[group.parent.id].y : 0;
            let y = parentY + NODE_H / 2 - block / 2;
            for (const kid of group.kids) {
                pos[kid.id] = {
                    x: hop * (NODE_W + COL_GAP),
                    y,
                    h: nodeHeight(kid)
                };
                y += nodeHeight(kid) + ROW_GAP;
            }
        }
        const ordered = col.filter(n => pos[n.id]).sort((a, b) => pos[a.id].y - pos[b.id].y);
        for (let i = 1; i < ordered.length; i++) {
            const prev = pos[ordered[i - 1].id];
            const cur = pos[ordered[i].id];
            const minY = prev.y + prev.h + ROW_GAP;
            if (cur.y < minY) {
                cur.y = minY;
            }
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
        maxX = Math.max(maxX, p.x + NODE_W);
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

function bezier(x1, y1, x2, y2) {
    const mid = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

function bezierPoint(x1, y1, x2, y2, t) {
    const mid = (x1 + x2) / 2;
    const u = 1 - t;
    return {
        x: u * u * u * x1 + 3 * u * u * t * mid + 3 * u * t * t * mid + t * t * t * x2,
        y: u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2
    };
}

function hideSiteMenu() {
    const old = document.querySelector('.cr-site-menu');
    if (old && old.parentNode) {
        old.parentNode.removeChild(old);
    }
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
    canvas.className = 'cr-canvas';
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'cr-edges');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    /** @type {{ edge: any, x: number, y: number }[]} */
    const siteMarks = [];
    for (const edge of graph.edges) {
        const a = pos[edge.from];
        const b = pos[edge.to];
        if (!a || !b) {
            continue;
        }
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'cr-edge');
        const fromRight = a.x < b.x;
        const x1 = fromRight ? a.x + NODE_W : a.x;
        const x2 = fromRight ? b.x : b.x + NODE_W;
        const y1 = a.y + a.h / 2;
        const y2 = b.y + b.h / 2;
        path.setAttribute('d', bezier(x1, y1, x2, y2));
        svg.appendChild(path);
        if (edge.sites && edge.sites.length) {
            const fromNode = graph.nodes.find(n => n.id === edge.from);
            const toNode = graph.nodes.find(n => n.id === edge.to);
            const childIsTo = Math.abs(toNode?.hop || 0) > Math.abs(fromNode?.hop || 0);
            const pt = bezierPoint(x1, y1, x2, y2, childIsTo ? 0.78 : 0.22);
            siteMarks.push({ edge, x: pt.x, y: pt.y });
        }
    }
    canvas.appendChild(svg);

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
        if (node.kind === 'more') {
            el.classList.add('is-more');
        }
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        el.style.height = p.h + 'px';
        el.title = node.kind === 'more'
            ? 'Show more siblings'
            : `${node.name}\n${node.path}:${node.line}`;

        if (node.kind === 'more') {
            el.textContent = node.name;
            el.addEventListener('click', ev => {
                ev.stopPropagation();
                vscode.postMessage({ type: 'expandMore', nodeId: node.expandKey || node.id });
            });
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
            el.addEventListener('click', () => {
                vscode.postMessage({ type: 'openNode', nodeId: node.id });
            });
            if (node.expandable && node.id !== graph.rootId) {
                const exp = document.createElement('button');
                exp.type = 'button';
                const collapse = !!node.expanded;
                exp.className = 'cr-toggle ' + (node.hop < 0 ? 'is-left' : 'is-right') + (collapse ? ' is-collapse' : '');
                exp.setAttribute('aria-label', collapse ? 'Collapse' : 'Expand');
                exp.title = collapse
                    ? (node.hop < 0 ? 'Collapse callers' : 'Collapse callees')
                    : (node.hop < 0 ? 'Expand callers' : 'Expand callees');
                exp.addEventListener('click', ev => {
                    ev.stopPropagation();
                    vscode.postMessage({
                        type: collapse ? 'collapseHop' : 'expandHop',
                        nodeId: node.id
                    });
                });
                el.appendChild(exp);
            }
        }
        canvas.appendChild(el);
    }
    for (const mark of siteMarks) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cr-edge-dot';
        const n = mark.edge.sites.length;
        btn.textContent = n > 1 ? String(n) : '';
        btn.title = n > 1
            ? `${n} call sites — click to choose`
            : 'Open call site in Context Window';
        btn.style.left = (mark.x - 8) + 'px';
        btn.style.top = (mark.y - 8) + 'px';
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            hideSiteMenu();
            if (n === 1) {
                vscode.postMessage({
                    type: 'openCallSite',
                    fromId: mark.edge.from,
                    toId: mark.edge.to,
                    index: 0
                });
                return;
            }
            const menu = document.createElement('div');
            menu.className = 'cr-site-menu';
            menu.style.left = (mark.x + 10) + 'px';
            menu.style.top = (mark.y + 10) + 'px';
            mark.edge.sites.forEach((site, index) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'cr-site-item';
                item.textContent = `line ${site.line + 1}`;
                item.addEventListener('click', e2 => {
                    e2.stopPropagation();
                    hideSiteMenu();
                    vscode.postMessage({
                        type: 'openCallSite',
                        fromId: mark.edge.from,
                        toId: mark.edge.to,
                        index
                    });
                });
                menu.appendChild(item);
            });
            canvas.appendChild(menu);
        });
        canvas.appendChild(btn);
    }
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
        if (hit && hit.closest && hit.closest('.cr-node, .cr-toggle, .cr-edge-dot, .cr-site-menu')) {
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
    } else if (msg.type === 'state' && pinBtn) {
        pinBtn.classList.toggle('is-on', !!msg.pinned);
        pinBtn.textContent = msg.pinned ? 'Pinned' : 'Pin';
    } else if (msg.type === 'loading' && msg.value && titleEl) {
        titleEl.textContent = 'Call Relation — loading…';
    }
});

if (stage) {
    bindPan(stage);
    stage.addEventListener('click', e => {
        const hit = e.target;
        if (hit && hit.closest && hit.closest('.cr-edge-dot, .cr-site-menu')) {
            return;
        }
        hideSiteMenu();
    });
}

vscode.postMessage({ type: 'ready' });
