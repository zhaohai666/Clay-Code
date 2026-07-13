/**
 * ClayCode 插件系统
 * adapter/tool/hook三类插件，setup/beforeAiRequest/afterToolExecute/destroy生命周期
 * ~/.claycode/plugins/ 自动扫描加载
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  PluginType,
  PluginLifecycle,
  PluginDescriptor,
  PluginInstance,
  ToolCall,
  ExecuteResult,
} from '../types';
import { logger } from '../utils';

/** 插件钩子上下文 */
export interface PluginContext {
  /** 当前会话ID */
  sessionId?: string;
  /** 当前适配器名称 */
  adapterName?: string;
  /** 请求时间戳 */
  timestamp: number;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/** 插件钩子结果 */
export interface PluginHookResult {
  /** 是否继续执行后续插件 */
  proceed: boolean;
  /** 修改后的数据（如果插件修改了输入） */
  modifiedData?: unknown;
  /** 错误信息 */
  error?: string;
}

/**
 * 插件管理器
 * 负责插件的发现、加载、生命周期管理和钩子调度
 */
export class PluginManager {
  private plugins: Map<string, PluginInstance> = new Map();
  private pluginsDir: string;
  private initialized: boolean = false;
  /** 文件修改时间记录（用于热重载变更检测） */
  private pluginMtimes: Map<string, number> = new Map();
  /** 文件监听器 */
  private watcher: fs.FSWatcher | null = null;
  /** 防抖定时器 */
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(pluginsDir?: string) {
    this.pluginsDir = pluginsDir ?? path.join(process.env.HOME ?? '~', '.claycode', 'plugins');
  }

  // ---- 插件发现与加载 ----

  /** 扫描plugins目录，加载所有合法插件 */
  async loadAll(): Promise<{ loaded: number; failed: number; errors: string[] }> {
    const result = { loaded: 0, failed: 0, errors: [] as string[] };

    if (!fs.existsSync(this.pluginsDir)) {
      logger.info(`[PluginManager] 插件目录不存在: ${this.pluginsDir}`);
      return result;
    }

    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pluginDir = path.join(this.pluginsDir, entry.name);
        try {
          await this.loadPlugin(pluginDir);
          result.loaded++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          result.failed++;
          result.errors.push(`${entry.name}: ${message}`);
          logger.warn(`[PluginManager] 插件加载失败 ${entry.name}: ${message}`);
        }
      }
    }

    logger.info(`[PluginManager] 加载完成: ${result.loaded}成功, ${result.failed}失败`);
    this.recordMtimes();
    return result;
  }

  /** 加载单个插件目录 */
  async loadPlugin(pluginDir: string): Promise<PluginInstance> {
    const descriptorPath = path.join(pluginDir, 'plugin.json');
    if (!fs.existsSync(descriptorPath)) {
      throw new Error(`缺少 plugin.json 描述文件: ${descriptorPath}`);
    }

    const raw = fs.readFileSync(descriptorPath, 'utf8');
    const descriptor: PluginDescriptor = JSON.parse(raw);

    // 校验描述符
    this.validateDescriptor(descriptor);

    // 尝试加载插件入口
    const entryPath = path.join(pluginDir, descriptor.main);
    if (!fs.existsSync(entryPath)) {
      throw new Error(`插件入口文件不存在: ${entryPath}`);
    }

    // 动态导入插件模块
    let pluginModule: Record<string, unknown>;
    try {
      pluginModule = await import(entryPath);
    } catch (err: unknown) {
      throw new Error(`插件导入失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 提取生命周期钩子
    const instance: PluginInstance = {
      descriptor,
      hooks: {
        setup: this.extractHook(pluginModule, 'setup'),
        beforeAiRequest: this.extractHook(pluginModule, 'beforeAiRequest'),
        afterToolExecute: this.extractHook(pluginModule, 'afterToolExecute'),
        destroy: this.extractHook(pluginModule, 'destroy'),
      },
      state: 'loaded',
      loadedAt: Date.now(),
    };

    // 检查重名插件
    if (this.plugins.has(descriptor.name)) {
      throw new Error(`插件名称冲突: ${descriptor.name}`);
    }

    this.plugins.set(descriptor.name, instance);
    logger.info(`[PluginManager] 插件已加载: ${descriptor.name} v${descriptor.version} (${descriptor.type})`);
    return instance;
  }

  /** 校验插件描述符 */
  private validateDescriptor(desc: PluginDescriptor): void {
    if (!desc.name || typeof desc.name !== 'string') {
      throw new Error('plugin.json 缺少有效的 name 字段');
    }
    if (!desc.version || typeof desc.version !== 'string') {
      throw new Error('plugin.json 缺少有效的 version 字段');
    }
    if (!desc.type || !['adapter', 'tool', 'hook'].includes(desc.type)) {
      throw new Error('plugin.json type 必须为 adapter/tool/hook');
    }
    if (!desc.main || typeof desc.main !== 'string') {
      throw new Error('plugin.json 缺少有效的 main 字段');
    }
  }

  /** 从模块中提取钩子函数 */
  private extractHook(mod: Record<string, unknown>, hookName: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
    const fn = mod[hookName];
    if (fn && typeof fn === 'function') {
      return fn as (...args: unknown[]) => Promise<unknown>;
    }
    return undefined;
  }

  // ---- 生命周期管理 ----

  /** 初始化所有插件（调用setup钩子） */
  async setupAll(): Promise<void> {
    for (const [name, plugin] of this.plugins) {
      if (plugin.hooks.setup) {
        try {
          await plugin.hooks.setup(plugin.descriptor);
          plugin.state = 'active';
          logger.debug(`[PluginManager] 插件setup完成: ${name}`);
        } catch (err: unknown) {
          plugin.state = 'error';
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[PluginManager] 插件setup失败 ${name}: ${message}`);
        }
      } else {
        plugin.state = 'active';
      }
    }
    this.initialized = true;
  }

  /** 销毁所有插件（调用destroy钩子） */
  async destroyAll(): Promise<void> {
    for (const [name, plugin] of this.plugins) {
      if (plugin.hooks.destroy) {
        try {
          await plugin.hooks.destroy();
          logger.debug(`[PluginManager] 插件destroy完成: ${name}`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[PluginManager] 插件destroy失败 ${name}: ${message}`);
        }
      }
      plugin.state = 'destroyed';
    }
    this.plugins.clear();
    this.initialized = false;
  }

  // ---- 钩子调度 ----

  /** 调用beforeAiRequest钩子 */
  async beforeAiRequest(context: PluginContext): Promise<PluginHookResult> {
    return this.dispatchHook('beforeAiRequest', context);
  }

  /** 调用afterToolExecute钩子 */
  async afterToolExecute(toolCall: ToolCall, result: ExecuteResult, context: PluginContext): Promise<PluginHookResult> {
    return this.dispatchHook('afterToolExecute', { toolCall, result, context });
  }

  /** 通用钩子调度 */
  private async dispatchHook(hookName: keyof PluginInstance['hooks'], data: unknown): Promise<PluginHookResult> {
    let proceed = true;
    let modifiedData = data;

    for (const [name, plugin] of this.plugins) {
      if (plugin.state !== 'active') continue;
      const hook = plugin.hooks[hookName];
      if (!hook) continue;

      try {
        const hookResult = await hook(modifiedData);
        if (hookResult && typeof hookResult === 'object') {
          const result = hookResult as PluginHookResult;
          if (result.modifiedData !== undefined) {
            modifiedData = result.modifiedData;
          }
          if (result.proceed === false) {
            proceed = false;
            logger.info(`[PluginManager] 插件 ${name} 中断了 ${hookName} 钩子链`);
            break;
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[PluginManager] 插件 ${name} 钩子 ${hookName} 执行失败: ${message}`);
      }
    }

    return { proceed, modifiedData };
  }

  // ---- 查询接口 ----

  /** 获取所有已加载插件 */
  getPlugins(): PluginInstance[] {
    return Array.from(this.plugins.values());
  }

  /** 按类型获取插件 */
  getPluginsByType(type: PluginType): PluginInstance[] {
    return Array.from(this.plugins.values()).filter(p => p.descriptor.type === type);
  }

  /** 获取指定插件 */
  getPlugin(name: string): PluginInstance | undefined {
    return this.plugins.get(name);
  }

  /** 卸载指定插件 */
  async unloadPlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    if (plugin.hooks.destroy) {
      try {
        await plugin.hooks.destroy();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[PluginManager] 插件destroy失败 ${name}: ${message}`);
      }
    }

    this.plugins.delete(name);
    logger.info(`[PluginManager] 插件已卸载: ${name}`);
    return true;
  }

  /** 是否已初始化 */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ---- 热重载（README 2.3.2） ----

  /** 重新加载指定插件（卸载→清缓存→重新加载） */
  async reloadPlugin(name: string): Promise<PluginInstance | null> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      logger.warn(`[PluginManager] 热重载失败: 插件 ${name} 未加载`);
      return null;
    }

    const pluginDir = path.dirname(path.join(this.pluginsDir, plugin.descriptor.name));
    const descriptorDir = this.findPluginDir(name);

    // 1. 调用destroy钩子
    if (plugin.hooks.destroy) {
      try {
        await plugin.hooks.destroy();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[PluginManager] 热重载: 插件 ${name} destroy失败: ${message}`);
      }
    }

    // 2. 从映射中移除
    this.plugins.delete(name);

    // 3. 清除Node.js模块缓存
    this.invalidateModuleCache(name);

    // 4. 重新加载
    if (descriptorDir) {
      try {
        const instance = await this.loadPlugin(descriptorDir);
        if (this.initialized && instance.hooks.setup) {
          await instance.hooks.setup(instance.descriptor);
          instance.state = 'active';
        }
        logger.info(`[PluginManager] 插件热重载成功: ${name}`);
        return instance;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[PluginManager] 插件热重载失败 ${name}: ${message}`);
        return null;
      }
    }

    logger.warn(`[PluginManager] 热重载失败: 找不到插件 ${name} 的目录`);
    return null;
  }

  /** 扫描插件目录，热重载已变更的插件、加载新增插件 */
  async hotReload(): Promise<{ reloaded: string[]; added: string[]; removed: string[]; errors: string[] }> {
    const result = { reloaded: [] as string[], added: [] as string[], removed: [] as string[], errors: [] as string[] };

    if (!fs.existsSync(this.pluginsDir)) {
      return result;
    }

    // 1. 检测已变更的插件（通过plugin.json修改时间）
    const currentPlugins = new Set<string>();
    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(this.pluginsDir, entry.name);
      const descriptorPath = path.join(pluginDir, 'plugin.json');

      if (!fs.existsSync(descriptorPath)) continue;

      currentPlugins.add(entry.name);
      const stat = fs.statSync(descriptorPath);
      const mtime = stat.mtimeMs;
      const prevMtime = this.pluginMtimes.get(entry.name);

      if (this.plugins.has(entry.name)) {
        // 已加载的插件：检查是否变更
        if (prevMtime !== undefined && mtime > prevMtime) {
          const instance = await this.reloadPlugin(entry.name);
          if (instance) {
            result.reloaded.push(entry.name);
            this.pluginMtimes.set(entry.name, mtime);
          } else {
            result.errors.push(entry.name);
          }
        }
      } else {
        // 新增插件
        try {
          await this.loadPlugin(pluginDir);
          if (this.initialized) {
            const plugin = this.plugins.get(entry.name);
            if (plugin?.hooks.setup) {
              await plugin.hooks.setup(plugin.descriptor);
              plugin.state = 'active';
            } else if (plugin) {
              plugin.state = 'active';
            }
          }
          result.added.push(entry.name);
          this.pluginMtimes.set(entry.name, mtime);
          logger.info(`[PluginManager] 热重载: 新增插件 ${entry.name}`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(`${entry.name}: ${message}`);
        }
      }
    }

    // 2. 检测已删除的插件
    for (const name of this.plugins.keys()) {
      if (!currentPlugins.has(name)) {
        await this.unloadPlugin(name);
        result.removed.push(name);
        this.pluginMtimes.delete(name);
        logger.info(`[PluginManager] 热重载: 移除插件 ${name}`);
      }
    }

    if (result.reloaded.length + result.added.length + result.removed.length > 0) {
      logger.info(`[PluginManager] 热重载完成: ${result.reloaded.length}重载, ${result.added.length}新增, ${result.removed.length}移除`);
    }

    return result;
  }

  /** 启动插件目录文件监听（自动热重载） */
  watchPlugins(): void {
    if (this.watcher) {
      logger.warn('[PluginManager] 文件监听已在运行');
      return;
    }

    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
    }

    this.watcher = fs.watch(this.pluginsDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      // 只关注plugin.json和.js/.ts文件变更
      if (filename.endsWith('plugin.json') || filename.endsWith('.js') || filename.endsWith('.ts')) {
        logger.debug(`[PluginManager] 检测到文件变更: ${filename}`);

        // 防抖：500ms内多次变更只触发一次
        if (this.reloadTimer) {
          clearTimeout(this.reloadTimer);
        }
        this.reloadTimer = setTimeout(() => {
          this.hotReload().catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`[PluginManager] 自动热重载失败: ${message}`);
          });
          this.reloadTimer = null;
        }, 500);
      }
    });

    logger.info(`[PluginManager] 已启动插件目录监听: ${this.pluginsDir}`);
  }

  /** 停止插件目录文件监听 */
  stopWatching(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      logger.info('[PluginManager] 已停止插件目录监听');
    }
  }

  /** 查找插件目录路径 */
  private findPluginDir(name: string): string | null {
    const pluginDir = path.join(this.pluginsDir, name);
    if (fs.existsSync(pluginDir) && fs.existsSync(path.join(pluginDir, 'plugin.json'))) {
      return pluginDir;
    }
    return null;
  }

  /** 清除插件的Node.js模块缓存 */
  private invalidateModuleCache(name: string): void {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    const entryPath = path.join(this.pluginsDir, plugin.descriptor.name, plugin.descriptor.main);

    // 清除require缓存中与该插件相关的所有模块
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(this.pluginsDir)) {
        delete require.cache[key];
      }
    }

    logger.debug(`[PluginManager] 已清除插件 ${name} 的模块缓存`);
  }

  /** 记录所有已加载插件的修改时间（用于后续变更检测） */
  recordMtimes(): void {
    for (const [name, plugin] of this.plugins) {
      const descriptorPath = path.join(this.pluginsDir, plugin.descriptor.name, 'plugin.json');
      if (fs.existsSync(descriptorPath)) {
        const stat = fs.statSync(descriptorPath);
        this.pluginMtimes.set(name, stat.mtimeMs);
      }
    }
  }
}