import * as vscode from 'vscode';

const SECTION = 'contextView';
const KEY = 'logging';

let channel: vscode.OutputChannel | undefined;

/** 调试日志总开关。默认关。 */
export function loggingEnabled(): boolean {
    return vscode.workspace.getConfiguration(SECTION).get<boolean>(KEY, false) === true;
}

function output(): vscode.OutputChannel {
    channel ??= vscode.window.createOutputChannel('Context View');
    return channel;
}

/** 开关关闭时什么都不写。第一段 tag 共用，第二段是模块名。 */
export function debugLog(module: string, message: string): void {
    if (!loggingEnabled()) {
        return;
    }
    output().appendLine(`[context-view] [${module}] ${message}`);
}

export function showLogChannel(): void {
    output().show(true);
}

export function disposeLogChannel(): void {
    channel?.dispose();
    channel = undefined;
}
