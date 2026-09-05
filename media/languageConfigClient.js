//@ts-check

// 把用户 VSCode 里各语言扩展贡献的 language-configuration 接到 Monaco。
// 不做 TextMate 分词修补：`${` / `}` 由语法自己产出，这里只补 VSCode 对它们的「括号身份」——
// TypeScript 配置是 brackets: [["${","}"], ...]，且 colorizedBracketPairs 不含 `${`，
// 插值分隔符保持 TextMate 色，不会被括号对着色拆成 `$` + `{`。

let _monaco = null;
let _vscode = null;
const _pending = new Map();
const _rawByLang = new Map();
const _listening = new Set();
const _waiters = new Map();

function toRegExp(value) {
    if (!value) { return undefined; }
    if (value instanceof RegExp) { return value; }
    if (typeof value === 'string') {
        try { return new RegExp(value); } catch (_) { return undefined; }
    }
    if (typeof value.pattern === 'string') {
        try { return new RegExp(value.pattern, value.flags || ''); } catch (_) { return undefined; }
    }
    return undefined;
}

function toPair(p) {
    if (Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string' && p[0] && p[1]) {
        return [p[0], p[1]];
    }
    return null;
}

function toClosingPair(p) {
    const pair = toPair(p);
    if (pair) { return { open: pair[0], close: pair[1] }; }
    if (p && typeof p.open === 'string' && typeof p.close === 'string' && p.open && p.close) {
        const out = { open: p.open, close: p.close };
        if (Array.isArray(p.notIn)) { out.notIn = p.notIn; }
        return out;
    }
    return null;
}

function indentAction(monaco, name) {
    const A = monaco.languages.IndentAction;
    switch (String(name || '').toLowerCase()) {
        case 'indent': return A.Indent;
        case 'indentoutdent': return A.IndentOutdent;
        case 'outdent': return A.Outdent;
        default: return A.None;
    }
}

function convertConfig(raw, monaco) {
    const cfg = {};
    if (raw.comments && typeof raw.comments === 'object') {
        cfg.comments = raw.comments;
    }
    if (Array.isArray(raw.brackets)) {
        cfg.brackets = raw.brackets.map(toPair).filter(Boolean);
    }
    if (Array.isArray(raw.colorizedBracketPairs)) {
        cfg.colorizedBracketPairs = raw.colorizedBracketPairs.map(toPair).filter(Boolean);
    }
    if (Array.isArray(raw.autoClosingPairs)) {
        cfg.autoClosingPairs = raw.autoClosingPairs.map(toClosingPair).filter(Boolean);
    }
    if (Array.isArray(raw.surroundingPairs)) {
        cfg.surroundingPairs = raw.surroundingPairs.map(toClosingPair).filter(Boolean);
    }
    if (typeof raw.autoCloseBefore === 'string') {
        cfg.autoCloseBefore = raw.autoCloseBefore;
    }
    const word = toRegExp(raw.wordPattern);
    if (word) { cfg.wordPattern = word; }
    if (raw.indentationRules && typeof raw.indentationRules === 'object') {
        const ir = {};
        const inc = toRegExp(raw.indentationRules.increaseIndentPattern);
        const dec = toRegExp(raw.indentationRules.decreaseIndentPattern);
        const un = toRegExp(raw.indentationRules.unIndentedLinePattern);
        const next = toRegExp(raw.indentationRules.indentNextLinePattern);
        if (inc) { ir.increaseIndentPattern = inc; }
        if (dec) { ir.decreaseIndentPattern = dec; }
        if (un) { ir.unIndentedLinePattern = un; }
        if (next) { ir.indentNextLinePattern = next; }
        if (Object.keys(ir).length) { cfg.indentationRules = ir; }
    }
    if (raw.folding && typeof raw.folding === 'object') {
        const folding = {};
        if (raw.folding.offSide) { folding.offSide = true; }
        if (raw.folding.markers) {
            const start = toRegExp(raw.folding.markers.start);
            const end = toRegExp(raw.folding.markers.end);
            if (start && end) { folding.markers = { start, end }; }
        }
        if (Object.keys(folding).length) { cfg.folding = folding; }
    }
    if (Array.isArray(raw.onEnterRules)) {
        const rules = [];
        for (const r of raw.onEnterRules) {
            if (!r) { continue; }
            const beforeText = toRegExp(r.beforeText);
            if (!beforeText) { continue; }
            const actionIn = r.action || {};
            const rule = {
                beforeText,
                action: {
                    indentAction: indentAction(monaco, actionIn.indent),
                    ...(typeof actionIn.appendText === 'string' ? { appendText: actionIn.appendText } : {}),
                    ...(typeof actionIn.removeText === 'number' ? { removeText: actionIn.removeText } : {})
                }
            };
            const afterText = toRegExp(r.afterText);
            const previousLineText = toRegExp(r.previousLineText);
            if (afterText) { rule.afterText = afterText; }
            if (previousLineText) { rule.previousLineText = previousLineText; }
            rules.push(rule);
        }
        if (rules.length) { cfg.onEnterRules = rules; }
    }
    return cfg;
}

function applyToMonaco(languageId, raw) {
    if (!_monaco || !raw) { return; }
    try {
        _monaco.languages.setLanguageConfiguration(languageId, convertConfig(raw, _monaco));
    } catch (e) {
        console.warn('[context-window] setLanguageConfiguration failed:', languageId, e);
    }
}

function fetchConfig(languageId) {
    const existing = _waiters.get(languageId);
    if (existing) { return existing.promise; }
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    _waiters.set(languageId, { resolve, promise });
    _vscode.postMessage({ type: 'requestLanguageConfig', languageId });
    setTimeout(() => {
        const w = _waiters.get(languageId);
        if (w) {
            _waiters.delete(languageId);
            w.resolve(null);
        }
    }, 5000);
    return promise;
}

export function handleLanguageConfigData(message) {
    const languageId = message && message.languageId;
    const w = _waiters.get(languageId);
    if (!w) { return; }
    _waiters.delete(languageId);
    w.resolve(message && message.found ? message.config : null);
}

export function ensureLanguageConfig(languageId) {
    if (!_monaco || !_vscode || !languageId) { return Promise.resolve(null); }
    const cached = _rawByLang.get(languageId);
    if (cached) {
        applyToMonaco(languageId, cached);
        return Promise.resolve(cached);
    }
    if (_pending.has(languageId)) { return _pending.get(languageId); }

    const p = fetchConfig(languageId).then((raw) => {
        if (!raw) { return null; }
        _rawByLang.set(languageId, raw);
        applyToMonaco(languageId, raw);
        // Monaco 内置 ts/js 在语言首次激活时会用自己的 conf（只有 {}）覆盖我们。
        // 语言激活后再写一次，并短延迟重试，保证 `${` 那对括号留下。
        if (!_listening.has(languageId)) {
            _listening.add(languageId);
            try {
                _monaco.languages.onLanguage(languageId, () => applyToMonaco(languageId, raw));
            } catch (_) { /* already registered */ }
        }
        [50, 200, 800].forEach((ms) => setTimeout(() => applyToMonaco(languageId, raw), ms));
        return raw;
    }).finally(() => {
        _pending.delete(languageId);
    });

    _pending.set(languageId, p);
    return p;
}

export function setupLanguageConfig({ monaco, vscode }) {
    _monaco = monaco;
    _vscode = vscode;
    window.addEventListener('message', (event) => {
        const m = event.data;
        if (m && m.type === 'languageConfigData') { handleLanguageConfigData(m); }
    });
    return { ensureLanguageConfig };
}
