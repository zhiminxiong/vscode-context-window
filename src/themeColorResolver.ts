import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// 从「当前 VSCode 主题」解析出语义 token 的真实配色，生成 Monaco 主题规则（foreground 不带 '#'）。
//
// 背景：VSCode 没有公开 API 直接返回主题解析后的 token 颜色，因此这里：
//   1) 找到当前主题贡献的 JSON 文件（含 include 继承链）并解析 tokenColors / semanticTokenColors；
//   2) 叠加用户设置 editor.semanticTokenColorCustomizations / editor.tokenColorCustomizations；
//   3) 对每个语义类型，先查 semanticTokenColors（含 *.declaration 等选择器），
//      未命中再用「语义类型 → textmate scope」默认映射回退到 tokenColors。
// 解析失败时返回 undefined，前端继续用硬编码的兜底默认色，保证不退化。

export interface SemanticRule {
    token: string;
    foreground?: string;
    fontStyle?: string;
}

interface TokenColorRule {
    scope?: string | string[];
    settings?: { foreground?: string; fontStyle?: string };
}

interface SemanticStyle {
    foreground?: string;
    fontStyle?: string;
}

// 语义类型 → 候选 textmate scope（按优先级）。用于主题未显式定义 semanticTokenColors 时回退取色。
const SEMANTIC_TO_SCOPES: Record<string, string[]> = {
    namespace: ['entity.name.namespace', 'entity.name.type.namespace', 'storage.modifier.namespace'],
    type: ['entity.name.type', 'support.type'],
    class: ['entity.name.type.class', 'entity.name.class', 'support.class'],
    struct: ['entity.name.type.struct', 'storage.type.struct', 'entity.name.type'],
    interface: ['entity.name.type.interface', 'entity.name.interface', 'entity.name.type'],
    enum: ['entity.name.type.enum', 'entity.name.type'],
    typeParameter: ['entity.name.type.parameter', 'entity.name.type.template', 'entity.name.type'],
    function: ['entity.name.function', 'support.function'],
    method: ['entity.name.function.member', 'entity.name.function'],
    macro: ['entity.name.function.preprocessor', 'entity.name.function'],
    decorator: ['entity.name.function.decorator', 'entity.name.decorator', 'meta.decorator'],
    variable: ['variable.other.readwrite', 'variable.other', 'variable'],
    parameter: ['variable.parameter', 'variable.other'],
    property: ['variable.other.property', 'variable.other.object.property', 'variable.other'],
    field: ['variable.other.property', 'variable.other'],
    enumMember: ['variable.other.enummember', 'constant.other.enum', 'constant'],
    event: ['variable.other.event', 'variable.other'],
    // 取通用 keyword 色（多数主题为蓝/storage 色）；Monarch 把 class/const/enum/import 等都归为 keyword，
    // 不能优先匹配 keyword.control（控制流专用，常是另一种颜色）。仅当主题没有通用 keyword 时才回退。
    keyword: ['keyword', 'keyword.control'],
    comment: ['comment'],
    string: ['string'],
    number: ['constant.numeric'],
    regexp: ['string.regexp', 'constant.regexp'],
    operator: ['keyword.operator'],
};

// 常见语言的 scope 后缀（用于解析「基础语法层」token 的语言专属配色，如 storage.type.class.ts）。
// 覆盖各 textmate 语法的 tokenPostfix；多发出的、不匹配任何实际 token 的规则是无害的。
const LANG_POSTFIXES = [
    'ts', 'js', 'tsx', 'jsx', 'cpp', 'c', 'cs', 'java', 'go', 'rs', 'rust', 'py', 'python',
    'rb', 'ruby', 'php', 'swift', 'kt', 'kotlin', 'lua', 'scala', 'dart', 'h', 'hpp', 'm', 'mm',
];

// 修饰符的规范顺序，对齐 VSCode 语义 token legend 的常见顺序。
// 编辑器里 Monaco 会按 legend 顺序把「类型 + 修饰符」拼成 "variable.declaration.readonly.local"，
// 主题 trie 做最长前缀匹配，因此生成规则时必须用相同顺序，前缀才能命中。
const MODIFIER_ORDER = [
    'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract',
    'async', 'modification', 'documentation', 'defaultLibrary', 'local',
    'fileScope', 'globalScope', 'constructorOrDestructor',
];

function sortModifiers(mods: string[]): string[] {
    const idx = (m: string) => {
        const i = MODIFIER_ORDER.indexOf(m);
        return i < 0 ? MODIFIER_ORDER.length : i;
    };
    return [...mods].sort((a, b) => idx(a) - idx(b));
}

// 去掉 JSONC 中的注释与尾随逗号，便于用 JSON.parse 解析主题文件。
function stripJsonComments(text: string): string {
    let out = '';
    let inString = false, inSingleLine = false, inMultiLine = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const n = i + 1 < text.length ? text[i + 1] : '';
        if (inSingleLine) {
            if (c === '\n') { inSingleLine = false; out += c; }
            continue;
        }
        if (inMultiLine) {
            if (c === '*' && n === '/') { inMultiLine = false; i++; }
            continue;
        }
        if (inString) {
            out += c;
            if (c === '\\') { out += n; i++; continue; }
            if (c === '"') { inString = false; }
            continue;
        }
        if (c === '"') { inString = true; out += c; continue; }
        if (c === '/' && n === '/') { inSingleLine = true; i++; continue; }
        if (c === '/' && n === '*') { inMultiLine = true; i++; continue; }
        out += c;
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
}

// 定位当前主题贡献的 JSON 文件路径。
function findThemePath(): string | undefined {
    const themeLabel = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    if (!themeLabel) { return undefined; }
    for (const ext of vscode.extensions.all) {
        const themes = ext.packageJSON?.contributes?.themes;
        if (!Array.isArray(themes)) { continue; }
        for (const t of themes) {
            if (t && (t.id === themeLabel || t.label === themeLabel) && t.path) {
                return path.join(ext.extensionPath, t.path);
            }
        }
    }
    return undefined;
}

// 读取主题 JSON，并沿 include 继承链合并（被继承者在前、当前覆盖在后）。
function loadThemeJson(
    file: string,
    seen: Set<string> = new Set()
): { tokenColors: TokenColorRule[]; semanticTokenColors: Record<string, any> } {
    const empty = { tokenColors: [] as TokenColorRule[], semanticTokenColors: {} as Record<string, any> };
    if (seen.has(file)) { return empty; }
    seen.add(file);

    let json: any;
    try {
        json = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    } catch {
        return empty;
    }

    let tokenColors: TokenColorRule[] = [];
    let semanticTokenColors: Record<string, any> = {};

    if (typeof json.include === 'string') {
        const inc = loadThemeJson(path.join(path.dirname(file), json.include), seen);
        tokenColors = inc.tokenColors;
        semanticTokenColors = inc.semanticTokenColors;
    }
    if (Array.isArray(json.tokenColors)) {
        tokenColors = tokenColors.concat(json.tokenColors);
    }
    if (json.semanticTokenColors && typeof json.semanticTokenColors === 'object') {
        semanticTokenColors = { ...semanticTokenColors, ...json.semanticTokenColors };
    }
    return { tokenColors, semanticTokenColors };
}

// 把主题颜色（可能带 '#' 与 alpha）规整为 Monaco token 规则所需的 6 位 hex（不带 '#'）。
function normalizeColor(color?: string): string | undefined {
    if (typeof color !== 'string') { return undefined; }
    let c = color.trim();
    if (!c) { return undefined; }
    if (c.startsWith('#')) { c = c.slice(1); }
    if (!/^[0-9a-fA-F]{3,8}$/.test(c)) { return undefined; }
    if (c.length === 3) { c = c.split('').map(x => x + x).join(''); }
    return c.slice(0, 6).toLowerCase();
}

// 把各种 fontStyle 形态（字符串 / {bold,italic,underline} 布尔）规整为 Monaco 接受的空格分隔串。
function normalizeFontStyle(settings: any): string | undefined {
    if (!settings) { return undefined; }
    if (typeof settings.fontStyle === 'string') {
        // 可能是 "bold italic" 或 "" 或 "none"
        const fs = settings.fontStyle.trim();
        return fs === 'none' ? '' : fs;
    }
    const parts: string[] = [];
    if (settings.bold === true) { parts.push('bold'); }
    if (settings.italic === true) { parts.push('italic'); }
    if (settings.underline === true) { parts.push('underline'); }
    if (settings.bold === false || settings.italic === false || settings.underline === false) {
        // 显式关闭：返回空串表示「无样式」，便于覆盖
        if (parts.length === 0) { return ''; }
    }
    return parts.length ? parts.join(' ') : undefined;
}

// 把 tokenColors 的 scope 规整为字符串数组（拆分逗号；对后代选择器取最后一段作为目标 scope）。
function normalizeScopes(scope?: string | string[]): string[] {
    if (!scope) { return []; }
    const list = Array.isArray(scope) ? scope : String(scope).split(',');
    const out: string[] = [];
    for (const s of list) {
        const trimmed = String(s).trim();
        if (!trimmed) { continue; }
        const segs = trimmed.split(/\s+/);
        out.push(segs[segs.length - 1]);
    }
    return out;
}

// 在 tokenColors 中按候选 scope 找最匹配规则（最长 scope 前缀、后者覆盖前者）。
function styleFromTokenColors(tokenColors: TokenColorRule[], candidateScopes: string[]): SemanticStyle | undefined {
    for (const target of candidateScopes) {
        let best: SemanticStyle | undefined;
        let bestLen = -1;
        for (const rule of tokenColors) {
            const settings = rule.settings;
            if (!settings || (!settings.foreground && !settings.fontStyle)) { continue; }
            for (const sc of normalizeScopes(rule.scope)) {
                if (target === sc || target.startsWith(sc + '.')) {
                    const len = sc.split('.').length;
                    if (len >= bestLen) {
                        bestLen = len;
                        best = { foreground: settings.foreground, fontStyle: settings.fontStyle };
                    }
                }
            }
        }
        if (best) { return best; }
    }
    return undefined;
}

// 一条 semanticTokenColors 规则对各样式位的「贡献」：undefined 表示该规则未定义此位。
// 对齐 VSCode TokenStyle.fromSettings 语义：
//   - 字符串简写（"#rrggbb"）：仅定义 foreground；
//   - 对象的 fontStyle 字符串（如 "italic bold" / "none" / ""）：定义全部 4 个样式位
//     （出现的词为 true，未出现的为 false）——这点最关键，"bold" 同时意味着 italic=false；
//   - 对象的布尔字段（bold/italic/underline/strikethrough）：只定义出现的那几位。
interface StyleBits {
    foreground?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
}

function parseStyleContribution(val: any): StyleBits {
    if (typeof val === 'string') {
        return { foreground: val };
    }
    const out: StyleBits = {};
    if (typeof val?.foreground === 'string') { out.foreground = val.foreground; }
    if (typeof val?.fontStyle === 'string') {
        const fs = val.fontStyle.trim();
        if (fs === 'none' || fs === '') {
            out.bold = out.italic = out.underline = out.strikethrough = false;
        } else {
            // 字符串形态定义全部 4 位：出现=true，未出现=false（VSCode 语义）
            out.bold = /\bbold\b/.test(fs);
            out.italic = /\bitalic\b/.test(fs);
            out.underline = /\bunderline\b/.test(fs);
            out.strikethrough = /\bstrikethrough\b/.test(fs);
        }
    } else {
        // 布尔对象形态：仅定义显式给出的位
        if (typeof val?.bold === 'boolean') { out.bold = val.bold; }
        if (typeof val?.italic === 'boolean') { out.italic = val.italic; }
        if (typeof val?.underline === 'boolean') { out.underline = val.underline; }
        if (typeof val?.strikethrough === 'boolean') { out.strikethrough = val.strikethrough; }
    }
    return out;
}

// 解析 semanticTokenColors 选择器（type.mod.mod:lang），与目标 token（type[.mod...]）匹配。
// 完全对齐 VSCode 的语义着色解析：
//   1) 打分 score = (类型匹配 ? 100 : 0) + 修饰符数 * 100 —— 类型匹配与「每个修饰符」等权（各 100），
//      故修饰符数量主导特异性：*.static（1 修饰符=100）与 method（类型=100）打平，靠后出现者覆盖。
//      这是修复「method 的 fontStyle:'bold' 把 *.static 的 'italic bold' 整体盖掉、丢失 italic」的关键。
//   2) foreground 与 bold/italic/underline/strikethrough 各自「独立」取分数最高（同分取后出现）的规则，
//      而非把 fontStyle 当整串覆盖 —— 这样 foreground 来自 method、样式位来自 *.static，与 VSCode 一致。
function styleFromSemanticColors(semanticTokenColors: Record<string, any>, token: string): SemanticStyle | undefined {
    const [tType, ...tMods] = token.split('.');
    let fg: string | undefined;
    let fgScore = -1;
    const bits: StyleBits = {};
    const bitScore = { bold: -1, italic: -1, underline: -1, strikethrough: -1 };
    let matched = false;

    for (const rawSelector of Object.keys(semanticTokenColors)) {
        if (rawSelector === 'enabled') { continue; }
        const selector = rawSelector.split(':')[0]; // 去掉 :language
        const [sType, ...sMods] = selector.split('.');
        if (sType !== '*' && sType !== tType) { continue; }
        if (!sMods.every(m => tMods.includes(m))) { continue; }
        const score = (sType === '*' ? 0 : 100) + sMods.length * 100;
        const c = parseStyleContribution(semanticTokenColors[rawSelector]);
        matched = true;
        // >= 使同分时「配置中后出现者」覆盖（与 VSCode 一致）；Object.keys 保序、Node 排序稳定
        if (c.foreground !== undefined && score >= fgScore) { fg = c.foreground; fgScore = score; }
        for (const p of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
            if (c[p] !== undefined && score >= bitScore[p]) { bits[p] = c[p]; bitScore[p] = score; }
        }
    }
    if (!matched) { return undefined; }

    const out: SemanticStyle = {};
    if (fg !== undefined) { out.foreground = fg; }
    // 只要有任一样式位被定义，就产出 fontStyle 串（可能为 '' 表示「显式无样式」，用于覆盖底层）
    if (bits.bold !== undefined || bits.italic !== undefined ||
        bits.underline !== undefined || bits.strikethrough !== undefined) {
        const parts: string[] = [];
        if (bits.bold) { parts.push('bold'); }
        if (bits.italic) { parts.push('italic'); }
        if (bits.underline) { parts.push('underline'); }
        if (bits.strikethrough) { parts.push('strikethrough'); }
        out.fontStyle = parts.join(' ');
    }
    return out;
}

// 判断一个设置键是否为「主题专属块」键（形如 "[Theme]" / "[*Light*]" / "[A][B]"）并匹配当前主题。
// VSCode 支持 * 通配与多组 [A][B]（任一匹配即生效），故这里逐组转正则匹配。
function matchesThemeSelector(key: string, themeLabel: string | undefined): boolean {
    if (!themeLabel) { return false; }
    const groups = key.match(/\[([^\]]+)\]/g);
    if (!groups) { return false; }
    for (const g of groups) {
        const pattern = g.slice(1, -1).trim();
        const re = new RegExp('^' + pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        if (re.test(themeLabel)) { return true; }
    }
    return false;
}

// 读取用户 editor.semanticTokenColorCustomizations 的 rules（全局 + 所有匹配当前主题的专属块），返回选择器 → 样式。
function readUserSemanticRules(themeLabel: string | undefined): Record<string, any> {
    const cfg = vscode.workspace.getConfiguration('editor').get<any>('semanticTokenColorCustomizations') || {};
    const merged: Record<string, any> = {};
    if (cfg.rules && typeof cfg.rules === 'object') { Object.assign(merged, cfg.rules); }
    for (const key of Object.keys(cfg)) {
        if (key === 'enabled' || key === 'rules') { continue; }
        if (matchesThemeSelector(key, themeLabel) && cfg[key]?.rules && typeof cfg[key].rules === 'object') {
            Object.assign(merged, cfg[key].rules);
        }
    }
    return merged;
}

// 读取用户 editor.tokenColorCustomizations 的 textMateRules（全局 + 所有匹配当前主题的专属块）。
function readUserTokenColors(themeLabel: string | undefined): TokenColorRule[] {
    const cfg = vscode.workspace.getConfiguration('editor').get<any>('tokenColorCustomizations') || {};
    const out: TokenColorRule[] = [];
    if (Array.isArray(cfg.textMateRules)) { out.push(...cfg.textMateRules); }
    for (const key of Object.keys(cfg)) {
        if (matchesThemeSelector(key, themeLabel) && Array.isArray(cfg[key]?.textMateRules)) {
            out.push(...cfg[key].textMateRules);
        }
    }
    return out;
}

// 合并多个样式来源：后者覆盖前者（仅覆盖存在的字段）。
function mergeStyle(...styles: (SemanticStyle | undefined)[]): SemanticStyle {
    const out: SemanticStyle = {};
    for (const s of styles) {
        if (!s) { continue; }
        if (s.foreground) { out.foreground = s.foreground; }
        if (s.fontStyle !== undefined) { out.fontStyle = s.fontStyle; }
    }
    return out;
}

// 解析出某个语义 token（如 "enum" 或 "enum.declaration"）的最终样式。
function resolveStyleForToken(
    token: string,
    typeForScopes: string,
    themeData: { tokenColors: TokenColorRule[]; semanticTokenColors: Record<string, any> },
    userSemantic: Record<string, any>
): SemanticStyle | undefined {
    // 优先级（低 → 高）：textmate 回退 < 主题 semanticTokenColors < 用户 semanticTokenColorCustomizations
    const fromScope = styleFromTokenColors(themeData.tokenColors, SEMANTIC_TO_SCOPES[typeForScopes] || []);
    const fromTheme = styleFromSemanticColors(themeData.semanticTokenColors, token);
    const fromUser = styleFromSemanticColors(userSemantic, token);
    const merged = mergeStyle(fromScope, fromTheme, fromUser);
    if (!merged.foreground && merged.fontStyle === undefined) { return undefined; }
    return merged;
}

export function resolveSemanticRules(): SemanticRule[] | undefined {
    try {
        return resolveSemanticRulesInner();
    } catch {
        // 任意异常都不应影响配置注入；失败时前端走硬编码兜底
        return undefined;
    }
}

// 解析「当前主题的完整 textmate tokenColors」为 Monaco 规则（scope → 颜色/字体）。
// 用途：方案 B 下 webview 用真实 TextMate 语法分词，会产出任意 scope（如 keyword.control.flow.cpp、
// string.quoted.double.cpp、punctuation.* 等）。这里把主题里所有 tokenColors 规则原样下发，
// Monaco 的主题 trie 即可按「最长 scope 前缀」为这些 scope 着色，使基础语法层与 VSCode 一致。
// 与 resolveSemanticRules 不同：那份是「语义类型 → 颜色」的精选集；这份是「全部 textmate scope → 颜色」的全集。
// 解析失败返回 undefined，前端回退（不渲染基础层颜色，仅靠语义层）。
export function resolveRawTokenColors(): SemanticRule[] | undefined {
    try {
        const themeFile = findThemePath();
        if (!themeFile) { return undefined; }
        const base = loadThemeJson(themeFile);
        const themeLabel = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
        const userTokenColors = readUserTokenColors(themeLabel);
        const all = base.tokenColors.concat(userTokenColors);

        const out: SemanticRule[] = [];
        const seen = new Set<string>();
        for (const rule of all) {
            const settings = rule.settings;
            if (!settings) { continue; }
            const fg = normalizeColor(settings.foreground);
            const fontStyle = normalizeFontStyle(settings);
            // fontStyle 语义：undefined = 主题未设置（Monaco 继承父 scope）；'' = 主题显式「无样式/重置」（须覆盖父 scope）。
            // 二者必须区分：只有当既无颜色、又未设置样式时才跳过；仅有 '' 重置（无颜色）也要保留，用于覆盖祖先的 bold/italic。
            if (!fg && fontStyle === undefined) { continue; }
            for (const sc of normalizeScopes(rule.scope)) {
                if (!sc) { continue; }
                // 去重 key：同一 scope 后者覆盖前者（与主题文件顺序一致），故记录顺序即可，重复直接覆盖
                const dupKey = sc;
                if (seen.has(dupKey)) {
                    // 覆盖已存在的同名 scope（保持后者优先）
                    const idx = out.findIndex(r => r.token === sc);
                    if (idx >= 0) {
                        out[idx] = {
                            token: sc,
                            ...(fg ? { foreground: fg } : {}),
                            // 保留显式 '' —— 用空串下发，Monaco 解析为 FontStyle.None（覆盖父 scope），与 VSCode 的「重置」一致。
                            ...(fontStyle !== undefined ? { fontStyle } : {}),
                        };
                    }
                    continue;
                }
                seen.add(dupKey);
                out.push({
                    token: sc,
                    ...(fg ? { foreground: fg } : {}),
                    ...(fontStyle !== undefined ? { fontStyle } : {}),
                });
            }
        }
        return out.length ? out : undefined;
    } catch {
        return undefined;
    }
}

function resolveSemanticRulesInner(): SemanticRule[] | undefined {
    const themeFile = findThemePath();
    if (!themeFile) { return undefined; }

    const base = loadThemeJson(themeFile);
    const themeLabel = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    const userSemantic = readUserSemanticRules(themeLabel);
    const userTokenColors = readUserTokenColors(themeLabel);

    // 用户 textmate 覆盖追加在最后，使其在「最长前缀 + 后者覆盖」匹配中优先级更高
    const themeData = {
        tokenColors: base.tokenColors.concat(userTokenColors),
        semanticTokenColors: base.semanticTokenColors,
    };

    // 收集主题 + 用户语义选择器里出现过的「修饰符组合」（按类型；'*' 适用于所有类型）。
    // 例如用户写了 variable.declaration.readonly / *.declaration，就为相应类型生成这些带修饰符的规则。
    const comboMap = collectModifierCombos(themeData.semanticTokenColors, userSemantic);
    const starCombos = comboMap.get('*') || new Set<string>();

    const rules: SemanticRule[] = [];
    let produced = false;

    const pushRule = (token: string, typeForScopes: string, baseFg?: string) => {
        const style = resolveStyleForToken(token, typeForScopes, themeData, userSemantic);
        const fg = normalizeColor(style?.foreground) || baseFg;
        const fontStyle = style?.fontStyle;
        if (fg) { produced = true; }
        rules.push({
            token,
            ...(fg ? { foreground: fg } : {}),
            // 保留显式 ''（重置样式）：与 undefined（继承父 scope）区分，避免 Monaco 继承祖先的 bold/italic。
            ...(fontStyle !== undefined ? { fontStyle } : {}),
        });
        return fg;
    };

    for (const type of Object.keys(SEMANTIC_TO_SCOPES)) {
        // 基础类型规则
        const baseFg = pushRule(type, type);
        // 该类型相关的修饰符组合 = 类型专属 ∪ '*' 通配。
        // 顺序很关键：通配（'*'，如来自 *.declaration）在前、类型专属（如来自 class.constructorOrDestructor）在后。
        // 二者拍平后同形（都是 class.<mod>），特异性（修饰符数）相同时前端按「后注册覆盖」取最后命中，
        // 故类型专属排在后面才能更高优先级——与 VSCode「类型选择器优先于通配选择器」一致。
        const combos = new Set<string>([...starCombos, ...(comboMap.get(type) || [])]);
        for (const combo of combos) {
            if (!combo) { continue; }
            pushRule(`${type}.${combo}`, type, baseFg);
        }
    }

    // 额外的「基础语法层」规则：关键字由 Monaco Monarch 着色（非语义 token）。前端会把通用 keyword
    // 细分成下列 TextMate scope（keyword.control.* / keyword.operator.* / storage.* / constant.language /
    // variable.language），这里为每个 scope 解析颜色，使其能像 VSCode 一样分别着色。
    // scopes 数组为「候选 + 回退」：从最精确逐级回退，最后回退到 keyword（保证至少有个合理颜色）。
    const extraTextmateRules: { token: string; scopes: string[] }[] = [
        { token: 'keyword.control', scopes: ['keyword.control', 'keyword'] },
        { token: 'keyword.control.conditional', scopes: ['keyword.control.conditional', 'keyword.control', 'keyword'] },
        { token: 'keyword.control.loop', scopes: ['keyword.control.loop', 'keyword.control', 'keyword'] },
        { token: 'keyword.control.trycatch', scopes: ['keyword.control.trycatch', 'keyword.control.exception', 'keyword.control', 'keyword'] },
        { token: 'keyword.control.flow', scopes: ['keyword.control.flow', 'keyword.control', 'keyword'] },
        { token: 'keyword.control.import', scopes: ['keyword.control.import', 'keyword.control', 'keyword'] },
        { token: 'keyword.operator.expression', scopes: ['keyword.operator.expression', 'keyword.operator.word', 'keyword.operator', 'keyword'] },
        { token: 'storage.type.class', scopes: ['storage.type.class', 'storage.type', 'keyword'] },
        { token: 'storage.type.enum', scopes: ['storage.type.enum', 'storage.type', 'keyword'] },
        { token: 'storage.type.struct', scopes: ['storage.type.struct', 'storage.type', 'keyword'] },
        { token: 'storage.type.interface', scopes: ['storage.type.interface', 'storage.type', 'keyword'] },
        { token: 'storage.type.function', scopes: ['storage.type.function', 'storage.type', 'keyword'] },
        { token: 'storage.type.namespace', scopes: ['storage.type.namespace', 'storage.type', 'keyword'] },
        { token: 'storage.type', scopes: ['storage.type', 'keyword'] },
        { token: 'storage.modifier', scopes: ['storage.modifier', 'storage.type', 'keyword'] },
        // 布尔值在前端被精确细分为 constant.language.boolean.true / .false，需逐一解析：
        // 主题常把布尔色精确挂到该层级，与 null/undefined 共用的 constant.language 不同。
        // 逐级回退（精确 → boolean → language → constant → keyword）保证至少有合理颜色。
        { token: 'constant.language.boolean.true', scopes: ['constant.language.boolean.true', 'constant.language.boolean', 'constant.language', 'constant', 'keyword'] },
        { token: 'constant.language.boolean.false', scopes: ['constant.language.boolean.false', 'constant.language.boolean', 'constant.language', 'constant', 'keyword'] },
        { token: 'constant.language', scopes: ['constant.language', 'constant', 'keyword'] },
        { token: 'variable.language', scopes: ['variable.language', 'variable', 'keyword'] },
    ];
    for (const ex of extraTextmateRules) {
        // 基础（无语言后缀）颜色：按候选 scope 前缀回退。
        const base = styleFromTokenColors(themeData.tokenColors, ex.scopes);
        const baseFg = normalizeColor(base?.foreground);
        // 保留 undefined（未设置=继承）与 ''（显式重置=覆盖）的区分，避免继承祖先 bold/italic。
        const baseFontStyle = base?.fontStyle;
        if (baseFg || baseFontStyle !== undefined) {
            produced = true;
            rules.push({
                token: ex.token,
                ...(baseFg ? { foreground: baseFg } : {}),
                ...(baseFontStyle !== undefined ? { fontStyle: baseFontStyle } : {}),
            });
        }
        // 语言后缀变体：Monaco 里这些 token 实际带语言后缀（如 storage.type.class.ts），
        // 用户的 textmate 规则也常按语言细分。这里对每个常见后缀做「精确 scope」解析，
        // 仅当颜色/样式与基础不同才发出对应规则（避免被 .jsdoc/.doxygen 等文档上下文规则误命中）。
        for (const p of LANG_POSTFIXES) {
            const suffixedToken = `${ex.token}.${p}`;
            const sp = styleFromTokenColors(themeData.tokenColors, [suffixedToken]);
            if (!sp) { continue; }
            const spFg = normalizeColor(sp.foreground);
            const spFontStyle = sp.fontStyle;
            if ((spFg || spFontStyle !== undefined) && (spFg !== baseFg || spFontStyle !== baseFontStyle)) {
                produced = true;
                rules.push({
                    token: suffixedToken,
                    ...(spFg ? { foreground: spFg } : {}),
                    ...(spFontStyle !== undefined ? { fontStyle: spFontStyle } : {}),
                });
            }
        }
    }

    // 一个颜色都没解析到，说明主题文件结构异常，放弃以走前端硬编码兜底
    return produced ? rules : undefined;
}

// 收集每个语义类型（含 '*'）出现过的修饰符组合，组合内修饰符按 legend 规范顺序排列后用 '.' 连接。
function collectModifierCombos(...sources: Record<string, any>[]): Map<string, Set<string>> {
    const perType = new Map<string, Set<string>>();
    for (const src of sources) {
        if (!src) { continue; }
        for (const rawSelector of Object.keys(src)) {
            if (rawSelector === 'enabled') { continue; }
            const parts = rawSelector.split(':')[0].split('.');
            const sType = parts[0];
            const sMods = parts.slice(1);
            if (!sMods.length) { continue; }
            const combo = sortModifiers(sMods).join('.');
            if (!perType.has(sType)) { perType.set(sType, new Set<string>()); }
            perType.get(sType)!.add(combo);
        }
    }
    return perType;
}
