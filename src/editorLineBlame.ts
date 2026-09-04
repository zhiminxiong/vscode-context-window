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
 * 这里交给编辑器的只有 MarkdownString。字号、按下变色不在这个口子里；
 * 头像行的左右分布靠 supportHtml 下的 <table width="100%">。
 *
 * 拷贝例外。新版编辑器给每个 hover part 挂一颗 HoverCopyButton，默认透明，
 * 指针进入这一行才显示——CodeBuddy 的「add to Chat」旁那颗就是它，不是他们
 * 改了我们的 markdown。所以卡片必须拆成两条装饰、两个 part：上半区作者和提交，
 * 下半区增删和 Changes。指针在哪一行，哪一行的拷贝才出现，跟 webview 的
 * is-copy-below 同一套分区，只是按钮是编辑器画的。
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
 * markdown 链接的目标里不能出现裸的 `)`，否则链接在那里就断了。
 * encodeURIComponent 偏偏放过圆括号，而参数里既有仓库路径（`C:\Program Files
 * (x86)\...`）也有提交信息，所以必须自己再补上这两个字符。
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

/** data URI，避免 markdown 表格单元格里出现 `|width=` 那种竖线。 */
function svgImage(svg: string): string {
    return `![](data:image/svg+xml,${encodeURIComponent(svg)})`;
}

/** 插件芯片左侧那个旋转过的 git 节点，12×12。图形下移 2px，跟旁边的 SHA 对齐。 */
function gitNodeImage(color: string): string {
    return svgImage(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12">`
        + `<g transform="translate(0 2.7)">`
        + `<path fill="${color}" transform="rotate(90 8 8)" d="M11.5 8C11.5 6.24 10.194 4.779 8.5 4.536V1.5C8.5 1.224 8.276 1 8 1C7.724 1 7.5 1.224 7.5 1.5V4.536C5.806 4.779 4.5 6.24 4.5 8C4.5 9.76 5.806 11.221 7.5 11.464V14.5C7.5 14.776 7.724 15 8 15C8.276 15 8.5 14.776 8.5 14.5V11.464C10.194 11.221 11.5 9.76 11.5 8ZM8 10.5C6.621 10.5 5.5 9.378 5.5 8C5.5 6.622 6.621 5.5 8 5.5C9.379 5.5 10.5 6.622 10.5 8C10.5 9.378 9.379 10.5 8 10.5Z"/>`
        + `</g></svg>`
    );
}

/** 插件 Open Changes 按钮里的 16×16 图标，浮窗只显示这个，不带文字。同样下移 2px。 */
function openChangesImage(color: string): string {
    return svgImage(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">`
        + `<g transform="translate(0 2)">`
        + `<path fill="${color}" d="M9.14645 5.85355C9.34171 6.04882 9.65829 6.04882 9.85355 5.85355C10.0488 5.65829 10.0488 5.34171 9.85355 5.14645L8.70711 4H10.5C11.3284 4 12 4.67157 12 5.5V10.05C10.8589 10.2816 10 11.2905 10 12.5C10 13.8807 11.1193 15 12.5 15C13.8807 15 15 13.8807 15 12.5C15 11.2905 14.1411 10.2816 13 10.05V5.5C13 4.11929 11.8807 3 10.5 3H8.70711L9.85355 1.85355C10.0488 1.65829 10.0488 1.34171 9.85355 1.14645C9.65829 0.951184 9.34171 0.951184 9.14645 1.14645L7.14645 3.14645C6.95118 3.34171 6.95118 3.65829 7.14645 3.85355L9.14645 5.85355ZM14 12.5C14 13.3284 13.3284 14 12.5 14C11.6716 14 11 13.3284 11 12.5C11 11.6716 11.6716 11 12.5 11C13.3284 11 14 11.6716 14 12.5ZM6 3.5C6 4.70948 5.14112 5.71836 4 5.94999V10.5C4 11.3284 4.67157 12 5.5 12H7.29289L6.14645 10.8536C5.95118 10.6583 5.95118 10.3417 6.14645 10.1464C6.34171 9.95118 6.65829 9.95118 6.85355 10.1464L8.85355 12.1464C9.04882 12.3417 9.04882 12.6583 8.85355 12.8536L6.85355 14.8536C6.65829 15.0488 6.34171 15.0488 6.14645 14.8536C5.95118 14.6583 5.95118 14.3417 6.14645 14.1464L7.29289 13H5.5C4.11929 13 3 11.8807 3 10.5V5.94999C1.85888 5.71836 1 4.70948 1 3.5C1 2.11929 2.11929 1 3.5 1C4.88071 1 6 2.11929 6 3.5ZM5 3.5C5 2.67157 4.32843 2 3.5 2C2.67157 2 2 2.67157 2 3.5C2 4.32843 2.67157 5 3.5 5C4.32843 5 5 4.32843 5 3.5Z"/>`
        + `</g></svg>`
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
    return `[${chip}](${commandLink(COPY_COMMAND, args)} "Copy SHA")`;
}

function avatarSrc(hover: LineBlameHoverInfo): string | undefined {
    const url = hover.avatarUrl;
    if (!url) {
        return undefined;
    }
    const withFallback = url.replace(/([?&])d=404\b/, '$1d=mp');
    const retina = withFallback.replace(/([?&])s=\d+\b/, '$1s=64');
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

/** 1×1 透明 PNG。浮窗里的 <img width> 会按属性拉伸，不依赖 SVG 固有尺寸。 */
const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function spacer(width: number, height = 1): string {
    return htmlImg(PIXEL_PNG, Math.max(1, Math.round(width)), height);
}

function clockDataUri(color: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14">`
        + `<path fill="${color}" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.25a5.75 5.75 0 1 1 0 11.5 5.75 5.75 0 0 1 0-11.5zM8.5 4v4.05l2.6 1.5-.5.87L7.5 8.55V4h1z"/>`
        + `</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 跟插件 .cw-line-blame-hover 一样：520–720。官方浮窗没有 CSS 口子，靠撑缝和折行卡这个区间。 */
const HOVER_MIN_PX = 520;
const HOVER_MAX_PX = 720;
const MONO_PX = 8.4;
const CODE_PAD_PX = 56;

function maxDiffChars(): number {
    return Math.max(24, Math.floor((HOVER_MAX_PX - CODE_PAD_PX) / MONO_PX));
}

function hoverWidthPx(hover: LineBlameHoverInfo, diff: readonly LineBlameDiffLine[]): number {
    let widest = HOVER_MIN_PX;
    const cap = maxDiffChars();
    for (const line of diff) {
        const text = String(line.text || '').replace(/^[ \t]+/, '');
        widest = Math.max(widest, CODE_PAD_PX + Math.min(text.length + 2, cap) * MONO_PX);
    }
    const subject = (hover.summary || '').split(/\r?\n/)[0] || '';
    widest = Math.max(widest, Math.min(subject.length * 7.2, HOVER_MAX_PX));
    return Math.max(HOVER_MIN_PX, Math.min(HOVER_MAX_PX, Math.round(widest)));
}

function headerGapPx(hover: LineBlameHoverInfo, diff: readonly LineBlameDiffLine[]): number {
    const who = hover.author || hover.authorName || 'Someone';
    const when = whenText(hover);
    const left = 28 + 10 + who.length * 8.5;
    const right = when ? 20 + when.length * 6.6 : 0;
    return Math.max(24, hoverWidthPx(hover, diff) - Math.round(left + right));
}

function ruleImage(width: number): string {
    const theme = vscode.window.activeColorTheme?.kind;
    const dark = theme === vscode.ColorThemeKind.Dark || theme === vscode.ColorThemeKind.HighContrast;
    const fill = dark ? '#454545' : '#e0e0e0';
    const w = Math.max(1, Math.round(width));
    return htmlImg(
        `data:image/svg+xml,${encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="1"><rect width="${w}" height="1" fill="${fill}"/></svg>`
        )}`,
        w,
        1
    );
}

function appendHeader(
    md: vscode.MarkdownString,
    hover: LineBlameHoverInfo,
    diff: readonly LineBlameDiffLine[]
): void {
    const who = escapeHtml(hover.author || hover.authorName || 'Someone');
    const when = escapeHtml(whenText(hover));
    const colors = palette();
    const src = avatarSrc(hover);
    const avatar = src ? htmlImg(src, 28, 28) : '';
    const clock = when ? htmlImg(clockDataUri(colors.muted), 14, 14) : '';
    const name = `<span><strong>${who}</strong></span>`;
    const time = when
        ? `<span style="color:${colors.muted};">${clock}&nbsp;${when}</span>`
        : '';
    const gap = when ? spacer(headerGapPx(hover, diff)) : '';
    md.appendMarkdown(
        `${avatar}${avatar ? '&nbsp;' : ''}${name}${gap}${time}\n\n`
    );
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
    const subject = lines[0];
    const body = lines.slice(1).join('  \n').replace(/^(?:\s*\n)+/, '');
    if (subject) {
        md.appendMarkdown(`${escapeMarkdown(subject)}\n\n`);
    }
    if (body.trim()) {
        md.appendMarkdown(`${escapeMarkdown(body)}\n\n`);
    }
}

/**
 * 当前行的增删。webview 用逐字符 affix 高亮，浮窗里只有语言着色可用，
 * 所以走 diff 代码块——增删的绿红由 VS Code 的 diff 语法着色给出。
 * 围栏用四个反引号，源码行里出现 ``` 也不会把块提前闭合。
 */
function diffBlock(diff: readonly LineBlameDiffLine[]): string {
    const cap = maxDiffChars();
    const rows: string[] = [];
    for (const line of diff) {
        const mark = line.kind === 'del' ? '-' : line.kind === 'add' ? '+' : ' ';
        // 和 webview 一样去掉行首缩进：浮窗窄，缩进只会把内容挤出视野。
        const text = String(line.text || '').replace(/^[ \t]+/, '');
        if (text.length + 2 <= cap) {
            rows.push(`${mark} ${text}`);
            continue;
        }
        rows.push(`${mark} ${text.slice(0, cap - 2)}`);
        for (let i = cap - 2; i < text.length; i += cap) {
            rows.push(`  ${text.slice(i, i + cap)}`);
        }
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
    detail?: vscode.MarkdownString;
}

/**
 * 两个 hover part，中间那根分割条是编辑器给相邻 part 画的，不要手写 ---。
 * 分区跟 webview 一样：上面作者和提交，下面 diff + Changes 合成一块，
 * 所以浮到底下时只有一颗拷贝，内容也是 diff 和 Changes 一起。
 */
function buildHover(
    info: LineBlameInfo,
    diff: readonly LineBlameDiffLine[],
    uriString: string,
    line1Based: number
): HoverParts {
    const hover = info.hover;
    const tips = section();
    appendHeader(tips, hover, diff);
    appendMessage(tips, hover.summary || '');
    if (hover.shortSha && !hover.workingTree) {
        tips.appendMarkdown(shaChip(hover.shortSha, hover.sha));
    }

    const detail = section();
    if (diff.length) {
        detail.appendMarkdown(`${diffBlock(diff)}\n\n`);
    }
    // 分割条只画在这一块里面，不另开 hover part，拷贝仍是 diff + Changes 一起。
    // 宽度跟卡好的浮窗宽一致，才能和 part 之间那根顶栏对齐。
    detail.appendMarkdown(`${ruleImage(hoverWidthPx(hover, diff))}\n\n`);
    detail.appendMarkdown(changesLine(hover));
    if (hover.sha || hover.workingTree) {
        const args: OpenChangesArgs = {
            uri: uriString,
            line: line1Based,
            sha: hover.sha,
            previousSha: hover.previousSha || '',
            workingTree: !!hover.workingTree
        };
        detail.appendMarkdown(
            ` &nbsp;[${openChangesImage(palette().icon)}](${commandLink(OPEN_CHANGES_COMMAND, args)} "Open Changes")`
        );
    }
    return { tips, detail };
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
    // 第二条不画字，只多贡献下半区 hover part：diff 和 Changes 在一起。
    const detailHover = vscode.window.createTextEditorDecorationType({});

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
        wipe(previous.editor, annotation, detailHover);
    };

    const apply = (
        editor: vscode.TextEditor,
        line0Based: number,
        text: string,
        hover: HoverParts
    ) => {
        if (decorated && decorated.editor !== editor) {
            wipe(decorated.editor, annotation, detailHover);
        }
        const end = editor.document.lineAt(line0Based).range.end;
        const range = new vscode.Range(end, end);
        editor.setDecorations(annotation, [{
            range,
            hoverMessage: hover.tips,
            renderOptions: { after: { contentText: text } }
        }]);
        editor.setDecorations(detailHover, hover.detail
            ? [{ range, hoverMessage: hover.detail }]
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
        apply(editor, line0, info.text, buildHover(info, [], uriString, line0 + 1));

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
        apply(editor, line0, info.text, buildHover(info, diff, uriString, line0 + 1));
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
            detailHover.dispose();
        }
    });

    schedule();
}
