import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('YuCoder聊天室插件已激活');

	// 注册聊天视图提供者
	const provider = new ChatViewProvider(context.extensionUri);
	
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			ChatViewProvider.viewType, 
			provider,
			{
				webviewOptions: { retainContextWhenHidden: true }
			}
		)
	);

	// 注册打开聊天室命令
	const openChatCommand = vscode.commands.registerCommand('yucoder-chat.openChat', () => {
		// 显示底部面板中的聊天视图
		vscode.commands.executeCommand('workbench.panel.yucoder-chat.focus');
	});

	context.subscriptions.push(openChatCommand);
}

export function deactivate() {
	console.log('YuCoder聊天室插件已停用');
} 