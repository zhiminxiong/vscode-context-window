import * as vscode from 'vscode';
import { ContextWindowProvider } from './contextView';

export function activate(context: vscode.ExtensionContext) {

	const provider = new ContextWindowProvider(context.extensionUri);
	context.subscriptions.push(provider);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ContextWindowProvider.viewType, provider));

	context.subscriptions.push(
		vscode.commands.registerCommand('contextView.contextWindow.pin', () => {
			provider.pin();
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('contextView.contextWindow.unpin', () => {
			provider.unpin();
		}));

    // 注册显示上下文窗口的命令
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-context-window.showContextWindow', () => {
            provider.show();
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-context-window.float', () => {
            provider.showFloatingWebview();
        }));

    const contextWindowConfig = vscode.workspace.getConfiguration('contextView.contextWindow');
    if (!contextWindowConfig.get('fixToken', false))
        return;

    const config = vscode.workspace.getConfiguration('editor.tokenColorCustomizations');
    const semanticHighlighting = (config?.get('textMateRules') || []) as Array<{
        scope: string;
        settings: {
            foreground?: string;
        };
    }>;
    let includeColor = '#0000FF'; // 默认颜色

    // 查找 include 关键字的颜色设置
    for (const rule of semanticHighlighting) {
        if (rule.scope === 'keyword.control.directive.include') {
            includeColor = rule.settings.foreground || includeColor;
            break;
        }
    }

    const editorConfig = vscode.workspace.getConfiguration('editor');
    //const fontFamily = editorConfig.get('fontFamily') || 'Consolas, monospace';
    const fontWeight = String(editorConfig.get('fontWeight') || 'normal');
    //const fontSize = editorConfig.get('fontSize') || 14;

    let decorationTypeInclude = vscode.window.createTextEditorDecorationType({
        color: includeColor,
        fontStyle: fontWeight === 'bold' ? 'oblique' : 'normal',
        fontWeight: fontWeight,
        //textDecoration: `none; font-size: ${fontSize}px`  // 使用 textDecoration 来设置字体大小
    });

    function updateDecorations() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !['c', 'cc', 'cpp', 'h', 'hpp', 'csharp'].includes(editor.document.languageId)) {
            return;
        }

        const text = editor.document.getText();
        const includeDecorations: vscode.DecorationOptions[] = [];

        const regex = /(?:^|\n)[ \t]*#[ \t]*(include|pragma|region|endregion)\b/g;
        let match;
        while ((match = regex.exec(text))) {
            const startPos = editor.document.positionAt(match.index);
            const endPos = editor.document.positionAt(match.index + match[0].length);
            const decoration = { range: new vscode.Range(startPos, endPos) };

            if (match[1] === 'include') {
                includeDecorations.push(decoration);
            } else if (match[1] === 'pragma') {
                includeDecorations.push(decoration);
            } else if (match[1] === 'region') {
                includeDecorations.push(decoration);
            } else if (match[1] === 'endregion') {
                includeDecorations.push(decoration);
            }
        }

        editor.setDecorations(decorationTypeInclude, includeDecorations);
    }

    vscode.window.onDidChangeActiveTextEditor(updateDecorations, null, context.subscriptions);
    vscode.workspace.onDidChangeTextDocument(event => {
        if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
            updateDecorations();
        }
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('editor.fontWeight') ||
            e.affectsConfiguration('editor.fontSize') ||
            e.affectsConfiguration('editor.tokenColorCustomizations')) {

            // 重新获取颜色设置
            const config = vscode.workspace.getConfiguration('editor.tokenColorCustomizations');
            const semanticHighlighting = (config?.get('textMateRules') || []) as Array<{
                scope: string;
                settings: {
                    foreground?: string;
                };
            }>;
            
            // 更新颜色
            for (const rule of semanticHighlighting) {
                if (rule.scope === 'keyword.control.directive.include') {
                    includeColor = rule.settings.foreground || '#0000FF';
                    break;
                }
            }

            // 获取新的字体设置
            const editorConfig = vscode.workspace.getConfiguration('editor');
            const newFontWeight = String(editorConfig.get('fontWeight') || 'normal');

            // 更新装饰器
            decorationTypeInclude.dispose();
            decorationTypeInclude = vscode.window.createTextEditorDecorationType({
                color: includeColor,
                fontStyle: newFontWeight === 'bold' ? 'oblique' : 'normal',
                fontWeight: newFontWeight,
            });
            updateDecorations();
        }
    }, null, context.subscriptions);

    updateDecorations();
}
