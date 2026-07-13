/**
 * @claycode/watcher 文件变更监听模块 (V1.2)
 * 基于 fs.watch / fs.watchFile 实现项目文件外部变更监听
 * 支持忽略规则(.gitignore/.clayignore)、防抖聚合、事件回调
 * 闲置超时自动关闭，减少CPU占用
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils';

/** 文件变更事件类型 */
export type FileChangeEvent = 'create' | 'update' | 'delete' | 'rename';

/** 文件变更记录（监听事件） */
export interface WatchFileChange {
  /** 事件类型 */
  event: FileChangeEvent;
  /** 文件路径（相对于项目根目录） */
  filePath: string;
  /** 绝对路径 */
  absolutePath: string;
  /** 事件时间戳 */
  timestamp: number;
}

/** 文件变更回调 */
export type FileChangeCallback = (changes: WatchFileChange[]) => void;

/** 监听器配置 */
export interface WatcherOptions {
  /** 项目根目录 */
  projectRoot: string;
  /** 防抖间隔(ms)，默认300ms */
  debounceMs?: number;
  /** 闲置超时(ms)，0表示不超时，默认30分钟 */
  idleTimeoutMs?: number;
  /** 忽略的目录模式，默认自动加载.gitignore */
  ignorePatterns?: string[];
  /** 是否递归监听子目录，默认true */
  recursive?: boolean;
  /** 变更回调 */
  onChange?: FileChangeCallback;
}

/** 默认忽略目录 */
const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '.tmp', '.temp', 'vendor', '__pycache__',
  '.venv', 'venv', 'target', '.gradle', '.idea', '.vscode',
  '.DS_Store', 'bin', 'obj', 'out',
];

/** 默认忽略文件扩展名（二进制/临时文件） */
const DEFAULT_IGNORE_EXTENSIONS = [
  '.log', '.tmp', '.swp', '.swo', '.lock', '.pid',
];

/**
 * 文件变更监听器
 * 基于fs.watch实现，支持防抖聚合、忽略规则、闲置超时
 */
export class FileWatcher {
  /** 项目根目录 */
  private projectRoot: string;
  /** 防抖间隔 */
  private debounceMs: number;
  /** 闲置超时 */
  private idleTimeoutMs: number;
  /** 忽略模式 */
  private ignorePatterns: Set<string>;
  /** 是否递归 */
  private recursive: boolean;
  /** 变更回调 */
  private onChange?: FileChangeCallback;

  /** fs.watch监听器实例列表 */
  private watchers: fs.FSWatcher[] = [];
  /** 是否正在监听 */
  private running = false;
  /** 防抖定时器 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 待处理的变更事件缓冲 */
  private pendingChanges: WatchFileChange[] = [];
  /** 闲置超时定时器 */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最后事件时间戳 */
  private lastEventTime = 0;
  /** 已监听的目录集合（防止重复监听） */
  private watchedDirs: Set<string> = new Set();

  constructor(options: WatcherOptions) {
    this.projectRoot = options.projectRoot;
    this.debounceMs = options.debounceMs ?? 300;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
    this.recursive = options.recursive ?? true;
    this.onChange = options.onChange;

    // 合并忽略模式
    this.ignorePatterns = new Set([
      ...DEFAULT_IGNORE_DIRS,
      ...(options.ignorePatterns ?? []),
    ]);

    // 加载.gitignore忽略规则
    this.loadGitignorePatterns();
  }

  /** 加载.gitignore中的忽略模式 */
  private loadGitignorePatterns(): void {
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        const patterns = content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
        for (const pattern of patterns) {
          // 提取目录名（去除前导/和尾随/）
          const cleaned = pattern.replace(/^\/+|\/+$/g, '').replace(/\*.*$/, '').trim();
          if (cleaned && !cleaned.includes('/')) {
            this.ignorePatterns.add(cleaned);
          }
        }
        logger.info(`[FileWatcher] 已加载.gitignore忽略规则: ${patterns.length}条`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[FileWatcher] 加载.gitignore失败: ${message}`);
      }
    }
  }

  /** 判断路径是否应被忽略 */
  private shouldIgnore(filePath: string): boolean {
    const relativePath = path.relative(this.projectRoot, filePath);
    const parts = relativePath.split(path.sep);

    // 检查目录名
    for (const part of parts) {
      if (this.ignorePatterns.has(part)) {
        return true;
      }
    }

    // 检查文件扩展名
    const ext = path.extname(filePath);
    if (DEFAULT_IGNORE_EXTENSIONS.includes(ext)) {
      return true;
    }

    // 检查隐藏文件（以.开头）
    const basename = path.basename(filePath);
    if (basename.startsWith('.') && basename !== '.clayignore') {
      return true;
    }

    return false;
  }

  /** 递归扫描目录并建立监听 */
  private scanAndWatch(dir: string): void {
    if (!fs.existsSync(dir) || this.shouldIgnore(dir)) return;
    const absDir = path.resolve(dir);
    if (this.watchedDirs.has(absDir)) return;

    try {
      // 监听当前目录
      const watcher = fs.watch(dir, { recursive: false }, (event, filename) => {
        this.handleFsEvent(event, filename, dir);
      });
      watcher.on('error', (err) => {
        logger.warn(`[FileWatcher] 监听错误 ${dir}: ${err.message}`);
      });
      this.watchers.push(watcher);
      this.watchedDirs.add(absDir);

      // 递归监听子目录
      if (this.recursive) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !this.shouldIgnore(entry.name)) {
            this.scanAndWatch(path.join(dir, entry.name));
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[FileWatcher] 扫描目录失败 ${dir}: ${message}`);
    }
  }

  /** 处理fs.watch事件 */
  private handleFsEvent(event: string, filename: string | null, dir: string): void {
    if (!filename || !this.running) return;

    const absolutePath = path.join(dir, filename);
    const relativePath = path.relative(this.projectRoot, absolutePath);

    // 忽略规则过滤
    if (this.shouldIgnore(absolutePath)) return;

    // 更新闲置计时
    this.lastEventTime = Date.now();
    this.resetIdleTimer();

    // 判断事件类型
    let changeEvent: FileChangeEvent;
    if (event === 'rename') {
      // rename可能是创建或删除
      if (fs.existsSync(absolutePath)) {
        changeEvent = 'create';
        // 如果是新建目录，需要添加监听
        if (fs.statSync(absolutePath).isDirectory()) {
          this.scanAndWatch(absolutePath);
        }
      } else {
        changeEvent = 'delete';
      }
    } else {
      // change事件
      changeEvent = 'update';
    }

    const record: WatchFileChange = {
      event: changeEvent,
      filePath: relativePath,
      absolutePath,
      timestamp: Date.now(),
    };

    this.pendingChanges.push(record);

    // 防抖：聚合短时间内的多个变更事件
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flushChanges();
    }, this.debounceMs);
  }

  /** 刷新待处理的变更事件 */
  private flushChanges(): void {
    if (this.pendingChanges.length === 0) return;

    const changes = [...this.pendingChanges];
    this.pendingChanges = [];
    this.debounceTimer = null;

    // 去重：相同文件相同时间窗口内只保留最新事件
    const deduplicated = this.deduplicateChanges(changes);

    logger.info(`[FileWatcher] 检测到 ${deduplicated.length} 个文件变更`);
    if (this.onChange) {
      this.onChange(deduplicated);
    }
  }

  /** 变更事件去重 */
  private deduplicateChanges(changes: WatchFileChange[]): WatchFileChange[] {
    const latest = new Map<string, WatchFileChange>();
    for (const change of changes) {
      const key = `${change.filePath}:${change.event}`;
      const existing = latest.get(key);
      if (!existing || change.timestamp > existing.timestamp) {
        latest.set(key, change);
      }
    }
    return Array.from(latest.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  /** 重置闲置超时定时器 */
  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    if (this.idleTimeoutMs > 0) {
      this.idleTimer = setTimeout(() => {
        const idleSeconds = Math.round((Date.now() - this.lastEventTime) / 1000);
        logger.info(`[FileWatcher] 闲置超时(${idleSeconds}s)，自动停止监听`);
        this.stop();
      }, this.idleTimeoutMs);
    }
  }

  /** 启动文件监听 */
  start(): void {
    if (this.running) {
      logger.warn('[FileWatcher] 监听已在运行中');
      return;
    }

    this.running = true;
    this.lastEventTime = Date.now();
    this.watchedDirs.clear();

    logger.info(`[FileWatcher] 启动文件变更监听: ${this.projectRoot}`);
    this.scanAndWatch(this.projectRoot);
    this.resetIdleTimer();

    logger.info(`[FileWatcher] 已监听 ${this.watchedDirs.size} 个目录`);
  }

  /** 停止文件监听 */
  stop(): void {
    if (!this.running) return;

    this.running = false;

    // 刷新剩余变更
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.flushChanges();
    }

    // 关闭所有fs.watch监听器
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // 忽略关闭错误
      }
    }
    this.watchers = [];
    this.watchedDirs.clear();

    // 清除闲置定时器
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    logger.info('[FileWatcher] 文件变更监听已停止');
  }

  /** 获取监听状态 */
  getStatus(): { running: boolean; watchedDirs: number; lastEventTime: number } {
    return {
      running: this.running,
      watchedDirs: this.watchedDirs.size,
      lastEventTime: this.lastEventTime,
    };
  }

  /** 设置变更回调 */
  setOnChange(callback: FileChangeCallback): void {
    this.onChange = callback;
  }
}