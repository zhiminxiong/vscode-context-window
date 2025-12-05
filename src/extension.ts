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
        vscode.commands.registerCommand('vscode-context-window.navigateUri', async (uri?: string, range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
            // 如果没有提供参数，则显示输入框
            if (!uri || !range) {
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

                    // 询问用户是导航到单点还是范围
                    const navigationType = await vscode.window.showQuickPick([
                        { label: 'Single Point', description: 'Navigate to specific line and character' },
                        { label: 'Range', description: 'Navigate to a range of lines' }
                    ], {
                        placeHolder: 'Select navigation type'
                    });

                    if (!navigationType) {
                        return;
                    }

                    let inputRange: { start: { line: number; character: number }; end: { line: number; character: number } };

                    if (navigationType.label === 'Single Point') {
                        // 获取行号
                        const lineInput = await vscode.window.showInputBox({
                            prompt: 'Enter line number',
                            placeHolder: '1'
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
                            prompt: 'Enter character column',
                            placeHolder: '1'
                        });
                        
                        if (!characterInput) {
                            return; // 用户取消了输入
                        }

                        const characterNumber = parseInt(characterInput);
                        if (isNaN(characterNumber) || characterNumber < 1) {
                            vscode.window.showErrorMessage('Invalid character number');
                            return;
                        }

                        // 创建单点range
                        inputRange = {
                            start: { line: lineNumber, character: characterNumber },
                            end: { line: lineNumber, character: characterNumber }
                        };
                    } else {
                        // 获取起始行号
                        const startLineInput = await vscode.window.showInputBox({
                            prompt: 'Enter start line number',
                            placeHolder: '1'
                        });
                        
                        if (!startLineInput) {
                            return;
                        }

                        const startLineNumber = parseInt(startLineInput);
                        if (isNaN(startLineNumber) || startLineNumber < 1) {
                            vscode.window.showErrorMessage('Invalid start line number');
                            return;
                        }

                        // 获取起始字符列号
                        const startCharacterInput = await vscode.window.showInputBox({
                            prompt: 'Enter start character column',
                            placeHolder: '0'
                        });
                        
                        if (!startCharacterInput) {
                            return;
                        }

                        const startCharacterNumber = parseInt(startCharacterInput);
                        if (isNaN(startCharacterNumber) || startCharacterNumber < 1) {
                            vscode.window.showErrorMessage('Invalid start character number');
                            return;
                        }

                        // 获取结束行号
                        const endLineInput = await vscode.window.showInputBox({
                            prompt: 'Enter end line number',
                            placeHolder: startLineNumber.toString()
                        });
                        
                        if (!endLineInput) {
                            return;
                        }

                        const endLineNumber = parseInt(endLineInput);
                        if (isNaN(endLineNumber) || endLineNumber < startLineNumber) {
                            vscode.window.showErrorMessage('Invalid end line number');
                            return;
                        }

                        // 获取结束字符列号
                        const endCharacterInput = await vscode.window.showInputBox({
                            prompt: 'Enter end character column',
                            placeHolder: startCharacterNumber.toString()
                        });
                        
                        if (!endCharacterInput) {
                            return;
                        }

                        const endCharacterNumber = parseInt(endCharacterInput);
                        if (isNaN(endCharacterNumber) || endCharacterNumber < 1) {
                            vscode.window.showErrorMessage('Invalid end character number');
                            return;
                        }

                        // 创建范围range
                        inputRange = {
                            start: { line: startLineNumber, character: startCharacterNumber },
                            end: { line: endLineNumber, character: endCharacterNumber }
                        };
                    }
                    
                    // 执行导航
                    await provider.navigateCommand(uriInput, inputRange);
                    vscode.window.showInformationMessage(`Navigated to ${uriInput}:${inputRange.start.line}:${inputRange.start.character}-${inputRange.end.line}:${inputRange.end.character}`);
                    
                } catch (error) {
                    vscode.window.showErrorMessage(`Navigation failed: ${error}`);
                }
            } else {
                // 如果提供了参数，直接执行导航
                await provider.navigateCommand(uri, range);
            }
        }));
    
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-context-window.testNavigate', () => {
            // 测试 extension.ts 第10行（单点）
            const singlePointRange = {
                start: { line: 9, character: 5 },
                end: { line: 10, character: 94 }
            };
            vscode.commands.executeCommand(
                'vscode-context-window.navigateUri',
                'file:///e:/code_proj/vscode-context-window/src/extension.ts',
                singlePointRange
            );
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-context-window.testNavigateRange', () => {
            // 测试 extension.ts 第10行第1字符 到 第20行第10字符的范围
            const range = {
                start: { line: 10, character: 1 },
                end: { line: 20, character: 10 }
            };
            vscode.commands.executeCommand(
                'vscode-context-window.navigateUri',
                'file:///e:/code_proj/vscode-context-window/src/extension.ts',
                range
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