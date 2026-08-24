//@ts-check

// 仅在用户主动点某一行（行号 / 行尾空白）后显示行尾 git 摘要。
// 点单词会走 jumpDefinition，跳转后光标回到 (0,0)，那种情况不显示。
// 浮窗挂在行尾摘要上：lineBlame 未显示时即使「允许 Alt」开着也不出现。
// 配置 lineBlameHover 控制是否允许 Alt 打开浮窗。指针在摘要上且按住 Alt 才打开；
// 松开 Alt 不关，移出摘要/浮窗才关。

const WIDGET_ID = 'cw.lineBlame';

/**
 * @param {{
 *   editor: import('monaco-editor').editor.IStandaloneCodeEditor,
 *   state: { uri?: string },
 *   vscode: { postMessage: (msg: any) => void },
 *   enabled?: boolean,
 *   hoverEnabled?: boolean  // 是否允许 Alt 打开浮窗
 * }} ctx
 */
export function createLineBlame(ctx) {
    const { editor, state, vscode } = ctx;
    let enabled = ctx && ctx.enabled !== false;
    let hoverEnabled = ctx && ctx.hoverEnabled !== false;
    let seq = 0;
    let timer = 0;
    /** @type {{ uri: string, line: number, text: string, hover?: any } | null} */
    let lastShown = null;
    let lastReqLine = 0;
    let lastReqUri = '';
    /** @type {HTMLSpanElement | null} */
    let node = null;
    /** @type {import('monaco-editor').editor.IContentWidget | null} */
    let widget = null;
    /** @type {HTMLDivElement | null} */
    let hoverEl = null;
    let hoverHideTimer = 0;
    let overBlame = false;
    let altDown = false;

    function syncFont() {
        if (!node) {
            return;
        }
        try {
            const info = editor.getOption(monaco.editor.EditorOption.fontInfo);
            if (info) {
                node.style.fontFamily = info.fontFamily;
                node.style.fontSize = info.fontSize + 'px';
                node.style.fontWeight = String(info.fontWeight || 'normal');
                node.style.fontStyle = 'normal';
                node.style.lineHeight = info.lineHeight + 'px';
            }
        } catch (_) { /* noop */ }
    }

    function syncLiveClass() {
        if (!node) {
            return;
        }
        node.classList.toggle('cw-line-blame-live', !!(enabled && hoverEnabled));
    }

    function canShowHover() {
        return !!(enabled && hoverEnabled && lastShown && lastShown.hover);
    }

    function tryRevealHover() {
        if (overBlame && altDown && canShowHover()) {
            showHover();
        }
    }

    function setAltDown(down) {
        altDown = !!down;
        if (altDown) {
            tryRevealHover();
        }
    }

    function hideHover() {
        if (hoverHideTimer) {
            clearTimeout(hoverHideTimer);
            hoverHideTimer = 0;
        }
        if (hoverEl && hoverEl.parentNode) {
            hoverEl.parentNode.removeChild(hoverEl);
        }
        hoverEl = null;
    }

    function cancelHideHover() {
        if (hoverHideTimer) {
            clearTimeout(hoverHideTimer);
            hoverHideTimer = 0;
        }
    }

    function scheduleHideHover() {
        cancelHideHover();
        hoverHideTimer = setTimeout(() => {
            hoverHideTimer = 0;
            hideHover();
        }, 200);
    }

    function makeOpenChangesButton(uri, previousSha, sha) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cw-line-blame-hover-open-changes';
        btn.title = 'Open Changes';
        btn.innerHTML = '<svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M5.5 3L2 6.5 5.5 10V8h3V5h-3V3zm5 10L14 9.5 10.5 6v2h-3v3h3v2z"/></svg>';
        btn.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            if (window.vscode) {
                window.vscode.postMessage({
                    type: 'openLineBlameChanges',
                    uri,
                    previousSha,
                    sha
                });
            }
            hideHover();
        });
        return btn;
    }

    function makeShaButton(label, fullSha) {
        const shaBtn = document.createElement('button');
        shaBtn.type = 'button';
        shaBtn.className = 'cw-line-blame-hover-sha';
        shaBtn.textContent = label || '';
        shaBtn.title = 'Copy commit hash';
        shaBtn.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            const text = fullSha || label;
            if (text && window.vscode) {
                window.vscode.postMessage({
                    type: 'copyToClipboard',
                    text,
                    notify: 'Commit hash copied'
                });
            }
        });
        return shaBtn;
    }

    function addText(parent, className, text) {
        const el = document.createElement('div');
        if (className) {
            el.className = className;
        }
        el.textContent = text || '';
        parent.appendChild(el);
        return el;
    }

    function positionHover() {
        if (!hoverEl || !node) {
            return;
        }
        const rect = node.getBoundingClientRect();
        const pad = 8;
        const hw = hoverEl.offsetWidth;
        const hh = hoverEl.offsetHeight;
        let left = rect.left;
        let top = rect.top - hh - 6;
        if (top < pad) {
            top = rect.bottom + 6;
        }
        if (left + hw > window.innerWidth - pad) {
            left = window.innerWidth - hw - pad;
        }
        hoverEl.style.left = Math.max(pad, left) + 'px';
        hoverEl.style.top = Math.max(pad, top) + 'px';
    }

    function showHover() {
        cancelHideHover();
        if (!canShowHover() || !node) {
            hideHover();
            return;
        }
        const h = lastShown.hover;
        if (!hoverEl) {
            hoverEl = document.createElement('div');
            hoverEl.className = 'cw-line-blame-hover';
            hoverEl.addEventListener('mouseenter', cancelHideHover);
            hoverEl.addEventListener('mouseleave', scheduleHideHover);
            hoverEl.addEventListener('mousedown', ev => ev.stopPropagation());
            document.body.appendChild(hoverEl);
        }
        hoverEl.innerHTML = '';

        const head = document.createElement('div');
        head.className = 'cw-line-blame-hover-head';
        addText(head, 'cw-line-blame-hover-author', h.author || '');
        const when = document.createElement('div');
        when.className = 'cw-line-blame-hover-when';
        if (h.ago && h.date) {
            when.textContent = `${h.ago} (${h.date})`;
        } else {
            when.textContent = h.ago || h.date || '';
        }
        head.appendChild(when);
        hoverEl.appendChild(head);

        if (h.summary) {
            addText(hoverEl, 'cw-line-blame-hover-summary', h.summary);
        }

        const actions = document.createElement('div');
        actions.className = 'cw-line-blame-hover-actions';
        if (h.shortSha) {
            actions.appendChild(makeShaButton(h.shortSha, h.sha));
        }
        if (actions.childNodes.length) {
            hoverEl.appendChild(actions);
        }

        if (h.previousShortSha && h.shortSha) {
            const changes = document.createElement('div');
            changes.className = 'cw-line-blame-hover-changes';
            changes.appendChild(document.createTextNode('Changes '));
            changes.appendChild(makeShaButton(h.previousShortSha, h.previousSha || h.previousShortSha));
            const sep = document.createElement('span');
            sep.className = 'cw-line-blame-hover-sep';
            sep.setAttribute('aria-hidden', 'true');
            sep.textContent = '↔';
            changes.appendChild(sep);
            changes.appendChild(document.createTextNode(h.shortSha));
            if (h.previousSha && h.sha && lastShown.uri) {
                changes.appendChild(makeOpenChangesButton(lastShown.uri, h.previousSha, h.sha));
            }
            hoverEl.appendChild(changes);
        }

        hoverEl.style.visibility = 'hidden';
        positionHover();
        hoverEl.style.visibility = 'visible';
    }

    function ensureWidget() {
        if (widget && node) {
            return;
        }
        node = document.createElement('span');
        node.className = 'cw-line-blame';
        node.addEventListener('mouseenter', () => {
            overBlame = true;
            tryRevealHover();
        });
        node.addEventListener('mouseleave', () => {
            overBlame = false;
            scheduleHideHover();
        });
        node.addEventListener('mousedown', ev => ev.stopPropagation());
        syncFont();
        syncLiveClass();
        widget = {
            getId: () => WIDGET_ID,
            getDomNode: () => node,
            getPosition: () => {
                if (!lastShown || lastShown.line < 1) {
                    return null;
                }
                const model = editor.getModel();
                if (!model || lastShown.line > model.getLineCount()) {
                    return null;
                }
                return {
                    position: {
                        lineNumber: lastShown.line,
                        column: model.getLineMaxColumn(lastShown.line)
                    },
                    preference: [monaco.editor.ContentWidgetPositionPreference.EXACT]
                };
            }
        };
        editor.addContentWidget(widget);
    }

    function hideWidget() {
        lastShown = null;
        overBlame = false;
        hideHover();
        if (node) {
            node.textContent = '';
        }
        if (widget) {
            try { editor.layoutContentWidget(widget); } catch (_) { /* noop */ }
        }
    }

    function apply(line, text, hover) {
        const model = editor.getModel();
        if (!model || !text || line < 1 || line > model.getLineCount()) {
            hideWidget();
            return;
        }
        lastShown = { uri: (state && state.uri) || '', line, text, hover };
        ensureWidget();
        syncFont();
        syncLiveClass();
        node.textContent = text;
        try { editor.layoutContentWidget(widget); } catch (_) { /* noop */ }
        if (hoverEl) {
            if (canShowHover()) {
                showHover();
            } else {
                hideHover();
            }
        }
    }

    function clear() {
        if (timer) {
            clearTimeout(timer);
            timer = 0;
        }
        lastReqLine = 0;
        lastReqUri = '';
        seq++;
        hideWidget();
    }

    function request(line) {
        if (!enabled || line < 1) {
            return;
        }
        const uri = state && state.uri;
        const model = editor.getModel();
        if (!uri || !model || line > model.getLineCount()) {
            return;
        }
        if (model.getValue() === 'No symbol found.') {
            return;
        }
        lastReqLine = line;
        lastReqUri = uri;
        const reqId = ++seq;
        vscode.postMessage({
            type: 'requestLineBlame',
            reqId,
            uri,
            line
        });
    }

    function schedule(line) {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = 0;
            request(line);
        }, 80);
    }

    function clickLine(e) {
        if (!enabled || !e || !e.target || !e.event || !e.event.leftButton) {
            return;
        }
        const type = e.target.type;
        const isStayClick = type === monaco.editor.MouseTargetType.CONTENT_EMPTY
            || type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
        if (!isStayClick) {
            return;
        }
        const line = (e.target.position && e.target.position.lineNumber) || 0;
        if (line >= 1) {
            schedule(line);
        }
    }

    function handleResult(message) {
        if (!message || message.reqId !== seq) {
            return;
        }
        if (!enabled) {
            clear();
            return;
        }
        if (message.line !== lastReqLine || (state && state.uri) !== message.uri || lastReqUri !== message.uri) {
            return;
        }
        if (!message.text) {
            hideWidget();
            return;
        }
        apply(message.line, message.text, message.hover);
    }

    function setEnabled(value) {
        enabled = !!value;
        syncLiveClass();
        if (!enabled) {
            clear();
        }
    }

    function setHoverEnabled(value) {
        hoverEnabled = !!value;
        syncLiveClass();
        if (!hoverEnabled) {
            hideHover();
        }
    }

    editor.onMouseUp(clickLine);

    window.addEventListener('keydown', e => {
        if (e.altKey || e.key === 'Alt') {
            setAltDown(true);
        }
    }, true);
    window.addEventListener('keyup', e => {
        if (e.key === 'Alt') {
            setAltDown(false);
        }
    }, true);
    window.addEventListener('blur', () => {
        setAltDown(false);
    });
    editor.onKeyDown(e => {
        if (e.altKey || e.keyCode === monaco.KeyCode.Alt) {
            setAltDown(true);
        }
    });
    editor.onKeyUp(e => {
        if (e.keyCode === monaco.KeyCode.Alt) {
            setAltDown(false);
        }
    });

    editor.onDidChangeModel(() => {
        hideHover();
        if (!enabled || !lastShown) {
            return;
        }
        if (lastShown.uri === (state && state.uri)) {
            apply(lastShown.line, lastShown.text, lastShown.hover);
        }
    });

    editor.onDidScrollChange(() => {
        if (hoverEl) {
            hideHover();
        }
    });

    return { handleResult, clear, setEnabled, setHoverEnabled };
}
