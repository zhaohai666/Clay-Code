import { describe, it, expect, beforeEach } from 'vitest';
import { ProtocolConverter } from '../core/protocol';
import { DEFAULT_CONFIG, TaskRequest, ToolCall } from '../types';

describe('ProtocolConverter', () => {
  let converter: ProtocolConverter;

  beforeEach(() => {
    converter = new ProtocolConverter(DEFAULT_CONFIG);
  });

  // ---- buildPrompt ----
  describe('buildPrompt', () => {
    it('应包含系统提示和用户需求', () => {
      const request: TaskRequest = {
        userPrompt: '帮我创建一个Hello World',
        projectChunkContext: '',
        sessionHistory: [],
      };
      const prompt = converter.buildPrompt(request);
      expect(prompt).toContain('ClayCode AI编码助手');
      expect(prompt).toContain('帮我创建一个Hello World');
      expect(prompt).toContain('可用工具列表');
    });

    it('应包含项目上下文', () => {
      const request: TaskRequest = {
        userPrompt: '修改代码',
        projectChunkContext: '文件: src/app.ts\nconst app = express();',
        sessionHistory: [],
      };
      const prompt = converter.buildPrompt(request);
      expect(prompt).toContain('项目文件摘要');
      expect(prompt).toContain('src/app.ts');
    });

    it('应包含历史对话', () => {
      const request: TaskRequest = {
        userPrompt: '继续修改',
        projectChunkContext: '',
        sessionHistory: [
          { role: 'user', content: '第一次请求' },
          { role: 'ai', content: 'AI回复' },
        ],
      };
      const prompt = converter.buildPrompt(request);
      expect(prompt).toContain('对话历史');
      expect(prompt).toContain('第一次请求');
      expect(prompt).toContain('AI回复');
    });

    it('应包含上一轮执行结果', () => {
      const request: TaskRequest = {
        userPrompt: '继续',
        projectChunkContext: '',
        sessionHistory: [],
        lastExecuteOutput: {
          success: true,
          outputText: '文件已写入',
          errorText: '',
          exitCode: 0,
          operateFiles: ['/tmp/test.txt'],
        },
      };
      const prompt = converter.buildPrompt(request);
      expect(prompt).toContain('上一轮执行结果');
      expect(prompt).toContain('执行成功');
      expect(prompt).toContain('文件已写入');
    });

    it('应包含执行失败的错误信息', () => {
      const request: TaskRequest = {
        userPrompt: '重试',
        projectChunkContext: '',
        sessionHistory: [],
        lastExecuteOutput: {
          success: false,
          outputText: '',
          errorText: '命令执行失败',
          exitCode: 1,
          operateFiles: [],
        },
      };
      const prompt = converter.buildPrompt(request);
      expect(prompt).toContain('执行失败');
      expect(prompt).toContain('命令执行失败');
    });
  });

  // ---- parseToolCalls ----
  describe('parseToolCalls', () => {
    it('应从JSON代码块解析工具调用', () => {
      const aiResponse = '好的，我来帮你：\n```json\n[{ "tool": "read", "filePath": "src/app.ts" }]\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(1);
      expect(calls[0].tool).toBe('read');
      expect(calls[0].filePath).toBe('src/app.ts');
    });

    it('应解析单个工具调用对象', () => {
      const aiResponse = '```json\n{ "tool": "write", "filePath": "test.txt", "content": "hello" }\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(1);
      expect(calls[0].tool).toBe('write');
      expect(calls[0].content).toBe('hello');
    });

    it('应解析多个工具调用', () => {
      const aiResponse = '```json\n[\n  { "tool": "read", "filePath": "a.ts" },\n  { "tool": "bash", "command": "npm test" }\n]\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(2);
      expect(calls[0].tool).toBe('read');
      expect(calls[1].tool).toBe('bash');
    });

    it('应忽略无效的工具调用', () => {
      const aiResponse = '```json\n[{ "tool": "unknown", "filePath": "test" }]\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(0);
    });

    it('应从行内JSON提取工具调用', () => {
      const aiResponse = '请执行 { "tool": "bash", "command": "echo hello" } 命令';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(1);
      expect(calls[0].tool).toBe('bash');
    });

    it('无工具调用应返回空数组', () => {
      const aiResponse = '这是一个纯文本回复，没有工具调用。';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(0);
    });

    it('应支持edit工具的patch参数', () => {
      const aiResponse = '```json\n{ "tool": "edit", "filePath": "app.ts", "patch": "@@ -1,3 +1,3 @@" }\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(1);
      expect(calls[0].tool).toBe('edit');
      expect(calls[0].patch).toBeDefined();
    });

    it('应支持glob工具', () => {
      const aiResponse = '```json\n{ "tool": "glob", "globPattern": "**/*.ts" }\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(1);
      expect(calls[0].tool).toBe('glob');
      expect(calls[0].globPattern).toBe('**/*.ts');
    });

    it('应支持git工具', () => {
      const aiResponse = '```json\n{ "tool": "git", "command": "git status" }\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(1);
      expect(calls[0].tool).toBe('git');
      expect(calls[0].command).toBe('git status');
    });
  });

  // ---- buildResponse/buildErrorResponse ----
  describe('buildResponse', () => {
    it('应构建成功响应', () => {
      const toolCalls: ToolCall[] = [{ tool: 'read', filePath: 'test.ts' }];
      const response = converter.buildResponse(0, '成功', toolCalls);
      expect(response.code).toBe(0);
      expect(response.msg).toBe('成功');
      expect(response.data.toolCalls.length).toBe(1);
      expect(response.data.appendChatMsg).toBeDefined();
    });

    it('应构建带追加消息的响应', () => {
      const toolCalls: ToolCall[] = [];
      const appendMsg = { role: 'system' as const, content: '已完成' };
      const response = converter.buildResponse(0, 'OK', toolCalls, appendMsg);
      expect(response.data.appendChatMsg.content).toBe('已完成');
    });

    it('应构建错误响应', () => {
      const response = converter.buildErrorResponse(2001, '文件越权');
      expect(response.code).toBe(2001);
      expect(response.data.toolCalls).toEqual([]);
      expect(response.data.appendChatMsg.content).toContain('2001');
    });
  });

  // ---- executionResultToMessage ----
  describe('executionResultToMessage', () => {
    it('成功结果应转换为系统消息', () => {
      const msg = converter.executionResultToMessage({
        success: true,
        outputText: '文件内容',
        errorText: '',
        exitCode: 0,
        operateFiles: [],
      });
      expect(msg.role).toBe('system');
      expect(msg.content).toContain('本地执行成功');
      expect(msg.content).toContain('文件内容');
    });

    it('失败结果应包含错误信息', () => {
      const msg = converter.executionResultToMessage({
        success: false,
        outputText: '',
        errorText: '命令失败',
        exitCode: 1,
        operateFiles: [],
      });
      expect(msg.content).toContain('本地执行失败');
      expect(msg.content).toContain('命令失败');
    });

    it('有Diff应包含Diff信息', () => {
      const msg = converter.executionResultToMessage({
        success: true,
        outputText: '',
        errorText: '',
        exitCode: 0,
        diffPatch: '@@ -1 +1 @@',
        operateFiles: [],
      });
      expect(msg.content).toContain('Diff');
    });
  });

  // ---- buildProjectContext ----
  describe('buildProjectContext', () => {
    it('应构建项目文件摘要', () => {
      const files = [
        { path: 'src/app.ts', content: 'const app = 1;' },
        { path: 'src/utils.ts', content: 'export function helper() {}' },
      ];
      const chunks = converter.buildProjectContext(files);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toContain('src/app.ts');
      expect(chunks[0]).toContain('src/utils.ts');
    });

    it('超过maxContextChunk应自动分块', () => {
      const files = [];
      for (let i = 0; i < 100; i++) {
        files.push({ path: `file${i}.ts`, content: 'x'.repeat(500) });
      }
      const chunks = converter.buildProjectContext(files);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        // 每个分块不应超过maxContextChunk太多
        expect(chunk.length).toBeLessThanOrEqual(DEFAULT_CONFIG.maxContextChunk + 100);
      }
    });

    it('单个超大文件应截断', () => {
      const files = [
        { path: 'huge.ts', content: 'x'.repeat(DEFAULT_CONFIG.maxContextChunk + 1000) },
      ];
      const chunks = converter.buildProjectContext(files);
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toContain('文件过大已截断');
    });

    it('空文件列表应返回空数组', () => {
      const chunks = converter.buildProjectContext([]);
      expect(chunks).toEqual([]);
    });
  });
});