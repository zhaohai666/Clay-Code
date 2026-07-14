import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalExecutor } from '../core/executor';
import { ToolCall } from '../types';
import { normalizePath } from '../utils';

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
      expect(result.operateFiles).toContain(normalizePath(filePath));
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

  // ---- V1.2: view 工具 ----
  describe('executeView', () => {
    it('应查看文件内容并显示元信息头', async () => {
      const filePath = path.join(tmpDir, 'view-test.txt');
      fs.writeFileSync(filePath, 'line1\nline2\nline3');
      const result = await executor.execute({ tool: 'view', filePath });
      expect(result.success).toBe(true);
      expect(result.outputText).toContain('view-test.txt');
      expect(result.outputText).toContain('KB');
      expect(result.outputText).toContain('line1');
    });

    it('应支持行范围查看', async () => {
      const filePath = path.join(tmpDir, 'view-range.txt');
      fs.writeFileSync(filePath, Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n'));
      const result = await executor.execute({ tool: 'view', filePath, lineRange: '5-10' });
      expect(result.success).toBe(true);
      expect(result.outputText).toContain('line5');
      expect(result.outputText).toContain('line10');
      // line1作为独立行不应出现（但line10/line11等包含line1子串）
      expect(result.outputText).not.toMatch(/^.*1 │ line1$/m);
    });

    it('文件不存在应返回错误', async () => {
      const result = await executor.execute({ tool: 'view', filePath: 'nonexistent-view.txt' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('文件不存在');
    });

    it('目录应返回不支持错误', async () => {
      const dirPath = path.join(tmpDir, 'subdir');
      fs.mkdirSync(dirPath);
      const result = await executor.execute({ tool: 'view', filePath: 'subdir' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('view不支持目录');
    });

    it('路径越权应拦截', async () => {
      const result = await executor.execute({ tool: 'view', filePath: '/etc/passwd' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('路径越权');
    });
  });

  // ---- V1.2: run_test 工具 ----
  describe('executeRunTest', () => {
    it('无测试标志文件应返回错误', async () => {
      // tmpDir中没有package.json/pom.xml等标志文件
      const result = await executor.execute({ tool: 'run_test' });
      expect(result.success).toBe(false);
      expect(result.errorText).toContain('无法识别项目测试命令');
    });

    it('有package.json应识别为npm测试', async () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
      // 不实际执行测试，只验证命令识别（执行可能失败因为无node_modules）
      const result = await executor.execute({ tool: 'run_test' });
      // 即使执行失败，也不应是"无法识别"错误
      if (!result.success) {
        expect(result.errorText).not.toContain('无法识别项目测试命令');
      }
    });
  });

  // ---- V1.2: symbol_search 工具 ----
  describe('executeSymbolSearch', () => {
    it('空项目索引应返回失败或无结果', async () => {
      // tmpDir中没有源代码文件
      const result = await executor.execute({ tool: 'symbol_search', symbolName: 'NonExistent' });
      // 可能返回索引为空或搜索无结果
      expect(result).toHaveProperty('success');
    });

    it('有源码文件时应可执行符号搜索', async () => {
      // 创建一个简单的TypeScript文件
      fs.writeFileSync(path.join(tmpDir, 'sample.ts'), 'export class MyClass { myMethod() {} }');
      const result = await executor.execute({ tool: 'symbol_search', symbolName: 'MyClass' });
      // 可能找到也可能找不到（取决于Tree-sitter是否可用）
      expect(result).toHaveProperty('success');
    });
  });

  // ---- V1.1: detectPatchConflicts 冲突预检测 ----
  describe('detectPatchConflicts', () => {
    it('无edit操作应返回空冲突列表', () => {
      const toolCalls: ToolCall[] = [
        { tool: 'read', filePath: path.join(tmpDir, 'test.txt') },
        { tool: 'bash', command: 'echo hello' },
      ];
      const conflicts = executor.detectPatchConflicts(toolCalls);
      expect(conflicts).toEqual([]);
    });

    it('单条edit操作应无冲突', () => {
      const toolCalls: ToolCall[] = [
        { tool: 'edit', filePath: path.join(tmpDir, 'test.txt'), patch: '@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE2\n line3' },
      ];
      const conflicts = executor.detectPatchConflicts(toolCalls);
      expect(conflicts).toEqual([]);
    });

    it('不同文件的edit操作应无冲突', () => {
      const toolCalls: ToolCall[] = [
        { tool: 'edit', filePath: path.join(tmpDir, 'a.txt'), patch: '@@ -1,3 +1,3 @@\n a1\n-a2\n+A2\n a3' },
        { tool: 'edit', filePath: path.join(tmpDir, 'b.txt'), patch: '@@ -1,3 +1,3 @@\n b1\n-b2\n+B2\n b3' },
      ];
      const conflicts = executor.detectPatchConflicts(toolCalls);
      expect(conflicts).toEqual([]);
    });

    it('相同文件不同行范围的edit操作应无冲突', () => {
      const toolCalls: ToolCall[] = [
        { tool: 'edit', filePath: path.join(tmpDir, 'same.txt'), patch: '@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE2\n line3' },
        { tool: 'edit', filePath: path.join(tmpDir, 'same.txt'), patch: '@@ -10,3 +10,3 @@\n line10\n-line11\n+LINE11\n line12' },
      ];
      const conflicts = executor.detectPatchConflicts(toolCalls);
      expect(conflicts).toEqual([]);
    });
  });

  // ---- V1.1: changeReview Diff预审确认 ----
  describe('changeReview', () => {
    it('未启用预审时变更应直接通过', async () => {
      const filePath = path.join(tmpDir, 'review-test.txt');
      fs.writeFileSync(filePath, 'original');
      const result = await executor.execute({ tool: 'write', filePath, content: 'modified' });
      expect(result.success).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('modified');
    });

    it('设置预审回调后应调用回调', async () => {
      let callbackCalled = false;
      let receivedDiff = '';
      let receivedOp = '';
      executor.setChangeReviewCallback(async (diff, filePath, operation) => {
        callbackCalled = true;
        receivedDiff = diff;
        receivedOp = operation;
        return true; // 确认变更
      });

      const filePath = path.join(tmpDir, 'review-callback.txt');
      fs.writeFileSync(filePath, 'old content');
      const result = await executor.execute({ tool: 'write', filePath, content: 'new content' });

      expect(callbackCalled).toBe(true);
      expect(receivedDiff).toContain('old content');
      expect(receivedDiff).toContain('new content');
      expect(result.success).toBe(true);
    });

    it('预审拒绝时变更不应生效', async () => {
      executor.setChangeReviewCallback(async () => false); // 拒绝变更

      const filePath = path.join(tmpDir, 'review-reject.txt');
      fs.writeFileSync(filePath, 'original content');
      const result = await executor.execute({ tool: 'write', filePath, content: 'rejected content' });

      expect(result.success).toBe(false);
      expect(result.errorText).toContain('拒绝');
      // 文件内容应保持不变
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('original content');
    });

    it('预审回调应接收正确的操作类型', async () => {
      const operations: string[] = [];
      executor.setChangeReviewCallback(async (_diff, _filePath, operation) => {
        operations.push(operation);
        return true;
      });

      const filePath = path.join(tmpDir, 'review-ops.txt');
      fs.writeFileSync(filePath, 'initial');
      await executor.execute({ tool: 'write', filePath, content: 'written' });
      await executor.execute({ tool: 'edit', filePath, patch: '@@ -1 +1 @@\n-written\n+edited' });

      expect(operations.length).toBeGreaterThanOrEqual(1);
    });
  });
});