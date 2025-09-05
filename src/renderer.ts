import * as vscode from 'vscode';

export interface FileContentInfo {
    content: string;
    line: number;
    column: number;
    jmpUri: string;
    languageId: string; // 添加语言ID用于Monaco Editor
    symbolName: string; // 添加符号名称字段
}

export class Renderer {
    private readonly _disposables: vscode.Disposable[] = [];
        
    // 创建一个事件发射器用于通知需要重新渲染
    private readonly _onNeedsRender = new vscode.EventEmitter<void>();
    public readonly needsRender: vscode.Event<void>;

    constructor() {
        // 使用自己的事件发射器
        this.needsRender = this._onNeedsRender.event;
    }

    dispose() {
        let item: vscode.Disposable | undefined;
        while ((item = this._disposables.pop())) {
            item.dispose();
        }
        this._onNeedsRender.dispose();
    }

    public async renderDefinitions(document: vscode.TextDocument, definitions: readonly vscode.Location[] | vscode.LocationLink[], 
                                selectedText: string | undefined): Promise<FileContentInfo> {
        let docs: FileContentInfo[] = [];

        for (const def of definitions) {
            if (def instanceof vscode.Location) {
                docs.push(await this.getFileContents(def.uri, def.range, document.languageId));
            } else {
                if (def.targetSelectionRange)
                    docs.push(await this.getFileContents(def.targetUri, def.targetSelectionRange, document.languageId));
                else
                    docs.push(await this.getFileContents(def.targetUri, def.targetRange, document.languageId));
            }
        }

        const parts = docs
            .filter(info => info.content.length > 0)
            .map(info => info.content);

        if (!parts.length) {
            return { content: '', line: 0, column: 0, jmpUri: '', languageId: document.languageId, symbolName: '' }
        };

        // 直接返回内容，不再使用highlighter
        return {
            content: parts.join('\n'),
            line: docs[0].line,
            column: docs[0].column,
            jmpUri: docs[0].jmpUri,
            languageId: docs[0].languageId,
            symbolName: selectedText || '' // 如果没有选中文本，则使用空字符串
        };
    }

    private async getFileContents(uri: vscode.Uri, range: vscode.Range, languageId: string): Promise<FileContentInfo> {
        const doc = await vscode.workspace.openTextDocument(uri);
        // console.debug(`uri = ${uri}`);
        // console.debug(`range = ${range.start.line} - ${range.end.line}`);

        // 检查文件扩展名，如果是 .inc 文件则强制使用 cpp 语言
        const fileExtension = uri.fsPath.toLowerCase().split('.').pop();
        const finalLanguageId = fileExtension === 'inc' ? 'cpp' : (doc.languageId || languageId);

        // Read entire file.
        const rangeText = new vscode.Range(0, 0, doc.lineCount, 0);
        let lines = doc.getText(rangeText);//.split(/\r?\n/);
        let firstLine = range.start.line;

        //console.debug(`uri = ${uri} firstLine = ${firstLine} lastLine = ${lastLine}`);

        return {
            content: lines,//.join("\n"),
            line: firstLine,
            column: range.start.character,
            jmpUri: uri.toString(),
            languageId: finalLanguageId,
            symbolName: '' // 使用文档的语言ID或传入的语言ID
        };
    }
}
