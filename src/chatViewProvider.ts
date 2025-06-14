import * as vscode from 'vscode';
import { ChatService } from './chatService';

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'yucoder-chat.chatView';
	private _view?: vscode.WebviewView;
	private _chatService?: ChatService;
	
	// 状态保持
	private _currentToken?: string;
	private _isConnected = false;
	private _chatMessages: any[] = [];
	private _onlineUsers: any[] = [];

	constructor(private readonly _extensionUri: vscode.Uri) {}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		// 获取配置并发送到WebView
		this._sendConfigToWebview();

		// 恢复状态
		this._restoreState();

		// 处理来自WebView的消息
		webviewView.webview.onDidReceiveMessage(async (data) => {
			switch (data.type) {
				case 'connect':
					await this._connectToChat();
					break;
				case 'disconnect':
					this._disconnect();
					break;
				case 'sendMessage':
					await this._sendMessage(data.message);
					break;
				case 'loadHistory':
					await this._loadHistory();
					break;
				case 'ready':
					// WebView已准备好，发送配置和恢复状态
					this._sendConfigToWebview();
					this._restoreState();
					break;
				case 'getConfig':
					this._sendConfigToWebview();
					break;
			}
		});
	}

	private _sendConfigToWebview() {
		if (!this._view) return;

		const config = vscode.workspace.getConfiguration('yucoderChat');
		const token = config.get<string>('token', '');
		const showAvatar = config.get<boolean>('showAvatar', true);
		const showImages = config.get<boolean>('showImages', true);

		this._view.webview.postMessage({
			type: 'config',
			data: {
				token,
				showAvatar,
				showImages
			}
		});
	}

	private async _connectToChat(token?: string) {
		if (!this._view) { return; }

		// 如果没有传入token，从配置中获取
		if (!token) {
			const config = vscode.workspace.getConfiguration('yucoderChat');
			token = config.get<string>('token', '');
		}

		if (!token) {
			vscode.window.showErrorMessage('请先在设置中配置YuCoder Token');
			return;
		}

		// 保存当前token
		this._currentToken = token;

		try {
			this._chatService = new ChatService(token);
			
			// 监听聊天服务的消息
			this._chatService.onMessage((message) => {
				// 保存消息到本地状态
				if (message.type === 'chat') {
					// 检查是否是自己发送的消息（避免重复显示）
					const messageData = message.data.message || message.data.messageWrapper?.message;
					if (messageData && messageData.sender && messageData.sender.id !== "me") {
						this._chatMessages.push(message.data);
						this._view?.webview.postMessage({
							type: 'newMessage',
							data: message
						});
					}
				} else {
					// 非聊天消息直接转发
					this._view?.webview.postMessage({
						type: 'newMessage',
						data: message
					});
				}
			});

			this._chatService.onUserOnline((users) => {
				this._onlineUsers = users;
				this._view?.webview.postMessage({
					type: 'userOnline',
					data: users
				});
			});

			this._chatService.onUserOffline((userId) => {
				this._onlineUsers = this._onlineUsers.filter(user => user.id !== userId);
				this._view?.webview.postMessage({
					type: 'userOffline',
					data: userId
				});
			});

			this._chatService.onConnected(() => {
				this._isConnected = true;
				this._view?.webview.postMessage({
					type: 'connected'
				});
			});

			this._chatService.onError((error) => {
				this._isConnected = false;
				this._view?.webview.postMessage({
					type: 'error',
					data: error
				});
			});

			await this._chatService.connect();
			
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (errorMessage.includes('Token无效') || errorMessage.includes('Token配置')) {
				vscode.window.showErrorMessage(`❌ ${errorMessage}`, '查看说明').then((selection) => {
					if (selection === '查看说明') {
						vscode.env.openExternal(vscode.Uri.parse('https://yucoder.cn'));
					}
				});
			} else {
				vscode.window.showErrorMessage(`连接聊天室失败: ${errorMessage}`);
			}
		}
	}

	private async _sendMessage(message: string) {
		if (this._chatService) {
			// 发送消息到服务器
			await this._chatService.sendMessage(message);
			
			// 获取真实的用户信息
			const userInfo = this._chatService.getUserInfo();
			
			// 乐观更新：立即在本地显示发送的消息
			const messageData = {
				id: Date.now().toString(),
				content: message,
				sender: {
					id: "me", // 仍然使用"me"作为标识符来避免重复显示
					name: userInfo?.userName || "我",
					avatar: userInfo?.userAvatar || "",
					level: userInfo?.level || 1,
					points: userInfo?.points || 0,
					isAdmin: userInfo?.userRole === 'admin',
					region: "本地",
					country: "本地",
					titleId: userInfo?.titleId || "0",
					avatarFrameUrl: userInfo?.avatarFramerUrl
				},
				timestamp: new Date().toISOString()
			};
			
			// 保存到本地状态
			this._chatMessages.push(messageData);
			
			// 发送到WebView显示
			this._view?.webview.postMessage({
				type: 'newMessage',
				data: {
					type: 'chat',
					data: {
						message: messageData
					}
				}
			});
		}
	}

	private _disconnect() {
		if (this._chatService) {
			this._chatService.disconnect();
			this._chatService = undefined;
		}
		this._isConnected = false;
		this._view?.webview.postMessage({
			type: 'disconnected'
		});
	}

	private async _loadHistory() {
		if (!this._view) { return; }

		const config = vscode.workspace.getConfiguration('yucoderChat');
		const token = config.get<string>('token', '');

		if (!token) {
			vscode.window.showErrorMessage('请先在设置中配置YuCoder Token');
			return;
		}

		try {
			const response = await fetch('https://api.yucoder.cn/api/chat/message/page/vo', {
				method: 'POST',
				headers: {
					'accept': '*/*',
					'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
					'content-type': 'application/json',
					'fish-dog-token': token,
					'origin': 'https://yucoder.cn',
					'referer': 'https://yucoder.cn/',
					'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
				},
				body: JSON.stringify({
					"current": 1,
					"pageSize": 50,
					"roomId": -1,
					"sortField": "createTime",
					"sortOrder": "desc"
				})
			});

			const data = await response.json();
			if (data.code === 0) {
				// 保存历史消息到本地状态
				this._chatMessages = data.data.records.reverse();
				this._view.webview.postMessage({
					type: 'historyLoaded',
					data: this._chatMessages
				});
			}
		} catch (error) {
			vscode.window.showErrorMessage(`加载历史消息失败: ${error}`);
		}
	}

	private _restoreState() {
		if (!this._view) return;

		// 发送配置
		this._sendConfigToWebview();

		// 恢复连接状态
		if (this._isConnected) {
			this._view.webview.postMessage({
				type: 'connected'
			});
		} else {
			this._view.webview.postMessage({
				type: 'disconnected'
			});
		}

		// 恢复聊天消息
		if (this._chatMessages.length > 0) {
			this._view.webview.postMessage({
				type: 'historyLoaded',
				data: this._chatMessages
			});
		}

		// 恢复在线用户
		if (this._onlineUsers.length > 0) {
			this._view.webview.postMessage({
				type: 'userOnline',
				data: this._onlineUsers
			});
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>YuCoder聊天室</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 10px;
        }
        
        .container {
            display: flex;
            flex-direction: column;
            height: calc(100vh - 20px);
        }
        
        .header {
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .header-title {
            margin: 0;
            font-size: 1em;
            color: var(--vscode-foreground);
        }
        
        .connection-controls {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .connect-btn {
            padding: 4px 8px;
            font-size: 0.85em;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            min-width: 50px;
        }
        
        .connect-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .connect-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        
        .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            border: 1px solid var(--vscode-foreground);
        }
        
        .status-indicator.connected {
            background-color: #22c55e;
            border-color: #22c55e;
        }
        
        .status-indicator.connecting {
            background-color: #f59e0b;
            border-color: #f59e0b;
            animation: pulse 1s infinite;
        }
        
        .status-indicator.disconnected {
            background-color: #ef4444;
            border-color: #ef4444;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .status {
            text-align: center;
            padding: 5px;
            margin-bottom: 10px;
            border-radius: 4px;
        }
        
        .status.connected {
            background-color: var(--vscode-terminal-ansiGreen);
            color: var(--vscode-terminal-background);
        }
        
        .status.connecting {
            background-color: var(--vscode-terminal-ansiYellow);
            color: var(--vscode-terminal-background);
        }
        
        .status.disconnected {
            background-color: var(--vscode-terminal-ansiRed);
            color: var(--vscode-terminal-background);
        }
        
        .messages {
            flex: 1;
            overflow-y: auto;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 10px;
            margin-bottom: 10px;
        }
        
        .message {
            margin-bottom: 8px;
            padding: 4px 0;
        }
        
        .message-header {
            display: flex;
            align-items: center;
            margin-bottom: 3px;
        }
        
        .avatar {
            width: 20px;
            height: 20px;
            border-radius: 50%;
            margin-right: 6px;
            flex-shrink: 0;
        }
        
        .username {
            font-weight: 500;
            margin-right: 6px;
            font-size: 0.9em;
        }
        
        .timestamp {
            font-size: 0.75em;
            opacity: 0.6;
        }
        
        .message-content {
            margin-left: 26px;
            line-height: 1.4;
        }
        
        .message-content img {
            max-width: 200px;
            border-radius: 4px;
            cursor: pointer;
            transition: opacity 0.2s;
        }
        
        .message-content img:hover {
            opacity: 0.8;
        }
        
        .image-placeholder {
            display: inline-block;
            padding: 4px 8px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.85em;
            text-decoration: none;
        }
        
        .image-placeholder:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        
        .input-area {
            display: flex;
            gap: 5px;
        }
        
        .message-input {
            flex: 1;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
        }
        
        .send-btn {
            padding: 8px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
        
        .send-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .send-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        
        .online-users {
            margin-bottom: 10px;
            padding: 8px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            background-color: var(--vscode-editor-background);
        }
        
        .online-users h4 {
            margin: 0 0 5px 0;
            font-size: 0.9em;
        }
        
        .user-list {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
        }
        
        .user-tag {
            font-size: 0.8em;
            padding: 2px 6px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h3 class="header-title">YuCoder聊天室</h3>
            <div class="connection-controls">
                <div id="statusIndicator" class="status-indicator disconnected" title="连接状态"></div>
                <button id="connectBtn" class="connect-btn" title="连接/断开">连接</button>
            </div>
        </div>
        
        <div id="onlineUsers" class="online-users" style="display: none;">
            <h4>在线用户</h4>
            <div id="userList" class="user-list"></div>
        </div>
        
        <div id="messages" class="messages"></div>
        
        <div class="input-area">
            <input type="text" id="messageInput" class="message-input" placeholder="输入消息..." disabled>
            <button id="sendBtn" class="send-btn" disabled>发送</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let connected = false;
        let onlineUsers = [];
        let config = {
            token: '',
            showAvatar: true,
            showImages: true
        };

        // DOM 元素
        const connectBtn = document.getElementById('connectBtn');
        const statusIndicator = document.getElementById('statusIndicator');
        const messagesDiv = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        const onlineUsersDiv = document.getElementById('onlineUsers');
        const userListDiv = document.getElementById('userList');

        // 连接按钮点击事件
        connectBtn.addEventListener('click', () => {
            if (!connected) {
                connect();
            } else {
                disconnect();
            }
        });

        // 发送消息按钮点击事件
        sendBtn.addEventListener('click', sendMessage);

        // 消息输入框回车事件
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });

        function connect() {
            if (!config.token) {
                alert('请先在VSCode设置中配置YuCoder Token\\n\\n文件 → 首选项 → 设置 → 搜索"YuCoder"');
                return;
            }
            
            setStatus('connecting');
            connectBtn.disabled = true;
            
            // 发送连接请求
            vscode.postMessage({
                type: 'connect'
            });
            
            // 加载历史消息
            vscode.postMessage({
                type: 'loadHistory'
            });
        }

        function disconnect() {
            vscode.postMessage({
                type: 'disconnect'
            });
        }
        
        function handleDisconnected() {
            connected = false;
            setStatus('disconnected');
            connectBtn.textContent = '连接';
            connectBtn.disabled = false;
            messageInput.disabled = true;
            sendBtn.disabled = true;
            onlineUsersDiv.style.display = 'none';
        }

        function setStatus(status) {
            if (statusIndicator) {
                statusIndicator.className = 'status-indicator ' + status;
                
                if (status === 'connected') {
                    connectBtn.textContent = '断开';
                    connectBtn.title = '断开连接';
                } else if (status === 'connecting') {
                    connectBtn.textContent = '连接中';
                    connectBtn.title = '正在连接...';
                } else {
                    connectBtn.textContent = '连接';
                    connectBtn.title = '点击连接';
                }
            }
        }

        function sendMessage() {
            const message = messageInput.value.trim();
            if (!message || !connected) return;
            
            vscode.postMessage({
                type: 'sendMessage',
                message: message
            });
            
            messageInput.value = '';
        }

        function addMessage(messageData) {
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message';
            
            const message = messageData.message || messageData.messageWrapper?.message;
            if (!message) {
                return;
            }
            
            const timestamp = new Date(message.timestamp).toLocaleString('zh-CN');
            const content = parseMessageContent(message.content);
            
            const avatarHtml = config.showAvatar ? 
                '<img src="' + message.sender.avatar + '" alt="avatar" class="avatar">' : '';
            
            messageDiv.innerHTML = 
                '<div class="message-header">' +
                    avatarHtml +
                    '<span class="username">' + message.sender.name + '</span>' +
                    '<span class="timestamp">' + timestamp + '</span>' +
                '</div>' +
                '<div class="message-content">' + content + '</div>';
            
            messagesDiv.appendChild(messageDiv);
            
            // 使用setTimeout确保在DOM更新后再滚动
            setTimeout(() => {
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }, 0);
        }

        function parseMessageContent(content) {
            // 解析图片标签 [img]url[/img]
            if (config.showImages) {
                return content.replace(/\\[img\\]([^\\[]+)\\[\\/img\\]/g, function(match, url) {
                    return '<img src="' + url + '" alt="图片" style="max-width:200px;border-radius:4px;cursor:pointer;">';
                });
            } else {
                return content.replace(/\\[img\\]([^\\[]+)\\[\\/img\\]/g, function(match, url) {
                    const imageId = 'img_' + Math.random().toString(36).substr(2, 9);
                    return '<span class="image-placeholder" style="cursor:pointer;" data-url="' + url + '" data-id="' + imageId + '" onclick="toggleImage(this)">[图片]</span>';
                });
            }
        }

        function toggleImage(element) {
            const url = element.getAttribute('data-url');
            const imageId = element.getAttribute('data-id');
            const existingImg = document.getElementById(imageId);
            
            if (existingImg) {
                // 如果图片已经显示，隐藏它
                existingImg.remove();
                element.textContent = '[图片]';
            } else {
                // 如果图片没有显示，显示它
                const img = document.createElement('img');
                img.id = imageId;
                img.src = url;
                img.alt = '图片';
                img.style.cssText = 'max-width:200px;border-radius:4px;cursor:pointer;display:block;margin:4px 0;';
                img.onclick = function() {
                    img.remove();
                    element.textContent = '[图片]';
                };
                
                // 在按钮后插入图片
                element.parentNode.insertBefore(img, element.nextSibling);
                element.textContent = '[隐藏图片]';
            }
        }

        function updateOnlineUsers(users) {
            onlineUsers = users;
            if (users.length > 0) {
                onlineUsersDiv.style.display = 'block';
                userListDiv.innerHTML = users.map(function(user) {
                    return '<span class="user-tag">' + user.name + '</span>';
                }).join('');
            }
        }

        // 通知插件WebView已准备好
        window.addEventListener('DOMContentLoaded', () => {
            // 请求配置
            vscode.postMessage({
                type: 'getConfig'
            });
            vscode.postMessage({
                type: 'ready'
            });
            
            // 设置初始状态
            setStatus('disconnected');
        });

        // 监听来自插件的消息
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'config':
                    config = message.data;
                    break;
                    
                case 'connected':
                    connected = true;
                    setStatus('connected');
                    connectBtn.disabled = false;
                    messageInput.disabled = false;
                    sendBtn.disabled = false;
                    break;
                    
                case 'disconnected':
                    handleDisconnected();
                    break;
                    
                case 'newMessage':
                    if (message.data.type === 'chat') {
                        addMessage(message.data.data);
                    }
                    break;
                    
                case 'userOnline':
                    updateOnlineUsers(message.data);
                    break;
                    
                case 'userOffline':
                    onlineUsers = onlineUsers.filter(user => user.id !== message.data);
                    updateOnlineUsers(onlineUsers);
                    break;
                    
                case 'historyLoaded':
                    messagesDiv.innerHTML = '';
                    message.data.forEach(record => {
                        addMessage(record);
                    });
                    break;
                    
                case 'error':
                    setStatus('disconnected');
                    connectBtn.disabled = false;
                    const errorMsg = message.data;
                    if (errorMsg.includes('Token无效') || errorMsg.includes('Token配置')) {
                        alert('⚠️ ' + errorMsg + '\\n\\n请先在VSCode设置中配置有效的Token\\n\\n文件 → 首选项 → 设置 → 搜索"YuCoder"');
                    } else {
                        alert('错误: ' + errorMsg);
                    }
                    break;
            }
        });
    </script>
</body>
</html>`;
	}
} 