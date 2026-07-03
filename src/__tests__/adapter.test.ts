import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaAdapter, AdapterFactory, BaseAdapter, AnyAdapter } from '../core/adapter';
import { DEFAULT_CONFIG, AdapterType } from '../types';
import { BrowserBridge } from '../core/browser';

// Mock BrowserBridge - 使用class mock确保是有效的构造函数
vi.mock('../core/browser', () => {
  class MockBrowserBridge {
    navigateTo = vi.fn().mockResolvedValue(undefined);
    typeAndSend = vi.fn().mockResolvedValue(undefined);
    waitForResponse = vi.fn().mockResolvedValue('AI response');
    close = vi.fn().mockResolvedValue(undefined);
    getInfo = vi.fn().mockReturnValue({ status: 'idle', restartCount: 0 });
  }
  return { BrowserBridge: MockBrowserBridge };
});

describe('OllamaAdapter', () => {
  let adapter: OllamaAdapter;

  beforeEach(() => {
    adapter = new OllamaAdapter(DEFAULT_CONFIG, 'llama3');
  });

  it('应正确初始化', () => {
    expect(adapter.name).toBe('ollama');
    expect(adapter.displayName).toBe('Ollama 本地模型');
    expect(adapter.getModel()).toBe('llama3');
  });

  it('应支持设置模型', () => {
    adapter.setModel('mistral');
    expect(adapter.getModel()).toBe('mistral');
  });

  it('getLoginUrl应返回endpoint', () => {
    expect(adapter.getLoginUrl()).toBe(DEFAULT_CONFIG.ollamaEndpoint);
  });

  it('应使用自定义endpoint', () => {
    const customConfig = { ...DEFAULT_CONFIG, ollamaEndpoint: 'http://custom:11434' };
    const customAdapter = new OllamaAdapter(customConfig, 'llama3');
    expect(customAdapter.getLoginUrl()).toBe('http://custom:11434');
  });
});

describe('BaseAdapter', () => {
  it('应正确初始化doubao适配器', () => {
    const bridge = new BrowserBridge(DEFAULT_CONFIG);
    const adapter = new BaseAdapter('doubao', bridge, DEFAULT_CONFIG);
    expect(adapter.name).toBe('doubao');
    expect(adapter.displayName).toBe('豆包');
    expect(adapter.url).toBe('https://www.doubao.com/chat/');
  });

  it('应正确初始化chatgpt-web适配器', () => {
    const bridge = new BrowserBridge(DEFAULT_CONFIG);
    const adapter = new BaseAdapter('chatgpt-web', bridge, DEFAULT_CONFIG);
    expect(adapter.name).toBe('chatgpt-web');
    expect(adapter.displayName).toBe('ChatGPT 网页版');
  });

  it('应正确初始化claude-web适配器', () => {
    const bridge = new BrowserBridge(DEFAULT_CONFIG);
    const adapter = new BaseAdapter('claude-web', bridge, DEFAULT_CONFIG);
    expect(adapter.name).toBe('claude-web');
    expect(adapter.displayName).toBe('Claude 网页版');
  });
});

describe('AdapterFactory', () => {
  let factory: AdapterFactory;
  let bridge: BrowserBridge;

  beforeEach(() => {
    bridge = new BrowserBridge(DEFAULT_CONFIG);
    factory = new AdapterFactory(bridge, DEFAULT_CONFIG);
  });

  it('应为ollama类型创建OllamaAdapter', () => {
    const adapter = factory.getAdapter('ollama');
    expect(adapter).toBeInstanceOf(OllamaAdapter);
    expect(adapter.name).toBe('ollama');
  });

  it('应为doubao类型创建BaseAdapter', () => {
    const adapter = factory.getAdapter('doubao');
    expect(adapter).toBeInstanceOf(BaseAdapter);
    expect(adapter.name).toBe('doubao');
  });

  it('应缓存适配器实例', () => {
    const adapter1 = factory.getAdapter('doubao');
    const adapter2 = factory.getAdapter('doubao');
    expect(adapter1).toBe(adapter2);
  });

  it('getDefaultAdapter应返回默认适配器', () => {
    const adapter = factory.getDefaultAdapter();
    expect(adapter.name).toBe(DEFAULT_CONFIG.defaultAdapter);
  });

  it('listAdapters应包含ollama', () => {
    const adapters = factory.listAdapters();
    const ollamaEntry = adapters.find(a => a.type === 'ollama');
    expect(ollamaEntry).toBeDefined();
    expect(ollamaEntry!.displayName).toBe('Ollama 本地模型');
  });

  it('listAdapters应包含所有网页适配器', () => {
    const adapters = factory.listAdapters();
    const types = adapters.map(a => a.type);
    expect(types).toContain('doubao');
    expect(types).toContain('chatgpt-web');
    expect(types).toContain('claude-web');
    expect(types).toContain('ollama');
  });

  it('isValidType应识别所有有效类型', () => {
    expect(factory.isValidType('doubao')).toBe(true);
    expect(factory.isValidType('chatgpt-web')).toBe(true);
    expect(factory.isValidType('claude-web')).toBe(true);
    expect(factory.isValidType('ollama')).toBe(true);
    expect(factory.isValidType('invalid')).toBe(false);
  });
});