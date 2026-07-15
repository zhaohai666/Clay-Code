/**
 * ClayCode 一体化AI编码工具 - 统一类型定义
 * 基于原生自研架构，模块间内存级数据流转
 * 分包模块化、安全隔离、插件可扩展、运维可观测
 */

// ============================================================
// 全局配置类型
// ============================================================

/** 支持的网页AI适配器类型 */
export type AdapterType = 'doubao' | 'chatgpt-web' | 'claude-web' | 'ollama' | 'kimi' | 'qwen' | 'deepseek';

/** 缓存级别 */
export type CacheLevel = 'l1' | 'l2' | 'l1+l2' | 'none';

/** 全局配置 */
export interface GlobalConfig {
  /** 默认AI适配器 */
  defaultAdapter: AdapterType;
  /** 数据根目录 */
  dataDir: string;
  /** 浏览器数据存储路径 */
  browserDataPath: string;
  /** Chrome可执行路径（空则自动探测） */
  chromePath: string;
  /** 会话存储目录 */
  sessionDir: string;
  /** 最大上下文分块字符数 */
  maxContextChunk: number;
  /** 最大历史消息条数 */
  maxHistoryMessages: number;
  /** 单轮AI请求超时(ms) */
  requestTimeout: number;
  /** AI回复等待超时(ms) */
  responseTimeout: number;
  /** 是否自动同步执行日志到AI上下文 */
  autoSyncExecuteLog: boolean;
  /** 浏览器是否无头模式 */
  browserHeadless: boolean;
  /** Shell命令执行白名单 */
  execWhiteList: string[];
  /** 是否启用沙箱隔离 */
  enableSandbox: boolean;
  /** 缓存级别：l1(内存)/l2(磁盘)/l1+l2/none */
  cacheLevel: CacheLevel;
  /** 批量文件操作数量上限（防恶意遍历） */
  maxBatchFiles: number;
  /** 浏览器闲置自动释放时间(ms)，默认10分钟 */
  browserIdleTimeout: number;
  /** AI请求指数退避最大重试次数 */
  maxRetryCount: number;
  /** Ollama本地模型服务地址 */
  ollamaEndpoint: string;
  /** 是否启用Docker沙箱 */
  enableDockerSandbox: boolean;
  /** Prometheus HTTP端点端口，0表示不启动，默认0 */
  metricsPort: number;
  /** API密钥（用于需要显式认证的适配器，AES加密存储） */
  apiKey: string;
  /** 代理URL（可包含认证信息，AES加密存储） */
  proxyUrl: string;
  /** V1.1: 是否启用文件变更Diff交互式预审确认 */
  requireChangeReview: boolean;
}

/** 默认全局配置 */
export const DEFAULT_CONFIG: GlobalConfig = {
  defaultAdapter: 'doubao',
  dataDir: '~/.claycode',
  browserDataPath: '~/.claycode/browser-cache',
  chromePath: '',
  sessionDir: '~/.claycode/sessions',
  maxContextChunk: 12000,
  maxHistoryMessages: 50,
  requestTimeout: 90000,
  responseTimeout: 120000,
  autoSyncExecuteLog: true,
  browserHeadless: false,
  execWhiteList: ['git', 'npm', 'pnpm', 'yarn', 'node', 'npx', 'tsc', 'eslint', 'prettier', 'mvn', 'gradle'],
  enableSandbox: false,
  cacheLevel: 'l1+l2',
  maxBatchFiles: 50,
  browserIdleTimeout: 10 * 60 * 1000,
  maxRetryCount: 3,
  ollamaEndpoint: 'http://localhost:11434',
  enableDockerSandbox: false,
  metricsPort: 0,
  apiKey: '',
  proxyUrl: '',
  requireChangeReview: false,
};

// ============================================================
// 聊天消息与会话类型
// ============================================================

/** 聊天消息角色 */
export type MessageRole = 'user' | 'ai' | 'system';

/** 聊天消息 */
export interface ChatMessage {
  role: MessageRole;
  content: string;
}

/** V1.2: 任务检查点 - 每轮工具执行后持久化执行现场，支持断点续跑 */
export interface Checkpoint {
  /** 检查点唯一ID */
  id: string;
  /** 所属会话ID */
  sessionId: string;
  /** 检查点创建时间戳 */
  timestamp: number;
  /** 执行轮次索引（从0开始） */
  roundIndex: number;
  /** 本轮工具调用列表 */
  toolCalls: ToolCall[];
  /** 本轮执行结果列表（与toolCalls一一对应） */
  executeResults: ExecuteResult[];
  /** 检查点时的消息快照（消息摘要，非全量） */
  messageCount: number;
  /** 检查点时的文件变更记录快照 */
  fileChangeCount: number;
  /** 用户自定义标签（可选） */
  label?: string;
}

/** V1.2: 工作区 - 会话多工作区分隔支持 */
export interface Workspace {
  /** 工作区唯一ID */
  id: string;
  /** 工作区名称 */
  name: string;
  /** 工作区项目根目录 */
  projectPath: string;
  /** 工作区文件变更记录（独立于会话级别） */
  fileChanges?: FileChangeRecord[];
  /** 工作区创建时间 */
  createdAt: number;
  /** 工作区最后活跃时间 */
  lastActiveAt: number;
  /** 是否为当前活跃工作区 */
  active: boolean;
}

/** 会话状态 */
export interface SessionState {
  /** 会话唯一ID */
  sessionId: string;
  /** 会话名称 */
  sessionName: string;
  /** 对话历史 */
  messages: ChatMessage[];
  /** 当前使用的适配器 */
  adapter: AdapterType;
  /** 关联的项目路径 */
  projectPath?: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 会话文件变更记录 */
  fileChanges?: FileChangeRecord[];
  /** V1.2: 任务检查点列表（断点续跑） */
  checkpoints?: Checkpoint[];
  /** V1.2: 多工作区列表 */
  workspaces?: Workspace[];
  /** V1.2: 当前活跃工作区ID */
  activeWorkspaceId?: string;
}

// ============================================================
// AI任务请求/响应协议 (内部流转)
// ============================================================

/** 本地执行结果 */
export interface ExecuteResult {
  /** 是否成功 */
  success: boolean;
  /** 标准输出文本 */
  outputText: string;
  /** 错误输出文本 */
  errorText: string;
  /** 退出码 */
  exitCode: number;
  /** 文件Diff补丁（编辑操作时） */
  diffPatch?: string;
  /** 操作涉及的文件列表 */
  operateFiles: string[];
  /** 文件变更记录（Git操作时自动同步至AI上下文） */
  fileChanges?: FileChangeRecord[];
}

/** AI任务请求结构体 */
/** V1.1: 任务规划结构 (README 3.3节) */
export interface TaskPlan {
  /** 任务摘要 */
  summary: string;
  /** 子任务列表 */
  subTasks: TaskPlanSubTask[];
  /** 规划创建时间 */
  createdAt: string;
  /** 规划状态: pending(待确认)/active(执行中)/completed(已完成)/cancelled(已取消) */
  status: 'pending' | 'active' | 'completed' | 'cancelled';
}

/** V1.1: 任务规划子任务 */
export interface TaskPlanSubTask {
  /** 子任务ID */
  id: string;
  /** 子任务标题 */
  title: string;
  /** 子任务描述 */
  description?: string;
  /** 是否已完成 */
  finished: boolean;
  /** 依赖的子任务ID列表 */
  depends?: string[];
  /** 预计工具调用 */
  estimatedTools?: ToolType[];
}

export interface TaskRequest {
  /** 用户原始需求 */
  userPrompt: string;
  /** 当前执行目录 */
  projectPath?: string;
  /** 项目文件摘要分块文本 */
  projectChunkContext: string;
  /** 历史对话记录 */
  sessionHistory: ChatMessage[];
  /** 上一轮本地执行日志 */
  lastExecuteOutput?: ExecuteResult;
  /** V1.1: 当前任务规划 */
  taskPlan?: TaskPlan;
  /** 全局配置（可选） */
  config?: GlobalConfig;
}

/** 标准化工具调用类型 */
export type ToolType = 'read' | 'edit' | 'write' | 'bash' | 'git' | 'glob' | 'view' | 'run_test' | 'symbol_search';

/** 标准化工具调用指令 */
export interface ToolCall {
  /** 工具类型 */
  tool: ToolType;
  /** 文件路径 (read/edit/write/view) */
  filePath?: string;
  /** 文件内容 (write) */
  content?: string;
  /** Diff补丁 (edit) */
  patch?: string;
  /** Shell命令 (bash/git) */
  command?: string;
  /** Glob匹配模式 (glob) */
  globPattern?: string;
  /** V1.2: 行范围 (view) "start-end" 格式，如 "10-50" */
  lineRange?: string;
  /** V1.2: 是否显示行号 (view)，默认true */
  showLineNumbers?: boolean;
  /** V1.2: 测试过滤模式 (run_test)，如 "test-file" 或 "test-name" */
  testFilter?: string;
  /** V1.2: 是否监听模式 (run_test)，默认false */
  testWatch?: boolean;
  /** V1.2: 符号搜索名称 (symbol_search)，精确或模糊匹配 */
  symbolName?: string;
  /** V1.2: 符号类型过滤 (symbol_search)，如 "class"、"function"、"interface" */
  symbolKind?: string;
  /** V1.2: 搜索结果上限 (symbol_search)，默认20 */
  symbolLimit?: number;
}

/** AI任务响应结构体 */
export interface TaskResponse {
  /** 状态码：0=成功 */
  code: number;
  /** 状态消息 */
  msg: string;
  data: {
    /** 标准化工具调用数组 */
    toolCalls: ToolCall[];
    /** 追加到对话上下文的消息 */
    appendChatMsg: ChatMessage;
    /** V1.1: 任务规划（复杂需求自动生成） */
    taskPlan?: TaskPlan;
  };
}

// ============================================================
// 全局错误码
// ============================================================

/** 错误码枚举 */
export enum ErrorCode {
  /** 正常成功 */
  SUCCESS = 0,
  /** 浏览器锁文件冲突 */
  BROWSER_LOCK_CONFLICT = 1001,
  /** 网页AI需要人机验证/未登录 */
  HUMAN_VERIFICATION = 1002,
  /** AI请求超时 */
  RESPONSE_TIMEOUT = 1003,
  /** 上下文超长截断 */
  CONTEXT_TOO_LONG = 1004,
  /** 文件越权/权限不足 */
  FILE_PERMISSION_DENIED = 2001,
  /** Shell命令不在白名单 */
  COMMAND_NOT_IN_WHITELIST = 2002,
  /** 命令执行异常 */
  SHELL_EXECUTION_ERROR = 2003,
  /** 多条补丁存在文件修改冲突 */
  PATCH_CONFLICT = 2004,
  /** 适配器不存在 */
  ADAPTER_NOT_FOUND = 3001,
  /** 会话数据解密失败 */
  SESSION_DECRYPT_FAILED = 4001,
  /** 检查点数据损坏 */
  CHECKPOINT_CORRUPT = 4002,
}

/** 错误码描述映射 */
export const ERROR_MESSAGES: Record<number, string> = {
  [ErrorCode.SUCCESS]: '成功',
  [ErrorCode.BROWSER_LOCK_CONFLICT]: '浏览器锁文件冲突，正在自动清理并重启',
  [ErrorCode.HUMAN_VERIFICATION]: '需要人机验证或未登录，请执行 clay login',
  [ErrorCode.RESPONSE_TIMEOUT]: 'AI回复超时，正在重试',
  [ErrorCode.CONTEXT_TOO_LONG]: '上下文超长，正在自动分块',
  [ErrorCode.FILE_PERMISSION_DENIED]: '文件越权或权限不足',
  [ErrorCode.COMMAND_NOT_IN_WHITELIST]: 'Shell命令不在白名单，请执行 clay config set execWhiteList 添加',
  [ErrorCode.SHELL_EXECUTION_ERROR]: 'Shell命令执行异常',
  [ErrorCode.PATCH_CONFLICT]: '多条补丁存在文件修改冲突，请调整变更方案',
  [ErrorCode.ADAPTER_NOT_FOUND]: '适配器不存在，请切换合法AI适配器',
  [ErrorCode.SESSION_DECRYPT_FAILED]: '会话数据解密失败，请重新登录',
  [ErrorCode.CHECKPOINT_CORRUPT]: '检查点数据损坏，将加载上一个有效快照',
};

// ============================================================
// AI适配器接口
// ============================================================

/** 网页AI适配器接口 */
export interface WebAIAdapter {
  /** 适配器名称 */
  name: AdapterType;
  /** 适配器显示名称 */
  displayName: string;
  /** 网页AI URL */
  url: string;
  /** 输入框CSS选择器 */
  inputSelector: string;
  /** 发送按钮CSS选择器 */
  sendButtonSelector: string;
  /** 回复内容容器CSS选择器 */
  responseSelector: string;
  /** 发送消息并获取回复 */
  ask(prompt: string, sessionId: string): Promise<string>;
  /** 发送消息并流式获取回复（边接收边解析） */
  askStream?(prompt: string, sessionId: string): AsyncIterableIterator<string>;
  /** 检查是否已登录 */
  isLoggedIn(): Promise<boolean>;
  /** 获取登录URL */
  getLoginUrl(): string;
}

// ============================================================
// 浏览器管理类型
// ============================================================

/** 浏览器实例状态 */
export type BrowserStatus = 'idle' | 'launching' | 'running' | 'crashed' | 'restarting';

/** 浏览器实例信息 */
export interface BrowserInfo {
  status: BrowserStatus;
  restartCount: number;
  lastStartedAt?: number;
  lastError?: string;
}

// ============================================================
// 插件系统类型
// ============================================================

/** 插件类型 */
export type PluginType = 'adapter' | 'tool' | 'hook';

/** 插件生命周期钩子 */
export interface PluginLifecycle {
  /** 插件安装初始化 */
  setup?(): Promise<void>;
  /** AI请求前钩子 */
  beforeAiRequest?(request: TaskRequest): Promise<TaskRequest>;
  /** 工具执行后钩子 */
  afterToolExecute?(toolCall: ToolCall, result: ExecuteResult): Promise<ExecuteResult>;
  /** 插件销毁清理 */
  destroy?(): Promise<void>;
}

/** 插件描述 */
export interface PluginDescriptor {
  /** 插件名称 */
  name: string;
  /** 插件版本 */
  version: string;
  /** 插件类型 */
  type: PluginType;
  /** 插件描述 */
  description: string;
  /** 插件入口 */
  main: string;
}

/** 已加载插件实例 */
export interface PluginInstance {
  descriptor: PluginDescriptor;
  hooks: {
    setup?: (...args: unknown[]) => Promise<unknown>;
    beforeAiRequest?: (...args: unknown[]) => Promise<unknown>;
    afterToolExecute?: (...args: unknown[]) => Promise<unknown>;
    destroy?: (...args: unknown[]) => Promise<unknown>;
  };
  state: 'loaded' | 'active' | 'error' | 'destroyed';
  loadedAt: number;
}

// ============================================================
// 插件市场类型（V1.1）
// ============================================================

/** 插件市场条目 */
export interface PluginMarketEntry {
  /** 插件名称 */
  name: string;
  /** 插件版本 */
  version: string;
  /** 插件类型 */
  type: PluginType;
  /** 插件描述 */
  description: string;
  /** 作者 */
  author: string;
  /** 下载URL或本地路径 */
  sourceUrl: string;
  /** 标签 */
  tags: string[];
  /** 下载次数 */
  downloads: number;
  /** 发布时间 */
  publishedAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/** 插件市场搜索结果 */
export interface PluginMarketSearchResult {
  /** 搜索结果条目 */
  entries: PluginMarketEntry[];
  /** 搜索关键词 */
  keyword: string;
  /** 结果总数 */
  total: number;
}

// ============================================================
// 缓存类型
// ============================================================

/** 缓存条目 */
export interface CacheEntry<T = unknown> {
  /** 缓存数据 */
  data: T;
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 访问次数 */
  hitCount: number;
}

// ============================================================
// 监控指标类型
// ============================================================

/** 性能监控指标 */
export interface MetricsData {
  /** AI请求平均延迟(ms) */
  aiLatencyAvg: number;
  /** AI请求P95延迟(ms) */
  aiLatencyP95: number;
  /** 内存实时占用(MB) */
  memoryUsageMB: number;
  /** 文件读取次数 */
  fileOpsRead: number;
  /** 文件写入次数 */
  fileOpsWrite: number;
  /** 文件编辑次数 */
  fileOpsEdit: number;
  /** Bash命令执行次数 */
  fileOpsBash: number;
  /** Git操作次数 */
  fileOpsGit: number;
  /** 命令执行成功率 */
  commandSuccessRate: number;
  /** Chrome浏览器重启次数 */
  browserRestarts: number;
}

// ============================================================
// 增量上下文同步类型
// ============================================================

/** 文件变更记录 */
export interface FileChangeRecord {
  /** 文件路径 */
  filePath: string;
  /** 变更类型 */
  changeType: 'created' | 'modified' | 'deleted';
  /** 文件内容摘要（前N行） */
  contentSnippet?: string;
  /** 变更时间戳 */
  timestamp: number;
}

// ============================================================
// ToolCall JSON Schema 校验类型
// ============================================================

/** ToolCall校验结果 */
export interface ToolCallValidationResult {
  /** 是否合法 */
  valid: boolean;
  /** 错误信息 */
  errors: string[];
  /** 修复建议 */
  fixSuggestion?: string;
}

// ============================================================
// 人性化错误提示类型
// ============================================================

/** 错误提示与修复指引 */
export interface ErrorGuide {
  /** 错误码 */
  code: number;
  /** 中文描述 */
  message: string;
  /** 修复建议 */
  fixSuggestion: string;
  /** 一键修复命令 */
  fixCommand?: string;
}

// ============================================================
// V1.2 Web管理面板类型
// ============================================================

/** Web面板配置 */
export interface WebPanelOptions {
  /** HTTP端口，默认18080 */
  port?: number;
  /** 绑定主机，默认localhost */
  host?: string;
  /** 是否自动打开浏览器 */
  openBrowser?: boolean;
}

/** Web面板API响应基类 */
export interface WebPanelApiResponse<T = unknown> {
  /** 是否成功 */
  success: boolean;
  /** 消息 */
  message?: string;
  /** 数据 */
  data?: T;
}

/** 会话摘要（Web面板用） */
export interface SessionSummary {
  /** 会话ID */
  sessionId: string;
  /** 会话名称 */
  sessionName: string;
  /** 适配器类型 */
  adapter: AdapterType;
  /** 消息数量 */
  messageCount: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 最后消息预览 */
  lastMessagePreview: string;
}

// ============================================================
// V1.2 批量导出Markdown报告类型
// ============================================================

/** 报告导出选项 */
export interface ReportExportOptions {
  /** 输出目录，默认当前目录 */
  outputDir?: string;
  /** 报告标题 */
  title?: string;
  /** 是否包含完整对话记录，默认true */
  includeChatHistory?: boolean;
  /** 是否包含文件变更记录，默认true */
  includeFileChanges?: boolean;
  /** 是否包含执行统计，默认true */
  includeMetrics?: boolean;
  /** 会话ID（指定导出单个会话） */
  sessionId?: string;
  /** 时间范围起始（毫秒时间戳） */
  fromTime?: number;
  /** 时间范围结束（毫秒时间戳） */
  toTime?: number;
}

/** 报告导出结果 */
export interface ReportExportResult {
  /** 是否成功 */
  success: boolean;
  /** 输出文件路径 */
  filePath?: string;
  /** 消息 */
  message: string;
  /** 包含的会话数 */
  sessionCount: number;
  /** 包含的文件变更数 */
  fileChangeCount: number;
  /** 报告生成时间 */
  generatedAt: number;
}