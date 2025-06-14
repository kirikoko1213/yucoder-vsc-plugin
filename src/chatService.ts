import * as WebSocket from 'ws';

export interface ChatMessage {
    id: string;
    content: string;
    sender: {
        id: string;
        name: string;
        avatar: string;
        level: number;
        points: number;
        isAdmin: boolean;
        region: string;
        country: string;
        avatarFrameUrl?: string;
        titleId: string;
    };
    timestamp: string;
}

export interface OnlineUser {
    id: string;
    name: string;
    avatar: string;
    level: number;
    points: number;
    isAdmin: boolean;
    status: string;
}

export interface UserInfo {
    id: string;
    userName: string;
    userAvatar: string;
    userProfile: string;
    email: string;
    userRole: string;
    points: number;
    usedPoints: number;
    avatarFramerUrl: string | null;
    titleId: string;
    titleIdList: string | null;
    level: number;
    lastSignInDate: string | null;
    bindPlatforms: any[];
}

export class ChatService {
    private ws?: WebSocket;
    private token: string;
    private keepAliveInterval?: NodeJS.Timeout;
    private reconnectTimeout?: NodeJS.Timeout;
    private isConnected = false;
    private userInfo?: UserInfo;

    // 事件回调
    private onMessageCallback?: (message: any) => void;
    private onUserOnlineCallback?: (users: OnlineUser[]) => void;
    private onUserOfflineCallback?: (userId: string) => void;
    private onConnectedCallback?: () => void;
    private onErrorCallback?: (error: string) => void;

    constructor(token: string) {
        this.token = token;
    }

    private async fetchUserInfo(): Promise<void> {
        try {
            const response = await fetch('https://api.yucoder.cn/api/user/get/login', {
                method: 'GET',
                headers: {
                    'accept': '*/*',
                    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
                    'fish-dog-token': this.token,
                    'origin': 'https://yucoder.cn',
                    'referer': 'https://yucoder.cn/',
                    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
                }
            });

            const data = await response.json();
            if (data.code === 0 && data.data && data.data.id) {
                this.userInfo = data.data;
                console.log('用户信息获取成功:', this.userInfo);
            } else {
                // Token无效或获取用户信息失败
                throw new Error('TOKEN_INVALID');
            }
        } catch (error) {
            console.error('获取用户信息失败:', error);
            if (error instanceof Error && error.message === 'TOKEN_INVALID') {
                throw new Error('Token无效或已过期，请检查Token配置是否正确');
            }
            throw new Error('网络错误，请检查网络连接或Token配置');
        }
    }

    public async connect(): Promise<void> {
        return new Promise(async (resolve, reject) => {
            try {
                // 首先获取用户信息
                await this.fetchUserInfo();
                
                const wsUrl = `wss://api.yucoder.cn/ws/?token=${this.token}`;
                this.ws = new WebSocket(wsUrl);

                this.ws.on('open', () => {
                    console.log('WebSocket连接已建立');
                    this.isConnected = true;
                    
                    // 发送激活消息
                    this.send({ type: 1 });
                    
                    // 开始心跳保活
                    this.startKeepAlive();
                    
                    if (this.onConnectedCallback) {
                        this.onConnectedCallback();
                    }
                    
                    resolve();
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.handleMessage(message);
                    } catch (error) {
                        console.error('解析消息失败:', error);
                    }
                });

                this.ws.on('close', () => {
                    console.log('WebSocket连接已关闭');
                    this.isConnected = false;
                    this.stopKeepAlive();
                    
                    // 尝试重连
                    this.scheduleReconnect();
                });

                this.ws.on('error', (error) => {
                    console.error('WebSocket错误:', error);
                    this.isConnected = false;
                    if (this.onErrorCallback) {
                        this.onErrorCallback(error.message);
                    }
                    reject(error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    public disconnect(): void {
        this.isConnected = false;
        this.stopKeepAlive();
        
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
        
        if (this.ws) {
            this.ws.close();
            this.ws = undefined;
        }
    }

    public async sendMessage(content: string): Promise<void> {
        if (!this.isConnected || !this.ws) {
            throw new Error('WebSocket未连接');
        }

        // 生成消息ID
        const messageId = Date.now().toString();
        
        const message = {
            type: 2,
            userId: -1,
            data: {
                type: "chat",
                content: {
                    message: {
                        id: messageId,
                        content: content,
                                                 sender: {
                             id: this.userInfo?.id || "unknown",
                             name: this.userInfo?.userName || "我",
                             avatar: this.userInfo?.userAvatar || "",
                             level: this.userInfo?.level || 1,
                             points: this.userInfo?.points || 0,
                             isAdmin: this.userInfo?.userRole === 'admin',
                             region: "未知",
                             country: "未知",
                             avatarFramerUrl: this.userInfo?.avatarFramerUrl,
                             titleId: this.userInfo?.titleId || "0",
                             titleIdList: this.userInfo?.titleIdList
                         },
                        timestamp: new Date().toISOString(),
                        region: "未知",
                        country: "未知"
                    }
                }
            }
        };

        this.send(message);
    }

    private send(message: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    private handleMessage(message: any): void {
        switch (message.type) {
            case 'chat':
                if (this.onMessageCallback) {
                    this.onMessageCallback(message);
                }
                break;
                
            // case 'userOnline':
            //     if (this.onUserOnlineCallback && Array.isArray(message.data)) {
            //         this.onUserOnlineCallback(message.data);
            //     }
            //     break;
                
            // case 'userOffline':
            //     if (this.onUserOfflineCallback) {
            //         this.onUserOfflineCallback(message.data);
            //     }
            //     break;
                
            default:
                // 处理其他类型的消息
                if (this.onMessageCallback) {
                    this.onMessageCallback(message);
                }
                break;
        }
    }

    private startKeepAlive(): void {
        // 每25秒发送一次心跳
        this.keepAliveInterval = setInterval(() => {
            if (this.isConnected) {
                this.send({ type: 4 });
                console.log('发送心跳保活');
            }
        }, 25000);
    }

    private stopKeepAlive(): void {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = undefined;
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimeout) {
            return;
        }

        this.reconnectTimeout = setTimeout(async () => {
            console.log('尝试重新连接...');
            try {
                await this.connect();
                console.log('重新连接成功');
            } catch (error) {
                console.error('重新连接失败:', error);
                this.scheduleReconnect();
            }
            this.reconnectTimeout = undefined;
        }, 5000);
    }

    // 事件监听方法
    public onMessage(callback: (message: any) => void): void {
        this.onMessageCallback = callback;
    }

    public onUserOnline(callback: (users: OnlineUser[]) => void): void {
        this.onUserOnlineCallback = callback;
    }

    public onUserOffline(callback: (userId: string) => void): void {
        this.onUserOfflineCallback = callback;
    }

    public onConnected(callback: () => void): void {
        this.onConnectedCallback = callback;
    }

    public onError(callback: (error: string) => void): void {
        this.onErrorCallback = callback;
    }

    public getUserInfo(): UserInfo | undefined {
        return this.userInfo;
    }
} 