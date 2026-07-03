import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager } from '../core/config';
import { DEFAULT_CONFIG, GlobalConfig } from '../types';

describe('ConfigManager', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `claycode-config-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- 配置加载 ----
  describe('loadFromDisk', () => {
    it('配置文件不存在时应返回默认配置', () => {
      const cm = new ConfigManager(path.join(tmpDir, 'nonexistent.json'));
      const config = cm.getConfig();
      expect(config.defaultAdapter).toBe(DEFAULT_CONFIG.defaultAdapter);
      expect(config.maxContextChunk).toBe(DEFAULT_CONFIG.maxContextChunk);
    });

    it('配置文件存在时应加载并合并', () => {
      const userConfig = { defaultAdapter: 'chatgpt-web' as const, maxContextChunk: 20000 };
      fs.writeFileSync(configPath, JSON.stringify(userConfig));

      const cm = new ConfigManager(configPath);
      const config = cm.getConfig();
      expect(config.defaultAdapter).toBe('chatgpt-web');
      expect(config.maxContextChunk).toBe(20000);
      // 其他字段应保留默认值
      expect(config.browserHeadless).toBe(DEFAULT_CONFIG.browserHeadless);
    });

    it('配置文件损坏时应回退默认值', () => {
      fs.writeFileSync(configPath, 'invalid json {{{');

      const cm = new ConfigManager(configPath);
      const config = cm.getConfig();
      expect(config.defaultAdapter).toBe(DEFAULT_CONFIG.defaultAdapter);
    });
  });

  // ---- 配置读取 ----
  describe('get/getConfig', () => {
    it('getConfig应返回配置的只读副本', () => {
      const cm = new ConfigManager(path.join(tmpDir, 'nonexistent.json'));
      const config1 = cm.getConfig();
      const config2 = cm.getConfig();
      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2); // 不同引用
    });

    it('get应返回单个配置项', () => {
      const cm = new ConfigManager(path.join(tmpDir, 'nonexistent.json'));
      expect(cm.get('defaultAdapter')).toBe('doubao');
      expect(cm.get('maxContextChunk')).toBe(12000);
      expect(cm.get('execWhiteList')).toEqual(DEFAULT_CONFIG.execWhiteList);
    });
  });

  // ---- 配置写入 ----
  describe('set', () => {
    it('set应更新字符串配置项并持久化', () => {
      const cm = new ConfigManager(configPath);
      cm.set('defaultAdapter', 'claude-web');
      expect(cm.get('defaultAdapter')).toBe('claude-web');

      // 验证持久化
      const cm2 = new ConfigManager(configPath);
      expect(cm2.get('defaultAdapter')).toBe('claude-web');
    });

    it('set应自动转换数字类型', () => {
      const cm = new ConfigManager(configPath);
      cm.set('maxContextChunk', '50000');
      expect(cm.get('maxContextChunk')).toBe(50000);
    });

    it('set应自动转换布尔类型', () => {
      const cm = new ConfigManager(configPath);
      cm.set('browserHeadless', 'true');
      expect(cm.get('browserHeadless')).toBe(true);
      cm.set('browserHeadless', 'false');
      expect(cm.get('browserHeadless')).toBe(false);
    });

    it('set应自动转换数组类型(逗号分隔)', () => {
      const cm = new ConfigManager(configPath);
      cm.set('execWhiteList', 'git,npm,python');
      expect(cm.get('execWhiteList')).toEqual(['git', 'npm', 'python']);
    });

    it('set未知配置项应忽略', () => {
      const cm = new ConfigManager(configPath);
      const before = cm.getConfig();
      cm.set('unknownKey', 'value');
      expect(cm.getConfig()).toEqual(before);
    });
  });

  // ---- 批量更新与重置 ----
  describe('update/reset', () => {
    it('update应批量合并配置', () => {
      const cm = new ConfigManager(configPath);
      const result = cm.update({ defaultAdapter: 'claude-web', maxContextChunk: 99999 });
      expect(result.defaultAdapter).toBe('claude-web');
      expect(result.maxContextChunk).toBe(99999);
      expect(result.browserHeadless).toBe(DEFAULT_CONFIG.browserHeadless);
    });

    it('reset应恢复默认配置', () => {
      const cm = new ConfigManager(configPath);
      cm.set('defaultAdapter', 'claude-web');
      cm.reset();
      expect(cm.get('defaultAdapter')).toBe('doubao');
    });
  });

  // ---- list ----
  describe('list', () => {
    it('list应返回所有配置项', () => {
      const cm = new ConfigManager(path.join(tmpDir, 'nonexistent.json'));
      const list = cm.list();
      expect(list.defaultAdapter).toBe('doubao');
      expect(list.maxContextChunk).toBe(12000);
      expect(Object.keys(list).length).toBeGreaterThan(0);
    });
  });

  // ---- 目录方法 ----
  describe('目录方法', () => {
    it('getCacheDir应返回dataDir下的cache目录', () => {
      const cm = new ConfigManager(path.join(tmpDir, 'nonexistent.json'));
      const cacheDir = cm.getCacheDir();
      expect(cacheDir).toContain('cache');
      expect(cacheDir).not.toContain('~');
    });

    it('getPluginsDir应返回dataDir下的plugins目录', () => {
      const cm = new ConfigManager(path.join(tmpDir, 'nonexistent.json'));
      expect(cm.getPluginsDir()).toContain('plugins');
    });

    it('getLogDir应返回dataDir下的logs目录', () => {
      const cm = new ConfigManager(path.join(tmpDir, 'nonexistent.json'));
      expect(cm.getLogDir()).toContain('logs');
    });

    it('getTempDir应返回dataDir下的temp目录', () => {
      const cm = new ConfigManager(path.join(tmpDir, 'nonexistent.json'));
      expect(cm.getTempDir()).toContain('temp');
    });

    it('getSessionDir应解析~路径', () => {
      const cm = new ConfigManager(path.join(tmpDir, 'nonexistent.json'));
      const sessionDir = cm.getSessionDir();
      expect(sessionDir).not.toContain('~');
      expect(sessionDir).toContain(os.homedir());
    });

    it('getDataDir应解析~路径', () => {
      const cm = new ConfigManager(path.join(tmpDir, 'nonexistent.json'));
      const dataDir = cm.getDataDir();
      expect(dataDir).not.toContain('~');
    });

    it('getBrowserDataPath应解析~路径', () => {
      const cm = new ConfigManager(path.join(tmpDir, 'nonexistent.json'));
      const browserPath = cm.getBrowserDataPath();
      expect(browserPath).not.toContain('~');
    });
  });

  // ---- ensureAllDirs ----
  describe('ensureAllDirs', () => {
    it('ensureAllDirs应创建所有必要目录', () => {
      // 使用临时目录作为dataDir
      const testConfigPath = path.join(tmpDir, 'test-config.json');
      const cm = new ConfigManager(testConfigPath);
      cm.update({ dataDir: tmpDir } as Partial<GlobalConfig>);
      cm.ensureAllDirs();

      expect(fs.existsSync(cm.getCacheDir())).toBe(true);
      expect(fs.existsSync(cm.getPluginsDir())).toBe(true);
      expect(fs.existsSync(cm.getLogDir())).toBe(true);
      expect(fs.existsSync(cm.getTempDir())).toBe(true);
    });
  });
});