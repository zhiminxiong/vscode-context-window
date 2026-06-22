//@ts-check

// 颜色相关工具函数：CSS 颜色解析、读取 CSS 变量、从 DOM 取渲染颜色

export function cssColorToMonaco(color) {
    if (!color) return undefined;
    const v = color.trim();
    if (v.startsWith('#')) return v;
    const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
    if (!m) return v;
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    const a = m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4])));
    const toHex = n => n.toString(16).padStart(2, '0');
    const alphaHex = a < 1 ? Math.round(a * 255).toString(16).padStart(2, '0') : '';
    return `#${toHex(r)}${toHex(g)}${toHex(b)}${alphaHex}`;
}

export function getCssVar(name) {
    try {
        const root = document.documentElement;
        if (!root || typeof getComputedStyle !== 'function') return undefined;
        const styles = getComputedStyle(root);
        if (!styles || typeof styles.getPropertyValue !== 'function') return undefined;
        const raw = styles.getPropertyValue(name);
        if (typeof raw !== 'string') return undefined;
        const v = raw.trim();
        if (!v) return undefined;
        return cssColorToMonaco(v);
    } catch (e) {
        console.warn('[definition] getCssVar failed:', name, e);
        return undefined;
    }
}

export function getTokenColorFromDOM(editor, position) {
    // 只负责从 DOM 获取渲染颜色，返回 hex 字符串或 null
    try {
        const domNode = editor.getDomNode();
        if (!domNode) return null;

        // getScrolledVisiblePosition 返回 null 当 position 不在可视区域
        const viewPos = editor.getScrolledVisiblePosition(position);
        if (!viewPos) return null;

        const editorRect = domNode.getBoundingClientRect();
        // 取位置中点，避免落到字符边缘（调整偏移以对齐到字符）
        const x = Math.round(editorRect.left + viewPos.left + 2);
        const y = Math.round(editorRect.top + viewPos.top + (viewPos.height || 16) / 2);

        // 获取该点所有元素（比 elementFromPoint 更稳）
        const els = document.elementsFromPoint(x, y);
        if (!els || els.length === 0) return null;

        // 寻找最可能是 token 的元素：span、class 包含 mtk（monaco token class）或有 color 样式
        for (const el of els) {
            if (!el) continue;
            // 优先找 <span class="mtk..."> 或直接带内联 color
            const tag = el.tagName;
            const cls = (el.className || '').toString();
            if (tag === 'SPAN' && (cls.includes('mtk') || cls.includes('token') || window.getComputedStyle(el).color)) {
                const computed = window.getComputedStyle(el).color;
                const hex = cssColorToMonaco(computed);
                if (hex) return hex;
            }
            // 也检查父元素（有时 color 在父上）
            const parent = el.parentElement;
            if (parent) {
                const parentColor = window.getComputedStyle(parent).color;
                const hex2 = cssColorToMonaco(parentColor);
                if (hex2) return hex2;
            }
        }

        return null;
    } catch (err) {
        console.error('[getTokenColorFromDOM] error', err);
        return null;
    }
}
