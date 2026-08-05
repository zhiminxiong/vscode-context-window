//@ts-check

// 编辑器鼠标交互逻辑：悬停高亮（onMouseMove + mouseleave 清理）与点击跳转 / 取色（onMouseUp）。
// 以 setup 形式创建，内部持有悬停高亮的可变状态（currentDecorations / lastWordKey），
// 并完成 onMouseMove / onMouseUp / mouseleave 的事件注册。
// 通过 ctx 共享 editor 引用、可变会话状态（state）、主题色标志（light）、vscode 通信对象，
// 以及缩进、光标显隐等回调。monaco / document / window 直接使用全局对象（与其它模块一致）。

import { getTokenColorFromDOM, getCssVar } from './colorUtils.js';
import { requestTokenStyle } from './tokenStyleClient.js';
import { pickTokenStyle } from './tokenPicker.js';
import { tokenAtPosition, semanticTokenAtPosition } from './tokenize.js';
import { getScopeAtPosition } from './textmateClient.js';
import { getTokenStyleSource } from './editorTheme.js';
import { trySelectBracketPairAt } from './bracketPairSelect.js';

// Sticky Scroll（粘附行）相关的 Monaco 内部标识：
// - 控制器 ID 见 monaco-editor/esm/vs/editor/contrib/stickyScroll/browser/stickyScrollController.js
// - widget ID 是粘附行 overlay widget 的 id，鼠标落在粘附行上时 e.target.detail 即为它
// 注意：这里读的是私有成员 _stickyScrollWidget（与本文件外已有的 editor._contextMenuService 等同类风险），
// 升级 monaco-editor 时需复核。
const STICKY_CONTROLLER_ID = 'store.contrib.stickyScrollController';
const STICKY_WIDGET_ID = 'editor.contrib.stickyScrollWidget';

export function setupEditorMouseHandlers(ctx) {
    const {
        editor,
        state,
        light,
        vscode,
        applyIndentationForModel,
        forcePointerCursor,
        showCursor,
        hideCursor,
        semanticState
    } = ctx;

    // 悬停高亮的可变状态
    let currentDecorations = [];
    // 记录上一次高亮的单词，范围未变则跳过 deltaDecorations，避免在同一单词上抖动时反复重画
    let lastWordKey = '';

    // === Sticky Scroll（粘附行）Ctrl/Cmd 悬停下划线的可变状态 ===
    // 粘附行不随 deltaDecorations 重绘（控制器只在滚动/tokens/配置/字体/行高变化时重渲染），
    // 所以这里直接给命中的叶子 span 加 class，与 VSCode 自己在粘附行上写 style.textDecoration 同思路。
    // stickyLinkEl：当前已加下划线的 span；lastStickyHoverEl：鼠标最近停留的可跳转 span
    //（供「鼠标不动、后按下 Ctrl」时补加下划线，对齐 VSCode 的 onMouseMoveOrRelevantKeyDown）。
    let stickyLinkEl = null;
    let lastStickyHoverEl = null;
    const STICKY_LINK_CLASS = 'cw-sticky-link';
    const hasTriggerModifier = (ev) => !!ev && (ev.ctrlKey || ev.metaKey);
    const setStickyLink = (el) => {
        if (stickyLinkEl === el) { return; }
        // 粘附行重渲染会整体替换 DOM，旧引用可能已脱离文档，isConnected 兜底避免无效写入
        if (stickyLinkEl && stickyLinkEl.isConnected) {
            stickyLinkEl.classList.remove(STICKY_LINK_CLASS);
        }
        stickyLinkEl = null;
        if (el && el.isConnected) {
            el.classList.add(STICKY_LINK_CLASS);
            stickyLinkEl = el;
        }
    };
    const clearStickyLink = () => setStickyLink(null);

    // 兼容读取点击次数：优先 Monaco IMouseEvent.detail，回退到原生 browserEvent.detail。
    // 用它在 onMouseUp 里识别双击——原生 DOM dblclick 在 Monaco 虚拟化内容上常因两次点击落在
    // 被重渲染替换的不同 DOM 节点而无法合成；而 detail（点击计数）来自输入层，不受 DOM 重建影响。
    const getClickCount = (e) => {
        const ev = e && e.event;
        if (!ev) { return 1; }
        return ev.detail || (ev.browserEvent && ev.browserEvent.detail) || 1;
    };

    // 性能优化：mouseleave 监听只在初始化时绑定一次，避免每次移动到新单词都堆叠 once 监听器（监听器泄漏）
    const editorDomForLeave = editor.getDomNode();
    if (editorDomForLeave) {
        editorDomForLeave.addEventListener('mouseleave', () => {
            if (currentDecorations.length) {
                currentDecorations = editor.deltaDecorations(currentDecorations, []);
            }
            lastWordKey = '';
            // 鼠标离开编辑器：粘附行下划线一并清掉，且忘记「最近悬停的 span」，
            // 否则之后在别处按下 Ctrl 会凭旧引用误加下划线
            lastStickyHoverEl = null;
            clearStickyLink();
        });
    }

    // Ctrl/Cmd 的按下/抬起也要驱动粘附行下划线（对齐 VSCode：鼠标停在 token 上后再按 Ctrl 同样出现下划线）。
    // Monaco 的 keyboardHandler 在本插件被置空，故直接在 document 上监听；window blur 时兜底清除，
    // 避免切走窗口后修饰键状态丢失导致下划线残留。
    document.addEventListener('keydown', (ev) => {
        if (hasTriggerModifier(ev) && lastStickyHoverEl) {
            setStickyLink(lastStickyHoverEl);
        }
    }, true);
    document.addEventListener('keyup', (ev) => {
        if (!hasTriggerModifier(ev)) {
            clearStickyLink();
        }
    }, true);
    window.addEventListener('blur', () => {
        lastStickyHoverEl = null;
        clearStickyLink();
    });

    // 取 Monaco 的粘附行 widget（内部实现，升级需复核）。
    // 它公开了 lineNumbers / getRenderedStickyLine()，可拿到每条粘附行的 lineDomNode 与 characterMapping，
    // 这是做字符级坐标换算的基础。
    const getStickyWidget = () => {
        try {
            const controller = editor.getContribution && editor.getContribution(STICKY_CONTROLLER_ID);
            const widget = controller && controller._stickyScrollWidget;
            return (widget && typeof widget.getRenderedStickyLine === 'function') ? widget : null;
        } catch (_) {
            return null;
        }
    };

    // 鼠标事件的视口坐标：StandardMouseEvent 的 posx/posy 是 page 坐标，拖选要用 client 坐标，
    // 优先取原生事件的 clientX/clientY
    const getClientPoint = (e) => {
        const me = e && e.event;
        const be = me && me.browserEvent;
        if (be && typeof be.clientX === 'number') { return { x: be.clientX, y: be.clientY }; }
        if (me && typeof me.posx === 'number') { return { x: me.posx, y: me.posy }; }
        return null;
    };

    // 由粘附行内的任意 DOM 节点找到它所属的 RenderedStickyLine
    //（含 lineNumber / lineDomNode / characterMapping）。
    // 必须走 Monaco 的 data-sticky-line-index 属性，不能用 y 坐标比 getBoundingClientRect：
    // 所有 .sticky-line-content 都是绝对定位、宽度为整条可滚动宽度、彼此完全重叠，
    // 靠 z-index 分层（非末行 z-index:1、末行 0，见 stickyScrollWidget._updatePosition），
    // 按 y 去比矩形只会命中被压在最上层的那一行——这正是「只有最后一行能操作」的原因。
    const getRenderedStickyLineFromNode = (domNode) => {
        const widget = getStickyWidget();
        if (!widget || !domNode) { return null; }
        try {
            const lineNumber = widget.getLineNumberFromChildDomNode(domNode);
            if (lineNumber === null || lineNumber === undefined) { return null; }
            return widget.getRenderedStickyLine(lineNumber) || null;
        } catch (_) {
            return null;
        }
    };

    // 按坐标找命中的粘附行：用 elementsFromPoint 拿到该点真实的元素栈（已按 z-index 排序），
    // 再取其中第一条粘附行。拖动时鼠标不在 Monaco 的事件目标上也能正确定位。
    const getRenderedStickyLineAtPoint = (clientX, clientY) => {
        let stack = [];
        try { stack = document.elementsFromPoint(clientX, clientY) || []; } catch (_) { stack = []; }
        for (const el of stack) {
            if (!el || typeof el.closest !== 'function') { continue; }
            const lineEl = el.closest('.sticky-line-content');
            if (!lineEl) { continue; }
            const rendered = getRenderedStickyLineFromNode(lineEl);
            if (rendered) { return rendered; }
        }
        return null;
    };

    // 空格宽度：characterMapping 的水平偏移以「空格宽」为单位，换算像素要乘它。
    // 与 Monaco 内部一致（RenderLineInput.spaceWidth 即 fontInfo.spaceWidth）。
    const getStickySpaceWidth = () => {
        try {
            const info = editor.getOption(monaco.editor.EditorOption.fontInfo);
            if (info && info.spaceWidth > 0) { return info.spaceWidth; }
        } catch (_) { /* 忽略，用下面的兜底 */ }
        return 8;
    };

    // 按 x 坐标在指定粘附行内定位「模型列」——字符级，与绘制共用同一套坐标换算。
    // characterMapping 的 _horizontalOffset 记录了每一列的水平偏移（单位：空格宽），
    // 用它做二分/线性查找即可，无需读 DOM 量像素：既避免 tab、缩进带来的偏差，
    // 也不会因为「鼠标没压在 token 上」而失效。
    const getStickyColumnAtX = (rendered, clientX) => {
        const cm = rendered && rendered.characterMapping;
        const lineDomNode = rendered && rendered.lineDomNode;
        if (!cm || !lineDomNode) { return 1; }
        const maxColumn = cm.length > 0 ? cm.length : 1; // CharacterMapping.length === 行文本长度 + 1
        // 内容原点：行 DOM 的左边缘（行 DOM 自身就是内容容器，缩进体现在渲染出的空白 part 里）
        const lineLeft = lineDomNode.getBoundingClientRect().left;
        const spaceWidth = getStickySpaceWidth();
        const x = (clientX - lineLeft) / (spaceWidth || 1); // 换算成「空格宽」单位
        if (x <= 0) { return 1; }
        let prevOffset = 0;
        try { prevOffset = cm.getHorizontalOffset(1); } catch (_) { prevOffset = 0; }
        for (let column = 2; column <= maxColumn; column++) {
            let offset = prevOffset;
            try { offset = cm.getHorizontalOffset(column); } catch (_) { /* 保持上一个 */ }
            if (x < offset) {
                // 落在 [column-1, column) 区间内：按字符中点决定吸附到前一列还是当前列，
                // 与编辑器里点击、拖选的手感一致
                const mid = (prevOffset + offset) / 2;
                return x <= mid ? column - 1 : column;
            }
            prevOffset = offset;
        }
        return maxColumn;
    };

    // 坐标 → 模型位置。先看是否落在某条粘附行；否则回落到正文区命中，
    // 这样可以从粘附行一路拖到正文区连成一片选区（与编辑器内拖选一致）。
    const resolveStickyDragPosition = (clientX, clientY) => {
        const rendered = getRenderedStickyLineAtPoint(clientX, clientY);
        if (rendered) {
            return { lineNumber: rendered.lineNumber, column: getStickyColumnAtX(rendered, clientX) };
        }
        try {
            const target = editor.getTargetAtClientPoint(clientX, clientY);
            const pos = target && target.position;
            return pos ? { lineNumber: pos.lineNumber, column: pos.column } : null;
        } catch (_) {
            return null;
        }
    };

    // 粘附行命中解析：position 一律走坐标换算（字符级），element/lineEl 供悬停下划线等 DOM 反馈使用。
    // 注意不再要求命中叶子 token 节点——行尾空白、缩进留白也算命中（此处取不到词的场景由调用方自行判断）。
    const getStickyTargetFromEvent = (e) => {
        const t = e && e.target;
        if (!t || t.type !== monaco.editor.MouseTargetType.OVERLAY_WIDGET || t.detail !== STICKY_WIDGET_ID) {
            return null;
        }
        const element = t.element;
        if (!element || typeof element.closest !== 'function') { return null; }
        const lineEl = element.closest('.sticky-line-content');
        if (!lineEl) { return null; }
        const point = getClientPoint(e);
        if (!point) { return null; }
        // 用命中的 DOM 节点反查所属粘附行（Monaco 在节点上存了 data-sticky-line-index），
        // 比按坐标猜更可靠：粘附行彼此重叠，坐标法会误判成最上层那一行
        const rendered = getRenderedStickyLineFromNode(lineEl);
        if (!rendered) { return null; }
        return {
            position: { lineNumber: rendered.lineNumber, column: getStickyColumnAtX(rendered, point.x) },
            element,
            lineEl
        };
    };

    // === 粘附行「选中」的视觉反馈 ===
    // 粘附行不渲染 selection 层（选区由正文区的 selections 层绘制），且不随装饰重绘，
    // 所以只能自己画：按选区列区间量出像素范围，往粘附行里插入绝对定位的覆盖层。
    // 用覆盖层而不是给 token span 上底色，才能做到字符级（选到 token 中间也能精确停住）。
    //
    // 重点：粘附区的选中【绝不能】落到 editor 的 model 选区上。
    // 粘附行在模型里是不连续的（如第 19、66、68 行），setSelection(19,x → 69,y) 在正文区
    // 会把中间几十行整片选中，完全不是用户要的效果。所以这里自建一套选区状态，
    // 连拷贝也自己处理（见 handleStickyCopy）。
    let stickySelectionOverlays = [];
    // 与视觉严格对应的选区分段：[{ lineNumber, startColumn, endColumn }]，拷贝时直接按它取文本，
    // 保证「看到的」和「拷到的」完全一致（不会把粘附行之间被折叠掉的内容也带上）。
    let stickySelectionSegments = [];
    let stickySelectionKey = '';
    const STICKY_SELECTION_CLASS = 'cw-sticky-selection';

    const clearStickySelection = () => {
        for (const el of stickySelectionOverlays) {
            if (el && el.isConnected) { el.remove(); }
        }
        stickySelectionOverlays = [];
        stickySelectionSegments = [];
        stickySelectionKey = '';
    };

    const applyStickySelectionColor = (widget) => {
        const root = widget && widget.getDomNode && widget.getDomNode();
        if (!root) { return; }
        const cfg = window.vsCodeEditorConfiguration && window.vsCodeEditorConfiguration.contextEditorCfg;
        const color = (cfg && cfg.selectionBackground)
            || getCssVar('--vscode-editor-selectionBackground')
            || '#07c2db71';
        root.style.setProperty('--cw-sticky-selection-bg', color);
    };

    // 量取某条粘附行内某一列的像素偏移（相对该行 DOM 内容原点）。
    // 直接用 characterMapping.getHorizontalOffset(column) —— 这正是 Monaco 自己算列像素偏移的方法
    //（见 viewLine.js 的 _getColumnPixelOffset），单位是「空格宽度的倍数」，乘以空格宽即得像素。
    // 这样 tab、缩进、行尾都天然正确，且与列换算共用同一坐标系，不会出现整体偏移。
    const measureStickyColumnOffset = (rendered, column) => {
        const cm = rendered && rendered.characterMapping;
        if (!cm) { return 0; }
        const maxColumn = cm.length > 0 ? cm.length : 1;
        const clamped = Math.min(Math.max(column, 1), maxColumn);
        let horizontalOffset = 0;
        try { horizontalOffset = cm.getHorizontalOffset(clamped); } catch (_) { horizontalOffset = 0; }
        return horizontalOffset * getStickySpaceWidth();
    };

    // 按选区范围重绘粘附区的选中态（可跨多条粘附行）。
    // range 只用来表达「从哪到哪」，遍历的对象始终是当前渲染出来的粘附行，
    // 因此模型里被折叠掉的中间行不会被选中——视觉上连续，语义上也只含粘附行。
    const paintStickySelection = (range) => {
        if (!range) { clearStickySelection(); return; }
        // 拖选时 mousemove 很密集，范围没变就不重复量取/重建 DOM
        const key = `${range.startLineNumber}:${range.startColumn}:${range.endLineNumber}:${range.endColumn}`;
        if (key === stickySelectionKey && stickySelectionOverlays.every(el => el && el.isConnected)) { return; }
        clearStickySelection();
        const widget = getStickyWidget();
        if (!widget) { return; }
        applyStickySelectionColor(widget);
        for (const lineNumber of (widget.lineNumbers || [])) {
            if (lineNumber < range.startLineNumber || lineNumber > range.endLineNumber) { continue; }
            let rendered = null;
            try { rendered = widget.getRenderedStickyLine(lineNumber); } catch (_) { rendered = null; }
            const lineDomNode = rendered && rendered.lineDomNode;
            if (!lineDomNode || !lineDomNode.isConnected || !rendered.characterMapping) { continue; }
            const maxColumn = rendered.characterMapping.length > 0 ? rendered.characterMapping.length : 1;
            const startColumn = lineNumber === range.startLineNumber ? range.startColumn : 1;
            const endColumn = lineNumber === range.endLineNumber ? range.endColumn : maxColumn;
            if (endColumn <= startColumn) { continue; }
            const left = measureStickyColumnOffset(rendered, startColumn);
            const right = measureStickyColumnOffset(rendered, endColumn);
            if (right <= left) { continue; }
            const overlay = document.createElement('div');
            overlay.className = STICKY_SELECTION_CLASS;
            // 覆盖层不能插进 lineDomNode：Monaco 的 getColumnOfNodeOffset 靠 previousSibling 计数得出
            // partIndex（见 viewLine.js:534），往行内插任何节点都会让列号错位，
            // 进而破坏 Ctrl+悬停下划线等依赖它的功能。所以挂到行 DOM 的父层（.sticky-widget-lines），
            // 用 top 对齐到该行，与行 DOM 同一坐标系（两者都以 lines 容器为定位父级）。
            overlay.style.left = `${left}px`;
            overlay.style.width = `${right - left}px`;
            overlay.style.top = lineDomNode.style.top || '0px';
            overlay.style.height = lineDomNode.style.height || `${rendered.height || 0}px`;
            // z-index 必须跟随所属行：Monaco 给非末行设 z-index:1、末行设 0
            //（见 stickyScrollWidget._updatePosition），且各行绝对定位、宽度为整条可滚动宽度、
            // 彼此完全重叠。覆盖层若用固定层级，就会被上层行的不透明背景（background-color: inherit）
            // 整块盖住——表现为只有末行的选中可见。
            // 跟随行层级 + 插在该行之后：同层后插入者绘制在上，从而压过行背景；
            // 又因为它是半透明色（selectionBackground 带 alpha）且 pointer-events: none，
            // 文字仍可见、命中判定也不受影响。
            overlay.style.zIndex = lineDomNode.style.zIndex || '0';
            const linesContainer = lineDomNode.parentElement;
            if (!linesContainer) { continue; }
            linesContainer.insertBefore(overlay, lineDomNode.nextSibling);
            stickySelectionOverlays.push(overlay);
            // 记录与视觉一一对应的分段，供 Ctrl+C 取文本
            stickySelectionSegments.push({ lineNumber, startColumn, endColumn });
        }
        stickySelectionKey = key;
    };

    // 在粘附行选中一段范围。
    // 只画自己的覆盖层，【不动】editor 的 model 选区：粘附行在模型里不连续，
    // 一旦 setSelection 就会把正文区里跨越的几十行整片选中（这正是之前的 bug）。
    const selectStickyRange = (range) => {
        paintStickySelection(range);
        // 确保编辑器持有焦点：Ctrl+C 的 keydown 必须能进到 webview 才能被下面的监听拿到。
        // 粘附行是 overlay widget，点它不一定会让编辑器聚焦（Monaco 只在命中正文/行号时才 focus）。
        if (stickySelectionSegments.length && !editor.hasTextFocus()) {
            editor.focus();
            // 聚焦会让光标显形，而粘附区选中并没有移动光标，保持隐藏更贴合实际
            hideCursor();
        }
    };

    // 粘附区选中内容的文本：严格按画出来的分段取，所见即所拷
    const getStickySelectionText = () => {
        if (!stickySelectionSegments.length) { return ''; }
        const model = editor.getModel();
        if (!model) { return ''; }
        const parts = [];
        for (const seg of stickySelectionSegments) {
            try {
                parts.push(model.getValueInRange(new monaco.Range(
                    seg.lineNumber, seg.startColumn, seg.lineNumber, seg.endColumn
                )));
            } catch (_) { /* 行已不存在（内容切换），忽略 */ }
        }
        return parts.join('\n');
    };

    // 粘附区自己的拷贝：因为不占用 model 选区，Monaco 的复制命令拿不到它，必须自己接管。
    // 只有存在粘附区选中时才拦截，正文区的 Ctrl+C 仍交给 Monaco。
    //
    // 写剪贴板一律走扩展端的 vscode.env.clipboard：webview 里 navigator.clipboard 受焦点与权限
    // 限制（document 常不是 focused，且无 clipboard-write 授权），经常静默失败或抛异常；
    // 原生 copy 事件的 clipboardData 也只在浏览器真的发起复制时才有，而这里没有原生选区
    //（插件全局设了 user-select: none），copy 事件根本不会被派发。
    const handleStickyCopy = (ev) => {
        const text = getStickySelectionText();
        if (!text) { return false; }
        // 若确实拿到了原生 copy 事件，顺手把数据塞进去（成本极低，且能覆盖系统菜单复制的场景）
        if (ev && ev.clipboardData) {
            try {
                ev.clipboardData.setData('text/plain', text);
                ev.preventDefault();
            } catch (_) { /* 忽略，下面的扩展端通道兜底 */ }
        }
        vscode.postMessage({ type: 'copyToClipboard', text });
        return true;
    };

    // 原生 copy 事件（如系统菜单触发的复制）
    document.addEventListener('copy', (ev) => { handleStickyCopy(ev); }, true);

    // Ctrl/Cmd + C：必须在捕获阶段抢在 Monaco 之前处理。
    // 编辑器的 keybinding 服务挂在编辑器 DOM 上，冒泡阶段才响应；这里用 document 捕获 + 
    // stopImmediatePropagation，避免 Monaco 用「空的 model 选区」执行复制、把剪贴板写成空串。
    document.addEventListener('keydown', (ev) => {
        if (!hasTriggerModifier(ev) || ev.shiftKey || ev.altKey) { return; }
        if (ev.key !== 'c' && ev.key !== 'C') { return; }
        if (!stickySelectionSegments.length) { return; }
        if (handleStickyCopy(null)) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
        }
    }, true);

    // === 左键拖选状态 ===
    // stickyDrag：mousedown 落在粘附行文本上时记录锚点；moved 表示真的拖动过（用于区分「单击」）。
    // suppressNextStickyClick：拖选结束后要吃掉紧随的 click——Monaco 自带的粘附行 click 监听会
    // _revealPosition() 并把选区重置成单点（setSelection(Range.fromPositions(position))），会毁掉刚拖出的选区。
    let stickyDrag = null;
    let suppressNextStickyClick = false;
    // 拖选刚结束的标记：document 捕获阶段的 onStickyDragEnd 先跑，随后 Monaco 才派发 onMouseUp，
    // 用它让 handleEditorMouseUp 认出「这次松手是拖选的收尾」，不要再当成单击处理。
    let stickyDragJustFinished = false;

    const stopStickyDrag = () => {
        stickyDrag = null;
        document.removeEventListener('mousemove', onStickyDragMove, true);
        document.removeEventListener('mouseup', onStickyDragEnd, true);
    };

    // 拖选过程：把当前坐标换算成模型位置，与锚点组成选区。
    // 位置换算不依赖「鼠标是否压在 token 上」，行尾空白、缩进留白、乃至拖到正文区都能连续选择。
    function onStickyDragMove(ev) {
        if (!stickyDrag) { return; }
        if ((ev.buttons & 1) === 0) { // 左键已松开（可能在窗口外松的），收尾
            onStickyDragEnd(ev);
            return;
        }
        const current = resolveStickyDragPosition(ev.clientX, ev.clientY);
        if (!current) { return; }
        const anchor = stickyDrag.anchor;
        if (current.lineNumber === anchor.lineNumber && current.column === anchor.column) {
            // 回到锚点：清空粘附区选中，但仍算「拖过」，避免松手时被当成单击去滚动定位
            if (stickyDrag.moved) { clearStickySelection(); }
            return;
        }
        stickyDrag.moved = true;
        const anchorFirst = anchor.lineNumber < current.lineNumber
            || (anchor.lineNumber === current.lineNumber && anchor.column <= current.column);
        const from = anchorFirst ? anchor : current;
        const to = anchorFirst ? current : anchor;
        selectStickyRange(new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column));
    }

    function onStickyDragEnd(ev) {
        if (!stickyDrag) { return; }
        const dragged = stickyDrag.moved;
        stopStickyDrag();
        if (!dragged) { return; }
        stickyDragJustFinished = true;
        // 拖选结束：吃掉紧随的那次 click，否则 Monaco 的粘附行 click 监听会 _revealPosition()
        // 并把选区重置成单点，刚拖出的选区就没了。只有松手仍在粘附区内时 click 才会经过粘附节点。
        const widget = getStickyWidget();
        const root = widget && widget.getDomNode && widget.getDomNode();
        if (root && ev && ev.target instanceof Node && root.contains(ev.target)) {
            suppressNextStickyClick = true;
        }
    }

    const installStickyClickSuppressor = () => {
        const widget = getStickyWidget();
        const root = widget && widget.getDomNode && widget.getDomNode();
        if (!root || root.__cwStickyClickSuppressor) { return; }
        root.__cwStickyClickSuppressor = true;
        // 挂在 widget 根节点的捕获阶段：早于 Monaco 注册在同一节点上的冒泡 click 监听。
        // 只吃「拖选刚结束」那一次，普通单击照常放行（保持 VSCode 的滚动定位行为）。
        root.addEventListener('click', (ev) => {
            if (suppressNextStickyClick) {
                suppressNextStickyClick = false;
                ev.stopImmediatePropagation();
                ev.preventDefault();
            }
        }, true);
    };
    installStickyClickSuppressor();

    // 粘附区一旦发生变化就取消选中，恢复成未选中状态。
    // 覆盖层是我们自己挂的独立节点，Monaco 重绘粘附行时不会同步它：滚动会改各行的 top / z-index
    // 甚至重建行节点，内容更新后行号还在但文本已换。与其想办法让覆盖层跟着变（要处理重放、
    // 失效判定、与拖选竞争等一堆情况），不如直接清掉——选中本就是即时操作，变化后失效最符合直觉。
    // 拖选进行中不清：那时位置由 onStickyDragMove 实时驱动，滚动是拖选的一部分。
    const clearStickySelectionOnChange = () => {
        if (stickyDrag) { return; }
        if (!stickySelectionOverlays.length) { return; }
        clearStickySelection();
    };

    editor.onDidScrollChange(clearStickySelectionOnChange);      // 滚动：粘附行集合与各行位置都会变
    editor.onDidChangeModelContent(clearStickySelectionOnChange); // 内容更新（跳到别的定义）
    editor.onDidChangeModel(clearStickySelectionOnChange);        // 切换 model
    editor.onDidLayoutChange(clearStickySelectionOnChange);       // 布局/字体变化会改列像素偏移

    editor.onMouseDown((e) => {
        // 新一轮鼠标交互开始：清掉可能残留的 click 抑制标志，避免误吃正常单击
        suppressNextStickyClick = false;
        // 只有「无修饰键的左键」落在粘附行上才准备拖选：
        // Ctrl/Cmd + 左键是跳定义，shift + 左键是 Monaco 的「定位到区块末行」，都不参与
        if (!e.event.leftButton || hasTriggerModifier(e.event) || e.event.shiftKey || e.event.altKey) {
            stopStickyDrag();
            return;
        }
        const sticky = getStickyTargetFromEvent(e);
        if (!sticky) {
            stopStickyDrag();
            return;
        }
        installStickyClickSuppressor(); // 兜底：widget 在 setup 时可能还没建好
        stickyDrag = { anchor: sticky.position, moved: false };
        // 拖选期间在 document 上跟踪鼠标：粘附行是 overlay widget，Monaco 的 onMouseMove 只在
        // 命中它的子节点时才给出事件，鼠标一旦划到行间空隙/行尾空白/正文区就断流。
        // 直接用原生 mousemove + 坐标换算，才能做到「像编辑器里一样按住不放随便拖」。
        document.addEventListener('mousemove', onStickyDragMove, true);
        document.addEventListener('mouseup', onStickyDragEnd, true);
    });

    function handleEditorMouseMove(e) {
        // 默认使用默认光标
        let isOverText = false;

        // 获取当前单词
        const model = editor.getModel();
        const position = e.target.position;
        if (model && position && e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) {
            const word = model.getWordAtPosition(position);
            if (word) {
                // 鼠标悬停在文本上，使用手型光标
                isOverText = true;
                // 单词范围未变化则不重复重画装饰
                const key = position.lineNumber + ':' + word.startColumn + ':' + word.endColumn;
                if (key !== lastWordKey) {
                    lastWordKey = key;
                    currentDecorations = editor.deltaDecorations(currentDecorations, [{
                        range: new monaco.Range(
                        position.lineNumber,
                        word.startColumn,
                        position.lineNumber,
                        word.endColumn
                        ),
                        options: {
                            inlineClassName: light ? 'ctrl-hover-link' : 'ctrl-hover-link-dark'
                        }
                    }]);
                }
            }
        }

        if (!isOverText && lastWordKey) {
            // 离开文本区域，清除装饰
            currentDecorations = editor.deltaDecorations(currentDecorations, []);
            lastWordKey = '';
        }

        // Sticky Scroll（粘附行）：记录鼠标下的可跳转 token，并在按住 Ctrl/Cmd 时加下划线。
        // 与 VSCode 一致——粘附行上「Ctrl/Cmd + 悬停」才提示可点击（普通悬停只是行高亮 + 手型）。
        // 拖选不在这里处理：它挂在 document 上（见 onStickyDragMove），否则鼠标划出 token 就断流。
        lastStickyHoverEl = null;
        const stickyTarget = getStickyTargetFromEvent(e);
        if (stickyTarget) {
            const stickyWord = model ? model.getWordAtPosition(stickyTarget.position) : null;
            // 下划线要精确落在 token 上，故仍要求命中的是叶子文本节点
            if (stickyWord && stickyTarget.element && stickyTarget.element.children.length === 0) {
                lastStickyHoverEl = stickyTarget.element;
            }
        }
        setStickyLink(hasTriggerModifier(e.event) ? lastStickyHoverEl : null);

        // 根据鼠标位置更新光标样式
        forcePointerCursor(isOverText);
        return true;
    }

    // 右键取色流程（正文区与粘附行共用）。
    // lookupPosition 必须是「单词首字符列」——见调用处注释；probeColor 是取色面板的初始色，
    // 由调用方按各自可靠的方式探测（正文区从渲染 DOM 取，粘附行直接取粘附 span 的 computed color）。
    async function runPickTokenStyle(model, lookupPosition, wordText, probeColor) {
        // 优先用后端语义 token 识别（右键即可知道该标识符的语义类型，如 variable/function/class）；
        // 该位置无语义 token（如关键字/操作符走基础层）时，回退到 Monaco 基础 tokenizer。
        let tokenInfo = (semanticState && semanticState.data)
            ? semanticTokenAtPosition(lookupPosition, semanticState)
            : null;
        if (!tokenInfo || !tokenInfo.token) {
            // 方案 B：优先用真实 TextMate 语法取该位置的 scope（如 storage.type.struct.cpp），
            // 与编辑器渲染同源；grammar 未就绪/未启用时回退到 Monaco 基础 tokenizer。
            let tm = null;
            if (window.ctxTextmate && window.ctxTextmate.enabled) {
                const sc = getScopeAtPosition(model, lookupPosition);
                if (sc && sc.picked) {
                    tm = {
                        token: sc.picked,
                        startColumn: sc.startColumn,
                        endColumn: sc.endColumn,
                        text: sc.text,
                        textmate: true // 标记：真实 TextMate scope，展示/写入用完整 scope，不做语言后缀裁剪
                    };
                }
            }
            tokenInfo = tm || tokenAtPosition(model, editor, lookupPosition);
        }
        if (!tokenInfo || !tokenInfo.token) { return; }
        //console.log('[definition] pickColor action for token:', tokenInfo);
        try {
            // 语义 token 会带 modifiers 数组；Monarch 回退 token 不带
            const isSemantic = Array.isArray(tokenInfo.modifiers);
            let token, style;
            if (isSemantic) {
                // 与 Monaco 内部 getTokenStyleMetadata 一致：
                // 把「类型 + 修饰符」拼成 "type.mod1.mod2"（如 parameter.declaration），
                // 右键即可看到带修饰符的完整身份，并能针对它单独配色。
                // requestTokenStyle 内部已按最长前缀匹配用户规则、并回退到前端默认语义规则
                // （含 *.declaration 系列），故此处直接取其结果作初值，写回目标仍是完整名。
                token = tokenInfo.modifiers.length
                    ? [tokenInfo.token].concat(tokenInfo.modifiers).join('.')
                    : tokenInfo.token;
                // 语义 token：按 VSCode 选择器匹配（类型 + 修饰符子集）
                style = await requestTokenStyle(token, true);
            } else {
                // 基础语法层 token：TextMate 前缀匹配。
                style = await requestTokenStyle(tokenInfo.token, false);
                token = tokenInfo.token;
                // 方案 B 的真实 TextMate scope（如 storage.type.struct.cpp）已是可渲染的完整 scope，
                // 保持完整展示/写入（对齐 VSCode）；仅对 Monarch 基础 token 在无规则时裁剪语言后缀。
                if (!tokenInfo.textmate && (!style || !style.found)) {
                    const lastDot = tokenInfo.token.lastIndexOf('.');
                    token = lastDot > 0 ? tokenInfo.token.slice(0, lastDot) : tokenInfo.token;
                }
            }
            //console.log('[definition] token style:', style);
            // 计算当前生效 token 的来源：自定义 > 语义/textmate > monaco，
            // 供取色面板展示（monaco/语义/textmate/自定义）。
            const source = getTokenStyleSource(token, isSemantic, !!tokenInfo.textmate);
            const newStyle = await pickTokenStyle({
                token,
                foreground: style?.foreground,
                fontStyle: style?.fontStyle,
                description: style?.description,
                source
            }, probeColor || '#808080', wordText);
            //console.log('[definition] picked new style:', newStyle);
            if (newStyle) {
                // 回传扩展端，后续用于更新规则
                vscode.postMessage({
                    type: 'tokenStyle.set',
                    newStyle,
                    token
                });
            }
        } catch (err) {
            console.error('[context-window] pickColor action failed:', err);
        }
    }

    // 处理链接点击事件 - 在Monaco内部跳转
    async function handleEditorMouseUp(e) {
        //console.log('[definition] Mouse up event:', e.target, e.event);
        // 完全阻止事件传播
        //e.event.preventDefault();
        //e.event.stopPropagation();
        // 使用 e.event.buttons 判断鼠标按键
        //const isLeftClick = (e.event.buttons & 1) === 1; // 左键
        //const isRightClick = (e.event.buttons & 2) === 2; // 右键

        // === Sticky Scroll（粘附行）鼠标行为 ===
        // 左键：普通单击（含 shift / 双击）不拦截，交给 Monaco 自带的 CLICK 监听（滚动并定位到该行）；
        //       拖选结束（moved）时吃掉那次 click，避免 _revealPosition 把刚拖出的选区重置成单点。
        // Ctrl/Cmd + 左键：跳定义。Monaco 原生这条路径走 languageFeaturesService.definitionProvider，
        //       而 webview 内没有注册 definition provider，其 ClickLinkGesture.onExecute 会静默返回，
        //       所以需要我们自己把跳转请求发回扩展端（与正文区 CONTENT_TEXT 的 jumpDefinition 同一消息）。
        // 右键：选中单词 / 取色，与正文区一致（Monaco 原生的粘附行右键菜单已被插件统一屏蔽）。
        const stickyTarget = getStickyTargetFromEvent(e);

        // 拖选收尾在 document 的捕获阶段就做完了（onStickyDragEnd 先于 Monaco 的 mouseup 监听），
        // 这里只需认出「这次 mouseup 属于刚结束的拖选」并直接结束，避免又去走单击/双击逻辑。
        if (stickyDragJustFinished) {
            stickyDragJustFinished = false;
            return true;
        }

        // 粘附行上的普通左键单击：Monaco 会把选区重置成单点，我们画的选中反馈同步清掉
        if (stickyTarget && e.event.leftButton && !hasTriggerModifier(e.event)) {
            clearStickySelection();
        }

        if (stickyTarget && e.event.leftButton && (e.event.ctrlKey || e.event.metaKey)) {
            // 已经点击跳转，下划线提示不再需要（内容更新后粘附行 DOM 也会重建）
            lastStickyHoverEl = null;
            clearStickyLink();
            const stickyModel = editor.getModel();
            const stickyWord = stickyModel && stickyModel.getWordAtPosition(stickyTarget.position);
            if (stickyWord) {
                vscode.postMessage({
                    type: 'jumpDefinition',
                    uri: state.uri,
                    token: stickyWord.word,
                    position: {
                        line: stickyTarget.position.lineNumber - 1,
                        character: stickyTarget.position.column - 1
                    }
                });
            }
            return true;
        }

        if (stickyTarget && e.event.rightButton) {
            const stickyModel = editor.getModel();
            const stickyWord = stickyModel && stickyModel.getWordAtPosition(stickyTarget.position);
            if (stickyWord) {
                if (window.pickTokenStyle) {
                    // 与正文区同理：按「单词首字符列」查 token，避免落在词尾边界命中相邻标点/空白 token。
                    // 初始色不能用 getTokenColorFromDOM——它依赖 getScrolledVisiblePosition 在正文区探点，
                    // 而粘附行对应的正文行往往已滚出视口，探到的会是别的元素；直接读粘附 span 的渲染色最准。
                    await runPickTokenStyle(
                        stickyModel,
                        { lineNumber: stickyTarget.position.lineNumber, column: stickyWord.startColumn },
                        stickyWord.word,
                        window.getComputedStyle(stickyTarget.element).color
                    );
                } else {
                    selectStickyRange(new monaco.Range(
                        stickyTarget.position.lineNumber,
                        stickyWord.startColumn,
                        stickyTarget.position.lineNumber,
                        stickyWord.endColumn
                    ));
                }
            }
            return true;
        }

        if (e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) {
            // 正文区一旦有点击，选区就落到正文区了，粘附区上一次画的选中底色已过期，先清掉
            clearStickySelection();

            // 获取当前单词
            let model = editor.getModel();
            if (!model) {
                //console.log('[definition] **********************no model found************************');
                model = monaco.editor.createModel(state.content, state.language);
                applyIndentationForModel(model);
                editor.setModel(model);
            }
            const position = e.target.position;

            // 右键【双击】紧挨括号/引号 → 选中整对（含定界符）。移植自扩展主编辑器的双击选定，
            // 此处严格要求「右键双击」；仅在非 pick token 且开关(doubleClickSelectsBracketPair)开启时生效。
            // 未命中括号/引号时返回 false，继续走下方右键单击选词逻辑，故不干扰原有右键选词。
            if (e.event.rightButton && getClickCount(e) >= 2 && !window.pickTokenStyle && window.selectBracketPairEnabled && model && position) {
                const hit = await trySelectBracketPairAt(editor, position);
                if (hit) { hideCursor(); return true; }
            }

            // 检查点击位置是否在当前选择范围内
            const selection = editor.getSelection();
            const isClickedTextSelected = selection && !selection.isEmpty() && selection.containsPosition(position);
            if (model && position && !isClickedTextSelected) {
                //console.log('[definition] start to mid + jump definition: ', e);
                const word = model.getWordAtPosition(position);
                if (word) {
                    if (e.event.rightButton) {
                        //console.log('[definition] start to mid + jump definition: ', word);
                        if (window.pickTokenStyle) {
                            // 取色一律按「用户看到的高亮单词」的起始列做 token 查找，而非鼠标原始点击列。
                            // 原因：getWordAtPosition 对词尾边界是包含的（点在 if 右边缘仍判定为 if），
                            // 而各 token 查找用的是右开区间 [startIndex, endIndex)，原始点击列若落在词尾边界，
                            // 会命中相邻的空白/标点 token，取到其容器 scope（如 meta.block.ts）而非关键字本身
                            // （keyword.control.conditional.ts）——这正是「偶现取错 token、改色后无变化」的根因。
                            // 用 word.startColumn（单词首字符列）可确定性命中单词自身的 token。
                            const lookupPosition = {
                                lineNumber: position.lineNumber,
                                column: word.startColumn
                            };
                            await runPickTokenStyle(
                                model,
                                lookupPosition,
                                word.word,
                                getTokenColorFromDOM(editor, lookupPosition)
                            );
                        } else {
                            editor.setSelection({
                                startLineNumber: position.lineNumber,
                                startColumn: word.startColumn,
                                endLineNumber: position.lineNumber,
                                endColumn: word.endColumn
                            });
                            // 右键选词后让编辑器获得键盘焦点，否则 Ctrl+F / Alt+W 等
                            // 快捷键收不到（此前必须再左键点一下才生效）。focus() 只影响
                            // 键盘焦点，不影响光标视觉可见性——后者由 hideCursor() 的
                            // cursor-active class 控制，故光标仍保持隐藏。
                            editor.focus();
                            hideCursor();
                        }
                    } else if (e.event.leftButton) {
                        //console.log(`[definition] start to jump definition: ${word} with uri ${uri}`);
                        hideCursor();
                        vscode.postMessage({
                            type: 'jumpDefinition',
                            uri: state.uri,
                            token: word.word,
                            position: {
                                line: position.lineNumber - 1,
                                character: position.column - 1
                            }
                        });
                    }
                }
            }
        } else {
            if (e.event.rightButton) {
                editor.focus();
                showCursor();
            } else if (e.event.leftButton && getClickCount(e) >= 2) {
                // 在「空白处」（非文本：CONTENT_EMPTY 等）双击 → 让 VSCode 主编辑区定位到当前上下文行。
                // 空白处没有单词，天然不会进入上面的 jumpDefinition 分支，故无需防抖即可与单击跳转共存。
                // 走 Monaco 的 onMouseUp（点击计数可靠），替代此前失效的原生 DOM dblclick。
                vscode.postMessage({
                    type: 'doubleClick',
                    location: 'bottomArea'
                });
            }
        }
        return true;
    }

    editor.onMouseMove(handleEditorMouseMove);
    editor.onMouseUp(handleEditorMouseUp);

    return { handleEditorMouseMove, handleEditorMouseUp };
}
