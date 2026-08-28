//@ts-check

// 用户主动点某一行后显示行尾 git 摘要。
// 手型光标（悬停在可跳转单词上）的点击走 jumpDefinition，不请求 blame。
// 其余点击（行号、行尾空白、运算符/空白等非单词处）与点行尾空白一样请求 blame。
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
    /** @type {{ uri: string, line: number, text: string, hover?: any, versionId: number, diffPending?: boolean, diffReqId?: number } | null} */
    let lastShown = null;
    let lastReqLine = 0;
    let lastReqUri = '';
    let pendingReq = false;
    let diffSeq = 0;
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
            showHover(false);
        }
    }

    function setAltDown(down) {
        const next = !!down;
        const rose = next && !altDown;
        altDown = next;
        if (rose) {
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

    function makeOpenChangesButton(uri, previousSha, sha, workingTree) {
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
                    sha,
                    workingTree: !!workingTree,
                    line: lastShown ? lastShown.line : 0
                });
            }
            hideHover();
        });
        return btn;
    }

    function makeShaButton(label, fullSha, current) {
        const shaBtn = document.createElement('button');
        shaBtn.type = 'button';
        shaBtn.className = 'cw-line-blame-hover-sha' + (current ? ' cw-line-blame-hover-sha-current' : '');
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

    function avatarLetter(name) {
        const s = String(name || '').trim();
        if (!s) {
            return '?';
        }
        return [...s][0].toUpperCase();
    }

    // 按首字母分段配色（A–C / D–F / …），白字保证对比度。
    const AVATAR_COLORS = [
        '#c0392b', // A–C
        '#d35400', // D–F
        '#b7950b', // G–I
        '#1e8449', // J–L
        '#148f77', // M–O
        '#2471a3', // P–R
        '#6c3483', // S–U
        '#7d3c98'  // V–Z 及其它
    ];

    function avatarColor(name) {
        const letter = avatarLetter(name);
        const code = letter.charCodeAt(0);
        let idx;
        if (code >= 65 && code <= 90) {
            idx = Math.min(AVATAR_COLORS.length - 1, Math.floor((code - 65) * AVATAR_COLORS.length / 26));
        } else {
            idx = (letter.codePointAt(0) || 0) % AVATAR_COLORS.length;
        }
        return AVATAR_COLORS[idx];
    }

    function makeLetterAvatar(name) {
        const badge = document.createElement('div');
        badge.className = 'cw-line-blame-hover-avatar-letter';
        badge.textContent = avatarLetter(name);
        badge.style.background = avatarColor(name);
        return badge;
    }

    function makeAvatar(h) {
        const name = h.authorName || h.author || '?';
        const letter = makeLetterAvatar(name);
        if (!h.avatarUrl) {
            return letter;
        }
        const wrap = document.createElement('span');
        wrap.className = 'cw-line-blame-hover-avatar-wrap';
        wrap.appendChild(letter);
        const img = document.createElement('img');
        img.className = 'cw-line-blame-hover-avatar';
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.hidden = true;
        img.addEventListener('load', () => {
            img.hidden = false;
            letter.hidden = true;
        });
        img.addEventListener('error', () => {
            img.remove();
            letter.hidden = false;
        });
        img.src = h.avatarUrl;
        wrap.appendChild(img);
        return wrap;
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

    // 单行替换时高亮中间不同的片段，对齐 GitLens 行内 diff。
    function splitAffix(a, b) {
        const left = String(a || '');
        const right = String(b || '');
        let i = 0;
        const max = Math.min(left.length, right.length);
        while (i < max && left[i] === right[i]) {
            i++;
        }
        let sa = left.length;
        let sb = right.length;
        while (sa > i && sb > i && left[sa - 1] === right[sb - 1]) {
            sa--;
            sb--;
        }
        if (i === 0 && sa === left.length && sb === right.length) {
            return null;
        }
        return {
            a: [left.slice(0, i), left.slice(i, sa), left.slice(sa)],
            b: [right.slice(0, i), right.slice(i, sb), right.slice(sb)]
        };
    }

    function appendAffix(el, parts) {
        if (parts[0]) {
            el.appendChild(document.createTextNode(parts[0]));
        }
        if (parts[1]) {
            const mid = document.createElement('span');
            mid.className = 'cw-line-blame-hover-diff-inner';
            mid.textContent = parts[1];
            el.appendChild(mid);
        }
        if (parts[2]) {
            el.appendChild(document.createTextNode(parts[2]));
        }
    }

    function renderDiff(h) {
        const rows = h && Array.isArray(h.diff) ? h.diff : [];
        if (!rows.length) {
            return null;
        }
        const box = document.createElement('div');
        box.className = 'cw-line-blame-hover-diff';
        const trimLead = text => String(text || '').replace(/^[ \t]+/, '');
        const dels = rows.filter(l => l.kind === 'del');
        const adds = rows.filter(l => l.kind === 'add');
        const affix = (dels.length === 1 && adds.length === 1)
            ? splitAffix(trimLead(dels[0].text), trimLead(adds[0].text))
            : null;
        for (const line of rows) {
            const row = document.createElement('div');
            const kind = line.kind === 'del' ? 'del' : line.kind === 'add' ? 'add' : 'ctx';
            row.className = 'cw-line-blame-hover-diff-line cw-line-blame-hover-diff-' + kind;
            const mark = document.createElement('span');
            mark.className = 'cw-line-blame-hover-diff-mark';
            mark.textContent = kind === 'del' ? '- ' : kind === 'add' ? '+ ' : '  ';
            const body = document.createElement('span');
            body.className = 'cw-line-blame-hover-diff-text';
            const text = trimLead(line.text);
            if (affix && kind === 'del') {
                appendAffix(body, affix.a);
            } else if (affix && kind === 'add') {
                appendAffix(body, affix.b);
            } else {
                body.textContent = text;
            }
            row.appendChild(mark);
            row.appendChild(body);
            box.appendChild(row);
        }
        return box;
    }

    function requestDiff() {
        if (!lastShown || !lastShown.hover || Array.isArray(lastShown.hover.diff) || lastShown.diffPending) {
            return;
        }
        lastShown.diffPending = true;
        const reqId = ++diffSeq;
        lastShown.diffReqId = reqId;
        vscode.postMessage({
            type: 'requestLineBlameDiff',
            reqId,
            uri: lastShown.uri,
            line: lastShown.line
        });
    }

    function patchHoverDiff() {
        if (!hoverEl || !lastShown || !lastShown.hover) {
            return;
        }
        const next = renderDiff(lastShown.hover);
        const old = hoverEl.querySelector('.cw-line-blame-hover-diff');
        if (!next) {
            if (old && old.parentNode) {
                old.parentNode.removeChild(old);
            }
            positionHover();
            return;
        }
        if (old && old.parentNode) {
            old.parentNode.replaceChild(next, old);
        } else {
            const foot = hoverEl.querySelector('.cw-line-blame-hover-foot');
            if (foot) {
                hoverEl.insertBefore(next, foot);
            } else {
                hoverEl.appendChild(next);
            }
        }
        positionHover();
    }

    function handleDiffResult(message) {
        if (!lastShown || !message || message.reqId !== lastShown.diffReqId) {
            return;
        }
        lastShown.diffPending = false;
        if (message.line !== lastShown.line || message.uri !== lastShown.uri) {
            return;
        }
        if (!lastShown.hover) {
            return;
        }
        lastShown.hover.diff = Array.isArray(message.diff) ? message.diff : [];
        if (hoverEl) {
            patchHoverDiff();
        }
    }

    function positionHover() {
        if (!hoverEl || !node) {
            return;
        }
        const rect = node.getBoundingClientRect();
        const pad = 8;
        const gap = 6;
        hoverEl.style.maxHeight = '';
        const hw = hoverEl.offsetWidth;
        const hh = hoverEl.offsetHeight;
        const availAbove = Math.max(0, rect.top - pad - gap);
        const availBelow = Math.max(0, window.innerHeight - rect.bottom - pad - gap);
        const placeBelow = availBelow >= availAbove || availBelow >= hh;
        let left = rect.left;
        if (left + hw > window.innerWidth - pad) {
            left = window.innerWidth - hw - pad;
        }
        let top = placeBelow ? rect.bottom + gap : rect.top - hh - gap;
        if (top + hh > window.innerHeight - pad) {
            top = window.innerHeight - hh - pad;
        }
        hoverEl.style.left = Math.max(pad, left) + 'px';
        hoverEl.style.top = Math.max(pad, top) + 'px';
    }

    function showHover(force) {
        cancelHideHover();
        if (!canShowHover() || !node) {
            hideHover();
            return;
        }
        // 按住 Alt 会重复 keydown；已打开就不要拆 DOM，否则头像会在照片/字母间闪。
        if (hoverEl && !force) {
            positionHover();
            requestDiff();
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
        const who = document.createElement('div');
        who.className = 'cw-line-blame-hover-who';
        who.appendChild(makeAvatar(h));
        addText(who, 'cw-line-blame-hover-author', h.author || '');
        head.appendChild(who);
        const when = document.createElement('div');
        when.className = 'cw-line-blame-hover-when';
        if (h.ago && h.date) {
            when.textContent = `${h.ago} (${h.date})`;
        } else {
            when.textContent = h.ago || h.date || '';
        }
        head.appendChild(when);
        hoverEl.appendChild(head);

        const raw = h.summary || '';
        const nl = raw.search(/\r?\n/);
        const subject = (nl < 0 ? raw : raw.slice(0, nl)).trim();
        const body = nl < 0 ? '' : raw.slice(nl).replace(/^\r?\n+/, '').replace(/\s+$/, '');
        const msg = document.createElement('div');
        msg.className = 'cw-line-blame-hover-msg';
        if (subject) {
            addText(msg, 'cw-line-blame-hover-summary', subject);
        }
        if (body) {
            addText(msg, 'cw-line-blame-hover-body', body);
        }
        if (msg.childNodes.length) {
            hoverEl.appendChild(msg);
        }

        const foot = document.createElement('div');
        foot.className = 'cw-line-blame-hover-foot';
        const actions = document.createElement('div');
        actions.className = 'cw-line-blame-hover-actions';
        if (h.shortSha && !h.workingTree) {
            actions.appendChild(makeShaButton(h.shortSha, h.sha));
        }
        if (actions.childNodes.length) {
            hoverEl.appendChild(actions);
        }

        const diffEl = renderDiff(h);
        if (diffEl) {
            hoverEl.appendChild(diffEl);
        }

        const changes = document.createElement('div');
        changes.className = 'cw-line-blame-hover-changes';
        if (h.workingTree) {
            const leftLabel = h.previousShortSha;
            const sameRef = !!(h.previousSha && h.sha && h.previousSha === h.sha);
            const rightLabel = (!sameRef && h.shortSha) ? h.shortSha : 'Working Tree';
            changes.appendChild(document.createTextNode('Changes '));
            if (leftLabel) {
                if (h.previousSha && h.previousSha !== 'working-tree') {
                    changes.appendChild(makeShaButton(leftLabel, h.previousSha, true));
                } else {
                    changes.appendChild(document.createTextNode(leftLabel));
                }
                const sep = document.createElement('span');
                sep.className = 'cw-line-blame-hover-sep';
                sep.setAttribute('aria-hidden', 'true');
                sep.textContent = '↔';
                changes.appendChild(sep);
            }
            if (!sameRef && h.shortSha && h.sha && h.sha !== 'working-tree') {
                changes.appendChild(makeShaButton(rightLabel, h.sha));
            } else {
                changes.appendChild(document.createTextNode(rightLabel));
            }
            if (lastShown.uri) {
                changes.appendChild(makeOpenChangesButton(
                    lastShown.uri,
                    h.previousSha || '',
                    h.sha || '',
                    true
                ));
            }
        } else if (h.previousShortSha && h.shortSha) {
            changes.appendChild(document.createTextNode('Changes '));
            changes.appendChild(makeShaButton(h.previousShortSha, h.previousSha || h.previousShortSha, true));
            const sep = document.createElement('span');
            sep.className = 'cw-line-blame-hover-sep';
            sep.setAttribute('aria-hidden', 'true');
            sep.textContent = '↔';
            changes.appendChild(sep);
            changes.appendChild(makeShaButton(h.shortSha, h.sha));
            if (h.previousSha && h.sha && lastShown.uri) {
                changes.appendChild(makeOpenChangesButton(lastShown.uri, h.previousSha, h.sha));
            }
        } else if (h.shortSha) {
            // 首提交没有 parent：GitLens 仍固定写 Changes added in <sha>，并可打开对空树的 diff。
            changes.appendChild(document.createTextNode('Changes added in '));
            changes.appendChild(makeShaButton(h.shortSha, h.sha));
            if (h.sha && lastShown.uri) {
                changes.appendChild(makeOpenChangesButton(lastShown.uri, '', h.sha));
            }
        } else {
            changes.appendChild(document.createTextNode('Uncommitted changes'));
        }
        foot.appendChild(changes);
        hoverEl.appendChild(foot);

        hoverEl.style.visibility = 'hidden';
        positionHover();
        hoverEl.style.visibility = 'visible';
        requestDiff();
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
        lastShown = {
            uri: (state && state.uri) || '',
            line,
            text,
            hover,
            versionId: model.getVersionId()
        };
        ensureWidget();
        syncFont();
        syncLiveClass();
        node.textContent = text;
        try { editor.layoutContentWidget(widget); } catch (_) { /* noop */ }
        if (hoverEl) {
            if (canShowHover()) {
                showHover(true);
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
        pendingReq = false;
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
        const versionId = model.getVersionId();
        if (lastShown
            && lastShown.uri === uri
            && lastShown.line === line
            && lastShown.versionId === versionId) {
            apply(line, lastShown.text, lastShown.hover);
            return;
        }
        if (pendingReq && lastReqLine === line && lastReqUri === uri) {
            return;
        }
        lastReqLine = line;
        lastReqUri = uri;
        pendingReq = true;
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

    function isLeftClick(e) {
        if (!e || !e.event) {
            return false;
        }
        if (e.event.leftButton) {
            return true;
        }
        const be = e.event.browserEvent;
        return !!(be && be.button === 0);
    }

    // 与 editorMouseHandlers 里「手型光标 / 左键跳定义」同一判定：正文里点在单词上。
    function isHandCursorClick(e) {
        if (!e || !e.target || e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) {
            return false;
        }
        const model = editor.getModel();
        const position = e.target.position;
        if (!model || !position) {
            return false;
        }
        return !!model.getWordAtPosition(position);
    }

    function fullLineFromSelection() {
        const sel = editor.getSelection();
        const model = editor.getModel();
        if (!sel || !model || sel.startColumn !== 1) {
            return 0;
        }
        const line = sel.startLineNumber;
        if (sel.endLineNumber === line + 1 && sel.endColumn === 1) {
            return line;
        }
        if (sel.endLineNumber === line && sel.endColumn >= model.getLineMaxColumn(line)) {
            return line;
        }
        if (sel.endLineNumber === line && sel.endColumn >= model.getLineLength(line) + 1) {
            return line;
        }
        return 0;
    }

    function clickLine(e) {
        if (!enabled || !isLeftClick(e)) {
            return;
        }
        // 手型（点在可跳转单词上）走 jumpDefinition，不请求 blame
        if (isHandCursorClick(e)) {
            return;
        }
        const line = (e.target && e.target.position && e.target.position.lineNumber)
            || fullLineFromSelection();
        if (line >= 1) {
            schedule(line);
        }
    }

    function handleResult(message) {
        if (!message || message.reqId !== seq) {
            return;
        }
        pendingReq = false;
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

    editor.onMouseDown(clickLine);
    editor.onMouseUp(clickLine);

    window.addEventListener('keydown', e => {
        if (e.repeat) {
            return;
        }
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
        if (e.browserEvent && e.browserEvent.repeat) {
            return;
        }
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

    return { handleResult, handleDiffResult, clear, setEnabled, setHoverEnabled };
}
