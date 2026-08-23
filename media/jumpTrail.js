//@ts-check

// 跳转链顶栏：foo › bar › baz。
// 长链用「中间折叠」：首项 + 当前项始终完整显示，其余能放下的贴在当前项两侧，
// 放不下的收进 … 下拉（对齐 VS Code breadcrumbs / 资源管理器路径栏）。

/**
 * @param {{ editor?: import('monaco-editor').editor.IStandaloneCodeEditor, onLayout?: () => void, enabled?: boolean }} [ctx]
 */
export function createJumpTrail(ctx) {
    const editor = ctx && ctx.editor;
    let enabled = ctx && typeof ctx.enabled === 'boolean' ? ctx.enabled : true;

    /** @type {{ items: any[], index: number } | null} */
    let lastState = null;
    /** @type {HTMLElement | null} */
    let dropdownEl = null;
    let resizeTimer = 0;

    function host() {
        let el = document.getElementById('jump-trail');
        if (el) {
            bindTrailMenu(el);
            return el;
        }
        el = document.createElement('div');
        el.id = 'jump-trail';
        el.className = 'jump-trail';
        el.hidden = true;
        document.body.insertBefore(el, document.body.firstChild);
        bindTrailMenu(el);
        return el;
    }

    function hopLine(item) {
        return (item && typeof item.line === 'number' && item.line > 0) ? item.line : 0;
    }

    function formatCallChain() {
        if (!lastState || !lastState.items.length) {
            return '';
        }
        const items = lastState.items;
        const current = Math.max(0, Math.min(lastState.index, items.length - 1));
        const lines = items.map((item, i) => {
            const line = hopLine(item);
            const file = item.file || '';
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
        if (!text || !window.vscode) {
            return;
        }
        window.vscode.postMessage({ type: 'copyToClipboard', text, notify: 'Call chain copied' });
    }

    function showTrailMenu(e) {
        hideDropdown();
        const old = document.getElementById('custom-context-menu');
        if (old) {
            old.remove();
        }
        const menu = document.createElement('div');
        menu.id = 'custom-context-menu';
        menu.className = 'custom-context-menu';
        menu.style.visibility = 'hidden';
        menu.addEventListener('mousedown', ev => ev.stopPropagation());
        const item = document.createElement('div');
        item.className = 'custom-context-menu-item';
        item.textContent = 'Copy Call Chain';
        item.onclick = () => {
            copyCallChain();
            menu.remove();
        };
        menu.appendChild(item);
        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        const padding = 4;
        let left = e.clientX;
        let top = e.clientY;
        if (left + rect.width > window.innerWidth - padding) {
            left = window.innerWidth - rect.width - padding;
        }
        if (top + rect.height > window.innerHeight - padding) {
            top = window.innerHeight - rect.height - padding;
        }
        menu.style.left = Math.max(padding, left) + 'px';
        menu.style.top = Math.max(padding, top) + 'px';
        menu.style.visibility = 'visible';
        document.addEventListener('mousedown', function onDocClick() {
            menu.remove();
            document.removeEventListener('mousedown', onDocClick);
        });
    }

    function bindTrailMenu(el) {
        if (el.dataset.trailMenuBound === '1') {
            return;
        }
        el.dataset.trailMenuBound = '1';
        el.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            if (!lastState || lastState.items.length < 2) {
                return;
            }
            showTrailMenu(e);
        });
    }

    function hideDropdown() {
        if (dropdownEl && dropdownEl.parentNode) {
            dropdownEl.parentNode.removeChild(dropdownEl);
        }
        dropdownEl = null;
        document.removeEventListener('mousedown', onDocMouseDown, true);
    }

    function onDocMouseDown(e) {
        if (dropdownEl && !dropdownEl.contains(e.target) && !e.target.closest('.jump-trail-overflow')) {
            hideDropdown();
        }
    }

    function navigateTo(index) {
        hideDropdown();
        if (window.vscode) {
            window.vscode.postMessage({ type: 'navigate', index });
        }
    }

    function itemTitle(item) {
        if (!item) {
            return '';
        }
        return item.file ? `${item.name || ''} — ${item.file}` : (item.name || '');
    }

    function showDropdown(anchor, hiddenItems) {
        hideDropdown();
        const menu = document.createElement('div');
        menu.className = 'jump-trail-dropdown';
        hiddenItems.forEach(({ item, index }) => {
            const row = document.createElement('div');
            row.className = 'jump-trail-dropdown-item';
            row.textContent = item.name || '?';
            row.title = itemTitle(item);
            row.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation();
                navigateTo(index);
            });
            menu.appendChild(row);
        });
        document.body.appendChild(menu);
        const rect = anchor.getBoundingClientRect();
        const menuH = menu.offsetHeight;
        const top = Math.max(4, rect.bottom + 4);
        let left = rect.left;
        const maxLeft = window.innerWidth - menu.offsetWidth - 8;
        if (left > maxLeft) {
            left = Math.max(8, maxLeft);
        }
        // 顶栏很矮，下拉默认开在下方；若会挡住太多编辑器也仍比往上开更符合「继续往下看链」的直觉。
        if (top + menuH > window.innerHeight - 28) {
            menu.style.top = Math.max(4, rect.top - menuH - 4) + 'px';
        } else {
            menu.style.top = top + 'px';
        }
        menu.style.left = left + 'px';
        dropdownEl = menu;
        document.addEventListener('mousedown', onDocMouseDown, true);
    }

    function layoutEditor() {
        if (!editor) {
            return;
        }
        const afterLayout = ctx && typeof ctx.onLayout === 'function' ? ctx.onLayout : null;
        requestAnimationFrame(() => {
            try { editor.layout(); } catch (_) { /* noop */ }
            if (afterLayout) {
                afterLayout();
            }
            setTimeout(() => {
                if (afterLayout) {
                    afterLayout();
                }
            }, 0);
        });
    }

    function makeSep() {
        const sep = document.createElement('span');
        sep.className = 'jump-trail-sep';
        sep.setAttribute('aria-hidden', 'true');
        return sep;
    }

    function makeMeasureNode(className, text) {
        const s = document.createElement('span');
        s.className = className;
        s.textContent = text;
        return s;
    }

    function measurePieces(el, items, current) {
        const box = document.createElement('div');
        box.className = 'jump-trail-measure';
        const sep = makeSep();
        const overflow = makeMeasureNode('jump-trail-overflow', '…');
        box.appendChild(sep);
        box.appendChild(overflow);
        const nodes = items.map((item, i) => {
            const node = makeMeasureNode(
                'jump-trail-item' + (i === current ? ' jump-trail-current' : ''),
                item.name || '?'
            );
            box.appendChild(node);
            return node;
        });
        el.appendChild(box);
        // 向上取整，避免多项亚像素累加后实际超出。
        const sepW = Math.ceil(sep.getBoundingClientRect().width);
        const overflowW = Math.ceil(overflow.getBoundingClientRect().width);
        const widths = nodes.map(n => Math.ceil(n.getBoundingClientRect().width));
        el.removeChild(box);
        return { sepW, overflowW, widths };
    }

    function contentWidth(el) {
        const style = getComputedStyle(el);
        const pl = parseFloat(style.paddingLeft) || 0;
        const pr = parseFloat(style.paddingRight) || 0;
        return Math.max(0, el.clientWidth - pl - pr);
    }

    function overflowsTrail(el) {
        const last = el.lastElementChild;
        if (!last) {
            return false;
        }
        const style = getComputedStyle(el);
        const padR = parseFloat(style.paddingRight) || 0;
        const limit = el.getBoundingClientRect().right - padR;
        return last.getBoundingClientRect().right > limit + 0.5;
    }

    // 溢出时先丢掉离当前项最远的中间项，首项和当前项不动。
    function dropFarthestExtra(visible, current) {
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

    function usedWidth(visible, widths, n, sepW, overflowW) {
        let w = 0;
        let needSep = false;
        let i = 0;
        while (i < n) {
            if (visible.has(i)) {
                if (needSep) { w += sepW; }
                w += widths[i];
                needSep = true;
                i++;
            } else {
                if (needSep) { w += sepW; }
                w += overflowW;
                needSep = true;
                while (i < n && !visible.has(i)) { i++; }
            }
        }
        return w;
    }

    // 优先钉住首项和当前项；剩余宽度先填当前项左侧（怎么跟过来的），再填右侧（链的尾巴）。
    function pickVisible(widths, current, avail, sepW, overflowW) {
        const n = widths.length;
        const visible = new Set([0, current]);
        const fits = (set) => usedWidth(set, widths, n, sepW, overflowW) <= avail;

        if (n <= 2 || !fits(visible)) {
            return visible;
        }

        for (let i = current - 1; i >= 1; i--) {
            visible.add(i);
            if (!fits(visible)) {
                visible.delete(i);
                break;
            }
        }
        for (let i = n - 1; i > current; i--) {
            visible.add(i);
            if (!fits(visible)) {
                visible.delete(i);
                break;
            }
        }
        return visible;
    }

    function appendSep(el) {
        el.appendChild(makeSep());
    }

    function appendItem(el, item, i, current) {
        const crumb = document.createElement('span');
        crumb.className = 'jump-trail-item' + (i === current ? ' jump-trail-current' : '');
        crumb.textContent = item.name || '?';
        crumb.title = itemTitle(item);
        if (i !== current) {
            crumb.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                navigateTo(i);
            });
        }
        el.appendChild(crumb);
    }

    function appendOverflow(el, hiddenItems) {
        const btn = document.createElement('span');
        btn.className = 'jump-trail-overflow';
        btn.textContent = '…';
        btn.title = hiddenItems.map(h => h.item.name || '?').join(' › ');
        btn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            if (dropdownEl) {
                hideDropdown();
            } else {
                showDropdown(btn, hiddenItems);
            }
        });
        el.appendChild(btn);
    }

    function paint(el, items, current, visible) {
        el.innerHTML = '';
        const n = items.length;
        let i = 0;
        let needSep = false;
        while (i < n) {
            if (visible.has(i)) {
                if (needSep) { appendSep(el); }
                appendItem(el, items[i], i, current);
                needSep = true;
                i++;
            } else {
                const hidden = [];
                while (i < n && !visible.has(i)) {
                    hidden.push({ item: items[i], index: i });
                    i++;
                }
                if (needSep) { appendSep(el); }
                appendOverflow(el, hidden);
                needSep = true;
            }
        }
    }

    function render(message) {
        hideDropdown();
        const items = (message && Array.isArray(message.items)) ? message.items : [];
        const index = (message && typeof message.index === 'number') ? message.index : 0;
        lastState = { items, index };

        const el = host();
        if (!el) {
            return;
        }

        const show = enabled && items.length > 1;
        el.hidden = !show;
        document.body.classList.toggle('has-jump-trail', show);

        if (typeof window.updateNavButtons === 'function') {
            window.updateNavButtons(index > 0, index < items.length - 1);
        }

        if (!show) {
            el.innerHTML = '';
            layoutEditor();
            return;
        }

        const current = Math.max(0, Math.min(index, items.length - 1));
        el.innerHTML = '';
        const { sepW, overflowW, widths } = measurePieces(el, items, current);
        // clientWidth 含 padding，必须扣掉，否则会多塞一项把当前项从右边裁掉。
        const avail = Math.max(0, contentWidth(el) - 8);
        const visible = pickVisible(widths, current, avail, sepW, overflowW);
        paint(el, items, current, visible);
        while (overflowsTrail(el) && dropFarthestExtra(visible, current)) {
            paint(el, items, current, visible);
        }
        layoutEditor();
    }

    window.addEventListener('resize', () => {
        if (!lastState || lastState.items.length < 2) {
            return;
        }
        if (resizeTimer) {
            clearTimeout(resizeTimer);
        }
        resizeTimer = setTimeout(() => {
            resizeTimer = 0;
            render(lastState);
        }, 80);
    });

    function setEnabled(value) {
        enabled = !!value;
        if (lastState) {
            render(lastState);
        } else {
            const el = host();
            el.hidden = true;
            document.body.classList.toggle('has-jump-trail', false);
            layoutEditor();
        }
    }

    return { render, setEnabled };
}
