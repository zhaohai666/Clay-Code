/**
 * ClayCode 配置管理模块
 * 全局配置读写、持久化至 ~/.claycode/config.json
 * 敏感字段AES-256-CBC加密存储
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GlobalConfig, DEFAULT_CONFIG, AdapterType, CacheLevel } from '../types';
import { resolveHome, ensureDir, logger } from '../utils';
import { SecurityManager } from './security';

/** 配置目录和文件路径 */
const CONFIG_DIR = path.join(os.homedir(), '.claycode');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/** 需要加密的敏感字段 */
const SENSITIVE_FIELDS: (keyof GlobalConfig)[] = ['apiKey', 'proxyUrl', 'ollamaEndpoint'];

export class ConfigManager {
  private config: GlobalConfig;
  private security: SecurityManager;
  private configPath: string;

  constructor(configPath?: string) {
    this.security = new SecurityManager(process.cwd());
    this.configPath = configPath || CONFIG_FILE;
    this.config = this.loadFromDisk();
  }

  /** 从磁盘加载配置（文件优先，回退默认值） */
  private loadFromDisk(): GlobalConfig {
    const filePath = this.configPath;
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const userConfig = JSON.parse(raw) as Partial<GlobalConfig>;
        // 解密敏感字段
        this.decryptSensitiveFields(userConfig);
        return this.mergeConfig(DEFAULT_CONFIG, userConfig);
      }
    } catch (err) {
      logger.warn(`[ConfigManager] 加载配置失败，使用默认值: ${(err as Error).message}`);
    }
    return { ...DEFAULT_CONFIG };
  }

  /** 获取当前配置（只读副本） */
  getConfig(): GlobalConfig {
    return { ...this.config };
  }

  /** 获取单个配置项 */
  get<K extends keyof GlobalConfig>(key: K): GlobalConfig[K] {
    return this.config[key];
  }

  /** 设置单个配置项（支持字符串值自动转换） */
  set(key: string, value: string): void {
    if (!(key in this.config)) {
      logger.warn(`[ConfigManager] 未知配置项: ${key}`);
      return;
    }

    // 类型转换
    const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    const defaultValue = defaults[key];

    if (typeof defaultValue === 'number') {
      (this.config as unknown as Record<string, unknown>)[key] = Number(value);
    } else if (typeof defaultValue === 'boolean') {
      (this.config as unknown as Record<string, unknown>)[key] = value === 'true';
    } else if (Array.isArray(defaultValue)) {
      // 数组类型：逗号分隔
      (this.config as unknown as Record<string, unknown>)[key] = value.split(',').map(s => s.trim());
    } else {
      (this.config as unknown as Record<string, unknown>)[key] = value;
    }

    this.saveToDisk();
    logger.info(`[ConfigManager] 设置 ${key} = ${value}`);
  }

  /** 批量更新配置 */
  update(partial: Partial<GlobalConfig>): GlobalConfig {
    this.config = this.mergeConfig(this.config, partial);
    this.saveToDisk();
    return this.getConfig();
  }

  /** 重置为默认配置 */
  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.saveToDisk();
    logger.info('[ConfigManager] 配置已重置为默认值');
  }

  /** 保存配置到文件（敏感字段加密） */
  private saveToDisk(): void {
    const configDir = path.dirname(this.configPath);
    ensureDir(configDir);
    const dataToSave = { ...this.config } as Record<string, unknown>;
    // 加密敏感字段
    for (const field of SENSITIVE_FIELDS) {
      if (dataToSave[field] && typeof dataToSave[field] === 'string') {
        try {
          dataToSave[field] = this.security.encrypt(dataToSave[field] as string);
        } catch {
          logger.warn(`[ConfigManager] 加密字段 ${String(field)} 失败，明文存储`);
        }
      }
    }
    fs.writeFileSync(this.configPath, JSON.stringify(dataToSave, null, 2), 'utf-8');
  }

  /** 解密敏感字段 */
  private decryptSensitiveFields(config: Partial<GlobalConfig>): void {
    for (const field of SENSITIVE_FIELDS) {
      const value = config[field];
      if (value && typeof value === 'string') {
        try {
          // 尝试解密，如果失败则认为是明文
          const decrypted = this.security.decrypt(value as string);
          (config as Record<string, unknown>)[field as string] = decrypted;
        } catch {
          // 解密失败，保留原值（可能是明文）
        }
      }
    }
  }

  /** 列出所有配置项 */
  list(): Record<string, unknown> {
    return { ...this.config } as Record<string, unknown>;
  }

  /** 获取浏览器数据目录的绝对路径 */
  getBrowserDataPath(): string {
    return resolveHome(this.config.browserDataPath);
  }

  /** 获取会话目录的绝对路径 */
  getSessionDir(): string {
    return resolveHome(this.config.sessionDir);
  }

  /** 获取数据根目录的绝对路径 */
  getDataDir(): string {
    return resolveHome(this.config.dataDir);
  }

  /** 获取缓存目录的绝对路径 */
  getCacheDir(): string {
    return path.join(resolveHome(this.config.dataDir), 'cache');
  }

  /** 获取插件目录的绝对路径 */
  getPluginsDir(): string {
    return path.join(resolveHome(this.config.dataDir), 'plugins');
  }

  /** 获取日志目录的绝对路径 */
  getLogDir(): string {
    return path.join(resolveHome(this.config.dataDir), 'logs');
  }

  /** 获取临时目录的绝对路径 */
  getTempDir(): string {
    return path.join(resolveHome(this.config.dataDir), 'temp');
  }

  /** 确保所有必要目录存在 */
  ensureAllDirs(): void {
    const dirs = [
      CONFIG_DIR,
      this.getDataDir(),
      this.getBrowserDataPath(),
      this.getSessionDir(),
      this.getCacheDir(),
      this.getPluginsDir(),
      this.getLogDir(),
      this.getTempDir(),
    ];
    for (const dir of dirs) {
      ensureDir(dir);
    }
  }

  /** 合并配置（用户配置覆盖默认值） */
  private mergeConfig(base: GlobalConfig, override: Partial<GlobalConfig>): GlobalConfig {
    return {
      defaultAdapter: override.defaultAdapter ?? base.defaultAdapter,
      dataDir: override.dataDir ?? base.dataDir,
      browserDataPath: override.browserDataPath ?? base.browserDataPath,
      chromePath: override.chromePath ?? base.chromePath,
      sessionDir: override.sessionDir ?? base.sessionDir,
      maxContextChunk: override.maxContextChunk ?? base.maxContextChunk,
      maxHistoryMessages: override.maxHistoryMessages ?? base.maxHistoryMessages,
      requestTimeout: override.requestTimeout ?? base.requestTimeout,
      responseTimeout: override.responseTimeout ?? base.responseTimeout,
      autoSyncExecuteLog: override.autoSyncExecuteLog ?? base.autoSyncExecuteLog,
      browserHeadless: override.browserHeadless ?? base.browserHeadless,
      execWhiteList: override.execWhiteList ?? base.execWhiteList,
      enableSandbox: override.enableSandbox ?? base.enableSandbox,
      cacheLevel: override.cacheLevel ?? base.cacheLevel,
      maxBatchFiles: override.maxBatchFiles ?? base.maxBatchFiles,
      browserIdleTimeout: override.browserIdleTimeout ?? base.browserIdleTimeout,
      maxRetryCount: override.maxRetryCount ?? base.maxRetryCount,
      ollamaEndpoint: override.ollamaEndpoint ?? base.ollamaEndpoint,
      enableDockerSandbox: override.enableDockerSandbox ?? base.enableDockerSandbox,
      metricsPort: override.metricsPort ?? base.metricsPort,
      apiKey: override.apiKey ?? base.apiKey,
      proxyUrl: override.proxyUrl ?? base.proxyUrl,
    };
  }
}

/** 配置管理单例（兼容旧名） */
export const configService = new ConfigManager();