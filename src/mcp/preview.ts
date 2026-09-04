import * as vscode from 'vscode';
import { RelationDirection, ToolResult, disposeToolState, queryEnclosingSymbol, queryRelations } from './tools';

/**
 * Runs the AI-facing tools at the cursor and dumps what a model would receive.
 *
 * This exists to judge output quality and cost before any transport is wired
 * up: the wording, how deep to go by default, and how many call sites are
 * worth their tokens are all decided by reading real answers.
 */

let channel: vscode.OutputChannel | undefined;

function output(): vscode.OutputChannel {
    channel ??= vscode.window.createOutputChannel('Context View MCP Preview');
    return channel;
}

function report(title: string, elapsedMs: number, result: ToolResult): void {
    const out = output();
    out.appendLine('');
    out.appendLine('='.repeat(72));
    out.appendLine(`${title}   status=${result.status}   ${elapsedMs}ms   ${result.text.length} chars`);
    if (result.detail) {
        out.appendLine(`detail: ${result.detail}`);
    }
    out.appendLine('-'.repeat(72));
    if (result.text) {
        out.appendLine(result.text);
    }
    out.show(true);
}

const PRESETS: readonly { label: string; description: string; depth: number; direction: RelationDirection }[] = [
    { label: 'both, depth 2', description: 'the default', depth: 2, direction: 'both' },
    { label: 'both, depth 1', description: 'immediate neighbours only', depth: 1, direction: 'both' },
    { label: 'callers, depth 3', description: 'who reaches this', depth: 3, direction: 'callers' },
    { label: 'callees, depth 3', description: 'what this reaches', depth: 3, direction: 'callees' },
    { label: 'both, depth 4', description: 'cost check', depth: 4, direction: 'both' }
];

async function previewRelations(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Open a file and put the cursor on a symbol first.');
        return;
    }
    const picked = await vscode.window.showQuickPick(PRESETS.slice(), {
        placeHolder: 'Relations preview — depth and direction'
    });
    if (!picked) {
        return;
    }
    const position = editor.selection.active;
    const started = Date.now();
    const result = await queryRelations({
        uri: editor.document.uri.toString(),
        line: position.line + 1,
        character: position.character + 1,
        depth: picked.depth,
        direction: picked.direction
    });
    report(
        `relations  ${vscode.workspace.asRelativePath(editor.document.uri, false)}:${position.line + 1}  [${picked.label}]`,
        Date.now() - started,
        result
    );
}

async function previewEnclosingSymbol(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Open a file and put the cursor on a line first.');
        return;
    }
    const line = editor.selection.active.line + 1;
    const started = Date.now();
    const result = await queryEnclosingSymbol({
        uri: editor.document.uri.toString(),
        line,
        includeText: true
    });
    report(
        `enclosing_symbol  ${vscode.workspace.asRelativePath(editor.document.uri, false)}:${line}`,
        Date.now() - started,
        result
    );
}

export function registerMcpToolPreview(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.mcp.previewRelations', () => void previewRelations()),
        vscode.commands.registerCommand('contextView.mcp.previewEnclosingSymbol', () => void previewEnclosingSymbol()),
        {
            dispose: () => {
                channel?.dispose();
                channel = undefined;
                disposeToolState();
            }
        }
    );
}
