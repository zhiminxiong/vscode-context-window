import * as vscode from 'vscode';

/** One place to look for both the endpoint's status and what a model was sent. */

let channel: vscode.OutputChannel | undefined;

export function mcpChannel(): vscode.OutputChannel {
    channel ??= vscode.window.createOutputChannel('Context View MCP');
    return channel;
}

export function mcpLog(message: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    mcpChannel().appendLine(`[${stamp}] ${message}`);
}

export function disposeMcpChannel(): void {
    channel?.dispose();
    channel = undefined;
}
