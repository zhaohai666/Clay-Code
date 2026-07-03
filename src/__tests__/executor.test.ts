import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalExecutor } from '../core/executor';
import { ToolCall } from '../types';

describe('LocalExecutor', () => {
  let tmpDir: string;
  let executor: LocalExecutor;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `claycode-executor-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    executor = new LocalExecutor(tmpDir, {
      maxOutputLength: 1000,
      execWhiteList: ['git', 'npm', 'node', 'echo', 'ls', 'cat'],
      enableSandbox: false,
    });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- read ----
  describe('executeRead', () => {
    it('应读取文件内容并添加行号', async () => {
      const filePath = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(filePath, 'line1\nline2\nline3');
      const result = await executor.execute({ tool: 'read', filePath });
      expect(result.success).toBe(true);
      expect(result.outputText).toContain('1: line1');
      expect(result.outputText).toContain('2: line2');
      expect(result.outputText).toContain('3: line3');
      expect(result.operateFiles).toContain(filePath);
    });

    it('文件不存在应返回错误', async () => {
      const result = await executor.execute({ tool: 'read', filePath: 'nonexistent.txt' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('文件不存在');
    });

    it('目录应列出内容', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
      const result = await executor.execute({ tool: 'read', filePath: '.' });
      expect(result.success).toBe(true);
      expect(result.outputText).toContain('a.txt');
      expect(result.outputText).toContain('b.txt');
    });

    it('路径越权应拦截', async () => {
      const result = await executor.execute({ tool: 'read', filePath: '/etc/passwd' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('路径越权');
    });
  });

  // ---- write ----
  describe('executeWrite', () => {
    it('应写入文件内容', async () => {
      const filePath = path.join(tmpDir, 'write-test.txt');
      const result = await executor.execute({ tool: 'write', filePath, content: 'Hello World' });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('Hello World');
    });

    it('应自动创建父目录', async () => {
      const filePath = path.join(tmpDir, 'sub', 'dir', 'file.txt');
      const result = await executor.execute({ tool: 'write', filePath, content: 'nested' });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('nested');
    });

    it('路径越权应拦截', async () => {
      const result = await executor.execute({ tool: 'write', filePath: '/tmp/hack.txt', content: 'hack' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('路径越权');
    });
  });

  // ---- edit (Diff补丁) ----
  describe('executeEdit', () => {
    it('应应用Diff补丁编辑文件', async () => {
      const filePath = path.join(tmpDir, 'edit-test.txt');
      fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5');

      const patch = '@@ -2,3 +2,3 @@\n line1\n-line2\n+LINE2\n line3';
      const result = await executor.execute({ tool: 'edit', filePath, patch });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('LINE2');
    });

    it('文件不存在应返回错误', async () => {
      const result = await executor.execute({ tool: 'edit', filePath: 'nonexistent.txt', patch: '@@ -1 +1 @@' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('文件不存在');
    });

    it('无效Diff补丁应返回错误', async () => {
      const filePath = path.join(tmpDir, 'bad-patch.txt');
      fs.writeFileSync(filePath, 'content');
      const result = await executor.execute({ tool: 'edit', filePath, patch: 'not a valid patch' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('无法解析');
    });

    it('路径越权应拦截', async () => {
      const result = await executor.execute({ tool: 'edit', filePath: '/etc/hosts', patch: '@@ -1 +1 @@' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('路径越权');
    });
  });

  // ---- bash (白名单校验) ----
  describe('executeBash', () => {
    it('白名单内命令应执行', async () => {
      const result = await executor.execute({ tool: 'bash', command: 'echo hello' });
      expect(result.success).toBe(true);
      expect(result.outputText.trim()).toBe('hello');
    });

    it('白名单外命令应拒绝', async () => {
      const result = await executor.execute({ tool: 'bash', command: 'rm -rf /' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('白名单');
    });

    it('空命令应拒绝', async () => {
      const result = await executor.execute({ tool: 'bash', command: '' });
      expect(result.success).toBe(false);
    });

    it('命令失败应返回错误输出', async () => {
      const result = await executor.execute({ tool: 'bash', command: 'ls /nonexistent_dir_xyz' });
      // ls在白名单中，但目录不存在会失败
      expect(result.success).toBe(false);
    });
  });

  // ---- git ----
  describe('executeGit', () => {
    it('允许的git子命令应执行', async () => {
      const result = await executor.execute({ tool: 'git', command: 'git status' });
      // git status 即使不在git仓库也会返回结果（只是可能失败）
      // 关键是不应该被白名单拦截
      expect(result.errorText).not.toContain('白名单');
    });

    it('不允许的git子命令应拒绝', async () => {
      const result = await executor.execute({ tool: 'git', command: 'git rebase' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('不允许的git命令');
    });

    it('无git前缀也应自动添加', async () => {
      const result = await executor.execute({ tool: 'git', command: 'status' });
      expect(result.errorText).not.toContain('白名单');
    });
  });

  // ---- glob ----
  describe('executeGlob', () => {
    it('应匹配文件模式', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'a');
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'b');
      fs.writeFileSync(path.join(tmpDir, 'c.js'), 'c');

      const result = await executor.execute({ tool: 'glob', globPattern: '*.ts' });
      expect(result.success).toBe(true);
      expect(result.outputText).toContain('a.ts');
      expect(result.outputText).toContain('b.ts');
      expect(result.outputText).not.toContain('c.js');
    });

    it('无匹配应返回空', async () => {
      const result = await executor.execute({ tool: 'glob', globPattern: '*.xyz' });
      expect(result.success).toBe(true);
      expect(result.outputText).toBe('');
    });
  });

  // ---- 不支持的工具 ----
  describe('不支持的工具', () => {
    it('不支持的tool类型应返回错误', async () => {
      const result = await executor.execute({ tool: 'unknown' as any, filePath: 'test' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('不支持的工具类型');
    });
  });

  // ---- executeBatch ----
  describe('executeBatch', () => {
    it('应顺序执行多个工具调用', async () => {
      const toolCalls: ToolCall[] = [
        { tool: 'write', filePath: path.join(tmpDir, 'batch1.txt'), content: 'first' },
        { tool: 'write', filePath: path.join(tmpDir, 'batch2.txt'), content: 'second' },
        { tool: 'read', filePath: path.join(tmpDir, 'batch1.txt') },
      ];
      const results = await executor.executeBatch(toolCalls);
      expect(results.length).toBe(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(true);
      expect(results[2].outputText).toContain('first');
    });

    it('某个失败不应中断后续执行', async () => {
      const toolCalls: ToolCall[] = [
        { tool: 'read', filePath: 'nonexistent.txt' },
        { tool: 'write', filePath: path.join(tmpDir, 'after-fail.txt'), content: 'ok' },
      ];
      const results = await executor.executeBatch(toolCalls);
      expect(results.length).toBe(2);
      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(true);
    });
  });

  // ---- Diff补丁解析 ----
  describe('parseDiffPatch', () => {
    it('应正确解析统一Diff格式', async () => {
      const filePath = path.join(tmpDir, 'diff-parse.txt');
      fs.writeFileSync(filePath, 'aaa\nbbb\nccc\nddd\neee');

      const patch = '@@ -2,3 +2,3 @@\n bbb\n-ccc\n+CCC\n ddd';
      const result = await executor.execute({ tool: 'edit', filePath, patch });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('CCC');
      expect(content).not.toContain('ccc');
    });
  });

  // ---- 输出截断 ----
  describe('输出截断', () => {
    it('超长输出应被截断', async () => {
      const longOutput = 'x'.repeat(2000);
      const result = await executor.execute({ tool: 'bash', command: `echo ${longOutput}` });
      // 输出应被截断到maxOutputLength以内
      if (result.success && result.outputText.length > 1000) {
        expect(result.outputText).toContain('截断');
      }
    });
  });
});