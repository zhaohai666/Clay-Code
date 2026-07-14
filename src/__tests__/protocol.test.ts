import { describe, it, expect, beforeEach } from 'vitest';
import { ProtocolConverter, TaskPlanEngine } from '../core/protocol';
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

    it('应支持view工具（终端文件阅读器）', () => {
      const aiResponse = '```json\n{ "tool": "view", "filePath": "src/app.ts", "lineRange": "10-50", "showLineNumbers": true }\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(1);
      expect(calls[0].tool).toBe('view');
      expect(calls[0].filePath).toBe('src/app.ts');
      expect(calls[0].lineRange).toBe('10-50');
      expect(calls[0].showLineNumbers).toBe(true);
    });

    it('应支持run_test工具（标准化测试）', () => {
      const aiResponse = '```json\n{ "tool": "run_test", "testFilter": "auth.test", "testWatch": false }\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(1);
      expect(calls[0].tool).toBe('run_test');
      expect(calls[0].testFilter).toBe('auth.test');
      expect(calls[0].testWatch).toBe(false);
    });

    it('应支持run_test工具无必填字段', () => {
      const aiResponse = '```json\n{ "tool": "run_test" }\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(1);
      expect(calls[0].tool).toBe('run_test');
    });

    it('应支持symbol_search工具（代码符号搜索）', () => {
      const aiResponse = '```json\n{ "tool": "symbol_search", "symbolName": "UserService", "symbolKind": "class", "symbolLimit": 20 }\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(1);
      expect(calls[0].tool).toBe('symbol_search');
      expect(calls[0].symbolName).toBe('UserService');
      expect(calls[0].symbolKind).toBe('class');
      expect(calls[0].symbolLimit).toBe(20);
    });

    it('应拒绝无效的symbol_search（缺少symbolName）', () => {
      const aiResponse = '```json\n{ "tool": "symbol_search", "symbolKind": "function" }\n```';
      const calls = converter.parseToolCalls(aiResponse);
      expect(calls.length).toBe(0);
    });
  });

  // ---- isValidToolCall ----
  describe('isValidToolCall', () => {
    it('应接受有效的read工具调用', () => {
      expect(converter.isValidToolCall({ tool: 'read', filePath: 'src/app.ts' })).toBe(true);
    });

    it('应接受有效的edit工具调用', () => {
      expect(converter.isValidToolCall({ tool: 'edit', filePath: 'src/app.ts', search: 'old', replace: 'new' })).toBe(true);
    });

    it('应接受有效的write工具调用', () => {
      expect(converter.isValidToolCall({ tool: 'write', filePath: 'src/app.ts', content: 'code' })).toBe(true);
    });

    it('应接受有效的bash工具调用', () => {
      expect(converter.isValidToolCall({ tool: 'bash', command: 'npm test' })).toBe(true);
    });

    it('应接受有效的git工具调用', () => {
      expect(converter.isValidToolCall({ tool: 'git', command: 'git status' })).toBe(true);
    });

    it('应接受有效的glob工具调用', () => {
      expect(converter.isValidToolCall({ tool: 'glob', globPattern: '**/*.ts' })).toBe(true);
    });

    it('应接受有效的view工具调用', () => {
      expect(converter.isValidToolCall({ tool: 'view', filePath: 'src/app.ts' })).toBe(true);
    });

    it('应接受有效的view工具调用（含可选字段）', () => {
      expect(converter.isValidToolCall({ tool: 'view', filePath: 'src/app.ts', lineRange: '10-50', showLineNumbers: true })).toBe(true);
    });

    it('应接受有效的run_test工具调用（无必填字段）', () => {
      expect(converter.isValidToolCall({ tool: 'run_test' })).toBe(true);
    });

    it('应接受有效的run_test工具调用（含可选字段）', () => {
      expect(converter.isValidToolCall({ tool: 'run_test', testFilter: 'auth.test', testWatch: false })).toBe(true);
    });

    it('应接受有效的symbol_search工具调用', () => {
      expect(converter.isValidToolCall({ tool: 'symbol_search', symbolName: 'UserService' })).toBe(true);
    });

    it('应接受有效的symbol_search工具调用（含可选字段）', () => {
      expect(converter.isValidToolCall({ tool: 'symbol_search', symbolName: 'UserService', symbolKind: 'class', symbolLimit: 20 })).toBe(true);
    });

    it('应拒绝非对象输入', () => {
      expect(converter.isValidToolCall(null)).toBe(false);
      expect(converter.isValidToolCall(undefined)).toBe(false);
      expect(converter.isValidToolCall('string')).toBe(false);
      expect(converter.isValidToolCall(123)).toBe(false);
    });

    it('应拒绝缺少tool字段的对象', () => {
      expect(converter.isValidToolCall({ filePath: 'src/app.ts' })).toBe(false);
    });

    it('应拒绝未知工具类型', () => {
      expect(converter.isValidToolCall({ tool: 'unknown', filePath: 'src/app.ts' })).toBe(false);
    });

    it('应拒绝read/edit/write/view缺少filePath', () => {
      expect(converter.isValidToolCall({ tool: 'read' })).toBe(false);
      expect(converter.isValidToolCall({ tool: 'edit', search: 'old', replace: 'new' })).toBe(false);
      expect(converter.isValidToolCall({ tool: 'write', content: 'code' })).toBe(false);
      expect(converter.isValidToolCall({ tool: 'view', lineRange: '10-50' })).toBe(false);
    });

    it('应拒绝bash/git缺少command', () => {
      expect(converter.isValidToolCall({ tool: 'bash' })).toBe(false);
      expect(converter.isValidToolCall({ tool: 'git' })).toBe(false);
    });

    it('应拒绝glob缺少globPattern', () => {
      expect(converter.isValidToolCall({ tool: 'glob' })).toBe(false);
    });

    it('应拒绝symbol_search缺少symbolName', () => {
      expect(converter.isValidToolCall({ tool: 'symbol_search' })).toBe(false);
      expect(converter.isValidToolCall({ tool: 'symbol_search', symbolKind: 'function' })).toBe(false);
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

// ---- TaskPlanEngine ----
describe('TaskPlanEngine', () => {
  let engine: TaskPlanEngine;

  beforeEach(() => {
    engine = new TaskPlanEngine();
  });

  // ---- shouldPlan ----
  describe('shouldPlan', () => {
    it('简单需求不应触发规划', () => {
      expect(engine.shouldPlan('修复typo')).toBe(false);
    });

    it('单个复杂信号不应触发规划', () => {
      expect(engine.shouldPlan('重构这个函数')).toBe(false);
    });

    it('两个以上复杂信号应触发规划', () => {
      expect(engine.shouldPlan('重构并迁移数据库模块')).toBe(true);
    });

    it('超过200字的需求应触发规划', () => {
      const longPrompt = '请帮我实现一个完整的用户管理系统'.repeat(15);
      expect(engine.shouldPlan(longPrompt)).toBe(true);
    });

    it('包含多步骤信号应触发规划', () => {
      expect(engine.shouldPlan('重构并迁移数据库模块')).toBe(true);
    });
  });

  // ---- createPlan ----
  describe('createPlan', () => {
    it('应创建包含子任务的规划', () => {
      const plan = engine.createPlan('重构认证模块', [
        { title: '分析现有代码', description: '阅读现有认证逻辑' },
        { title: '编写新实现' },
      ]);
      expect(plan.summary).toBe('重构认证模块');
      expect(plan.subTasks.length).toBe(2);
      expect(plan.status).toBe('pending');
    });

    it('应自动分配子任务ID', () => {
      const plan = engine.createPlan('迁移数据库', [
        { title: '备份数据' },
        { title: '执行迁移' },
        { title: '验证结果' },
      ]);
      expect(plan.subTasks[0].id).toBe('task-1');
      expect(plan.subTasks[1].id).toBe('task-2');
      expect(plan.subTasks[2].id).toBe('task-3');
    });

    it('子任务初始状态应为未完成', () => {
      const plan = engine.createPlan('测试', [{ title: '步骤1' }]);
      expect(plan.subTasks[0].finished).toBe(false);
    });

    it('应支持子任务依赖', () => {
      const plan = engine.createPlan('测试', [
        { title: '步骤1', depends: [] },
        { title: '步骤2', depends: ['task-1'] },
      ]);
      expect(plan.subTasks[1].depends).toEqual(['task-1']);
    });

    it('应设为当前规划', () => {
      engine.createPlan('当前规划', [{ title: '任务1' }]);
      expect(engine.getCurrentPlan()).not.toBeNull();
      expect(engine.getCurrentPlan()!.summary).toBe('当前规划');
    });
  });

  // ---- extractPlanFromResponse ----
  describe('extractPlanFromResponse', () => {
    it('应从JSON代码块提取规划', () => {
      const response = '```json\n{"summary":"重构","subTasks":[{"title":"步骤1"},{"title":"步骤2"}]}\n```';
      const plan = engine.extractPlanFromResponse(response);
      expect(plan).not.toBeNull();
      expect(plan!.summary).toBe('重构');
      expect(plan!.subTasks.length).toBe(2);
    });

    it('应从代码块提取规划（非tool字段JSON）', () => {
      const response = '```json\n{"summary":"迁移","subTasks":[{"title":"分析"},{"title":"执行"}]}\n```';
      const plan = engine.extractPlanFromResponse(response);
      expect(plan).not.toBeNull();
      expect(plan!.summary).toBe('迁移');
      expect(plan!.subTasks.length).toBe(2);
    });

    it('无效响应应返回null', () => {
      expect(engine.extractPlanFromResponse('这是普通文本')).toBeNull();
    });

    it('缺少subTasks应返回null', () => {
      const response = '```json\n{"summary":"无子任务"}\n```';
      expect(engine.extractPlanFromResponse(response)).toBeNull();
    });

    it('应标准化规划字段', () => {
      const response = '```json\n{"summary":"测试","subTasks":[{"title":"步骤1"}]}\n```';
      const plan = engine.extractPlanFromResponse(response);
      expect(plan!.subTasks[0].id).toBe('task-1');
      expect(plan!.subTasks[0].finished).toBe(false);
      expect(plan!.status).toBe('pending');
    });
  });

  // ---- getCurrentPlan ----
  describe('getCurrentPlan', () => {
    it('初始应返回null', () => {
      expect(engine.getCurrentPlan()).toBeNull();
    });

    it('创建规划后应返回当前规划', () => {
      engine.createPlan('当前', [{ title: '任务1' }]);
      expect(engine.getCurrentPlan()).not.toBeNull();
    });
  });

  // ---- updateSubTask ----
  describe('updateSubTask', () => {
    it('应更新子任务字段', () => {
      engine.createPlan('测试', [{ title: '步骤1' }]);
      const plan = engine.updateSubTask('task-1', { finished: true });
      expect(plan).not.toBeNull();
      expect(plan!.subTasks[0].finished).toBe(true);
    });

    it('所有子任务完成应标记规划为completed', () => {
      engine.createPlan('测试', [{ title: '步骤1' }]);
      const plan = engine.updateSubTask('task-1', { finished: true });
      expect(plan!.status).toBe('completed');
    });

    it('不存在的taskId应返回null', () => {
      engine.createPlan('测试', [{ title: '步骤1' }]);
      expect(engine.updateSubTask('non-existent', { finished: true })).toBeNull();
    });

    it('无当前规划应返回null', () => {
      expect(engine.updateSubTask('task-1', { finished: true })).toBeNull();
    });
  });

  // ---- activatePlan / cancelPlan ----
  describe('activatePlan / cancelPlan', () => {
    it('activatePlan应将状态设为active', () => {
      engine.createPlan('测试', [{ title: '步骤1' }]);
      const plan = engine.activatePlan();
      expect(plan).not.toBeNull();
      expect(plan!.status).toBe('active');
    });

    it('cancelPlan应将状态设为cancelled', () => {
      engine.createPlan('测试', [{ title: '步骤1' }]);
      const plan = engine.cancelPlan();
      expect(plan).not.toBeNull();
      expect(plan!.status).toBe('cancelled');
    });

    it('无当前规划时activatePlan应返回null', () => {
      expect(engine.activatePlan()).toBeNull();
    });

    it('无当前规划时cancelPlan应返回null', () => {
      expect(engine.cancelPlan()).toBeNull();
    });
  });

  // ---- getNextTask ----
  describe('getNextTask', () => {
    it('active状态下应返回第一个未完成任务', () => {
      engine.createPlan('测试', [
        { title: '步骤1' },
        { title: '步骤2' },
      ]);
      engine.activatePlan();
      const next = engine.getNextTask();
      expect(next).not.toBeNull();
      expect(next!.title).toBe('步骤1');
    });

    it('应跳过已完成的任务', () => {
      engine.createPlan('测试', [
        { title: '步骤1' },
        { title: '步骤2' },
      ]);
      engine.activatePlan();
      engine.updateSubTask('task-1', { finished: true });
      const next = engine.getNextTask();
      expect(next!.title).toBe('步骤2');
    });

    it('应尊重依赖关系', () => {
      engine.createPlan('测试', [
        { title: '步骤1' },
        { title: '步骤2', depends: ['task-1'] },
      ]);
      engine.activatePlan();
      // 步骤2依赖步骤1，步骤1未完成，getNextTask应返回步骤1
      const next = engine.getNextTask();
      expect(next!.title).toBe('步骤1');
    });

    it('依赖满足后应返回依赖任务', () => {
      engine.createPlan('测试', [
        { title: '步骤1' },
        { title: '步骤2', depends: ['task-1'] },
      ]);
      engine.activatePlan();
      engine.updateSubTask('task-1', { finished: true });
      const next = engine.getNextTask();
      expect(next!.title).toBe('步骤2');
    });

    it('非active状态应返回null', () => {
      engine.createPlan('测试', [{ title: '步骤1' }]);
      // 状态为pending，不是active
      expect(engine.getNextTask()).toBeNull();
    });

    it('所有任务完成应返回null', () => {
      engine.createPlan('测试', [{ title: '步骤1' }]);
      engine.activatePlan();
      engine.updateSubTask('task-1', { finished: true });
      expect(engine.getNextTask()).toBeNull();
    });
  });

  // ---- generatePlanSummary ----
  describe('generatePlanSummary', () => {
    it('应生成包含摘要和状态的文本', () => {
      engine.createPlan('重构认证模块', [
        { title: '分析代码' },
        { title: '编写新实现' },
      ]);
      const summary = engine.generatePlanSummary();
      expect(summary).toContain('重构认证模块');
      expect(summary).toContain('pending');
      expect(summary).toContain('分析代码');
      expect(summary).toContain('编写新实现');
    });

    it('已完成任务应显示完成标记', () => {
      engine.createPlan('测试', [{ title: '步骤1' }]);
      engine.updateSubTask('task-1', { finished: true });
      const summary = engine.generatePlanSummary();
      expect(summary).toContain('✅');
    });

    it('应显示依赖关系', () => {
      engine.createPlan('测试', [
        { title: '步骤1' },
        { title: '步骤2', depends: ['task-1'] },
      ]);
      const summary = engine.generatePlanSummary();
      expect(summary).toContain('依赖');
      expect(summary).toContain('task-1');
    });

    it('无规划时应返回空字符串', () => {
      expect(engine.generatePlanSummary()).toBe('');
    });
  });
});