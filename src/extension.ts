import * as vscode from 'vscode';
import { ContextWindowProvider } from './contextView';

export function activate(context: vscode.ExtensionContext) {

    const provider = new ContextWindowProvider(context.extensionUri);
    context.subscriptions.push(provider);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ContextWindowProvider.viewType, provider));

    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('FloatContextView', provider)
    );

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

    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-context-window.navigateUri', async (uri?: string, line?: number, character?: number) => {
            // 如果没有提供参数，则显示输入框
            if (!uri || line === undefined || character === undefined) {
                try {
                    // 获取 URI
                    const uriInput = await vscode.window.showInputBox({
                        prompt: 'Enter file URI',
                        placeHolder: 'file:///e:/code_proj/vscode-context-window/src/extension.ts',
                        value: uri || ''
                    });
                    
                    if (!uriInput) {
                        return; // 用户取消了输入
                    }

                    // 获取行号
                    const lineInput = await vscode.window.showInputBox({
                        prompt: 'Enter line number',
                        placeHolder: '1',
                        value: line !== undefined ? line.toString() : ''
                    });
                    
                    if (!lineInput) {
                        return; // 用户取消了输入
                    }

                    const lineNumber = parseInt(lineInput);
                    if (isNaN(lineNumber) || lineNumber < 1) {
                        vscode.window.showErrorMessage('Invalid line number');
                        return;
                    }

                    // 获取字符列号
                    const characterInput = await vscode.window.showInputBox({
                        prompt: 'Enter character column (usually 0)',
                        placeHolder: '1',
                        value: character !== undefined ? character.toString() : '0'
                    });
                    
                    if (!characterInput) {
                        return; // 用户取消了输入
                    }

                    const characterNumber = parseInt(characterInput);
                    if (isNaN(characterNumber) || characterNumber < 0) {
                        vscode.window.showErrorMessage('Invalid character number');
                        return;
                    }

                    // 执行导航
                    await provider.navigateCommand(uriInput, lineNumber, characterNumber);
                    vscode.window.showInformationMessage(`Navigated to ${uriInput}:${lineNumber}:${characterNumber}`);
                    
                } catch (error) {
                    vscode.window.showErrorMessage(`Navigation failed: ${error}`);
                }
            } else {
                // 如果提供了参数，直接执行导航
                provider.navigateCommand(uri, line, character);
            }
        }));
    
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-context-window.testNavigate', () => {
            // 测试 extension.ts 第10行
            vscode.commands.executeCommand(
                'vscode-context-window.navigateUri',
                'file:///e:/code_proj/vscode-context-window/src/extension.ts',
                10,
                1
            );
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