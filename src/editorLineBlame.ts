import * as https from 'https';
import * as vscode from 'vscode';
import {
    LineBlameDiffLine,
    LineBlameHoverInfo,
    LineBlameInfo,
    blameLine,
    blameLineDiff,
    openBlameDiff
} from './lineBlame';

/**
 * 主编辑器当前行的 git blame 行尾注解，替代 GitLens 的同名能力。
 *
 * 数据全部来自 lineBlame.ts——和 Context Window 里那份行尾摘要同一个来源、
 * 同一套缓存，所以两边显示的文字必然一致，也不会各自打一遍 git。版式也照
 * media/lineBlame.js 那张卡片来。
 *
 * 但两者不可能长得一样，因为渲染的人不同：webview 那张卡片是我们自己的 DOM；
 * 这里交给编辑器的只有 MarkdownString。字号、按下变色不在这个口子里；样式也只剩
 * 标签一条路——VS Code 的 markdown 消毒器只在 <span> 上放行 style，且只认
 * color / background-color / border-radius，别的标签写了 style 一律抹掉。所以
 * 头像行的对齐与左右分布靠 supportHtml 下的 <table>，靠单元格默认的居中对齐。
 *
 * 拷贝例外。新版编辑器给每个 hover part 挂一颗 HoverCopyButton，默认透明，
 * 指针进入这一行才显示——CodeBuddy 的「add to Chat」旁那颗就是它，不是他们
 * 改了我们的 markdown。所以卡片拆成三条装饰、三个 part：作者和提交、增删、
 * Changes。指针在哪一行，哪一行的拷贝才出现。顺带，part 之间那两根分割条也
 * 由编辑器统一画，宽度天然一致，我们自己画不出等长的（见 buildHover）。
 */

const CONFIG_SECTION = 'contextView.editor';
const CONFIG_ENABLED = 'lineBlame';
const OPEN_CHANGES_COMMAND = 'contextView.editor.openLineBlameChanges';
const COPY_COMMAND = 'contextView.editor.copyLineBlame';

/**
 * 光标停下来多久才去问 git。按住方向键连续移动时，中间每一行都问一次纯属浪费，
 * 而 blame 是子进程调用。取值以「移动停止后几乎立刻出现」为准。
 */
const SETTLE_MS = 150;

interface OpenChangesArgs {
    uri: string;
    line: number;
    sha: string;
    previousSha: string;
    workingTree: boolean;
}

interface CopyArgs {
    text: string;
    notify: string;
}

/**
 * command: 链接的目标。参数里既有仓库路径（`C:\Program Files (x86)\...`）也有
 * 提交信息，encodeURIComponent 偏偏放过圆括号，所以自己再补上这两个字符——
 * 目标最终落在 data-href 属性里，多编码一层无碍，省得日后挪回 `[x](y)` 时
 * 又被一个裸的 `)` 把链接截断。
 */
function commandLink(command: string, args: unknown): string {
    const payload = encodeURIComponent(JSON.stringify([args]))
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
    return `command:${command}?${payload}`;
}

function isEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(CONFIG_ENABLED, true);
}

/**
 * 提交信息里的 markdown 元字符必须转义后再进浮窗。浮窗为了放 command: 链接
 * 必须 isTrusted、为了放图标必须 supportThemeIcons、为了给芯片上色必须
 * supportHtml，而提交信息是仓库里的任意文本；不转义就等于把它当模板执行。
 * 转义 ( ) 让正文里的 $(x) 失效，转义 < > 让它写不出标签。
 */
function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>~$]/g, ch => `\\${ch}`);
}

/**
 * 把 webview 的 color-mix(in srgb, fg N%, transparent) 算成不透明色。
 * 浮窗的 <span style> 只认写死的十六进制，透明底会变成发灰的脏色。
 */
function mixOn(fg: string, amount: number, bg: string): string {
    const parse = (hex: string): [number, number, number] => {
        const n = parseInt(hex.slice(1), 16);
        return [n >> 16, (n >> 8) & 255, n & 255];
    };
    const [fr, fgC, fb] = parse(fg);
    const [br, bgC, bb] = parse(bg);
    const mix = (a: number, b: number) => Math.round(a * amount + b * (1 - amount));
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${hex(mix(fr, br))}${hex(mix(fgC, bgC))}${hex(mix(fb, bb))}`;
}

/**
 * 芯片和工作区颜色照 media/main.css 的 .cw-line-blame-hover-sha。
 * 底色是 color-mix 16%/22% 叠在浮窗底上，这里预先混好。
 */
interface Palette {
    commit: string;
    commitBackground: string;
    parent: string;
    parentBackground: string;
    muted: string;
    icon: string;
    hoverBackground: string;
}

function palette(): Palette {
    const kind = vscode.window.activeColorTheme?.kind;
    const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    if (dark) {
        const hoverBackground = '#252526';
        return {
            commit: '#3fb950',
            commitBackground: mixOn('#3fb950', 0.22, hoverBackground),
            parent: '#9d9d9d',
            parentBackground: mixOn('#9d9d9d', 0.18, hoverBackground),
            muted: '#9d9d9d',
            icon: '#c5c5c5',
            hoverBackground
        };
    }
    const hoverBackground = '#ffffff';
    return {
        commit: '#16825d',
        commitBackground: mixOn('#16825d', 0.16, hoverBackground),
        parent: '#6a6a6a',
        parentBackground: mixOn('#6a6a6a', 0.18, hoverBackground),
        muted: '#6a6a6a',
        icon: '#616161',
        hoverBackground
    };
}

function tint(color: string, markdown: string): string {
    return `<span style="color:${color};">${markdown}</span>`;
}

/**
 * 内联 SVG。写成 <img> 而不是 `![](...)`：这些图标要出现在脚注那张表格里，
 * 而 markdown 的 HTML 块是原样输出的，图片语法在里面不会被解析。标签在两种
 * 上下文里都成立。尺寸照 SVG 自己的 width/height 写，渲染结果和原来一致。
 */
function svgImage(svg: string, width: number, height: number): string {
    return htmlImg(`data:image/svg+xml,${encodeURIComponent(svg)}`, width, height);
}

/** 插件芯片左侧那个旋转过的 git 节点，12×12。图形下移 2px，跟旁边的 SHA 对齐。 */
function gitNodeImage(color: string): string {
    return svgImage(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12">`
        + `<g transform="translate(0 2.7)">`
        + `<path fill="${color}" transform="rotate(90 8 8)" d="M11.5 8C11.5 6.24 10.194 4.779 8.5 4.536V1.5C8.5 1.224 8.276 1 8 1C7.724 1 7.5 1.224 7.5 1.5V4.536C5.806 4.779 4.5 6.24 4.5 8C4.5 9.76 5.806 11.221 7.5 11.464V14.5C7.5 14.776 7.724 15 8 15C8.276 15 8.5 14.776 8.5 14.5V11.464C10.194 11.221 11.5 9.76 11.5 8ZM8 10.5C6.621 10.5 5.5 9.378 5.5 8C5.5 6.622 6.621 5.5 8 5.5C9.379 5.5 10.5 6.622 10.5 8C10.5 9.378 9.379 10.5 8 10.5Z"/>`
        + `</g></svg>`,
        12,
        12
    );
}

/** 插件 Open Changes 按钮里的 16×16 图标，浮窗只显示这个，不带文字。同样下移 2px。 */
function openChangesImage(color: string): string {
    return svgImage(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">`
        + `<g transform="translate(0 2)">`
        + `<path fill="${color}" d="M9.14645 5.85355C9.34171 6.04882 9.65829 6.04882 9.85355 5.85355C10.0488 5.65829 10.0488 5.34171 9.85355 5.14645L8.70711 4H10.5C11.3284 4 12 4.67157 12 5.5V10.05C10.8589 10.2816 10 11.2905 10 12.5C10 13.8807 11.1193 15 12.5 15C13.8807 15 15 13.8807 15 12.5C15 11.2905 14.1411 10.2816 13 10.05V5.5C13 4.11929 11.8807 3 10.5 3H8.70711L9.85355 1.85355C10.0488 1.65829 10.0488 1.34171 9.85355 1.14645C9.65829 0.951184 9.34171 0.951184 9.14645 1.14645L7.14645 3.14645C6.95118 3.34171 6.95118 3.65829 7.14645 3.85355L9.14645 5.85355ZM14 12.5C14 13.3284 13.3284 14 12.5 14C11.6716 14 11 13.3284 11 12.5C11 11.6716 11.6716 11 12.5 11C13.3284 11 14 11.6716 14 12.5ZM6 3.5C6 4.70948 5.14112 5.71836 4 5.94999V10.5C4 11.3284 4.67157 12 5.5 12H7.29289L6.14645 10.8536C5.95118 10.6583 5.95118 10.3417 6.14645 10.1464C6.34171 9.95118 6.65829 9.95118 6.85355 10.1464L8.85355 12.1464C9.04882 12.3417 9.04882 12.6583 8.85355 12.8536L6.85355 14.8536C6.65829 15.0488 6.34171 15.0488 6.14645 14.8536C5.95118 14.6583 5.95118 14.3417 6.14645 14.1464L7.29289 13H5.5C4.11929 13 3 11.8807 3 10.5V5.94999C1.85888 5.71836 1 4.70948 1 3.5C1 2.11929 2.11929 1 3.5 1C4.88071 1 6 2.11929 6 3.5ZM5 3.5C5 2.67157 4.32843 2 3.5 2C2.67157 2 2 2.67157 2 3.5C2 4.32843 2.67157 5 3.5 5C4.32843 5 5 4.32843 5 3.5Z"/>`
        + `</g></svg>`,
        16,
        16
    );
}

/**
 * webview 里的 SHA 芯片：git 节点 + 短 SHA，连图标一起有底色，点了拷贝完整 SHA。
 * 颜色按 .cw-line-blame-hover-sha / -current 预先混好。
 */
function shaChip(shortSha: string, fullSha: string, parent = false): string {
    const colors = palette();
    const fg = parent ? colors.parent : colors.commit;
    const bg = parent ? colors.parentBackground : colors.commitBackground;
    const label = shortSha.replace(/[`<>]/g, '');
    const chip = [
        `<span style="color:${fg};background-color:${bg};">`,
        `&nbsp;${gitNodeImage(fg)} ${label}&nbsp;`,
        '</span>'
    ].join('');
    const args: CopyArgs = { text: fullSha || shortSha, notify: 'SHA copied' };
    return htmlLink(commandLink(COPY_COMMAND, args), 'Copy SHA', chip);
}

/**
 * 保留 Gravatar 的 d=404：没登记头像时让它直接 404，我们才好换成首字母牌子，
 * 和 media/lineBlame.js 一样。换成 d=mp 只会拿到一张所有人都一样的灰人像。
 */
function avatarSrc(hover: LineBlameHoverInfo): string | undefined {
    const url = hover.avatarUrl;
    if (!url) {
        return undefined;
    }
    const retina = url.replace(/([?&])s=\d+\b/, '$1s=64');
    return /[?&]s=\d+/.test(retina)
        ? retina
        : `${retina}${retina.includes('?') ? '&' : '?'}s=64`;
}

function whenText(hover: LineBlameHoverInfo): string {
    return hover.ago && hover.date
        ? `${hover.ago} (${hover.date})`
        : hover.ago || hover.date || '';
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlImg(src: string, width: number, height: number): string {
    return `<img src="${escapeHtml(src)}" width="${width}" height="${height}" alt="">`;
}

/**
 * 可点的链接，写成标签而不是 `[x](y)`。
 *
 * 脚注那一整块要包进 <table>（见 buildHover），而 markdown 的 HTML 块是原样
 * 输出的——里面的 `[x](y)` 不会再被解析成链接，芯片就成了死字符。所以链接自己
 * 也得是标签。
 *
 * 用 data-href 而不是 href：浮窗的点击处理是 `target.closest('a[data-href]')`
 * 再读 dataset.href，markdown 渲染出来的链接也是这个形状，所以这样写和原来
 * 完全同一条路径。data-href 同样在消毒器的属性白名单里。
 */
function htmlLink(href: string, title: string, inner: string): string {
    return `<a data-href="${escapeHtml(href)}" title="${escapeHtml(title)}">${inner}</a>`;
}

/**
 * 头像。webview 那边自己 fetch，失败就退回首字母牌子（media/lineBlame.js 的
 * makeAvatar）；浮窗里我们只能交出一段 markdown，<img> 加载成没成功看不见，
 * 所以把顺序倒过来：在扩展宿主先把图取回来内联成 data URI，取不到——作者没登记
 * Gravatar（404）、断网、被代理挡住——就直接画同一套首字母牌子，不留一个空洞。
 */
const AVATAR_PX = 28;
const AVATAR_MAX_BYTES = 512 * 1024;
const AVATAR_TIMEOUT_MS = 5000;
/** 拉失败不是永久结论：作者以后可能补登记头像，隔一段时间再试一次。 */
const AVATAR_RETRY_MS = 10 * 60 * 1000;

/** src 为 null 表示这一轮没拉到；at 用来隔一阵子再试。 */
type AvatarEntry = { src: string | null; at: number };

/** 整个会话共用：光标在同一提交的相邻行之间移动时不会重复走网络。 */
const avatarCache = new Map<string, AvatarEntry>();
const avatarInflight = new Map<string, Promise<string | null>>();

function cachedAvatar(url: string): string | undefined {
    return avatarCache.get(url)?.src || undefined;
}

function shouldFetchAvatar(url: string): boolean {
    const hit = avatarCache.get(url);
    if (!hit) {
        return true;
    }
    return hit.src ? false : Date.now() - hit.at >= AVATAR_RETRY_MS;
}

function fetchAvatar(url: string, redirects = 2): Promise<string | null> {
    return new Promise(resolve => {
        let settled = false;
        const done = (value: string | null) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };
        if (!/^https:/i.test(url)) {
            done(null);
            return;
        }
        try {
            const req = https.get(
                url,
                {
                    headers: { 'user-agent': 'vscode-context-window', accept: 'image/*' },
                    timeout: AVATAR_TIMEOUT_MS
                },
                res => {
                    const status = res.statusCode || 0;
                    const location = res.headers.location;
                    if (status >= 300 && status < 400 && location && redirects > 0) {
                        res.resume();
                        fetchAvatar(new URL(location, url).toString(), redirects - 1).then(done, () => done(null));
                        return;
                    }
                    const type = String(res.headers['content-type'] || '').split(';')[0].trim();
                    if (status !== 200 || !/^image\//i.test(type)) {
                        res.resume();
                        done(null);
                        return;
                    }
                    const chunks: Buffer[] = [];
                    let size = 0;
                    res.on('data', (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > AVATAR_MAX_BYTES) {
                            res.destroy();
                            done(null);
                            return;
                        }
                        chunks.push(chunk);
                    });
                    res.on('end', () => done(`data:${type};base64,${Buffer.concat(chunks).toString('base64')}`));
                    res.on('error', () => done(null));
                }
            );
            req.on('timeout', () => {
                req.destroy();
                done(null);
            });
            req.on('error', () => done(null));
        } catch {
            done(null);
        }
    });
}

function loadAvatar(url: string): Promise<string | null> {
    const pending = avatarInflight.get(url);
    if (pending) {
        return pending;
    }
    const job = fetchAvatar(url).then(src => {
        avatarCache.set(url, { src, at: Date.now() });
        avatarInflight.delete(url);
        return src;
    }, () => {
        avatarCache.set(url, { src: null, at: Date.now() });
        avatarInflight.delete(url);
        return null;
    });
    avatarInflight.set(url, job);
    return job;
}

function avatarLetter(name: string): string {
    const s = String(name || '').trim();
    return s ? [...s][0].toUpperCase() : '?';
}

// 与 media/lineBlame.js 同一张色表：按首字母分段（A–C / D–F / …），白字保证对比度。
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

function avatarColor(name: string): string {
    const letter = avatarLetter(name);
    const code = letter.charCodeAt(0);
    const idx = code >= 65 && code <= 90
        ? Math.min(AVATAR_COLORS.length - 1, Math.floor((code - 65) * AVATAR_COLORS.length / 26))
        : (letter.codePointAt(0) || 0) % AVATAR_COLORS.length;
    return AVATAR_COLORS[idx];
}

/** 首字母牌子。圆角、字号、配色照 .cw-line-blame-hover-avatar-letter。 */
function letterAvatarUri(name: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_PX}" height="${AVATAR_PX}" viewBox="0 0 28 28">`
        + `<rect width="28" height="28" rx="6" ry="6" fill="${avatarColor(name)}"/>`
        + `<text x="14" y="14" fill="#ffffff" font-family="sans-serif" font-size="14" font-weight="600"`
        + ` text-anchor="middle" dominant-baseline="central">${escapeHtml(avatarLetter(name))}</text>`
        + `</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function avatarImage(hover: LineBlameHoverInfo): string {
    const url = avatarSrc(hover);
    const src = (url && cachedAvatar(url)) || letterAvatarUri(hover.authorName || hover.author || '');
    return htmlImg(src, AVATAR_PX, AVATAR_PX);
}

/** 1×1 透明 PNG。浮窗里的 <img width> 会按属性拉伸，不依赖 SVG 固有尺寸。 */
const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function spacer(width: number, height = 1): string {
    return htmlImg(PIXEL_PNG, Math.max(1, Math.round(width)), height);
}

/**
 * 时钟图标，和旁边的时间文字对齐。
 *
 * 行内图片是坐在基线上的，它所在的行框下面还挂着字体的下沿空间，所以图片盒的
 * 中线比行框中线高出半个下沿——图标看着就比文字高一点。跟 gitNodeImage、
 * openChangesImage 一个路子：把图形画到一个更高的盒子的下半部，图形中线就正好
 * 落回行框中线。盒子高 CLOCK_BOX_PX、图形高 CLOCK_PX，差出来的就是那半个下沿。
 */
const CLOCK_PX = 14;
const CLOCK_BOX_PX = 18;
/** 视野框跟着等比拉高，避免非等比缩放把圆压扁。 */
const CLOCK_VIEW_H = (16 * CLOCK_BOX_PX) / CLOCK_PX;

function clockImage(color: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 ${CLOCK_VIEW_H.toFixed(2)}"`
        + ` width="${CLOCK_PX}" height="${CLOCK_BOX_PX}">`
        + `<g transform="translate(0 ${(CLOCK_VIEW_H - 16).toFixed(2)})">`
        + `<path fill="${color}" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.25a5.75 5.75 0 1 1 0 11.5 5.75 5.75 0 0 1 0-11.5zM8.5 4v4.05l2.6 1.5-.5.87L7.5 8.55V4h1z"/>`
        + `</g></svg>`;
    return htmlImg(`data:image/svg+xml,${encodeURIComponent(svg)}`, CLOCK_PX, CLOCK_BOX_PX);
}

/**
 * 卡片宽度区间，跟插件 .cw-line-blame-hover 一样：520–720。
 *
 * 官方浮窗没有 CSS 口子，两头都得自己想办法。下限靠头像那行里塞一张定宽透明图
 * 撑出来；上限只能靠预先折行——编辑器给浮窗的 max-width 是
 * `max(编辑器宽 * 0.66, 750)`，屏幕一宽就是一千多像素，而一段中文正文可以一直
 * 摊到那里才折。所以正文和增删都按下面这个预算自己断行，让内容根本够不到
 * 编辑器那个上限，卡片自然就停在 720。
 */
const HOVER_MIN_PX = 520;
const HOVER_MAX_PX = 720;

/** 正文可用宽度：内容区左右内边距各 8px，右侧再留 20px 给拷贝按钮。 */
const CONTENT_PAD_PX = 36;
/** 代码块自己还有一圈内边距。 */
const CODE_PAD_PX = 56;

const MONO_PX = 8.4;
const TEXT_PX = 7.2;

/**
 * 中日韩文字和全角标点占两个西文字身位。不把它们算成两倍，一行中文的实际宽度
 * 就是估算的两倍，折行等于没做——截图里那张铺满屏幕的卡片就是这么来的。
 */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function charPx(ch: string, unit: number): number {
    return WIDE_CHAR.test(ch) ? unit * 2 : unit;
}

function textPx(text: string, unit: number): number {
    let px = 0;
    for (const ch of text) {
        px += charPx(ch, unit);
    }
    return px;
}

type Token = { text: string; space: boolean; px: number };

/** 西文词和网址整块不拆，中文逐字可断，空白单独成块——就是折行的最小单位。 */
function tokenize(text: string): Token[] {
    const out: Token[] = [];
    let word = '';
    const flush = () => {
        if (word) {
            out.push({ text: word, space: false, px: textPx(word, TEXT_PX) });
            word = '';
        }
    };
    for (const ch of text) {
        if (/\s/.test(ch)) {
            flush();
            out.push({ text: ch, space: true, px: TEXT_PX });
        } else if (WIDE_CHAR.test(ch)) {
            flush();
            out.push({ text: ch, space: false, px: TEXT_PX * 2 });
        } else {
            word += ch;
        }
    }
    flush();
    return out;
}

/**
 * 按像素预算折行。一个词本身就超预算时（长网址）让它自己占一行，宁可越界也不
 * 切断：切开的网址不再会被识别成可点的链接。
 */
function wrapText(text: string, budget: number): string[] {
    const lines: string[] = [];
    let line = '';
    let px = 0;
    for (const token of tokenize(text)) {
        if (line && px + token.px > budget) {
            lines.push(line);
            line = token.space ? '' : token.text;
            px = token.space ? 0 : token.px;
            continue;
        }
        if (token.space && !line) {
            // 折到新行以后，行首那个空格没有意义
            continue;
        }
        line += token.text;
        px += token.px;
    }
    if (line) {
        lines.push(line);
    }
    return lines.map(l => l.replace(/\s+$/, '')).filter(l => l.length > 0);
}

/**
 * 头像行里那张透明图的宽度：把卡片撑到下限。名字和时间按估算宽度扣掉，估不准
 * 也只影响下限那点余量——时间贴不贴右边由单元格的 align 决定，与这里无关。
 */
function headerGapPx(hover: LineBlameHoverInfo): number {
    const who = hover.author || hover.authorName || 'Someone';
    const when = whenText(hover);
    const left = 28 + 10 + textPx(who, 8.5);
    const right = when ? 20 + textPx(when, 6.6) : 0;
    return Math.max(24, HOVER_MIN_PX - Math.round(left + right));
}

/**
 * 让一段文字不折行。名字那格 width="100%" 会把其余格子压到各自的最小折行宽度，
 * 时间就被挤成了一列竖排。`nowrap` 不在消毒器的属性白名单里，style 又只在
 * <span> 上认那三条颜色属性，所以只能从文本下手：空格换成不换行空格，这一格的
 * 最小宽度就等于整串的宽度，表格自然会把它留成一行。
 */
function noWrap(text: string): string {
    return text.replace(/ /g, '&nbsp;');
}

/**
 * 头像和名字这一行。行内图片是按基线摆的——图的下沿落在文字基线上，所以 28px 的
 * 头像整个悬在文字上方，和 webview 里 `align-items: center` 的那一行对不上。
 * 浮窗又没有 CSS 口子：VS Code 的 markdown 消毒器只在 <span> 上放行 style，
 * 且只认 color / background-color / border-radius，vertical-align 会被直接抹掉。
 *
 * 所以改用单行表格。单元格默认就是 vertical-align: middle，头像、名字、时钟、
 * 时间各占一格，天然按中线对齐，等价于 webview 那套 flex。左右分布同理：表格
 * width="100%" 跟着卡片实际宽度走，名字那格吃掉多余的空间，右边两格被顶到
 * 右端——正文长短决定卡片多宽，时间都在右端，不再依赖估算。width 和 align 是
 * 消毒器白名单里的属性，style 才是被拦的那个。
 *
 * 时钟和时间必须是两格，不能塞进同一格：同一格里图片和文字之间存在断行机会，
 * 被压到最小宽度时就会从那里断开，图标独占一行。而同一行的单元格永远并排，
 * 不可能上下分开。
 */
function appendHeader(md: vscode.MarkdownString, hover: LineBlameHoverInfo): void {
    const who = escapeHtml(hover.author || hover.authorName || 'Someone');
    const when = escapeHtml(whenText(hover));
    const colors = palette();
    // 撑下限的透明图跟着名字走：它只是把这一格的最小宽度垫起来。
    // 名字不锁行：它那格 width="100%" 会先分到所有余量，只有整行实在放不下时
    // 才会折——那时候让长名字折，好过把卡片撑破。
    const cells = [
        `<td>${avatarImage(hover)}</td>`,
        `<td width="100%">&nbsp;<strong>${who}</strong>${spacer(headerGapPx(hover))}</td>`
    ];
    if (when) {
        cells.push(`<td>${clockImage(colors.muted)}</td>`);
        cells.push(
            `<td align="right"><span style="color:${colors.muted};">`
            + `&nbsp;${noWrap(when)}</span></td>`
        );
    }
    // 整张表写在一行里：markdown 的 HTML 块要到空行才结束，中途换行会把后面的
    // 提交信息一起吞进原样 HTML。
    md.appendMarkdown(`<table width="100%"><tr>${cells.join('')}</tr></table>\n\n`);
}

/** 一段正文。作者自己的换行保留，太长的行按预算再折。 */
function appendParagraph(md: vscode.MarkdownString, sourceLines: readonly string[]): void {
    const budget = HOVER_MAX_PX - CONTENT_PAD_PX;
    const out: string[] = [];
    for (const source of sourceLines) {
        const wrapped = wrapText(source, budget);
        if (wrapped.length) {
            out.push(...wrapped.map(escapeMarkdown));
        } else {
            // 作者留的空行，照原样留着
            out.push('');
        }
    }
    while (out.length && !out[out.length - 1]) {
        out.pop();
    }
    if (out.length) {
        md.appendMarkdown(`${out.join('  \n')}\n\n`);
    }
}

/** 首行是标题、其余是正文，和 webview 的 summary / body 一致。 */
function appendMessage(md: vscode.MarkdownString, message: string): void {
    const lines = message.split(/\r?\n/).map(line => line.trim());
    while (lines.length && !lines[lines.length - 1]) {
        lines.pop();
    }
    if (!lines.length) {
        return;
    }
    const body = lines.slice(1);
    while (body.length && !body[0]) {
        body.shift();
    }
    if (lines[0]) {
        appendParagraph(md, [lines[0]]);
    }
    if (body.some(line => line)) {
        appendParagraph(md, body);
    }
}

/**
 * 当前行的增删。webview 用逐字符 affix 高亮，浮窗里只有语言着色可用，
 * 所以走 diff 代码块——增删的绿红由 VS Code 的 diff 语法着色给出。
 * 围栏用四个反引号，源码行里出现 ``` 也不会把块提前闭合。
 */
function diffBlock(diff: readonly LineBlameDiffLine[]): string {
    // 代码块不会自己折行，超出的部分只会把卡片撑宽，所以在这里按同一个预算断开。
    const budget = HOVER_MAX_PX - CODE_PAD_PX;
    const rows: string[] = [];
    for (const line of diff) {
        const mark = line.kind === 'del' ? '-' : line.kind === 'add' ? '+' : ' ';
        // 和 webview 一样去掉行首缩进：浮窗窄，缩进只会把内容挤出视野。
        const text = String(line.text || '').replace(/^[ \t]+/, '');
        // 续行用两格空白顶头，和首行的 `+ ` / `- ` 对齐。
        let row = `${mark} `;
        let px = MONO_PX * 2;
        let taken = 0;
        for (const ch of text) {
            const w = charPx(ch, MONO_PX);
            if (taken && px + w > budget) {
                rows.push(row);
                row = '  ';
                px = MONO_PX * 2;
                taken = 0;
            }
            row += ch;
            px += w;
            taken++;
        }
        rows.push(row);
    }
    return `\`\`\`\`diff\n${rows.join('\n')}\n\`\`\`\``;
}

/** 逐字照搬 media/lineBlame.js 的 Changes 脚注措辞，两边不该有出入。 */
function changesLine(hover: LineBlameHoverInfo): string {
    // webview 的脚注文字比正文淡一档，芯片才是亮的。
    const label = (text: string) => tint(palette().muted, text);
    if (hover.workingTree) {
        const left = hover.previousShortSha || '';
        const sameRef = !!(hover.previousSha && hover.sha && hover.previousSha === hover.sha);
        const right = (!sameRef && hover.shortSha)
            ? shaChip(hover.shortSha, hover.sha)
            : label('Working Tree');
        return left
            ? `${label('Changes')} ${shaChip(left, hover.previousSha || left, true)} ${label('↔')} ${right}`
            : `${label('Changes')} ${right}`;
    }
    if (hover.previousShortSha && hover.shortSha) {
        const previous = shaChip(hover.previousShortSha, hover.previousSha || hover.previousShortSha, true);
        return `${label('Changes')} ${previous} ${label('↔')} ${shaChip(hover.shortSha, hover.sha)}`;
    }
    if (hover.shortSha) {
        // 首提交没有 parent：GitLens 仍固定写 Changes added in <sha>。
        return `${label('Changes added in')} ${shaChip(hover.shortSha, hover.sha)}`;
    }
    return label('Uncommitted changes');
}

function section(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    // isTrusted 同时是脚注 command: 链接和 <span style> 上色的前提；
    // 所有取自仓库的文本都已转义。
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.supportHtml = true;
    return md;
}

interface HoverParts {
    tips: vscode.MarkdownString;
    diff?: vscode.MarkdownString;
    foot?: vscode.MarkdownString;
}

/**
 * 三个 hover part：作者和提交 / 增删 / Changes。两根分割条都由编辑器在相邻
 * part 之间画，我们一根都不自己画。
 *
 * 自己画不出等长的线。手写的 `---` 落在 .hover-contents 里，它自带的
 * margin:-8px 只够抵消内容区那 8px 内边距；而带拷贝按钮的行（.hover-row-with-copy）
 * 右侧还留了 20px 给按钮，线就比上面那根短 20px。想补回来得改外边距，可
 * VS Code 的消毒器只在 <span> 上放行 style，hr 上写什么都会被抹掉。
 * 交给编辑器画则天然一致：那两根线是同一条 .hover-row 顶边框。
 *
 * 代价是拷贝按钮从两颗变三颗，增删和 Changes 各拷各的，不再像 webview 那样
 * 一起拷。
 */
function buildHover(
    info: LineBlameInfo,
    diff: readonly LineBlameDiffLine[],
    uriString: string,
    line1Based: number
): HoverParts {
    const hover = info.hover;
    const tips = section();
    appendHeader(tips, hover);
    appendMessage(tips, hover.summary || '');
    if (hover.shortSha && !hover.workingTree) {
        tips.appendMarkdown(shaChip(hover.shortSha, hover.sha));
    }

    const parts: HoverParts = { tips };
    if (diff.length) {
        const code = section();
        code.appendMarkdown(diffBlock(diff));
        parts.diff = code;
    }

    const foot = section();
    let changes = changesLine(hover);
    if (hover.sha || hover.workingTree) {
        const args: OpenChangesArgs = {
            uri: uriString,
            line: line1Based,
            sha: hover.sha,
            previousSha: hover.previousSha || '',
            workingTree: !!hover.workingTree
        };
        changes += ' &nbsp;' + htmlLink(
            commandLink(OPEN_CHANGES_COMMAND, args),
            'Open Changes',
            openChangesImage(palette().icon)
        );
    }
    // 和头像那行一样包一层表格，卡片上下留白才对称：浮窗只给内容区 4px 内边距，
    // 表格自己还带 2px 的 border-spacing 和 1px 的单元格内边距。顶上是表格、
    // 底下是段落的话，底边就少那 3px。这 3px 没法单独补——p:last-child 的
    // margin-bottom 被浮窗清零了，而给它加个兄弟节点又会一次多出 8px。
    // 两头用同一种结构，多少像素都对得上，不必写死。
    foot.appendMarkdown(`<table><tr><td>${changes}</td></tr></table>`);
    parts.foot = foot;
    return parts;
}

/**
 * 该行有未保存的改动时的注解。此时不能用 git 的答案：blame 按磁盘算行号，
 * 编辑器里插入或删除过行，行号就已经对不上了。但「这一行和磁盘不一样，而且
 * 文档是脏的」本身就足以断定它是当前用户尚未提交的改动，不必再问 git。
 */
function unsavedHover(): HoverParts {
    const tips = section();
    tips.appendMarkdown('$(account) **You**&nbsp; &nbsp; &nbsp;Uncommitted changes\n\n');
    tips.appendMarkdown(tint(
        palette().muted,
        'This line differs from the file on disk. Save it to see who last changed the surrounding code.'
    ));
    return { tips };
}

function wipe(editor: vscode.TextEditor, ...types: vscode.TextEditorDecorationType[]): void {
    for (const type of types) {
        try {
            editor.setDecorations(type, []);
        } catch {
            // 编辑器已经关掉了，装饰随之消失。
        }
    }
}

export function registerEditorLineBlame(context: vscode.ExtensionContext): void {
    const annotation = vscode.window.createTextEditorDecorationType({
        after: {
            // 与 Context Window 里那条注解同样的留白和颜色（main.css 的 .cw-line-blame）。
            margin: '0 0 0 6ch',
            color: new vscode.ThemeColor('contextView.lineBlameForeground')
        }
    });
    // 后两条不画字，只各贡献一个 hover part：增删、Changes。
    // 顺序就是这里创建、下面 setDecorations 的顺序，浮窗里的先后与之一致。
    const diffHover = vscode.window.createTextEditorDecorationType({});
    const footHover = vscode.window.createTextEditorDecorationType({});

    /** 当前画着注解的编辑器和行，用来判断某次事件是否让它失效。 */
    let decorated: { editor: vscode.TextEditor; line: number } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** blame 是异步的；光标可能已经走了。只认最后一次请求的结果。 */
    let generation = 0;

    const clear = () => {
        generation++;
        const previous = decorated;
        decorated = undefined;
        if (!previous) {
            return;
        }
        wipe(previous.editor, annotation, diffHover, footHover);
    };

    const apply = (
        editor: vscode.TextEditor,
        line0Based: number,
        text: string,
        hover: HoverParts
    ) => {
        if (decorated && decorated.editor !== editor) {
            wipe(decorated.editor, annotation, diffHover, footHover);
        }
        const end = editor.document.lineAt(line0Based).range.end;
        const range = new vscode.Range(end, end);
        editor.setDecorations(annotation, [{
            range,
            hoverMessage: hover.tips,
            renderOptions: { after: { contentText: text } }
        }]);
        editor.setDecorations(diffHover, hover.diff
            ? [{ range, hoverMessage: hover.diff }]
            : []);
        editor.setDecorations(footHover, hover.foot
            ? [{ range, hoverMessage: hover.foot }]
            : []);
        decorated = { editor, line: line0Based };
    };

    const refresh = async () => {
        if (!isEnabled()) {
            clear();
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            clear();
            return;
        }
        const doc = editor.document;
        // blame 只对磁盘上的文件有意义。diff 的左侧、untitled、各种虚拟文档都跳过。
        if (doc.uri.scheme !== 'file') {
            clear();
            return;
        }
        const selection = editor.selection;
        // 跨行选择时行尾注解只是噪音，且「当前行」已经没有单一含义。
        if (selection.start.line !== selection.end.line) {
            clear();
            return;
        }
        const line0 = selection.active.line;
        if (line0 >= doc.lineCount) {
            clear();
            return;
        }

        const mine = ++generation;
        const uriString = doc.uri.toString();
        // 期间光标移动、切了编辑器、开关被关掉，或文档被删短到这一行已不存在
        // （lineAt 会抛），这次结果就作废。
        const stillMine = () => mine === generation
            && vscode.window.activeTextEditor === editor
            && editor.selection.active.line === line0
            && line0 < doc.lineCount
            && isEnabled();

        let info: LineBlameInfo | undefined;
        try {
            info = await blameLine(uriString, line0 + 1);
        } catch {
            info = undefined;
        }
        if (!stillMine()) {
            return;
        }

        const stale = info?.content !== undefined && info.content !== doc.lineAt(line0).text;
        if (stale) {
            if (doc.isDirty) {
                apply(editor, line0, 'You, Uncommitted changes', unsavedHover());
            } else {
                // 文档是干净的却对不上磁盘，说明磁盘刚被外部改过（checkout 之类），
                // 手上这份已经过期。宁可不显示，等下一次刷新。
                clear();
            }
            return;
        }
        if (!info?.text) {
            clear();
            return;
        }

        // 行尾文字先画出来，不等增删。webview 是浮窗打开后才拉 diff，而
        // hoverMessage 是静态的、只能预先备好，所以这里拿两步走近似那个效果：
        // 注解立刻可见，浮窗随后升级成带 diff 的完整版本。中间这一小段时间里
        // 划过去只是少一块 diff，不会看到空浮窗。
        const blame = info;
        let shownDiff: readonly LineBlameDiffLine[] = [];
        const draw = () => apply(
            editor,
            line0,
            blame.text,
            buildHover(blame, shownDiff, uriString, line0 + 1)
        );
        draw();

        // 头像同理：先用首字母牌子，图取回来了再重画一次。取不到就一直是牌子。
        const avatarUrl = avatarSrc(blame.hover);
        if (avatarUrl && shouldFetchAvatar(avatarUrl)) {
            void loadAvatar(avatarUrl).then(src => {
                if (src && stillMine()) {
                    draw();
                }
            });
        }

        let diff: readonly LineBlameDiffLine[] | undefined;
        try {
            // 同一提交的相邻行命中 fileDiffCache，不会每行都真去打 git diff。
            diff = await blameLineDiff(uriString, line0 + 1);
        } catch {
            diff = undefined;
        }
        if (!diff?.length || !stillMine()) {
            return;
        }
        shownDiff = diff;
        draw();
    };

    const schedule = () => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = undefined;
            void refresh();
        }, SETTLE_MS);
    };

    context.subscriptions.push(
        // SHA 芯片的点击拷贝。分区拷贝走编辑器自己的 HoverCopyButton，不经过这里。
        vscode.commands.registerCommand(COPY_COMMAND, async (args?: CopyArgs) => {
            if (!args?.text) {
                return;
            }
            await vscode.env.clipboard.writeText(args.text);
            if (args.notify) {
                vscode.window.setStatusBarMessage(args.notify, 2000);
            }
        }),
        vscode.commands.registerCommand(OPEN_CHANGES_COMMAND, async (args?: OpenChangesArgs) => {
            if (!args?.uri || (!args.sha && !args.workingTree)) {
                return;
            }
            try {
                await openBlameDiff(args.uri, args.previousSha || '', args.sha, {
                    workingTree: args.workingTree,
                    line: args.line
                });
            } catch (err) {
                console.error('[context-window] open line blame changes failed:', err);
                vscode.window.showErrorMessage('Failed to open git changes');
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (e.textEditor !== vscode.window.activeTextEditor) {
                return;
            }
            // 光标换行、或者选区拉成了跨行，画着的那条就不再属于当前行了。等
            // blame 回来再换会留下一段旧行仍带注解的时间，所以先清掉，宁可空一下。
            // 同一行内移动不动它，免得敲着方向键一路闪。
            const selection = e.textEditor.selection;
            const leftTheLine = decorated
                && (decorated.line !== selection.active.line
                    || selection.start.line !== selection.end.line);
            if (leftTheLine) {
                clear();
            }
            schedule();
        }),
        vscode.window.onDidChangeActiveTextEditor(() => {
            // 立刻清掉：上一份注解属于另一个文件，留着就是错的。
            clear();
            schedule();
        }),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document !== vscode.window.activeTextEditor?.document) {
                return;
            }
            // 文档一改，画着的注解就作废了：装饰的 range 跟着编辑平移，所以在
            // 上方插入或删除行时，它会连着旧行的内容一起漂到别处，而 git 的答案
            // 也已经对不上磁盘。停手后 refresh 会给出「Uncommitted changes」。
            clear();
            schedule();
        }),
        vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc === vscode.window.activeTextEditor?.document) {
                schedule();
            }
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_ENABLED}`)) {
                clear();
                schedule();
            }
        }),
        // 浮窗里的颜色是写死的十六进制，明暗两套靠主题类型选。换了主题就得重建，
        // 否则手上这份浮窗会在新主题下用旧那套颜色。
        vscode.window.onDidChangeActiveColorTheme(() => {
            clear();
            schedule();
        })
    );

    context.subscriptions.push({
        dispose: () => {
            if (timer) {
                clearTimeout(timer);
            }
            annotation.dispose();
            diffHover.dispose();
            footHover.dispose();
        }
    });

    schedule();
}
