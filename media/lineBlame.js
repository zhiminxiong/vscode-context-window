//@ts-check

// 用户主动点某一行后显示行尾 git 摘要。
// 手型光标（悬停在可跳转单词上）的点击走 jumpDefinition，不请求 blame。
// 其余点击（行号、行尾空白、运算符/空白等非单词处）与点行尾空白一样请求 blame。
// 浮窗挂在行尾摘要上：lineBlame 未显示时不出现。
// 配置 lineBlameHover：勾选则指针在摘要上移动并停留后出浮窗；不勾选（默认）则还要按住 Alt。
// 必须在摘要上发生过 mousemove（摘要出现在静止光标下不算），再等 HOVER_DELAY_MS（其间预拉 diff）。
// 松开 Alt 不关，移出摘要/浮窗才关。
// Alt 模式下，在摘要/浮窗上会吞掉单独的 Alt，避免 Windows 顶栏菜单抢走焦点。

const WIDGET_ID = 'cw.lineBlame';

/**
 * @param {{
 *   editor: import('monaco-editor').editor.IStandaloneCodeEditor,
 *   state: { uri?: string },
 *   vscode: { postMessage: (msg: any) => void },
 *   enabled?: boolean,
 *   hoverAuto?: boolean  // 勾选：移上摘要即出浮窗；不勾选：按住 Alt 才出
 * }} ctx
 */
export function createLineBlame(ctx) {
    const { editor, state, vscode } = ctx;
    let enabled = ctx && ctx.enabled !== false;
    let hoverAuto = !!(ctx && ctx.hoverAuto);
    let seq = 0;
    let timer = 0;
    /** @type {{ uri: string, line: number, text: string, hover?: any, versionId: number, diffPending?: boolean, diffReqId?: number } | null} */
    let lastShown = null;
    let lastReqLine = 0;
    let lastReqUri = '';
    let pendingReq = false;
    let diffSeq = 0;
    /** @type {Map<string, any[]>} */
    const lineDiffCache = new Map();

    function lineDiffKey(uri, line) {
        return `${uri}\0${line}`;
    }

    function attachCachedDiff(shown) {
        if (!shown || !shown.hover || Array.isArray(shown.hover.diff)) {
            return;
        }
        const cached = lineDiffCache.get(lineDiffKey(shown.uri, shown.line));
        if (cached) {
            shown.hover.diff = cached;
        }
    }
    /** @type {HTMLSpanElement | null} */
    let node = null;
    /** @type {import('monaco-editor').editor.IContentWidget | null} */
    let widget = null;
    /** @type {HTMLDivElement | null} */
    let hoverEl = null;
    let hoverHideTimer = 0;
    let hoverShowTimer = 0;
    // 对齐本面板 Monaco hover（main.js delay: 300），也给 git diff 一点拉取时间。
    const HOVER_DELAY_MS = 300;
    let overBlame = false;
    let hoverMoved = false;
    let enterX = 0;
    let enterY = 0;
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
        node.classList.toggle('cw-line-blame-live', !!enabled);
    }

    function canShowHover() {
        return !!(enabled && lastShown && lastShown.hover);
    }

    function tryRevealHover() {
        if (!overBlame || !hoverMoved || !canShowHover()) {
            return;
        }
        if (hoverAuto || altDown) {
            showHover(false);
        }
    }

    function cancelShowHover() {
        if (hoverShowTimer) {
            clearTimeout(hoverShowTimer);
            hoverShowTimer = 0;
        }
    }

    function scheduleShowHover() {
        if (!overBlame || !hoverMoved || !canShowHover() || !(hoverAuto || altDown)) {
            return;
        }
        if (hoverEl) {
            tryRevealHover();
            return;
        }
        requestDiff();
        if (hoverShowTimer) {
            return;
        }
        hoverShowTimer = setTimeout(() => {
            hoverShowTimer = 0;
            tryRevealHover();
        }, HOVER_DELAY_MS);
    }

    function setAltDown(down) {
        const next = !!down;
        const rose = next && !altDown;
        altDown = next;
        if (rose) {
            scheduleShowHover();
            // Alt 常被 VSCode/Windows 用来聚焦顶栏菜单，webview 会 blur，下一次 Alt 就进不来。
            // 打开浮窗后立刻把焦点拉回编辑器。
            if (hoverEl) {
                try {
                    editor.focus();
                } catch (e) {
                    // ignore
                }
            }
        }
    }

    function isBareAlt(e) {
        if (!e || e.ctrlKey || e.metaKey || e.shiftKey) {
            return false;
        }
        const key = e.key || '';
        const code = e.code || '';
        return key === 'Alt' || code === 'AltLeft' || code === 'AltRight';
    }

    // 指针在行尾摘要或浮窗上时吞掉单独的 Alt，避免顶栏菜单抢走焦点。
    function shouldConsumeAlt() {
        return !!(!hoverAuto && enabled && (overBlame || hoverEl));
    }

    function consumeBareAlt(e) {
        if (!e || !shouldConsumeAlt() || !isBareAlt(e)) {
            return false;
        }
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') {
            e.stopImmediatePropagation();
        }
        return true;
    }

    function hideHover() {
        if (hoverHideTimer) {
            clearTimeout(hoverHideTimer);
            hoverHideTimer = 0;
        }
        cancelShowHover();
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

    function copyPlain(text, notify) {
        if (!text || !window.vscode) {
            return;
        }
        window.vscode.postMessage({
            type: 'copyToClipboard',
            text,
            notify: notify || 'Copied'
        });
    }

    function formatTipsCopy(h) {
        if (!h) {
            return '';
        }
        const who = String(h.author || '').trim();
        let when = '';
        if (h.ago && h.date) {
            when = `${h.ago} (${h.date})`;
        } else {
            when = h.ago || h.date || '';
        }
        const raw = String(h.summary || '');
        const nl = raw.search(/\r?\n/);
        const subject = (nl < 0 ? raw : raw.slice(0, nl)).trim();
        const body = nl < 0 ? '' : raw.slice(nl).replace(/^\r?\n+/, '').replace(/\s+$/, '');
        const msg = body ? `${subject}\n\n${body}` : subject;
        const sha = h.workingTree ? '' : String(h.shortSha || '').trim();
        const line1 = [who, when].filter(Boolean).join(' ');
        const parts = [];
        if (line1) {
            parts.push(line1);
        }
        if (msg) {
            parts.push('', msg);
        }
        if (sha) {
            parts.push('', sha);
        }
        return parts.join('\n');
    }

    function formatChangesLine(h) {
        if (!h) {
            return '';
        }
        if (h.workingTree) {
            const left = h.previousShortSha || '';
            const sameRef = !!(h.previousSha && h.sha && h.previousSha === h.sha);
            const right = (!sameRef && h.shortSha) ? h.shortSha : 'Working Tree';
            return left ? `Changes ${left} ⟷ ${right}` : `Changes ${right}`;
        }
        if (h.previousShortSha && h.shortSha) {
            return `Changes ${h.previousShortSha} ⟷ ${h.shortSha}`;
        }
        if (h.shortSha) {
            return `Changes added in ${h.shortSha}`;
        }
        return 'Uncommitted changes';
    }

    function formatDiffCopy(h) {
        const rows = h && Array.isArray(h.diff) ? h.diff : [];
        const trimLead = text => String(text || '').replace(/^[ \t]+/, '');
        const lines = rows.map(line => {
            const mark = line.kind === 'del' ? '-' : line.kind === 'add' ? '+' : ' ';
            return `${mark} ${trimLead(line.text)}`;
        });
        const changes = formatChangesLine(h);
        if (lines.length && changes) {
            return `${lines.join('\n')}\n\n${changes}`;
        }
        return lines.length ? lines.join('\n') : changes;
    }

    function makeCopyButton(getText, title) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cw-line-blame-hover-copy';
        btn.title = title || 'Copy';
        btn.setAttribute('aria-label', title || 'Copy');
        btn.tabIndex = -1;
        btn.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25z"/><path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25z"/></svg>';
        btn.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            const text = typeof getText === 'function' ? getText() : getText;
            copyPlain(text, 'Copied');
        });
        btn.addEventListener('mousedown', ev => ev.stopPropagation());
        return btn;
    }

    function makeShaButton(label, fullSha, current) {
        const shaBtn = document.createElement('button');
        shaBtn.type = 'button';
        shaBtn.className = 'cw-line-blame-hover-sha' + (current ? ' cw-line-blame-hover-sha-current' : '');
        shaBtn.textContent = label || '';
        shaBtn.title = 'Copy SHA';
        shaBtn.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            const text = fullSha || label;
            if (text && window.vscode) {
                window.vscode.postMessage({
                    type: 'copyToClipboard',
                    text,
                    notify: 'SHA copied'
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

    function toCssColor(fg) {
        const s = String(fg || '').trim();
        if (!s) {
            return '';
        }
        if (s.startsWith('#') || s.startsWith('rgb') || s.startsWith('hsl') || s.startsWith('var(')) {
            return s;
        }
        if (/^[0-9a-fA-F]{6,8}$/.test(s)) {
            return '#' + s;
        }
        return s;
    }

    function pickRuleColor(rules, token) {
        if (!Array.isArray(rules)) {
            return '';
        }
        for (let i = rules.length - 1; i >= 0; i--) {
            const r = rules[i];
            if (r && r.token === token && r.foreground) {
                return toCssColor(r.foreground);
            }
        }
        return '';
    }

    // + / - 对齐 VSCode 里 `+` 的 token：keyword.operator.arithmetic（Inspect 常见为偏紫）。
    // 不用泛化 semantic operator（Light+ 常是前景黑）。解析不到时留给 CSS 兜底。
    function getOperatorMarkColor() {
        const cfg = window.vsCodeEditorConfiguration || {};
        const sources = [cfg.themeTextmateRules, cfg.themeSemanticRules];
        for (const token of ['keyword.operator.arithmetic', 'keyword.operator']) {
            for (const src of sources) {
                const c = pickRuleColor(src, token);
                if (c) {
                    return c;
                }
            }
        }
        return pickRuleColor(cfg.customThemeRules, 'operator')
            || pickRuleColor(cfg.themeSemanticRules, 'operator')
            || '';
    }

    function renderDiff(h) {
        const rows = h && Array.isArray(h.diff) ? h.diff : [];
        if (!rows.length) {
            return null;
        }
        const box = document.createElement('div');
        box.className = 'cw-line-blame-hover-diff';
        const markColor = getOperatorMarkColor();
        if (markColor) {
            box.style.setProperty('--cw-operator-foreground', markColor);
        }
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
        const detail = hoverEl.querySelector('.cw-line-blame-hover-detail');
        if (!next) {
            if (old && old.parentNode) {
                old.parentNode.removeChild(old);
            }
            positionHover();
            return;
        }
        if (old && old.parentNode) {
            old.parentNode.replaceChild(next, old);
        } else if (detail) {
            const foot = detail.querySelector('.cw-line-blame-hover-foot');
            if (foot) {
                detail.insertBefore(next, foot);
            } else {
                detail.insertBefore(next, detail.firstChild);
            }
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
        lineDiffCache.set(lineDiffKey(lastShown.uri, lastShown.line), lastShown.hover.diff);
        if (hoverEl) {
            patchHoverDiff();
            hoverEl.style.visibility = 'visible';
        }
    }

    function getAnchorLineRect() {
        const fallback = node.getBoundingClientRect();
        if (!lastShown || lastShown.line < 1) {
            return fallback;
        }
        try {
            const edNode = editor.getDomNode();
            const pos = editor.getScrolledVisiblePosition({
                lineNumber: lastShown.line,
                column: 1
            });
            if (!edNode || !pos) {
                return fallback;
            }
            const edRect = edNode.getBoundingClientRect();
            const top = edRect.top + pos.top;
            const height = pos.height || fallback.height;
            return {
                top,
                bottom: top + height,
                left: fallback.left,
                right: fallback.right,
                width: fallback.width,
                height
            };
        } catch (e) {
            return fallback;
        }
    }

    function positionHover() {
        if (!hoverEl || !node) {
            return;
        }
        const rect = getAnchorLineRect();
        const pad = 8;
        const minH = 120;
        hoverEl.style.maxHeight = '';
        const hw = hoverEl.offsetWidth;
        const availAbove = Math.max(0, rect.top - pad);
        const availBelow = Math.max(0, window.innerHeight - rect.bottom - pad);
        // 只按哪边空间大选边，不看当前高度。否则没 diff 时变矮会往下，diff 到了再翻上去。
        const placeBelow = availBelow > availAbove;
        const avail = placeBelow ? availBelow : availAbove;
        const cap = Math.max(minH, avail || (window.innerHeight - pad * 2));
        hoverEl.style.maxHeight = cap + 'px';
        const hh = hoverEl.offsetHeight;
        let left = rect.left;
        if (left + hw > window.innerWidth - pad) {
            left = window.innerWidth - hw - pad;
        }
        let top = placeBelow ? rect.bottom : rect.top - hh;
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
        attachCachedDiff(lastShown);
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
            hoverEl.addEventListener('wheel', ev => ev.stopPropagation(), { passive: true });
            document.body.appendChild(hoverEl);
        }
        hoverEl.innerHTML = '';

        const tips = document.createElement('div');
        tips.className = 'cw-line-blame-hover-tips';

        const head = document.createElement('div');
        head.className = 'cw-line-blame-hover-head';
        const who = document.createElement('div');
        who.className = 'cw-line-blame-hover-who';
        who.appendChild(makeAvatar(h));
        addText(who, 'cw-line-blame-hover-author', h.author || '');
        head.appendChild(who);
        const when = document.createElement('div');
        when.className = 'cw-line-blame-hover-when';
        const clock = document.createElement('span');
        clock.className = 'cw-line-blame-hover-when-icon';
        clock.setAttribute('aria-hidden', 'true');
        clock.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.25a5.75 5.75 0 1 1 0 11.5 5.75 5.75 0 0 1 0-11.5zM8.5 4v4.05l2.6 1.5-.5.87L7.5 8.55V4h1z"/></svg>';
        when.appendChild(clock);
        const whenText = document.createElement('span');
        if (h.ago && h.date) {
            whenText.textContent = `${h.ago} (${h.date})`;
        } else {
            whenText.textContent = h.ago || h.date || '';
        }
        when.appendChild(whenText);
        head.appendChild(when);
        tips.appendChild(head);

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
            tips.appendChild(msg);
        }

        const actions = document.createElement('div');
        actions.className = 'cw-line-blame-hover-actions';
        if (h.shortSha && !h.workingTree) {
            actions.appendChild(makeShaButton(h.shortSha, h.sha));
        }
        if (actions.childNodes.length) {
            tips.appendChild(actions);
        }
        tips.appendChild(makeCopyButton(
            () => formatTipsCopy(lastShown && lastShown.hover),
            'Copy'
        ));
        hoverEl.appendChild(tips);

        const detail = document.createElement('div');
        detail.className = 'cw-line-blame-hover-detail';

        const foot = document.createElement('div');
        foot.className = 'cw-line-blame-hover-foot';

        const diffEl = renderDiff(h);
        if (diffEl) {
            detail.appendChild(diffEl);
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
        detail.appendChild(foot);
        detail.appendChild(makeCopyButton(
            () => formatDiffCopy(lastShown && lastShown.hover),
            'Copy'
        ));
        hoverEl.appendChild(detail);

        hoverEl.style.visibility = 'hidden';
        positionHover();
        const waitingDiff = lastShown.hover && !Array.isArray(lastShown.hover.diff);
        if (!waitingDiff) {
            hoverEl.style.visibility = 'visible';
        }
        requestDiff();
    }

    function ensureWidget() {
        if (widget && node) {
            return;
        }
        node = document.createElement('span');
        node.className = 'cw-line-blame';
        node.addEventListener('mouseenter', ev => {
            overBlame = true;
            hoverMoved = false;
            enterX = ev.clientX;
            enterY = ev.clientY;
        });
        node.addEventListener('mousemove', ev => {
            if (!overBlame || hoverMoved) {
                if (hoverMoved) {
                    scheduleShowHover();
                }
                return;
            }
            const dx = ev.clientX - enterX;
            const dy = ev.clientY - enterY;
            if (dx * dx + dy * dy < 1) {
                return;
            }
            hoverMoved = true;
            scheduleShowHover();
        });
        node.addEventListener('mouseleave', () => {
            overBlame = false;
            hoverMoved = false;
            cancelShowHover();
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
        hoverMoved = false;
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
        const nextHover = hover && typeof hover === 'object' ? hover : {};
        lastShown = {
            uri: (state && state.uri) || '',
            line,
            text,
            hover: nextHover,
            versionId: model.getVersionId()
        };
        attachCachedDiff(lastShown);
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

    function setHoverAuto(value) {
        hoverAuto = !!value;
        syncLiveClass();
        if (hoverAuto) {
            scheduleShowHover();
        }
    }

    editor.onMouseDown(clickLine);
    editor.onMouseUp(clickLine);

    window.addEventListener('keydown', e => {
        if (e.repeat) {
            return;
        }
        consumeBareAlt(e);
        if (e.altKey || e.key === 'Alt') {
            setAltDown(true);
        }
    }, true);
    window.addEventListener('keyup', e => {
        consumeBareAlt(e);
        if (e.key === 'Alt') {
            setAltDown(false);
        }
    }, true);
    window.addEventListener('blur', () => {
        setAltDown(false);
    });
    editor.onKeyDown(e => {
        const ev = e.browserEvent;
        if (ev && ev.repeat) {
            return;
        }
        if (ev) {
            consumeBareAlt(ev);
        }
        if (shouldConsumeAlt() && (e.altKey || e.keyCode === monaco.KeyCode.Alt)) {
            e.preventDefault();
            e.stopPropagation();
        }
        if (e.altKey || e.keyCode === monaco.KeyCode.Alt) {
            setAltDown(true);
        }
    });
    editor.onKeyUp(e => {
        const ev = e.browserEvent;
        if (ev) {
            consumeBareAlt(ev);
        }
        if (e.keyCode === monaco.KeyCode.Alt) {
            if (shouldConsumeAlt()) {
                e.preventDefault();
                e.stopPropagation();
            }
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

    return { handleResult, handleDiffResult, clear, setEnabled, setHoverAuto };
}
