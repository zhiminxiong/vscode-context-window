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
}
