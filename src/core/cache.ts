/**
 * ClayCode 分级缓存模块
 * L1内存常驻缓存 + L2磁盘持久化缓存 + LRU淘汰 + 5分钟闲置回收
 */

import * as fs from 'fs';
import * as path from 'path';
import { CacheEntry, CacheLevel } from '../types';
import { logger, normalizePath } from '../utils';

/** 默认L1缓存最大条目数 */
const DEFAULT_L1_MAX_ENTRIES = 500;
/** 默认闲置回收时间(5分钟) */
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
/** L2磁盘缓存文件扩展名 */
const CACHE_FILE_EXT = '.cache.json';

/**
 * 分级缓存管理器
 * L1: 内存缓存，快速访问，LRU淘汰
 * L2: 磁盘缓存，持久化存储，按需加载
 */
export class CacheManager {
  private l1: Map<string, CacheEntry<unknown>> = new Map();
  private l1MaxEntries: number;
  private idleTtlMs: number;
  private cacheLevel: CacheLevel;
  private l2Dir: string;
  private gcTimer?: ReturnType<typeof setInterval>;

  constructor(options?: {
    cacheLevel?: CacheLevel;
    l1MaxEntries?: number;
    idleTtlMs?: number;
    l2Dir?: string;
  }) {
    this.cacheLevel = options?.cacheLevel ?? 'l1+l2';
    this.l1MaxEntries = options?.l1MaxEntries ?? DEFAULT_L1_MAX_ENTRIES;
    this.idleTtlMs = options?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.l2Dir = options?.l2Dir ?? '';

    // 启动闲置回收定时器（每60秒检查一次）
    this.gcTimer = setInterval(() => this.evictIdle(), 60_000);
  }

  // ---- 通用API ----

  /** 获取缓存 */
  get<T>(key: string): T | undefined {
    // L1查找
    if (this.cacheLevel === 'l1' || this.cacheLevel === 'l1+l2') {
      const entry = this.l1.get(key) as CacheEntry<T> | undefined;
      if (entry) {
        entry.lastAccessedAt = Date.now();
        entry.hitCount++;
        this.l1.delete(key); // LRU: 删除后重新插入到末尾
        this.l1.set(key, entry);
        return entry.data;
      }
    }

    // L2查找
    if (this.cacheLevel === 'l2' || this.cacheLevel === 'l1+l2') {
      const l2Data = this.loadL2<T>(key);
      if (l2Data !== undefined) {
        // 回填L1
        if (this.cacheLevel === 'l1+l2') {
          this.setL1(key, l2Data);
        }
        return l2Data;
      }
    }

    return undefined;
  }

  /** 设置缓存 */
  set<T>(key: string, data: T): void {
    if (this.cacheLevel === 'none') return;

    // L1写入
    if (this.cacheLevel === 'l1' || this.cacheLevel === 'l1+l2') {
      this.setL1(key, data);
    }

    // L2写入
    if (this.cacheLevel === 'l2' || this.cacheLevel === 'l1+l2') {
      this.saveL2(key, data);
    }
  }

  /** 删除缓存 */
  delete(key: string): boolean {
    const l1Deleted = this.l1.delete(key);
    const l2Deleted = this.deleteL2(key);
    return l1Deleted || l2Deleted;
  }

  /** 检查缓存是否存在 */
  has(key: string): boolean {
    if (this.l1.has(key)) return true;
    if (this.cacheLevel === 'l2' || this.cacheLevel === 'l1+l2') {
      return this.hasL2(key);
    }
    return false;
  }

  /** 清空所有缓存 */
  clear(): void {
    this.l1.clear();
    this.clearL2();
  }

  /** 获取缓存统计信息 */
  stats(): { l1Size: number; l2Size: number; l1HitRate: number } {
    let totalHits = 0;
    let totalAccess = 0;
    for (const entry of this.l1.values()) {
      totalHits += entry.hitCount;
      totalAccess += entry.hitCount;
    }
    return {
      l1Size: this.l1.size,
      l2Size: this.getL2FileCount(),
      l1HitRate: totalAccess > 0 ? totalHits / totalAccess : 0,
    };
  }

  // ---- L1 内存缓存 ----

  private setL1<T>(key: string, data: T): void {
    // LRU淘汰：超过最大条目数时删除最旧的
    while (this.l1.size >= this.l1MaxEntries) {
      const oldestKey = this.l1.keys().next().value;
      if (oldestKey !== undefined) {
        this.l1.delete(oldestKey);
      }
    }

    const entry: CacheEntry<T> = {
      data,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      hitCount: 0,
    };
    this.l1.set(key, entry as CacheEntry<unknown>);
  }

  /** 闲置回收：清理超过TTL未被访问的条目 */
  private evictIdle(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.l1) {
      if (now - entry.lastAccessedAt > this.idleTtlMs) {
        keysToDelete.push(key);
      }
    }

    if (keysToDelete.length > 0) {
      for (const key of keysToDelete) {
        this.l1.delete(key);
      }
      logger.debug(`[CacheManager] L1闲置回收: 清理 ${keysToDelete.length} 条`);
    }
  }

  // ---- L2 磁盘缓存 ----

  private getL2Path(key: string): string {
    // 使用hash避免文件名非法字符
    const hash = this.hashKey(key);
    return path.join(this.l2Dir, `${hash}${CACHE_FILE_EXT}`);
  }

  private hashKey(key: string): string {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const chr = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  private loadL2<T>(key: string): T | undefined {
    if (!this.l2Dir) return undefined;
    try {
      const filePath = this.getL2Path(key);
      if (!fs.existsSync(filePath)) return undefined;
      const raw = fs.readFileSync(filePath, 'utf8');
      const entry: CacheEntry<T> = JSON.parse(raw);
      entry.lastAccessedAt = Date.now();
      entry.hitCount++;
      // 回写访问信息
      fs.writeFileSync(filePath, JSON.stringify(entry), 'utf8');
      return entry.data;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[CacheManager] L2加载失败 key=${key}: ${message}`);
      return undefined;
    }
  }

  private saveL2<T>(key: string, data: T): void {
    if (!this.l2Dir) return;
    try {
      if (!fs.existsSync(this.l2Dir)) {
        fs.mkdirSync(this.l2Dir, { recursive: true });
      }
      const filePath = this.getL2Path(key);
      const entry: CacheEntry<T> = {
        data,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        hitCount: 0,
      };
      fs.writeFileSync(filePath, JSON.stringify(entry), 'utf8');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[CacheManager] L2写入失败 key=${key}: ${message}`);
    }
  }

  private deleteL2(key: string): boolean {
    if (!this.l2Dir) return false;
    try {
      const filePath = this.getL2Path(key);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private hasL2(key: string): boolean {
    if (!this.l2Dir) return false;
    return fs.existsSync(this.getL2Path(key));
  }

  private clearL2(): void {
    if (!this.l2Dir || !fs.existsSync(this.l2Dir)) return;
    try {
      const files = fs.readdirSync(this.l2Dir);
      for (const file of files) {
        if (file.endsWith(CACHE_FILE_EXT)) {
          fs.unlinkSync(path.join(this.l2Dir, file));
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[CacheManager] L2清空失败: ${message}`);
    }
  }

  private getL2FileCount(): number {
    if (!this.l2Dir || !fs.existsSync(this.l2Dir)) return 0;
    try {
      return fs.readdirSync(this.l2Dir).filter(f => f.endsWith(CACHE_FILE_EXT)).length;
    } catch {
      return 0;
    }
  }

  /** 销毁缓存管理器，清理定时器 */
  destroy(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = undefined;
    }
    this.l1.clear();
  }
}