//@ts-check

// 仅在用户主动点某一行（行号 / 行尾空白）后显示行尾 git 摘要。
// 点单词会走 jumpDefinition，跳转后光标回到 (0,0)，那种情况不显示。

const WIDGET_ID = 'cw.lineBlame';

/**
 * @param {{
 *   editor: import('monaco-editor').editor.IStandaloneCodeEditor,
 *   state: { uri?: string },
 *   vscode: { postMessage: (msg: any) => void },
 *   enabled?: boolean
 * }} ctx
 */
export function createLineBlame(ctx) {
    const { editor, state, vscode } = ctx;
    let enabled = ctx && ctx.enabled !== false;
    let seq = 0;
    let timer = 0;
    /** @type {{ uri: string, line: number, text: string } | null} */
    let lastShown = null;
    let lastReqLine = 0;
    let lastReqUri = '';
    /** @type {HTMLSpanElement | null} */
    let node = null;
    /** @type {import('monaco-editor').editor.IContentWidget | null} */
    let widget = null;

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

    function ensureWidget() {
        if (widget && node) {
            return;
        }
        node = document.createElement('span');
        node.className = 'cw-line-blame';
        syncFont();
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
        if (node) {
            node.textContent = '';
        }
        if (widget) {
            try { editor.layoutContentWidget(widget); } catch (_) { /* noop */ }
        }
    }

    function apply(line, text) {
        const model = editor.getModel();
        if (!model || !text || line < 1 || line > model.getLineCount()) {
            hideWidget();
            return;
        }
        lastShown = { uri: (state && state.uri) || '', line, text };
        ensureWidget();
        syncFont();
        node.textContent = text;
        try { editor.layoutContentWidget(widget); } catch (_) { /* noop */ }
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
        apply(message.line, message.text);
    }

    function setEnabled(value) {
        enabled = !!value;
        if (!enabled) {
            clear();
        }
    }

    editor.onMouseUp(clickLine);

    editor.onDidChangeModel(() => {
        if (!enabled || !lastShown) {
            return;
        }
        if (lastShown.uri === (state && state.uri)) {
            apply(lastShown.line, lastShown.text);
        }
    });

    return { handleResult, clear, setEnabled };
}
