import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CommandHistory } from '../utils/history';

describe('CommandHistory', () => {
  let tmpDir: string;
  let historyPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `claycode-history-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    historyPath = path.join(tmpDir, 'history');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- 基本操作 ----
  describe('基本操作', () => {
    it('应添加命令到历史记录', () => {
      const history = new CommandHistory({ historyPath });
      history.add('clay agent "test"');
      expect(history.size).toBe(1);
      expect(history.getAll()).toContain('clay agent "test"');
    });

    it('应去重连续重复命令', () => {
      const history = new CommandHistory({ historyPath });
      history.add('clay chat');
      history.add('clay chat');
      expect(history.size).toBe(1);
    });

    it('应忽略空命令', () => {
      const history = new CommandHistory({ historyPath });
      history.add('');
      history.add('   ');
      expect(history.size).toBe(0);
    });

    it('应trim命令前后空白', () => {
      const history = new CommandHistory({ historyPath });
      history.add('  clay chat  ');
      expect(history.getAll()[0]).toBe('clay chat');
    });

    it('非连续重复命令应保留', () => {
      const history = new CommandHistory({ historyPath });
      history.add('clay chat');
      history.add('clay agent "test"');
      history.add('clay chat');
      expect(history.size).toBe(3);
    });
  });

  // ---- 浏览历史 ----
  describe('浏览历史', () => {
    it('getPrevious应返回上一条命令', () => {
      const history = new CommandHistory({ historyPath });
      history.add('first');
      history.add('second');
      history.add('third');
      expect(history.getPrevious()).toBe('third');
      expect(history.getPrevious()).toBe('second');
      expect(history.getPrevious()).toBe('first');
    });

    it('getNext应返回下一条命令', () => {
      const history = new CommandHistory({ historyPath });
      history.add('first');
      history.add('second');
      history.add('third');
      history.getPrevious(); // currentIndex: 3→2, 返回'third'
      history.getPrevious(); // currentIndex: 2→1, 返回'second'
      expect(history.getNext()).toBe('third'); // currentIndex: 1→2, 返回'third'
      expect(history.getNext()).toBeNull(); // currentIndex: 2→3(>=length-1), 返回null
    });

    it('浏览到顶部后getPrevious应返回null', () => {
      const history = new CommandHistory({ historyPath });
      history.add('only');
      history.getPrevious();
      expect(history.getPrevious()).toBeNull();
    });

    it('浏览到底部后getNext应返回null', () => {
      const history = new CommandHistory({ historyPath });
      history.add('only');
      expect(history.getNext()).toBeNull();
    });

    it('resetPosition应重置浏览位置', () => {
      const history = new CommandHistory({ historyPath });
      history.add('first');
      history.add('second');
      history.getPrevious();
      history.resetPosition();
      expect(history.getPrevious()).toBe('second');
    });
  });

  // ---- 搜索 ----
  describe('搜索', () => {
    it('应模糊搜索历史命令', () => {
      const history = new CommandHistory({ historyPath });
      history.add('clay agent "refactor"');
      history.add('clay chat');
      history.add('clay agent "fix bug"');
      const results = history.search('agent');
      expect(results.length).toBe(2);
      expect(results).toContain('clay agent "refactor"');
      expect(results).toContain('clay agent "fix bug"');
    });

    it('搜索应不区分大小写', () => {
      const history = new CommandHistory({ historyPath });
      history.add('Clay Agent');
      const results = history.search('clay');
      expect(results.length).toBe(1);
    });

    it('无匹配应返回空数组', () => {
      const history = new CommandHistory({ historyPath });
      history.add('clay chat');
      const results = history.search('nonexistent');
      expect(results).toEqual([]);
    });
  });

  // ---- 持久化 ----
  describe('持久化', () => {
    it('应持久化历史记录到磁盘', () => {
      const history = new CommandHistory({ historyPath });
      history.add('clay agent "test"');
      history.add('clay chat');
      // 新实例应能加载
      const history2 = new CommandHistory({ historyPath });
      expect(history2.size).toBe(2);
      expect(history2.getAll()).toContain('clay agent "test"');
      expect(history2.getAll()).toContain('clay chat');
    });

    it('clear应清空历史并持久化', () => {
      const history = new CommandHistory({ historyPath });
      history.add('clay chat');
      history.clear();
      expect(history.size).toBe(0);
      const history2 = new CommandHistory({ historyPath });
      expect(history2.size).toBe(0);
    });
  });

  // ---- 条数限制 ----
  describe('条数限制', () => {
    it('超出maxEntries应移除最早记录', () => {
      const history = new CommandHistory({ historyPath, maxEntries: 3 });
      history.add('cmd1');
      history.add('cmd2');
      history.add('cmd3');
      history.add('cmd4');
      expect(history.size).toBe(3);
      expect(history.getAll()[0]).toBe('cmd2');
      expect(history.getAll()[2]).toBe('cmd4');
    });
  });
});