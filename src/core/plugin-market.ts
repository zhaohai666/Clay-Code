/**
 * ClayCode 插件市场管理（V1.1）
 * 本地注册表 + 远程注册表URL（可配置）
 * 支持：search / install / info / publish / list
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { PluginMarketEntry, PluginMarketSearchResult, PluginType } from '../types';
import { logger, resolveHome } from '../utils';

/** 插件市场注册表 */
interface MarketRegistry {
  /** 注册表版本 */
  version: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 插件条目列表 */
  entries: PluginMarketEntry[];
}

/**
 * 插件市场管理器
 * V1.1简易市场：本地注册表 + 可选远程URL同步
 */
export class PluginMarketManager {
  private registryPath: string;
  private registry: MarketRegistry;
  private remoteUrl: string | null;

  constructor(options?: { registryDir?: string; remoteUrl?: string }) {
    const dir = options?.registryDir ?? path.join(resolveHome('~'), '.claycode', 'plugins');
    this.registryPath = path.join(dir, 'market-registry.json');
    this.remoteUrl = options?.remoteUrl ?? null;
    this.registry = this.loadRegistry();
  }

  // ---- 搜索 ----

  /** 搜索插件市场 */
  search(keyword: string, options?: { type?: PluginType; limit?: number }): PluginMarketSearchResult {
    const limit = options?.limit ?? 20;
    let entries = this.registry.entries;

    // 按类型过滤
    if (options?.type) {
      entries = entries.filter(e => e.type === options.type);
    }

    // 按关键词搜索（名称、描述、标签）
    if (keyword) {
      const kw = keyword.toLowerCase();
      entries = entries.filter(e =>
        e.name.toLowerCase().includes(kw) ||
        e.description.toLowerCase().includes(kw) ||
        e.tags.some(t => t.toLowerCase().includes(kw)) ||
        e.author.toLowerCase().includes(kw)
      );
    }

    // 按下载量排序
    entries.sort((a, b) => b.downloads - a.downloads);

    return {
      entries: entries.slice(0, limit),
      keyword,
      total: entries.length,
    };
  }

  // ---- 安装 ----

  /** 从市场安装插件 */
  async install(name: string, pluginsDir: string): Promise<{ success: boolean; message: string }> {
    const entry = this.registry.entries.find(e => e.name === name);
    if (!entry) {
      return { success: false, message: `市场中未找到插件: ${name}` };
    }

    const pluginDir = path.join(pluginsDir, entry.name);
    if (fs.existsSync(pluginDir)) {
      return { success: false, message: `插件 ${name} 已安装，请先卸载后再安装` };
    }

    try {
      // 判断来源：本地路径 vs 远程URL
      if (entry.sourceUrl.startsWith('file://') || entry.sourceUrl.startsWith('/') || entry.sourceUrl.startsWith('.')) {
        // 本地路径安装
        const sourcePath = entry.sourceUrl.replace(/^file:\/\//, '');
        await this.installFromLocal(sourcePath, pluginDir, entry);
      } else if (entry.sourceUrl.startsWith('http://') || entry.sourceUrl.startsWith('https://')) {
        // 远程URL安装
        await this.installFromRemote(entry.sourceUrl, pluginDir, entry);
      } else {
        // 尝试作为npm包安装
        await this.installFromNpm(entry.sourceUrl, pluginDir, entry);
      }

      // 更新下载次数
      entry.downloads++;
      this.saveRegistry();

      return { success: true, message: `插件 ${name} v${entry.version} 安装成功` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[PluginMarket] 安装插件失败: ${message}`);
      return { success: false, message: `安装失败: ${message}` };
    }
  }

  // ---- 信息查询 ----

  /** 获取插件详细信息 */
  info(name: string): PluginMarketEntry | null {
    return this.registry.entries.find(e => e.name === name) ?? null;
  }

  // ---- 发布 ----

  /** 发布插件到市场注册表 */
  publish(entry: Omit<PluginMarketEntry, 'downloads' | 'publishedAt' | 'updatedAt'>): { success: boolean; message: string } {
    // 检查是否已存在
    const existing = this.registry.entries.find(e => e.name === entry.name);
    if (existing) {
      // 更新版本
      existing.version = entry.version;
      existing.description = entry.description;
      existing.author = entry.author;
      existing.sourceUrl = entry.sourceUrl;
      existing.tags = entry.tags;
      existing.type = entry.type;
      existing.updatedAt = Date.now();
      this.saveRegistry();
      return { success: true, message: `插件 ${entry.name} 已更新至 v${entry.version}` };
    }

    // 新增条目
    const now = Date.now();
    const newEntry: PluginMarketEntry = {
      ...entry,
      downloads: 0,
      publishedAt: now,
      updatedAt: now,
    };
    this.registry.entries.push(newEntry);
    this.registry.updatedAt = now;
    this.saveRegistry();

    return { success: true, message: `插件 ${entry.name} v${entry.version} 已发布到市场` };
  }

  // ---- 列表 ----

  /** 列出市场所有插件 */
  list(options?: { type?: PluginType; sort?: 'downloads' | 'updated' }): PluginMarketEntry[] {
    let entries = [...this.registry.entries];

    if (options?.type) {
      entries = entries.filter(e => e.type === options.type);
    }

    const sort = options?.sort ?? 'downloads';
    if (sort === 'downloads') {
      entries.sort((a, b) => b.downloads - a.downloads);
    } else if (sort === 'updated') {
      entries.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    return entries;
  }

  // ---- 远程同步 ----

  /** 从远程URL同步注册表 */
  async syncFromRemote(): Promise<{ success: boolean; synced: number; message: string }> {
    if (!this.remoteUrl) {
      return { success: false, synced: 0, message: '未配置远程注册表URL' };
    }

    try {
      const remoteData = await this.fetchRemote(this.remoteUrl);
      const remoteRegistry: MarketRegistry = JSON.parse(remoteData);

      if (!remoteRegistry.entries || !Array.isArray(remoteRegistry.entries)) {
        return { success: false, synced: 0, message: '远程注册表格式无效' };
      }

      // 合并远程条目（本地条目优先）
      const localNames = new Set(this.registry.entries.map(e => e.name));
      let synced = 0;
      for (const entry of remoteRegistry.entries) {
        if (!localNames.has(entry.name)) {
          this.registry.entries.push(entry);
          synced++;
        }
      }

      this.registry.updatedAt = Date.now();
      this.saveRegistry();

      return { success: true, synced, message: `已同步 ${synced} 个新插件` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, synced: 0, message: `同步失败: ${message}` };
    }
  }

  // ---- 内部方法 ----

  /** 加载本地注册表 */
  private loadRegistry(): MarketRegistry {
    if (!fs.existsSync(this.registryPath)) {
      // 初始化空注册表
      const empty: MarketRegistry = {
        version: 1,
        updatedAt: Date.now(),
        entries: this.getBuiltinEntries(),
      };
      this.saveRegistryFile(empty);
      return empty;
    }

    try {
      const raw = fs.readFileSync(this.registryPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      logger.warn('[PluginMarket] 注册表损坏，重新初始化');
      const empty: MarketRegistry = {
        version: 1,
        updatedAt: Date.now(),
        entries: this.getBuiltinEntries(),
      };
      this.saveRegistryFile(empty);
      return empty;
    }
  }

  /** 保存注册表 */
  private saveRegistry(): void {
    this.registry.updatedAt = Date.now();
    this.saveRegistryFile(this.registry);
  }

  /** 保存注册表文件 */
  private saveRegistryFile(registry: MarketRegistry): void {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), 'utf8');
  }

  /** 内置示例插件条目 */
  private getBuiltinEntries(): PluginMarketEntry[] {
    return [
      {
        name: 'claycode-adapter-chatgpt',
        version: '1.0.0',
        type: 'adapter' as PluginType,
        description: 'ChatGPT网页版适配器插件',
        author: 'ClayCode',
        sourceUrl: 'builtin://chatgpt-web',
        tags: ['adapter', 'chatgpt', 'web'],
        downloads: 100,
        publishedAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        name: 'claycode-adapter-doubao',
        version: '1.0.0',
        type: 'adapter' as PluginType,
        description: '豆包网页版适配器插件',
        author: 'ClayCode',
        sourceUrl: 'builtin://doubao',
        tags: ['adapter', 'doubao', 'web'],
        downloads: 80,
        publishedAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        name: 'claycode-tool-linter',
        version: '1.0.0',
        type: 'tool' as PluginType,
        description: '代码风格检查工具插件，集成ESLint/Prettier',
        author: 'ClayCode',
        sourceUrl: 'builtin://linter',
        tags: ['tool', 'linter', 'eslint'],
        downloads: 50,
        publishedAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
  }

  /** 从本地路径安装 */
  private async installFromLocal(sourcePath: string, targetDir: string, entry: PluginMarketEntry): Promise<void> {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`源路径不存在: ${sourcePath}`);
    }

    // 复制目录
    fs.mkdirSync(targetDir, { recursive: true });
    const entries = fs.readdirSync(sourcePath);
    for (const entryName of entries) {
      const srcFile = path.join(sourcePath, entryName);
      const destFile = path.join(targetDir, entryName);
      fs.copyFileSync(srcFile, destFile);
    }

    logger.info(`[PluginMarket] 从本地安装: ${sourcePath} -> ${targetDir}`);
  }

  /** 从远程URL安装 */
  private async installFromRemote(url: string, targetDir: string, entry: PluginMarketEntry): Promise<void> {
    const data = await this.fetchRemote(url);
    fs.mkdirSync(targetDir, { recursive: true });

    // 假设远程返回的是tar.gz或zip，简化处理：保存为plugin文件
    const indexPath = path.join(targetDir, 'index.js');
    fs.writeFileSync(indexPath, data, 'utf8');

    // 创建plugin.json
    const descriptor = {
      name: entry.name,
      version: entry.version,
      type: entry.type,
      description: entry.description,
      main: 'index.js',
    };
    fs.writeFileSync(path.join(targetDir, 'plugin.json'), JSON.stringify(descriptor, null, 2), 'utf8');

    logger.info(`[PluginMarket] 从远程安装: ${url} -> ${targetDir}`);
  }

  /** 从npm安装 */
  private async installFromNpm(packageName: string, targetDir: string, entry: PluginMarketEntry): Promise<void> {
    const { execSync } = require('child_process');
    fs.mkdirSync(targetDir, { recursive: true });

    // npm install到临时目录
    execSync(`npm install ${packageName} --prefix "${targetDir}"`, {
      encoding: 'utf-8',
      timeout: 60000,
    });

    logger.info(`[PluginMarket] 从npm安装: ${packageName} -> ${targetDir}`);
  }

  /** HTTP请求获取远程数据 */
  private fetchRemote(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      client.get(url, (res) => {
        let data = '';
        res.on('data', (chunk: string | Buffer) => {
          data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });
  }
}