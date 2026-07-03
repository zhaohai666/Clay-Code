import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CacheManager } from '../core/cache';

describe('CacheManager', () => {
  let tmpDir: string;
  let cache: CacheManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `claycode-cache-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    cache?.destroy();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- L1 内存缓存 ----
  describe('L1 内存缓存', () => {
    it('应能存取缓存值', () => {
      cache = new CacheManager({ cacheLevel: 'l1', l1MaxEntries: 100, l2Dir: '' });
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('不存在的key应返回undefined', () => {
      cache = new CacheManager({ cacheLevel: 'l1', l2Dir: '' });
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('has应正确判断缓存是否存在', () => {
      cache = new CacheManager({ cacheLevel: 'l1', l2Dir: '' });
      cache.set('exists', true);
      expect(cache.has('exists')).toBe(true);
      expect(cache.has('notexists')).toBe(false);
    });

    it('delete应能删除缓存', () => {
      cache = new CacheManager({ cacheLevel: 'l1', l2Dir: '' });
      cache.set('del-me', 42);
      expect(cache.get('del-me')).toBe(42);
      cache.delete('del-me');
      expect(cache.get('del-me')).toBeUndefined();
    });

    it('clear应清空所有缓存', () => {
      cache = new CacheManager({ cacheLevel: 'l1', l2Dir: '' });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
    });

    it('LRU淘汰：超过最大条目数应淘汰最旧', () => {
      cache = new CacheManager({ cacheLevel: 'l1', l1MaxEntries: 3, l2Dir: '' });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // 超过3个，a应被淘汰
      cache.set('d', 4);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
    });

    it('访问应更新LRU顺序', () => {
      cache = new CacheManager({ cacheLevel: 'l1', l1MaxEntries: 3, l2Dir: '' });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // 访问a，使其变为最新
      cache.get('a');
      // 插入d，b应被淘汰（最旧未访问）
      cache.set('d', 4);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBeUndefined();
    });

    it('应支持对象类型缓存值', () => {
      cache = new CacheManager({ cacheLevel: 'l1', l2Dir: '' });
      const obj = { name: 'test', items: [1, 2, 3] };
      cache.set('obj', obj);
      expect(cache.get('obj')).toEqual(obj);
    });
  });

  // ---- L2 磁盘缓存 ----
  describe('L2 磁盘缓存', () => {
    it('应能持久化到磁盘并读取', () => {
      cache = new CacheManager({ cacheLevel: 'l2', l2Dir: tmpDir });
      cache.set('disk-key', 'disk-value');
      // 重新创建实例验证持久化
      const cache2 = new CacheManager({ cacheLevel: 'l2', l2Dir: tmpDir });
      expect(cache2.get('disk-key')).toBe('disk-value');
      cache2.destroy();
    });

    it('L2删除应移除磁盘文件', () => {
      cache = new CacheManager({ cacheLevel: 'l2', l2Dir: tmpDir });
      cache.set('del-disk', 'val');
      cache.delete('del-disk');
      expect(cache.get('del-disk')).toBeUndefined();
    });

    it('L2 has应检查磁盘文件', () => {
      cache = new CacheManager({ cacheLevel: 'l2', l2Dir: tmpDir });
      cache.set('has-key', 'val');
      expect(cache.has('has-key')).toBe(true);
      cache.delete('has-key');
      expect(cache.has('has-key')).toBe(false);
    });
  });

  // ---- L1+L2 混合缓存 ----
  describe('L1+L2 混合缓存', () => {
    it('set应同时写入L1和L2', () => {
      cache = new CacheManager({ cacheLevel: 'l1+l2', l2Dir: tmpDir });
      cache.set('both', 'value');
      // L1应有
      expect(cache.get('both')).toBe('value');
      // L2也应有
      const cache2 = new CacheManager({ cacheLevel: 'l2', l2Dir: tmpDir });
      expect(cache2.get('both')).toBe('value');
      cache2.destroy();
    });

    it('L2数据应回填L1', () => {
      // 先用L2写入
      const cacheL2 = new CacheManager({ cacheLevel: 'l2', l2Dir: tmpDir });
      cacheL2.set('backfill', 'from-l2');
      cacheL2.destroy();

      // 新实例L1+L2应能从L2回填
      cache = new CacheManager({ cacheLevel: 'l1+l2', l2Dir: tmpDir });
      expect(cache.get('backfill')).toBe('from-l2');
    });
  });

  // ---- none 级别 ----
  describe('none 级别', () => {
    it('cacheLevel=none应忽略所有操作', () => {
      cache = new CacheManager({ cacheLevel: 'none', l2Dir: '' });
      cache.set('key', 'val');
      expect(cache.get('key')).toBeUndefined();
    });
  });

  // ---- 统计信息 ----
  describe('stats', () => {
    it('应返回正确的统计信息', () => {
      cache = new CacheManager({ cacheLevel: 'l1', l1MaxEntries: 100, l2Dir: '' });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.get('a');
      cache.get('a');
      const stats = cache.stats();
      expect(stats.l1Size).toBe(2);
    });
  });

  // ---- 闲置回收 ----
  describe('闲置回收', () => {
    it('destroy应清理定时器', () => {
      cache = new CacheManager({ cacheLevel: 'l1', idleTtlMs: 100, l2Dir: '' });
      cache.set('temp', 'val');
      cache.destroy();
      // 不应抛错
      expect(true).toBe(true);
    });
  });
});