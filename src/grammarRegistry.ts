import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// 从用户实际安装的所有 VSCode 语言扩展里「收割」TextMate 语法贡献（contributes.grammars），
// 建立三张表供 webview 端的 vscode-textmate 使用：
//   - languageToScope：languageId → 顶层 scopeName（如 cpp → source.cpp），webview 据此知道某语言用哪份语法；
//   - scopeToFile：    scopeName → 语法文件绝对路径，webview 按需请求时据此读取并下发原始内容；
//   - injections：     目标 scope → 注入语法 scope 列表（contributes.grammars[].injectTo），
//                      供 Registry.getInjections 解析注入语法（如 TODO 高亮、字符串内嵌等）。
//
// 这样 webview 拿到的语法「和用户 VSCode 里跑的完全一致」（含其安装的第三方语言扩展），无需自行维护语法库。

export interface GrammarMaps {
    languageToScope: Record<string, string>;
    injections: Record<string, string[]>;
}

let _scopeToFile: Map<string, string> | undefined;
let _maps: GrammarMaps | undefined;

// 从同一 language 的多个候选 scope 里挑「主语法」scope。
// 必要性：C/C++ 等扩展会为同一 language 贡献多份 grammar（如 cpp 同时有 source.cpp 与
// source.cpp.embedded.macro），「取第一个」可能撞上 embedded/injection 这类残缺子语法。
// 规则：先排除明显的 embedded/injection 子语法；再在剩余里取「scope 层级最浅」（最接近根）的，
// 同级取先出现者。这样 source.cpp(2 段) 稳胜 source.cpp.embedded.macro(4 段)。
function pickPrimaryScope(candidates: string[]): string {
    const isSub = (s: string) => /\.(embedded|injection|inject)\b/.test(s);
    const primary = candidates.filter(s => !isSub(s));
    const pool = primary.length ? primary : candidates;
    let best = pool[0];
    let bestDepth = best.split('.').length;
    for (let i = 1; i < pool.length; i++) {
        const d = pool[i].split('.').length;
        if (d < bestDepth) { best = pool[i]; bestDepth = d; }
    }
    return best;
}

function build(): void {
    const scopeToFile = new Map<string, string>();
    const langCandidates: Record<string, string[]> = {};
    const injections: Record<string, string[]> = {};

    for (const ext of vscode.extensions.all) {
        const grammars = ext.packageJSON?.contributes?.grammars;
        if (!Array.isArray(grammars)) { continue; }
        for (const g of grammars) {
            if (!g || typeof g.scopeName !== 'string' || typeof g.path !== 'string') { continue; }
            const abs = path.join(ext.extensionPath, g.path);
            // 同一 scope 可能被多个扩展贡献：先到先得，避免被同名覆盖
            if (!scopeToFile.has(g.scopeName)) {
                scopeToFile.set(g.scopeName, abs);
            }
            // 收集该 language 的所有候选 scope，稍后挑主语法（排除 embedded/injection、取层级最浅）
            if (typeof g.language === 'string' && g.language) {
                (langCandidates[g.language] = langCandidates[g.language] || []).push(g.scopeName);
            }
            // 注入语法：injectTo 列出它要注入到哪些目标 scope
            if (Array.isArray(g.injectTo)) {
                for (const target of g.injectTo) {
                    if (typeof target !== 'string') { continue; }
                    (injections[target] = injections[target] || []).push(g.scopeName);
                }
            }
        }
    }

    const languageToScope: Record<string, string> = {};
    for (const lang of Object.keys(langCandidates)) {
        languageToScope[lang] = pickPrimaryScope(langCandidates[lang]);
    }

    _scopeToFile = scopeToFile;
    _maps = { languageToScope, injections };
}

// 语言/注入映射（一次构建后缓存）。
export function getGrammarMaps(): GrammarMaps {
    if (!_maps) { build(); }
    return _maps!;
}

// 按 scopeName 读取语法文件原始内容（webview 按需请求时调用）。
// 返回 content + path（path 供前端 parseRawGrammar 据扩展名判定 JSON / plist）。
export function getGrammarContent(scopeName: string): { content: string; path: string } | undefined {
    if (!_scopeToFile) { build(); }
    const file = _scopeToFile!.get(scopeName);
    if (!file) { return undefined; }
    try {
        const content = fs.readFileSync(file, 'utf8');
        return { content, path: file };
    } catch {
        return undefined;
    }
}
