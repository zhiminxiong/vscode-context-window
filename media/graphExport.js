//@ts-check

// 关系图导出：把当前图变成可以贴进文档 / PR 的产物。
//
// 输入是 callRelation.js 组装的「导出模型」——一份不含 DOM 引用的普通数据
// （节点位置、连线路径 d、以及从渲染后的元素上采样到的主题色）。这样格式逻辑
// 全在本文件里，画布那边只负责取数。
//
// 三种输出的定位不同：
//   - SVG：当前视图的矢量快照，颜色跟随用户主题，独立可看（不依赖 CSS 变量）；
//   - PNG：由 SVG 栅格化而来（见 toPngDataUrl），给不支持 SVG 的地方用；
//   - Mermaid / DOT：结构化文本，交给 Markdown / Graphviz 自己排版，
//     所以不带坐标，也丢掉纯 UI 性质的「Show more」节点。
//
// callRelation.js 是普通脚本（非 ESM），故这里也用全局挂载而不是 export。

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    // 画布边界外留白：容纳箭头（8px）、描边与圆弧连线的外凸。
    const PAD = 24;

    function svgEl(name) {
        return document.createElementNS(SVG_NS, name);
    }

    function attrs(el, map) {
        for (const key of Object.keys(map)) {
            const value = map[key];
            if (value !== undefined && value !== null && value !== '') {
                el.setAttribute(key, String(value));
            }
        }
        return el;
    }

    // ===== 文本裁剪 =====

    // 节点宽度是固定的，画布上靠 CSS ellipsis 截断；SVG 里没有这套，只能量着截。
    function fitText(text, maxWidth, size, bold, measure) {
        const full = String(text || '');
        if (!full || !measure || maxWidth <= 0) {
            return full;
        }
        if (measure(full, size, bold) <= maxWidth) {
            return full;
        }
        let lo = 0;
        let hi = full.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (measure(full.slice(0, mid) + '…', size, bold) <= maxWidth) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return lo > 0 ? full.slice(0, lo) + '…' : '';
    }

    // ===== SVG =====

    function arrowMarker(id, fill) {
        const marker = attrs(svgEl('marker'), {
            id,
            viewBox: '0 0 10 10',
            refX: 0,
            refY: 5,
            markerWidth: 8,
            markerHeight: 8,
            markerUnits: 'userSpaceOnUse',
            orient: 'auto',
            overflow: 'visible'
        });
        marker.appendChild(attrs(svgEl('path'), { d: 'M 0 1.2 L 10 5 L 0 8.8 z', fill }));
        return marker;
    }

    function drawNode(model, node) {
        const v = model.theme.variants[node.variant] || model.theme.variants.node;
        const g = svgEl('g');
        const inset = v.borderWidth / 2;
        g.appendChild(attrs(svgEl('rect'), {
            x: node.x + inset,
            y: node.y + inset,
            width: Math.max(0, node.w - v.borderWidth),
            height: Math.max(0, node.h - v.borderWidth),
            rx: v.radius,
            ry: v.radius,
            fill: v.bg,
            stroke: v.border,
            'stroke-width': v.borderWidth,
            'stroke-dasharray': v.dashed ? '4 3' : ''
        }));

        // 画布上节点是 flex column + justify-content:center，这里按同样的方式
        // 把「名字 + file:line」两行整体垂直居中。
        const sub = node.showSub ? node.sub : '';
        const contentH = v.nameLine + (sub ? v.subGap + v.subLine : 0);
        const top = node.y + (node.h - contentH) / 2;
        const fallbackW = Math.max(0, node.w - v.padX * 2);
        const nameW = Math.max(0, node.maxNameW != null ? node.maxNameW : fallbackW);
        const subW = Math.max(0, node.maxSubW != null ? node.maxSubW : fallbackW);
        const textX = v.centered ? node.x + node.w / 2 : node.x + v.padX;
        const anchor = v.centered ? 'middle' : '';

        // 基线自己算，不用 dominant-baseline：部分 SVG 阅读器不认它，
        // 一旦被忽略文字就会整体错位。0.35em 是行内居中的常用近似。
        const baseline = (centerY, size) => centerY + size * 0.35;

        const label = fitText(node.label, nameW, v.nameSize, true, model.measure);
        const name = attrs(svgEl('text'), {
            x: textX,
            y: baseline(top + v.nameLine / 2, v.nameSize),
            fill: v.nameFg,
            'font-size': v.nameSize,
            'font-weight': v.nameWeight,
            'text-anchor': anchor
        });
        name.textContent = label;
        g.appendChild(name);

        if (sub) {
            const metaText = fitText(sub, subW, v.subSize, false, model.measure);
            const meta = attrs(svgEl('text'), {
                x: textX,
                y: baseline(top + v.nameLine + v.subGap + v.subLine / 2, v.subSize),
                fill: v.subFg,
                'font-size': v.subSize,
                'text-anchor': anchor
            });
            meta.textContent = metaText;
            g.appendChild(meta);
        }

        // 完整符号名放进 <title>：SVG 查看器里悬停可见，短名截断了也不丢信息。
        if (node.full && node.full !== node.label) {
            const title = svgEl('title');
            title.textContent = node.full;
            g.appendChild(title);
        }
        return g;
    }

    /**
     * 生成独立可用的 SVG 文本。
     * 需要 DOM：先把图挂进文档量一次 getBBox 才能得到含圆弧外凸的真实边界。
     */
    function toSvg(model) {
        // 不显式写 xmlns：XMLSerializer 会为 SVG 命名空间自动补声明，
        // 手写反而可能被序列化成重复属性。
        const svg = attrs(svgEl('svg'), { 'font-family': model.theme.font });
        const defs = svgEl('defs');
        defs.appendChild(arrowMarker('arrow', model.theme.edge));
        defs.appendChild(arrowMarker('arrow-anchor', model.theme.anchorEdge));
        svg.appendChild(defs);

        const bg = attrs(svgEl('rect'), { fill: model.theme.bg });
        svg.appendChild(bg);

        const content = svgEl('g');
        for (const frame of model.groups) {
            content.appendChild(attrs(svgEl('rect'), {
                x: frame.x,
                y: frame.y,
                width: frame.w,
                height: frame.h,
                rx: 8,
                ry: 8,
                fill: 'none',
                stroke: model.theme.frame,
                'stroke-width': 2,
                'stroke-dasharray': '6 4'
            }));
        }
        for (const edge of model.edges) {
            if (!edge.d) {
                continue;
            }
            content.appendChild(attrs(svgEl('path'), {
                d: edge.d,
                fill: 'none',
                stroke: edge.anchor ? model.theme.anchorEdge : model.theme.edge,
                'stroke-width': edge.live ? 1.5 : 1.2,
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
                'stroke-dasharray': edge.anchor ? '5 4' : '',
                'marker-end': edge.anchor ? 'url(#arrow-anchor)' : 'url(#arrow)'
            }));
        }
        for (const node of model.nodes) {
            content.appendChild(drawNode(model, node));
        }
        for (const count of model.siteCounts || []) {
            const g = attrs(svgEl('g'), { transform: `translate(${count.x} ${count.y})` });
            g.appendChild(attrs(svgEl('ellipse'), {
                cx: 0,
                cy: 0,
                rx: count.rx,
                ry: count.ry,
                fill: model.theme.sites,
                stroke: model.theme.sites,
                'stroke-width': 1.1
            }));
            const label = attrs(svgEl('text'), {
                x: 0,
                y: 9 * 0.35,
                fill: model.theme.sitesFg,
                'font-size': 9,
                'font-weight': 700,
                'text-anchor': 'middle'
            });
            label.textContent = count.text;
            g.appendChild(label);
            content.appendChild(g);
        }
        for (const node of model.nodes) {
            for (const badge of node.badges || []) {
                const g = svgEl('g');
                g.appendChild(attrs(svgEl('rect'), {
                    x: badge.x,
                    y: badge.y,
                    width: badge.w,
                    height: badge.h,
                    rx: badge.radius,
                    ry: badge.radius,
                    fill: badge.bg
                }));
                const label = attrs(svgEl('text'), {
                    x: badge.x + badge.w / 2,
                    y: badge.y + badge.h / 2 + 10 * 0.35,
                    fill: badge.fg,
                    'font-size': 10,
                    'font-weight': 700,
                    'text-anchor': 'middle'
                });
                label.textContent = badge.text;
                g.appendChild(label);
                content.appendChild(g);
            }
        }
        svg.appendChild(content);

        // 量真实边界：节点坐标算不出圆弧连线的外凸，getBBox 才准。
        svg.setAttribute('width', '10');
        svg.setAttribute('height', '10');
        svg.style.position = 'absolute';
        svg.style.left = '-99999px';
        svg.style.top = '0';
        document.body.appendChild(svg);
        let box;
        try {
            box = content.getBBox();
        } finally {
            document.body.removeChild(svg);
        }
        svg.removeAttribute('style');

        const width = Math.max(1, Math.ceil(box.width + PAD * 2));
        const height = Math.max(1, Math.ceil(box.height + PAD * 2));
        const minX = Math.floor(box.x - PAD);
        const minY = Math.floor(box.y - PAD);
        attrs(svg, {
            width,
            height,
            viewBox: `${minX} ${minY} ${width} ${height}`
        });
        attrs(bg, { x: minX, y: minY, width, height });

        const title = svgEl('title');
        title.textContent = model.title || 'Relation';
        svg.insertBefore(title, svg.firstChild);

        const xml = new XMLSerializer().serializeToString(svg);
        return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`;
    }

    /** SVG → PNG data URL。scale 用于导出高分辨率位图。 */
    function toPngDataUrl(svgText, scale) {
        return new Promise((resolve, reject) => {
            const ratio = Math.max(1, scale || 1);
            const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
            const img = new Image();
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round(img.width * ratio));
                    canvas.height = Math.max(1, Math.round(img.height * ratio));
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        reject(new Error('canvas 2d context unavailable'));
                        return;
                    }
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/png'));
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = () => reject(new Error('failed to rasterize svg'));
            img.src = url;
        });
    }

    // ===== 结构化文本 =====

    // Mermaid / DOT 只描述结构，「Show more」是纯交互占位、没有符号身份，带上只是噪音。
    function structuralNodes(model) {
        return model.nodes.filter(n => n.kind !== 'more');
    }

    function structuralEdges(model, ids) {
        return model.edges.filter(e => ids.has(e.from) && ids.has(e.to));
    }

    function shortIds(nodes) {
        const map = new Map();
        nodes.forEach((node, i) => map.set(node.id, 'n' + i));
        return map;
    }

    function mermaidText(value) {
        // Mermaid 的方括号标签里这些字符会破坏解析，用它的 #NN; 实体转义。
        return String(value || '')
            .replace(/#/g, '#35;')
            .replace(/"/g, '#quot;')
            .replace(/</g, '#lt;')
            .replace(/>/g, '#gt;')
            .replace(/\r?\n/g, ' ');
    }

    function toMermaid(model) {
        const nodes = structuralNodes(model);
        const ids = new Set(nodes.map(n => n.id));
        const ref = shortIds(nodes);
        const lines = [
            `%% ${model.title || 'Relation'}`,
            '%% Generated by Context Window',
            'flowchart LR'
        ];
        for (const node of nodes) {
            const label = node.sub
                ? `${mermaidText(node.label)}<br/><small>${mermaidText(node.sub)}</small>`
                : mermaidText(node.label);
            // 标签一律带引号：库分组名里可能有括号 / 空格，不引会破坏 Mermaid 解析。
            const shape = node.kind === 'group' ? ['[("', '")]'] : ['["', '"]'];
            lines.push(`    ${ref.get(node.id)}${shape[0]}${label}${shape[1]}`);
        }
        for (const edge of structuralEdges(model, ids)) {
            const arrow = edge.anchor ? '-.->' : '-->';
            const label = edge.sites > 1 ? `|${edge.sites}|` : '';
            lines.push(`    ${ref.get(edge.from)} ${arrow}${label} ${ref.get(edge.to)}`);
        }
        // 中心节点用 Mermaid 自己的 classDef 标出来，不依赖具体主题色。
        const root = nodes.find(n => n.isRoot);
        if (root) {
            lines.push('    classDef center stroke-width:2px,font-weight:bold');
            lines.push(`    class ${ref.get(root.id)} center`);
        }
        return lines.join('\n') + '\n';
    }

    function dotText(value) {
        return String(value || '')
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\r?\n/g, ' ');
    }

    function toDot(model) {
        const nodes = structuralNodes(model);
        const ids = new Set(nodes.map(n => n.id));
        const ref = shortIds(nodes);
        const lines = [
            `// ${model.title || 'Relation'}`,
            '// Generated by Context Window',
            'digraph relation {',
            '    rankdir=LR;',
            '    graph [bgcolor="transparent"];',
            `    node [shape=box, style="rounded", fontname="${dotText(model.theme.dotFont)}", fontsize=11, margin="0.14,0.07"];`,
            '    edge [arrowsize=0.7];'
        ];
        for (const node of nodes) {
            const label = node.sub
                ? `${dotText(node.label)}\\n${dotText(node.sub)}`
                : dotText(node.label);
            const opts = [`label="${label}"`];
            if (node.full && node.full !== node.label) {
                opts.push(`tooltip="${dotText(node.full)}"`);
            }
            if (node.isRoot) {
                opts.push('style="rounded,bold"', 'penwidth=2');
            } else if (node.kind === 'group') {
                opts.push('style="rounded,dashed"');
            }
            lines.push(`    ${ref.get(node.id)} [${opts.join(', ')}];`);
        }
        for (const edge of structuralEdges(model, ids)) {
            const opts = [];
            if (edge.anchor) {
                opts.push('style=dashed');
            }
            if (edge.sites > 1) {
                opts.push(`label="${edge.sites}"`, 'fontsize=9');
            }
            const tail = opts.length ? ` [${opts.join(', ')}]` : '';
            lines.push(`    ${ref.get(edge.from)} -> ${ref.get(edge.to)}${tail};`);
        }
        lines.push('}');
        return lines.join('\n') + '\n';
    }

    /** @type {any} */ (window).crGraphExport = { toSvg, toPngDataUrl, toMermaid, toDot };
}());
