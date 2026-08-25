//@ts-check

const NODE_W = 168;
const NODE_H = 52;
const COMPACT_H = 38;
const MORE_H = 36;
const COL_GAP = 88;
const ROW_GAP = 14;
const COMPACT_GAP = 8;
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
/** @type {string} */
let selectedKey = '';

function nodeHeight(node, rootId) {
    if (node.kind === 'more') {
        return node.compact ? 30 : MORE_H;
    }
    if (node.id === rootId) {
        return 64;
    }
    return node.compact ? COMPACT_H : NODE_H;
}

function nodeGap(node) {
    return node.compact ? COMPACT_GAP : ROW_GAP;
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
        pos[n.id] = { x: 0, y: centerY, h };
        centerY += h + ROW_GAP;
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
            const block = group.kids.reduce((sum, n) => sum + nodeHeight(n, graph.rootId) + nodeGap(n), 0)
                - (group.kids.length ? nodeGap(group.kids[group.kids.length - 1]) : 0);
            const parentY = group.parent && pos[group.parent.id] ? pos[group.parent.id].y : 0;
            const parentH = group.parent && pos[group.parent.id] ? pos[group.parent.id].h : NODE_H;
            let y = parentY + parentH / 2 - block / 2;
            for (const kid of group.kids) {
                pos[kid.id] = {
                    x: hop * (NODE_W + COL_GAP),
                    y,
                    h: nodeHeight(kid, graph.rootId)
                };
                y += nodeHeight(kid, graph.rootId) + nodeGap(kid);
            }
        }
        const ordered = col.filter(n => pos[n.id]).sort((a, b) => pos[a.id].y - pos[b.id].y);
        for (let i = 1; i < ordered.length; i++) {
            const prev = pos[ordered[i - 1].id];
            const cur = pos[ordered[i].id];
            const minY = prev.y + prev.h + nodeGap(ordered[i]);
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

function nodeById(graph, id) {
    return graph.nodes.find(n => n.id === id);
}

function edgeHubId(graph, edge) {
    const from = nodeById(graph, edge.from);
    const to = nodeById(graph, edge.to);
    return Math.abs(to?.hop || 0) > Math.abs(from?.hop || 0) ? edge.from : edge.to;
}

function busXForHub(hubPos, childPos) {
    const gap = 28;
    if (childPos.x >= hubPos.x) {
        return hubPos.x + NODE_W + gap;
    }
    return hubPos.x - gap;
}

function orthoPath(x1, y1, x2, y2, busX) {
    if (Math.abs(y1 - y2) < 0.5) {
        return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    const r = Math.min(7, Math.abs(busX - x1), Math.abs(x2 - busX), Math.abs(y2 - y1) / 2);
    if (r < 1.5) {
        return `M ${x1} ${y1} L ${busX} ${y1} L ${busX} ${y2} L ${x2} ${y2}`;
    }
    const down = y2 > y1;
    const toRight = x2 > busX;
    const fromRight = x1 > busX;
    const yCorner1 = down ? y1 + r : y1 - r;
    const yCorner2 = down ? y2 - r : y2 + r;
    const xEnter = fromRight ? busX + r : busX - r;
    const xLeave = toRight ? busX + r : busX - r;
    return `M ${x1} ${y1} L ${xEnter} ${y1} Q ${busX} ${y1} ${busX} ${yCorner1} L ${busX} ${yCorner2} Q ${busX} ${y2} ${xLeave} ${y2} L ${x2} ${y2}`;
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
    canvas.className = 'cr-canvas';
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'cr-edges');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    const hoverLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    hoverLayer.setAttribute('class', 'cr-edge-hover-layer');
    hoverLayer.setAttribute('pointer-events', 'none');
    const setHoverPath = (pathD) => {
        while (hoverLayer.firstChild) {
            hoverLayer.removeChild(hoverLayer.firstChild);
        }
        if (!pathD) {
            return;
        }
        const hoverPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hoverPath.setAttribute('class', 'cr-edge cr-edge-hover');
        hoverPath.setAttribute('d', pathD);
        hoverLayer.appendChild(hoverPath);
    };
    for (const edge of graph.edges) {
        const a = pos[edge.from];
        const b = pos[edge.to];
        if (!a || !b) {
            continue;
        }
        const sameCol = Math.abs(a.x - b.x) < 1;
        let d;
        if (sameCol) {
            const top = a.y <= b.y ? a : b;
            const bot = a.y <= b.y ? b : a;
            const x = a.x + NODE_W / 2;
            d = `M ${x} ${top.y + top.h} L ${x} ${bot.y}`;
        } else {
            const fromRight = a.x < b.x;
            const x1 = fromRight ? a.x + NODE_W : a.x;
            const x2 = fromRight ? b.x : b.x + NODE_W;
            const y1 = a.y + a.h / 2;
            const y2 = b.y + b.h / 2;
            const hubId = edgeHubId(graph, edge);
            const hubPos = pos[hubId] || a;
            const childPos = hubId === edge.from ? b : a;
            d = orthoPath(x1, y1, x2, y2, busXForHub(hubPos, childPos));
        }
        const live = !!(edge.sites && edge.sites.length) && edge.style !== 'anchor';
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'cr-edge-group' + (live ? ' is-live' : ''));
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'cr-edge' + (edge.style === 'anchor' ? ' is-anchor' : ''));
        path.setAttribute('d', d);
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
                setHoverPath(d);
            });
            g.addEventListener('pointerleave', () => {
                setHoverPath('');
            });
            g.appendChild(hit);
        }
        svg.appendChild(g);
    }
    svg.appendChild(hoverLayer);
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
        el.style.height = p.h + 'px';
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
        }
        canvas.appendChild(el);
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
        if (hit && hit.closest && hit.closest('.cr-node, .cr-toggle, .cr-edge-group, .cr-site-menu')) {
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
        if (hit && hit.closest && hit.closest('.cr-edge-group, .cr-site-menu')) {
            return;
        }
        hideSiteMenu();
    });
}

vscode.postMessage({ type: 'ready' });
