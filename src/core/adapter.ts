/**
 * ClayCode AI适配器层
 * 统一抽象网页AI的输入框、发送按钮、回复内容选择器
 * 内置适配器：doubao、chatgpt-web、claude-web
 */

import { AdapterType, WebAIAdapter, GlobalConfig } from '../types';
import { BrowserBridge } from './browser';
import { logger } from '../utils';

/** 适配器配置定义 */
interface AdapterConfig {
  name: AdapterType;
  displayName: string;
  url: string;
  inputSelector: string;
  sendButtonSelector: string;
  responseSelector: string;
  loginUrl: string;
}

/** 网页AI适配器类型（不含ollama，ollama由OllamaAdapter单独处理） */
type WebAdapterType = Exclude<AdapterType, 'ollama'>;

/** 内置适配器配置表 */
const ADAPTER_CONFIGS: Record<WebAdapterType, AdapterConfig> = {
  doubao: {
    name: 'doubao',
    displayName: '豆包',
    url: 'https://www.doubao.com/chat/',
    inputSelector: 'textarea.semi-input-textarea',
    sendButtonSelector: '',  // 豆包使用Enter键发送，无需按钮选择器
    responseSelector: '[class*="md-box-root"]',
    loginUrl: 'https://www.doubao.com/',
  },
  'chatgpt-web': {
    name: 'chatgpt-web',
    displayName: 'ChatGPT 网页版',
    url: 'https://chat.openai.com/',
    inputSelector: '#prompt-textarea',
    sendButtonSelector: 'button[data-testid="send-button"]',
    responseSelector: '.markdown:last-child',
    loginUrl: 'https://chat.openai.com/auth/login',
  },
  'claude-web': {
    name: 'claude-web',
    displayName: 'Claude 网页版',
    url: 'https://claude.ai/chat',
    inputSelector: 'div[contenteditable="true"]',
    sendButtonSelector: 'button[aria-label="Send Message"]',
    responseSelector: '.markdown-content:last-child',
    loginUrl: 'https://claude.ai/login',
  },
  kimi: {
    name: 'kimi',
    displayName: 'Kimi',
    url: 'https://kimi.moonshot.cn/',
    inputSelector: 'textarea[class*="chat-input"]',
    sendButtonSelector: 'button[class*="send"]',
    responseSelector: '.mark-down:last-child',
    loginUrl: 'https://kimi.moonshot.cn/',
  },
  qwen: {
    name: 'qwen',
    displayName: '通义千问',
    url: 'https://tongyi.aliyun.com/qianwen/',
    inputSelector: 'textarea[class*="input"]',
    sendButtonSelector: 'button[class*="send"]',
    responseSelector: '.markdown-body:last-child',
    loginUrl: 'https://tongyi.aliyun.com/qianwen/',
  },
  deepseek: {
    name: 'deepseek',
    displayName: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    inputSelector: 'textarea',
    sendButtonSelector: '',  // DeepSeek使用Enter键发送
    responseSelector: '.markdown-body',
    loginUrl: 'https://chat.deepseek.com/',
  },
};

/**
 * AI适配器基类
 * 实现通用的网页AI交互逻辑
 */
export class BaseAdapter implements WebAIAdapter {
  name: AdapterType;
  displayName: string;
  url: string;
  inputSelector: string;
  sendButtonSelector: string;
  responseSelector: string;

  private config: AdapterConfig;
  private bridge: BrowserBridge;
  private globalConfig: GlobalConfig;

  constructor(adapterType: WebAdapterType, bridge: BrowserBridge, globalConfig: GlobalConfig) {
    this.config = ADAPTER_CONFIGS[adapterType];
    if (!this.config) {
      throw new Error(`不支持的适配器类型: ${adapterType}`);
    }
    this.name = this.config.name;
    this.displayName = this.config.displayName;
    this.url = this.config.url;
    this.inputSelector = this.config.inputSelector;
    this.sendButtonSelector = this.config.sendButtonSelector;
    this.responseSelector = this.config.responseSelector;
    this.bridge = bridge;
    this.globalConfig = globalConfig;
  }

  /** 发送消息并获取AI回复 */
  async ask(prompt: string, sessionId: string): Promise<string> {
    logger.info(`[${this.displayName}] 发送消息 (会话: ${sessionId.slice(0, 8)}...)`);

    try {
      // 1. 导航到AI网页
      await this.bridge.navigateTo(this.url);

      // 2. 输入并发送消息
      await this.bridge.typeAndSend(this.inputSelector, this.sendButtonSelector, prompt);

      // 3. 等待AI回复
      const response = await this.bridge.waitForResponse(
        this.responseSelector,
        this.globalConfig.requestTimeout
      );

      logger.info(`[${this.displayName}] 收到回复 (${response.length} 字符)`);
      return response;

    } catch (err) {
      const errorCode = (err as any).code;
      if (errorCode) {
        logger.error(`[${this.displayName}] 错误码: ${errorCode}, ${(err as Error).message}`);
      } else {
        logger.error(`[${this.displayName}] 请求失败: ${(err as Error).message}`);
      }
      throw err;
    }
  }

  /** 检查是否已登录 */
  async isLoggedIn(): Promise<boolean> {
    try {
      // 先恢复已保存的Cookie，复用登录态
      if (this.bridge.hasCookieCache()) {
        await this.bridge.loadCookies();
      }
      const page = await this.bridge.navigateTo(this.url);
      // 检查是否存在输入框（已登录状态）
      try {
        await page.waitForSelector(this.inputSelector, { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /** 获取登录URL */
  getLoginUrl(): string {
    return this.config.loginUrl;
  }
}

/**
 * Ollama本地模型适配器
 * 通过HTTP调用Ollama REST API，无需浏览器
 * 支持离线无网页场景的本地量化模型推理
 */
export class OllamaAdapter implements WebAIAdapter {
  name: AdapterType = 'ollama';
  displayName: string = 'Ollama 本地模型';
  url: string = '';
  inputSelector: string = '';
  sendButtonSelector: string = '';
  responseSelector: string = '';

  private endpoint: string;
  private model: string;

  constructor(globalConfig: GlobalConfig, model: string = 'llama3') {
    this.endpoint = globalConfig.ollamaEndpoint || 'http://localhost:11434';
    this.model = model;
  }

  /** 发送消息并获取AI回复（调用Ollama /api/chat 接口） */
  async ask(prompt: string, sessionId: string): Promise<string> {
    logger.info(`[Ollama] 发送消息 (会话: ${sessionId.slice(0, 8)}..., 模型: ${this.model})`);

    try {
      const http = await import('http');
      const requestBody = JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      });

      const url = new URL('/api/chat', this.endpoint);

      const response = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port || '11434',
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(requestBody),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                if (parsed.message?.content) {
                  resolve(parsed.message.content);
                } else if (parsed.error) {
                  reject(new Error(`Ollama错误: ${parsed.error}`));
                } else {
                  resolve(data);
                }
              } catch {
                resolve(data);
              }
            });
          }
        );

        req.on('error', (err: Error) => reject(new Error(`Ollama连接失败: ${err.message}`)));
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('Ollama请求超时')); });
        req.write(requestBody);
        req.end();
      });

      logger.info(`[Ollama] 收到回复 (${response.length} 字符)`);
      return response;

    } catch (err) {
      logger.error(`[Ollama] 请求失败: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * 发送消息并流式获取回复（README 5.3 流式实时解析）
   * 使用Ollama /api/chat 接口的stream模式，边接收边yield文本块
   */
  async *askStream(prompt: string, sessionId: string): AsyncIterableIterator<string> {
    logger.info(`[Ollama] 流式发送消息 (会话: ${sessionId.slice(0, 8)}..., 模型: ${this.model})`);

    const http = await import('http');
    const requestBody = JSON.stringify({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    });

    const url = new URL('/api/chat', this.endpoint);

    const responseStream = await new Promise<import('http').IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || '11434',
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody),
          },
        },
        (res) => resolve(res),
      );

      req.on('error', (err: Error) => reject(new Error(`Ollama连接失败: ${err.message}`)));
      req.setTimeout(120000, () => { req.destroy(); reject(new Error('Ollama请求超时')); });
      req.write(requestBody);
      req.end();
    });

    let buffer = '';
    for await (const chunk of responseStream) {
      buffer += chunk.toString();
      // Ollama流式响应每行是一个JSON对象
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后一个可能不完整的行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.message?.content) {
            yield parsed.message.content;
          }
          if (parsed.done) {
            return;
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    }

    // 处理缓冲区剩余内容
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        if (parsed.message?.content) {
          yield parsed.message.content;
        }
      } catch {
        // 忽略
      }
    }
  }

  /** 检查Ollama服务是否可用 */
  async isLoggedIn(): Promise<boolean> {
    try {
      const http = await import('http');
      const url = new URL('/api/tags', this.endpoint);

      return new Promise<boolean>((resolve) => {
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port || '11434',
            path: url.pathname,
            method: 'GET',
          },
          (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                // 检查是否有可用模型
                resolve(Array.isArray(parsed.models) && parsed.models.length > 0);
              } catch {
                resolve(false);
              }
            });
          }
        );
        req.on('error', () => resolve(false));
        req.setTimeout(5000, () => { req.destroy(); resolve(false); });
        req.end();
      });
    } catch {
      return false;
    }
  }

  /** 获取Ollama模型列表 */
  async listModels(): Promise<string[]> {
    try {
      const http = await import('http');
      const url = new URL('/api/tags', this.endpoint);

      return new Promise<string[]>((resolve) => {
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port || '11434',
            path: url.pathname,
            method: 'GET',
          },
          (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                resolve((parsed.models || []).map((m: { name: string }) => m.name));
              } catch {
                resolve([]);
              }
            });
          }
        );
        req.on('error', () => resolve([]));
        req.setTimeout(5000, () => { req.destroy(); resolve([]); });
        req.end();
      });
    } catch {
      return [];
    }
  }

  /** 获取登录URL（Ollama无需登录） */
  getLoginUrl(): string {
    return this.endpoint;
  }

  /** 设置模型 */
  setModel(model: string): void {
    this.model = model;
  }

  /** 获取当前模型 */
  getModel(): string {
    return this.model;
  }
}

/** 适配器类型联合 */
export type AnyAdapter = BaseAdapter | OllamaAdapter;

/**
 * 适配器工厂
 * 根据类型创建对应的AI适配器实例
 * Ollama类型创建OllamaAdapter（无需浏览器），其余创建BaseAdapter
 */
export class AdapterFactory {
  private bridge: BrowserBridge;
  private globalConfig: GlobalConfig;
  private adapters: Map<AdapterType, AnyAdapter> = new Map();

  constructor(bridge: BrowserBridge, globalConfig: GlobalConfig) {
    this.bridge = bridge;
    this.globalConfig = globalConfig;
  }

  /** 获取或创建适配器实例 */
  getAdapter(type: AdapterType): AnyAdapter {
    let adapter = this.adapters.get(type);
    if (!adapter) {
      if (type === 'ollama') {
        adapter = new OllamaAdapter(this.globalConfig);
      } else {
        adapter = new BaseAdapter(type, this.bridge, this.globalConfig);
      }
      this.adapters.set(type, adapter);
    }
    return adapter;
  }

  /** 获取当前默认适配器 */
  getDefaultAdapter(): AnyAdapter {
    return this.getAdapter(this.globalConfig.defaultAdapter);
  }

  /** 列出所有支持的适配器类型 */
  listAdapters(): Array<{ type: AdapterType; displayName: string; url: string }> {
    const webAdapters = Object.entries(ADAPTER_CONFIGS).map(([type, config]) => ({
      type: type as AdapterType,
      displayName: config.displayName,
      url: config.url,
    }));
    // 加入Ollama
    webAdapters.push({
      type: 'ollama',
      displayName: 'Ollama 本地模型',
      url: this.globalConfig.ollamaEndpoint || 'http://localhost:11434',
    });
    return webAdapters;
  }

  /** 检查适配器类型是否有效 */
  isValidType(type: string): type is AdapterType {
    return type in ADAPTER_CONFIGS || type === 'ollama';
  }
}