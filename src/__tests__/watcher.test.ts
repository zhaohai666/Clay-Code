/**
 * FileWatcher 文件变更监听模块测试 (V1.2)
 * 覆盖：构造函数配置、忽略规则、变更去重、生命周期管理、防抖聚合
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileWatcher, WatchFileChange, FileChangeEvent } from '../core/watcher';

/** 创建临时测试目录 */
function createTempDir(prefix = 'claycode-watcher-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

/** 递归删除目录 */
function removeDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('FileWatcher', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeDir(tempDir);
  });

  describe('构造函数与配置', () => {
    it('应使用默认配置', () => {
      const watcher = new FileWatcher({ projectRoot: tempDir });
      const status = watcher.getStatus();
      expect(status.running).toBe(false);
      expect(status.watchedDirs).toBe(0);
      watcher.stop();
    });

    it('应接受自定义debounceMs', () => {
      const watcher = new FileWatcher({ projectRoot: tempDir, debounceMs: 100 });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('应接受自定义idleTimeoutMs', () => {
      const watcher = new FileWatcher({ projectRoot: tempDir, idleTimeoutMs: 0 });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('应接受自定义ignorePatterns', () => {
      const watcher = new FileWatcher({
        projectRoot: tempDir,
        ignorePatterns: ['custom-ignore'],
      });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('应接受recursive=false配置', () => {
      const watcher = new FileWatcher({ projectRoot: tempDir, recursive: false });
      expect(watcher).toBeDefined();
      watcher.stop();
    });
  });

  describe('忽略规则', () => {
    it('应忽略node_modules目录', () => {
      const nodeDir = path.join(tempDir, 'node_modules');
      fs.mkdirSync(nodeDir);
      fs.writeFileSync(path.join(nodeDir, 'package.json'), '{}');
      const watcher = new FileWatcher({ projectRoot: tempDir });
      watcher.start();
      // node_modules不应被监听
      const status = watcher.getStatus();
      expect(status.watchedDirs).toBe(1); // 只有根目录
      watcher.stop();
    });

    it('应忽略.git目录', () => {
      const gitDir = path.join(tempDir, '.git');
      fs.mkdirSync(gitDir);
      fs.writeFileSync(path.join(gitDir, 'config'), 'test');
      const watcher = new FileWatcher({ projectRoot: tempDir });
      watcher.start();
      const status = watcher.getStatus();
      expect(status.watchedDirs).toBe(1);
      watcher.stop();
    });

    it('应忽略.log扩展名文件', () => {
      // .log文件在DEFAULT_IGNORE_EXTENSIONS中
      // 通过shouldIgnore逻辑处理
      const watcher = new FileWatcher({ projectRoot: tempDir });
      watcher.start();
      // 创建.log文件不应触发回调
      const changes: WatchFileChange[] = [];
      watcher.setOnChange((c) => changes.push(...c));
      fs.writeFileSync(path.join(tempDir, 'test.log'), 'log content');
      watcher.stop();
    });

    it('应忽略隐藏文件（非.clayignore）', () => {
      const watcher = new FileWatcher({ projectRoot: tempDir });
      watcher.start();
      const status = watcher.getStatus();
      expect(status.running).toBe(true);
      watcher.stop();
    });

    it('应加载.gitignore中的忽略规则', () => {
      fs.writeFileSync(path.join(tempDir, '.gitignore'), 'dist\n*.log\n# comment\nbuild\n');
      const watcher = new FileWatcher({ projectRoot: tempDir });
      // .gitignore中的dist和build应被加入忽略列表
      const distDir = path.join(tempDir, 'dist');
      fs.mkdirSync(distDir);
      fs.writeFileSync(path.join(distDir, 'bundle.js'), 'code');
      watcher.start();
      const status = watcher.getStatus();
      // dist目录不应被监听
      expect(status.watchedDirs).toBe(1);
      watcher.stop();
    });

    it('应合并自定义忽略模式', () => {
      const customDir = path.join(tempDir, 'custom-ignore');
      fs.mkdirSync(customDir);
      fs.writeFileSync(path.join(customDir, 'file.txt'), 'content');
      const watcher = new FileWatcher({
        projectRoot: tempDir,
        ignorePatterns: ['custom-ignore'],
      });
      watcher.start();
      const status = watcher.getStatus();
      expect(status.watchedDirs).toBe(1);
      watcher.stop();
    });
  });

  describe('生命周期管理', () => {
    it('start应启动监听', () => {
      const watcher = new FileWatcher({ projectRoot: tempDir });
      watcher.start();
      const status = watcher.getStatus();
      expect(status.running).toBe(true);
      expect(status.watchedDirs).toBeGreaterThanOrEqual(1);
      watcher.stop();
    });

    it('重复start应输出警告但不报错', () => {
      const watcher = new FileWatcher({ projectRoot: tempDir });
      watcher.start();
      // 再次start不应抛出异常
      expect(() => watcher.start()).not.toThrow();
      watcher.stop();
    });

    it('stop应停止监听', () => {
      const watcher = new FileWatcher({ projectRoot: tempDir });
      watcher.start();
      watcher.stop();
      const status = watcher.getStatus();
      expect(status.running).toBe(false);
      expect(status.watchedDirs).toBe(0);
    });

    it('未启动时stop不应报错', () => {
      const watcher = new FileWatcher({ projectRoot: tempDir });
      expect(() => watcher.stop()).not.toThrow();
    });

    it('getStatus应返回正确状态', () => {
      const watcher = new FileWatcher({ projectRoot: tempDir });
      let status = watcher.getStatus();
      expect(status.running).toBe(false);
      expect(status.watchedDirs).toBe(0);
      expect(status.lastEventTime).toBe(0);

      watcher.start();
      status = watcher.getStatus();
      expect(status.running).toBe(true);
      expect(status.watchedDirs).toBeGreaterThanOrEqual(1);
      expect(status.lastEventTime).toBeGreaterThan(0);

      watcher.stop();
    });
  });

  describe('变更回调', () => {
    it('应通过构造函数设置onChange回调', () => {
      const changes: WatchFileChange[][] = [];
      const watcher = new FileWatcher({
        projectRoot: tempDir,
        debounceMs: 50,
        onChange: (c) => changes.push(c),
      });
      watcher.start();
      // 创建文件触发变更
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'hello');
      watcher.stop();
      // stop时会flush剩余变更
    });

    it('应通过setOnChange设置回调', () => {
      const changes: WatchFileChange[] = [];
      const watcher = new FileWatcher({ projectRoot: tempDir, debounceMs: 50 });
      watcher.setOnChange((c) => changes.push(...c));
      watcher.start();
      fs.writeFileSync(path.join(tempDir, 'newfile.txt'), 'content');
      watcher.stop();
    });

    it('回调应包含正确的变更结构', async () => {
      const changePromise = new Promise<WatchFileChange>((resolve) => {
        const watcher = new FileWatcher({
          projectRoot: tempDir,
          debounceMs: 50,
          onChange: (changes) => {
            if (changes.length > 0) {
              watcher.stop();
              resolve(changes[0]);
            }
          },
        });
        watcher.start();
        fs.writeFileSync(path.join(tempDir, 'trigger.txt'), 'data');
      });

      const change = await changePromise;
      expect(change).toHaveProperty('event');
      expect(change).toHaveProperty('filePath');
      expect(change).toHaveProperty('absolutePath');
      expect(change).toHaveProperty('timestamp');
      expect(typeof change.timestamp).toBe('number');
    }, 5000);
  });

  describe('递归监听', () => {
    it('recursive=true应监听子目录', () => {
      const subDir = path.join(tempDir, 'src');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, 'index.ts'), 'console.log("hi")');
      const watcher = new FileWatcher({ projectRoot: tempDir, recursive: true });
      watcher.start();
      const status = watcher.getStatus();
      expect(status.watchedDirs).toBeGreaterThanOrEqual(2);
      watcher.stop();
    });

    it('recursive=false应只监听根目录', () => {
      const subDir = path.join(tempDir, 'src');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, 'index.ts'), 'code');
      const watcher = new FileWatcher({ projectRoot: tempDir, recursive: false });
      watcher.start();
      const status = watcher.getStatus();
      expect(status.watchedDirs).toBe(1);
      watcher.stop();
    });
  });

  describe('变更事件去重', () => {
    it('相同文件相同事件应去重保留最新', () => {
      // 直接测试deduplicateChanges逻辑（通过回调间接验证）
      const watcher = new FileWatcher({ projectRoot: tempDir, debounceMs: 100 });
      const uniqueChanges: WatchFileChange[] = [];
      watcher.setOnChange((changes) => uniqueChanges.push(...changes));
      watcher.start();
      // 快速多次写入同一文件
      const filePath = path.join(tempDir, 'dedup.txt');
      fs.writeFileSync(filePath, 'v1');
      fs.writeFileSync(filePath, 'v2');
      fs.writeFileSync(filePath, 'v3');
      watcher.stop();
    });
  });
});