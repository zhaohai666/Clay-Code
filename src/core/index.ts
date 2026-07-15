/**
 * ClayCode 主引擎入口
 * 串联四大模块：终端交互 → 浏览器桥接 → 协议转换 → 本地执行
 * 单进程一体化，模块间内存级通信
 * 集成安全/缓存/插件/监控子系统
 * 增量上下文同步 + 全链路异常自动恢复 + 资源自动回收
 */

import * as path from 'path';
import {
  GlobalConfig, TaskRequest, TaskResponse, ToolCall,
  ChatMessage, ExecuteResult, ErrorCode, ERROR_MESSAGES,
  DEFAULT_CONFIG, AdapterType, CacheLevel, FileChangeRecord,
} from '../types';
import { logger, findChromePath, resolveHome } from '../utils';
import { ConfigManager } from './config';
import { SessionManager } from './session';
import { BrowserBridge } from './browser';
import { ProtocolConverter } from './protocol';
import { StreamingToolCallParser } from './protocol';
import { LocalExecutor } from './executor';
import { AdapterFactory, OllamaAdapter } from './adapter';
import { SecurityManager } from './security';
import { CacheManager } from './cache';
import { PluginManager } from './plugin';
import { MetricsCollector } from './metrics';

/** 引擎运行状态 */
export type EngineState = 'idle' | 'thinking' | 'executing' | 'error';

/** 指数退避重试延迟基数(ms) */
const RETRY_BASE_DELAY = 1000;
/** AI无ToolCall自动重试最大次数 */
const MAX_NO_TOOLCALL_RETRY = 2;

export class ClayCodeEngine {
  private config: GlobalConfig;
  private configManager: ConfigManager;
  private sessionManager: SessionManager;
  private browserBridge: BrowserBridge;
  private protocol: ProtocolConverter;
  private executor: LocalExecutor;
  private adapterFactory: AdapterFactory;
  private security: SecurityManager;
  private cache: CacheManager;
  private pluginManager: PluginManager;
  private metrics: MetricsCollector;
  private state: EngineState = 'idle';
  private maxRounds: number;
  private cwd: string;

  /** 增量上下文：追踪本轮文件变更 */
  private changedFiles: Set<string> = new Set();
  /** 上一轮项目上下文摘要 */
  private previousContext: string = '';
  /** 浏览器闲置释放定时器 */
  private browserIdleTimer?: ReturnType<typeof setTimeout>;
  /** 任务临时变量（任务结束清理） */
  private tempVars: Map<string, unknown> = new Map();

  constructor(options?: {
    configPath?: string;
    cwd?: string;
    maxRounds?: number;
    /** 强制浏览器无头模式（覆盖配置文件中的browserHeadless） */
    browserHeadless?: boolean;
  }) {
    // 1. 加载配置
    this.configManager = new ConfigManager(options?.configPath);
    this.config = this.configManager.getConfig();
    // 覆盖浏览器无头模式（chat/agent命令需要headless，login命令需要可见）
    if (options?.browserHeadless !== undefined) {
      this.config.browserHeadless = options.browserHeadless;
    }

    this.cwd = options?.cwd || process.cwd();

    // 2. 安全管理器
    this.security = new SecurityManager(this.cwd, {
      execWhiteList: this.config.execWhiteList,
    });

    // 3. 初始化会话管理
    this.sessionManager = new SessionManager(
      this.configManager.getSessionDir(),
      this.config.maxContextChunk,
      this.security,
    );

    // 4. 分级缓存管理器
    this.cache = new CacheManager({
      cacheLevel: this.config.cacheLevel,
      l2Dir: this.configManager.getCacheDir(),
    });

    // 5. 插件管理器
    this.pluginManager = new PluginManager(this.configManager.getPluginsDir());

    // 6. 监控指标采集器
    this.metrics = new MetricsCollector({
      httpPort: this.config.metricsPort,
    });

    // 7. 初始化协议转换器
    this.protocol = new ProtocolConverter(this.config);

    // 8. 初始化本地执行引擎
    this.executor = new LocalExecutor(this.cwd, {
      maxOutputLength: this.config.maxContextChunk,
      execWhiteList: this.config.execWhiteList,
      enableSandbox: this.config.enableSandbox,
      enableDockerSandbox: this.config.enableDockerSandbox,
    });

    // 9. 初始化浏览器桥接
    this.browserBridge = new BrowserBridge(this.config);

    // 10. 初始化适配器工厂
    this.adapterFactory = new AdapterFactory(this.browserBridge, this.config);

    // 11. 最大循环轮次
    this.maxRounds = options?.maxRounds || 10;
  }

  /** 获取当前引擎状态 */
  getState(): EngineState {
    return this.state;
  }

  /** 获取配置 */
  getConfig(): GlobalConfig {
    return { ...this.config };
  }

  /** 设置默认适配器 */
  setDefaultAdapter(adapter: string): void {
    this.config.defaultAdapter = adapter as GlobalConfig['defaultAdapter'];
  }

  /** 获取会话管理器 */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /** 获取安全管理器 */
  getSecurityManager(): SecurityManager {
    return this.security;
  }

  /** 获取缓存管理器 */
  getCacheManager(): CacheManager {
    return this.cache;
  }

  /** 获取插件管理器 */
  getPluginManager(): PluginManager {
    return this.pluginManager;
  }

  /** 获取监控指标采集器 */
  getMetricsCollector(): MetricsCollector {
    return this.metrics;
  }

  /** 获取配置管理器 */
  getConfigManager(): ConfigManager {
    return this.configManager;
  }

  /**
   * 初始化引擎：启动浏览器 + 加载会话 + 初始化插件
   */
  async init(): Promise<void> {
    logger.info('[ClayCodeEngine] 初始化中...');

    // 确保所有目录存在
    this.configManager.ensureAllDirs();

    // 初始化日志
    logger.init();

    // 加载会话
    await this.sessionManager.init();

    // 启动浏览器
    await this.browserBridge.launch();
    logger.info('[ClayCodeEngine] 浏览器已启动');

    // 恢复已保存的Cookie（复用登录态）
    if (this.browserBridge.hasCookieCache()) {
      await this.browserBridge.loadCookies();
      logger.info('[ClayCodeEngine] 已恢复登录态');
    }

    // 加载并初始化插件
    await this.pluginManager.loadAll();
    await this.pluginManager.setupAll();
    logger.info('[ClayCodeEngine] 插件已加载');

    // 启动Prometheus HTTP端点（如果配置了端口）
    if (this.config.metricsPort > 0) {
      await this.metrics.startHttpServer();
    }

    logger.info('[ClayCodeEngine] 初始化完成');
  }

  /**
   * 主入口：处理用户任务
   * 循环执行：发送AI → 解析工具调用 → 本地执行 → 结果回传 → 再发送
   * 集成：增量上下文同步 + 全链路异常自动恢复 + 资源自动回收
   */
  async processTask(
    userPrompt: string,
    sessionId?: string,
    onProgress?: (state: EngineState, msg: string) => void
  ): Promise<TaskResponse> {
    // 重置任务状态
    this.changedFiles.clear();
    this.tempVars.clear();

    // 获取或创建会话
    const session = sessionId
      ? this.sessionManager.getSession(sessionId)
      : this.sessionManager.createSession();

    // 追加用户消息
    this.sessionManager.addMessage(session.sessionId, { role: 'user', content: userPrompt });

    // 获取适配器
    const adapter = this.adapterFactory.getAdapter(this.config.defaultAdapter);
    if (!adapter) {
      const errMsg = ERROR_MESSAGES[ErrorCode.ADAPTER_NOT_FOUND] || '适配器不存在';
      return this.protocol.buildErrorResponse(ErrorCode.ADAPTER_NOT_FOUND, errMsg);
    }

    // 尝试恢复登录态（可选，不阻塞请求）
    try {
      if (this.browserBridge.hasCookieCache()) {
        await this.browserBridge.loadCookies();
      }
    } catch { /* 忽略Cookie加载失败，继续请求 */ }

    // 插件钩子：beforeAiRequest
    await this.pluginManager.beforeAiRequest({
      sessionId: session.sessionId,
      adapterName: this.config.defaultAdapter,
      timestamp: Date.now(),
    });

    // 构建初始请求（增量上下文同步：首轮构建项目摘要）
    const initialContext = await this.buildInitialProjectContext();
    this.previousContext = initialContext;
    let request: TaskRequest = {
      userPrompt,
      projectPath: this.cwd,
      sessionHistory: session.messages.slice(-this.config.maxHistoryMessages),
      projectChunkContext: initialContext,
      lastExecuteOutput: undefined,
    };

    // 循环执行
    let round = 0;
    let lastResponse: TaskResponse | null = null;
    let noToolCallRetryCount = 0;

    while (round < this.maxRounds) {
      round++;
      this.state = 'thinking';
      onProgress?.('thinking', `第 ${round} 轮：等待AI回复...`);
      logger.info(`[ClayCodeEngine] === 第 ${round} 轮 ===`);

      try {
        // 1. 发送给AI（带指数退避重试）
        const aiResponse = await this.askWithRetry(adapter, request, session.sessionId);

        // 2. 解析工具调用
        const toolCalls = this.protocol.parseToolCalls(aiResponse);

        // 3. 如果没有工具调用，说明AI直接回复了文本
        //    全链路异常恢复：AI返回无合法ToolCall时自动追加提示词重新请求
        if (toolCalls.length === 0) {
          noToolCallRetryCount++;
          if (noToolCallRetryCount <= MAX_NO_TOOLCALL_RETRY) {
            logger.info(`[ClayCodeEngine] AI未返回工具调用，追加提示词重试(${noToolCallRetryCount}/${MAX_NO_TOOLCALL_RETRY})`);
            this.sessionManager.addMessage(session.sessionId, { role: 'ai', content: aiResponse });
            this.sessionManager.addMessage(session.sessionId, {
              role: 'system',
              content: '请使用标准JSON工具调用格式输出操作指令，不要仅回复文本说明。参考系统提示中的工具格式。',
            });
            // 更新请求上下文
            request = {
              ...request,
              sessionHistory: session.messages.slice(-this.config.maxHistoryMessages),
            };
            continue;
          }

          // 超过重试次数，接受AI文本回复
          this.sessionManager.addMessage(session.sessionId, { role: 'ai', content: aiResponse });
          lastResponse = this.protocol.buildResponse(0, 'AI文本回复', [], {
            role: 'ai',
            content: aiResponse,
          });
          break;
        }

        // 重置无ToolCall重试计数
        noToolCallRetryCount = 0;

        // 4. 执行工具调用
        this.state = 'executing';
        onProgress?.('executing', `第 ${round} 轮：执行 ${toolCalls.length} 个工具调用...`);
        const results = await this.executor.executeBatch(toolCalls);

        // 5. 记录文件操作和命令结果到监控 + 追踪文件变更
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const tc = toolCalls[i];
          if (tc) {
            this.metrics.recordFileOperation(tc.tool as 'read' | 'write' | 'edit' | 'bash' | 'git');
            // 增量上下文：追踪文件变更（write/edit操作 + Git操作变更记录）
            if (tc.filePath && ['write', 'edit'].includes(tc.tool)) {
              this.changedFiles.add(tc.filePath);
            }
            // README 3.4.3：Git变更记录自动同步至AI上下文
            if (tc.tool === 'git' && result.operateFiles.length > 0) {
              for (const f of result.operateFiles) {
                this.changedFiles.add(f);
              }
            }
          }
          this.metrics.recordCommandResult(result.success);
        }

        // 6. 汇总执行结果
        const summaryResult = this.summarizeResults(results);
        const execMessage = this.protocol.executionResultToMessage(summaryResult);

        // 7. 插件钩子：afterToolExecute
        for (let i = 0; i < results.length; i++) {
          const tc = toolCalls[i];
          if (tc) {
            await this.pluginManager.afterToolExecute(tc, results[i], {
              sessionId: session.sessionId,
              adapterName: this.config.defaultAdapter,
              timestamp: Date.now(),
            });
          }
        }

        // 8. 追加到会话
        this.sessionManager.addMessage(session.sessionId, { role: 'ai', content: aiResponse });
        this.sessionManager.addMessage(session.sessionId, execMessage);

        // 9. 增量上下文同步：仅传输变更文件片段
        const incrementalContext = this.protocol.buildIncrementalContextFromFiles(
          this.cwd,
          Array.from(this.changedFiles),
          summaryResult,
        );
        this.previousContext = incrementalContext;

        // 10. 构建下一轮请求
        request = {
          userPrompt,
          projectPath: this.cwd,
          sessionHistory: session.messages.slice(-this.config.maxHistoryMessages),
          projectChunkContext: incrementalContext,
          lastExecuteOutput: summaryResult,
        };

        // 11. 构建本轮响应
        lastResponse = this.protocol.buildResponse(0, `第${round}轮执行完成`, toolCalls, execMessage);

        // 12. 检查是否所有工具都成功
        const hasFailure = results.some(r => !r.success);
        if (hasFailure) {
          logger.warn('[ClayCodeEngine] 部分工具执行失败，继续循环让AI处理');
        }

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[ClayCodeEngine] 第${round}轮异常: ${message}`);

        // 全链路异常恢复：Chrome崩溃自动重启
        if (message.includes('Browser') || message.includes('Chrome') || message.includes('Target closed')) {
          logger.info('[ClayCodeEngine] 检测到浏览器崩溃，尝试自动重启...');
          try {
            await this.browserBridge.attemptRestart();
            this.metrics.recordBrowserRestart();
            logger.info('[ClayCodeEngine] 浏览器重启成功，继续任务');
            // 不break，继续下一轮重试
            continue;
          } catch (restartErr) {
            logger.error(`[ClayCodeEngine] 浏览器重启失败: ${restartErr instanceof Error ? restartErr.message : String(restartErr)}`);
          }
        }

        this.state = 'error';
        lastResponse = this.protocol.buildErrorResponse(ErrorCode.RESPONSE_TIMEOUT, message);
        break;
      }
    }

    if (round >= this.maxRounds) {
      logger.warn(`[ClayCodeEngine] 达到最大轮次 ${this.maxRounds}，终止循环`);
      lastResponse = this.protocol.buildErrorResponse(
        ErrorCode.CONTEXT_TOO_LONG,
        `达到最大执行轮次 ${this.maxRounds}`
      );
    }

    this.state = 'idle';
    onProgress?.('idle', '任务完成');

    // 资源自动回收：任务结束清理临时变量
    this.tempVars.clear();
    this.changedFiles.clear();

    // 持久化会话
    this.sessionManager.persistSession(session.sessionId);

    // 重置浏览器闲置计时器
    this.resetBrowserIdleTimer();

    return lastResponse || this.protocol.buildErrorResponse(ErrorCode.RESPONSE_TIMEOUT, '无响应');
  }

  /**
   * 流式任务处理（README 5.3 流式实时工具调用解析）
   * AI流式响应边解析边执行工具调用，无需等待完整回复
   * 仅在适配器支持askStream时启用，否则回退到普通模式
   */
  async processTaskStreaming(
    task: string,
    sessionId?: string,
    onProgress?: (state: EngineState, msg: string) => void,
    onToolCall?: (toolCall: ToolCall, index: number) => void,
  ): Promise<TaskResponse> {
    const session = sessionId
      ? this.sessionManager.getSession(sessionId) || this.sessionManager.createSession(undefined, this.config.defaultAdapter, this.cwd)
      : this.sessionManager.createSession(undefined, this.config.defaultAdapter, this.cwd);

    const adapterName = this.config.defaultAdapter;
    const adapter = this.adapterFactory.getAdapter(adapterName);

    // 检查适配器是否支持流式（仅OllamaAdapter支持askStream）
    if (!('askStream' in adapter) || typeof (adapter as OllamaAdapter).askStream !== 'function') {
      logger.info('[ClayCodeEngine] 适配器不支持流式，回退到普通模式');
      return this.processTask(task, session.sessionId, onProgress);
    }

    const streamAdapter = adapter as OllamaAdapter;

    // 尝试恢复登录态（可选，不阻塞请求）
    try {
      if (this.browserBridge.hasCookieCache()) {
        await this.browserBridge.loadCookies();
      }
    } catch { /* 忽略Cookie加载失败，继续请求 */ }

    this.changedFiles.clear();
    this.tempVars.clear();

    const projectContext = await this.buildInitialProjectContext();
    this.sessionManager.addMessage(session.sessionId, { role: 'user', content: task });

    const request: TaskRequest = {
      userPrompt: task,
      projectChunkContext: projectContext,
      sessionHistory: session.messages.slice(-this.config.maxHistoryMessages),
    };

    const streamParser = new StreamingToolCallParser(this.config);
    if (onToolCall) {
      streamParser.onToolCall(onToolCall);
    }

    let round = 0;
    let lastResponse: TaskResponse | null = null;
    let noToolCallRetryCount = 0;

    while (round < this.maxRounds) {
      round++;
      this.state = 'thinking';
      onProgress?.('thinking', `第 ${round} 轮：流式等待AI回复...`);
      logger.info(`[ClayCodeEngine] === 流式第 ${round} 轮 ===`);

      try {
        // 1. 流式发送给AI
        const prompt = this.protocol.buildPrompt(request);
        streamParser.reset();

        this.state = 'thinking';
        for await (const chunk of streamAdapter.askStream(prompt, session.sessionId)) {
          const newCallCount = streamParser.append(chunk);
          if (newCallCount > 0) {
            logger.info(`[ClayCodeEngine] 流式解析到 ${newCallCount} 个新工具调用`);
          }
        }

        // 2. 最终解析
        const toolCalls = streamParser.finalize();

        // 3. 获取AI文本回复
        const textContent = streamParser.getTextContent();

        // 4. 如果没有工具调用
        if (toolCalls.length === 0) {
          noToolCallRetryCount++;
          if (noToolCallRetryCount <= MAX_NO_TOOLCALL_RETRY) {
            logger.info(`[ClayCodeEngine] AI未返回工具调用，追加提示词重试(${noToolCallRetryCount}/${MAX_NO_TOOLCALL_RETRY})`);
            this.sessionManager.addMessage(session.sessionId, { role: 'ai', content: textContent });
            this.sessionManager.addMessage(session.sessionId, {
              role: 'system',
              content: '请使用标准JSON工具调用格式输出操作指令，不要仅回复文本说明。参考系统提示中的工具格式。',
            });
            request.sessionHistory = session.messages.slice(-this.config.maxHistoryMessages);
            continue;
          }

          this.sessionManager.addMessage(session.sessionId, { role: 'ai', content: textContent });
          lastResponse = this.protocol.buildResponse(0, 'AI文本回复', [], {
            role: 'ai',
            content: textContent,
          });
          break;
        }

        noToolCallRetryCount = 0;

        // 5. 执行工具调用
        this.state = 'executing';
        onProgress?.('executing', `第 ${round} 轮：执行 ${toolCalls.length} 个工具调用...`);
        const results = await this.executor.executeBatch(toolCalls);

        // 6. 记录监控与文件变更
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const tc = toolCalls[i];
          if (tc) {
            this.metrics.recordFileOperation(tc.tool as 'read' | 'write' | 'edit' | 'bash');
            if (tc.filePath && ['write', 'edit'].includes(tc.tool)) {
              this.changedFiles.add(tc.filePath);
            }
          }
          this.metrics.recordCommandResult(result.success);
        }

        // 7. 汇总执行结果
        const combinedResult = this.summarizeResults(results);
        this.sessionManager.addMessage(session.sessionId, { role: 'ai', content: textContent || JSON.stringify(toolCalls) });
        this.sessionManager.addMessage(session.sessionId, this.protocol.executionResultToMessage(combinedResult));

        // 8. 更新请求上下文
        request.sessionHistory = session.messages.slice(-this.config.maxHistoryMessages);
        request.lastExecuteOutput = combinedResult;

        // 增量上下文
        if (this.changedFiles.size > 0) {
          request.projectChunkContext = this.protocol.buildIncrementalContextFromFiles(
            this.cwd,
            Array.from(this.changedFiles),
            combinedResult,
          );
        }

        lastResponse = this.protocol.buildResponse(0, `执行${combinedResult.success ? '成功' : '失败'}`, toolCalls);

      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(`[ClayCodeEngine] 流式处理错误: ${error.message}`);

        // 浏览器崩溃恢复
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
          try {
            await this.browserBridge.attemptRestart();
            logger.info('[ClayCodeEngine] 浏览器重启成功，继续处理');
            continue;
          } catch (restartErr) {
            logger.error(`[ClayCodeEngine] 浏览器重启失败: ${restartErr instanceof Error ? restartErr.message : String(restartErr)}`);
          }
        }

        this.state = 'error';
        lastResponse = this.protocol.buildErrorResponse(ErrorCode.RESPONSE_TIMEOUT, error.message);
        break;
      }
    }

    if (round >= this.maxRounds) {
      lastResponse = this.protocol.buildErrorResponse(
        ErrorCode.CONTEXT_TOO_LONG,
        `达到最大执行轮次 ${this.maxRounds}`,
      );
    }

    this.state = 'idle';
    onProgress?.('idle', '流式任务完成');
    this.tempVars.clear();
    this.changedFiles.clear();
    this.sessionManager.persistSession(session.sessionId);
    this.resetBrowserIdleTimer();

    return lastResponse || this.protocol.buildErrorResponse(ErrorCode.RESPONSE_TIMEOUT, '无响应');
  }

  /**
   * 全链路异常恢复: 网络波动指数退避重试，最大3次
   */
  private async askWithRetry(
    adapter: { ask: (prompt: string, sessionId: string) => Promise<string> },
    request: TaskRequest,
    sessionId: string,
  ): Promise<string> {
    const maxRetries = this.config.maxRetryCount;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const startTime = Date.now();
        const prompt = this.protocol.buildPrompt(request);
        const aiResponse = await adapter.ask(prompt, sessionId);
        this.metrics.recordAiLatency(Date.now() - startTime);
        return aiResponse;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
          logger.warn(`[ClayCodeEngine] AI请求失败(${attempt + 1}/${maxRetries})，${delay}ms后重试: ${lastError.message}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('AI请求失败');
  }

  /**
   * 构建初始项目上下文
   * 首轮任务启动时扫描项目文件摘要
   */
  private async buildInitialProjectContext(): Promise<string> {
    try {
      const { execSync } = await import('child_process');
      // 使用git ls-files获取项目文件列表（比glob更精准）
      const files = execSync('git ls-files 2>/dev/null || find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | head -50', {
        cwd: this.cwd,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim().split('\n').filter(Boolean);

      if (files.length === 0) return '';

      // 读取关键文件内容作为项目摘要
      const fileList: Array<{ path: string; content: string }> = [];
      const priorityExts = ['.ts', '.js', '.json', '.md', '.yaml', '.yml'];
      const priorityFiles = files.filter(f => priorityExts.some(ext => f.endsWith(ext))).slice(0, 20);

      for (const file of priorityFiles) {
        try {
          const fullPath = path.resolve(this.cwd, file);
          const content = await import('fs').then(fs => fs.readFileSync(fullPath, 'utf-8'));
          fileList.push({ path: file, content });
        } catch {
          // 跳过无法读取的文件
        }
      }

      const chunks = this.protocol.buildProjectContext(fileList);
      return chunks.length > 0 ? chunks[0] : '';
    } catch {
      logger.debug('[ClayCodeEngine] 构建初始项目上下文失败，使用空上下文');
      return '';
    }
  }

  /**
   * 重置浏览器闲置计时器
   * 资源自动回收：浏览器闲置10分钟自动释放
   */
  private resetBrowserIdleTimer(): void {
    if (this.browserIdleTimer) {
      clearTimeout(this.browserIdleTimer);
    }
    this.browserIdleTimer = setTimeout(async () => {
      logger.info('[ClayCodeEngine] 浏览器闲置超时，自动释放资源...');
      try {
        await this.browserBridge.close();
        logger.info('[ClayCodeEngine] 浏览器已释放');
      } catch (err) {
        logger.warn(`[ClayCodeEngine] 浏览器释放失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.config.browserIdleTimeout);
  }

  /**
   * 交互式对话模式
   */
  async chat(
    message: string,
    sessionId?: string,
    onProgress?: (state: EngineState, msg: string) => void
  ): Promise<TaskResponse> {
    return this.processTask(message, sessionId, onProgress);
  }

  /**
   * Agent模式：自主执行任务
   */
  async agent(
    task: string,
    sessionId?: string,
    onProgress?: (state: EngineState, msg: string) => void
  ): Promise<TaskResponse> {
    return this.processTask(task, sessionId, onProgress);
  }

  /**
   * 打开登录页面
   */
  async login(adapterName?: string): Promise<string> {
    const name = (adapterName || this.config.defaultAdapter) as AdapterType;
    const adapter = this.adapterFactory.getAdapter(name);
    if (!adapter) {
      throw new Error(`适配器不存在: ${name}`);
    }

    await this.browserBridge.launch();
    const url = adapter.getLoginUrl();
    const page = await this.browserBridge.getPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    return url;
  }

  /**
   * 保存登录状态（Cookie加密持久化）
   * 供clay login命令在用户完成登录后调用
   */
  async saveLoginState(): Promise<void> {
    try {
      await this.browserBridge.saveCookies();
    } catch (err) {
      logger.warn(`[ClayCodeEngine] 保存登录状态失败: ${(err as Error).message}`);
    }
  }

  /**
   * 启动Cookie自动保存（clay login期间使用）
   * 定期保存Cookie避免Ctrl+C时Chrome已关闭导致保存失败
   */
  startCookieAutoSave(intervalMs?: number): void {
    this.browserBridge.startCookieAutoSave(intervalMs);
  }

  /** 停止Cookie自动保存 */
  stopCookieAutoSave(): void {
    this.browserBridge.stopCookieAutoSave();
  }

  /** 检查是否有Cookie缓存文件 */
  hasCookieCache(): boolean {
    return this.browserBridge.hasCookieCache();
  }

  /**
   * 关闭引擎，释放资源
   * 退出前自动保存Cookie，确保登录态持久化
   */
  async dispose(): Promise<void> {
    logger.info('[ClayCodeEngine] 关闭引擎...');
    // 先保存Cookie（浏览器关闭前才能获取）
    try {
      await this.browserBridge.saveCookies();
      logger.info('[ClayCodeEngine] 登录状态已保存');
    } catch { /* 忽略 */ }
    try {
      await this.pluginManager.destroyAll();
    } catch { /* 忽略 */ }
    try {
      await this.browserBridge.close();
    } catch { /* 忽略 */ }
    this.cache.destroy();
    try {
      await this.metrics.destroy();
    } catch { /* 忽略 */ }
    logger.close();
  }

  /** 汇总多个执行结果 */
  private summarizeResults(results: ExecuteResult[]): ExecuteResult {
    const success = results.every(r => r.success);
    const outputText = results
      .map((r, i) => `[${i + 1}] ${r.success ? '✓' : '✗'} ${r.outputText || r.errorText}`)
      .join('\n');
    const errorText = results
      .filter(r => !r.success)
      .map(r => r.errorText)
      .join('\n');
    const diffPatch = results
      .filter(r => r.diffPatch)
      .map(r => r.diffPatch)
      .join('\n');

    // 收集所有操作的文件
    const operateFiles = results
      .filter(r => r.operateFiles && r.operateFiles.length > 0)
      .flatMap(r => r.operateFiles!);

    return {
      success,
      outputText,
      errorText: errorText || '',
      exitCode: success ? 0 : 1,
      diffPatch: diffPatch || undefined,
      operateFiles,
    };
  }
}

/**
 * ClayCode SDK 导出
 * 供外部程序集成使用
 */
export class ClayCodeSDK {
  private engine: ClayCodeEngine;

  constructor(options?: { configPath?: string; cwd?: string }) {
    this.engine = new ClayCodeEngine(options);
  }

  /** 初始化 */
  async init(): Promise<void> {
    await this.engine.init();
  }

  /** 发送对话消息 */
  async chat(message: string, sessionId?: string): Promise<TaskResponse> {
    return this.engine.chat(message, sessionId);
  }

  /** Agent模式执行任务 */
  async agent(task: string, sessionId?: string): Promise<TaskResponse> {
    return this.engine.agent(task, sessionId);
  }

  /** 获取引擎实例 */
  getEngine(): ClayCodeEngine {
    return this.engine;
  }

  /** 关闭 */
  async dispose(): Promise<void> {
    await this.engine.dispose();
  }
}