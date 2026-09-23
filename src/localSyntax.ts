import * as path from 'path';
import type * as TS from 'typescript';

let tsLib: typeof TS | undefined;

/** Loaded on first use so activation does not pay for the compiler. */
function ts(): typeof TS {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    tsLib ??= require('typescript') as typeof TS;
    return tsLib;
}

function scriptKind(fsPath: string): TS.ScriptKind | undefined {
    const t = ts();
    switch (path.extname(fsPath).toLowerCase()) {
        case '.ts':
        case '.mts':
        case '.cts':
            return t.ScriptKind.TS;
        case '.tsx':
            return t.ScriptKind.TSX;
        case '.js':
        case '.mjs':
        case '.cjs':
            return t.ScriptKind.JS;
        case '.jsx':
            return t.ScriptKind.JSX;
        default:
            return undefined;
    }
}

/** Syntax-only parse of a TS/JS file; other languages return undefined. */
export function parseLocalSource(fsPath: string, lines: readonly string[]): TS.SourceFile | undefined {
    const kind = scriptKind(fsPath);
    if (kind === undefined) {
        return undefined;
    }
    const t = ts();
    return t.createSourceFile(fsPath, lines.join('\n'), t.ScriptTarget.Latest, true, kind);
}

/** Nodes the TS document-symbol walk can report as a callable, property, or field. */
function isSymbolSpan(t: typeof TS, node: TS.Node): boolean {
    return t.isFunctionLike(node)
        || t.isPropertyDeclaration(node)
        || t.isPropertySignature(node)
        || t.isPropertyAssignment(node)
        || t.isShorthandPropertyAssignment(node)
        || t.isVariableDeclaration(node)
        || t.isClassStaticBlockDeclaration(node);
}

function declName(t: typeof TS, node: TS.Node): string | undefined {
    const name = (node as { name?: TS.Node }).name;
    if (name && (t.isIdentifier(name) || t.isPrivateIdentifier(name) || t.isStringLiteral(name))) {
        return name.text;
    }
    return undefined;
}

/**
 * True only when `enclosingCallable(uri, line, ident)` must come back empty:
 * the line lies inside a declaration named `ident`, and no other callable,
 * property, or variable spans it. Anything else is left to the language server.
 * @param line 0-based
 */
export function onlySameNamedEnclosing(sf: TS.SourceFile, line: number, ident: string): boolean {
    const t = ts();
    let named = false;
    let other = false;
    const visit = (node: TS.Node): void => {
        if (other) {
            return;
        }
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
        const end = sf.getLineAndCharacterOfPosition(node.end).line;
        if (line < start || line > end) {
            return;
        }
        if (isSymbolSpan(t, node)) {
            if (declName(t, node) !== ident) {
                other = true;
                return;
            }
            named = true;
        }
        t.forEachChild(node, visit);
    };
    t.forEachChild(sf, visit);
    return named && !other;
}
