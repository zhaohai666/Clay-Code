/**
 * ClayCode 协议转换与上下文管理器
 * 网页自由文本 ↔ 标准化ToolCall指令互转
 * 双向上下文同步：项目摘要上行 / 执行结果下行
 */

import {
  ToolCall, ToolType, TaskRequest, TaskResponse,
  ChatMessage, ExecuteResult, ErrorCode, GlobalConfig,
  FileChangeRecord,
} from '../types';
import { logger, cleanStreamOutput, extractCodeBlocks, extractInlineJSON, safeParseJSON, StreamBuffer } from '../utils';
import * as fs from 'fs';
import * as path from 'path';

/** AI系统提示词模板 */
const SYSTEM_PROMPT = `你是ClayCode AI编码助手。你需要根据用户需求生成标准化的工具调用指令。

可用工具列表：
1. read - 读取文件内容: { "tool": "read", "filePath": "..." }
2. write - 写入文件: { "tool": "write", "filePath": "...", "content": "..." }
3. edit - 增量Diff编辑: { "tool": "edit", "filePath": "...", "patch": "@@ -行号,数量 +行号,数量 @@\\n-旧代码\\n+新代码" }
4. bash - 执行Shell命令: { "tool": "bash", "command": "..." }
5. git - Git操作: { "tool": "git", "command": "git commit -m '...'" }
6. glob - 目录遍历: { "tool": "glob", "globPattern": "**/*.ts" }

请以JSON格式输出工具调用，可以输出单个或数组。例如：
\`\`\`json
[
  { "tool": "edit", "filePath": "./src/app.ts", "patch": "@@ -10,3 +10,5 @@\\n- const old = 1;\\n+ const new = 2;" },
  { "tool": "bash", "command": "npm run build" }
]
\`\`\`

如果需要向用户解释，直接输出文本即可。`;

export class ProtocolConverter {
  private config: GlobalConfig;

  constructor(config: GlobalConfig) {
    this.config = config;
  }

  /**
   * 组装AI请求的完整提示词
   * 包含系统提示、项目上下文、历史对话、执行结果
   */
  buildPrompt(request: TaskRequest): string {
    const parts: string[] = [];

    // 1. 系统提示
    parts.push(SYSTEM_PROMPT);

    // 2. 项目上下文
    if (request.projectChunkContext) {
      parts.push(`\n--- 项目文件摘要 ---\n${request.projectChunkContext}\n--- 结束 ---\n`);
    }

    // 3. 历史对话
    if (request.sessionHistory && request.sessionHistory.length > 0) {
      parts.push('\n--- 对话历史 ---');
      for (const msg of request.sessionHistory) {
        const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'ai' ? 'AI' : '系统';
        parts.push(`[${roleLabel}]: ${msg.content}`);
      }
      parts.push('--- 结束 ---\n');
    }

    // 4. 上一轮执行结果
    if (request.lastExecuteOutput) {
      const exec = request.lastExecuteOutput;
      parts.push('\n--- 上一轮执行结果 ---');
      parts.push(`执行${exec.success ? '成功' : '失败'}`);
      if (exec.outputText) parts.push(`输出:\n${exec.outputText}`);
      if (exec.errorText) parts.push(`错误:\n${exec.errorText}`);
      if (exec.diffPatch) parts.push(`Diff:\n${exec.diffPatch}`);
      parts.push('--- 结束 ---\n');
    }

    // 5. 当前用户需求
    parts.push(`\n用户需求: ${request.userPrompt}`);

    return parts.join('\n');
  }

  /**
   * 解析AI回复文本，提取标准化工具调用
   */
  parseToolCalls(aiResponse: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    // 1. 清洗输出
    const cleaned = cleanStreamOutput(aiResponse);

    // 2. 提取代码块
    const codeBlocks = extractCodeBlocks(cleaned);

    // 3. 从代码块中解析工具调用
    for (const block of codeBlocks) {
      const parsed = safeParseJSON(block);
      if (parsed) {
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (this.isValidToolCall(item)) {
              toolCalls.push(item as ToolCall);
            }
          }
        } else if (this.isValidToolCall(parsed)) {
          toolCalls.push(parsed as ToolCall);
        }
      }
    }

    // 4. 如果代码块没有解析出工具调用，尝试行内JSON
    if (toolCalls.length === 0) {
      const inlineJSONs = extractInlineJSON(cleaned);
      for (const jsonStr of inlineJSONs) {
        const parsed = safeParseJSON(jsonStr);
        if (parsed && this.isValidToolCall(parsed)) {
          toolCalls.push(parsed as ToolCall);
        }
      }
    }

    logger.info(`[ProtocolConverter] 解析出 ${toolCalls.length} 个工具调用`);
    return toolCalls;
  }

  /**
   * 构建任务响应
   */
  buildResponse(
    code: number,
    msg: string,
    toolCalls: ToolCall[],
    appendMsg?: ChatMessage
  ): TaskResponse {
    return {
      code,
      msg,
      data: {
        toolCalls,
        appendChatMsg: appendMsg ?? { role: 'system', content: '' },
      },
    };
  }

  /**
   * 构建错误响应
   */
  buildErrorResponse(code: number, msg: string): TaskResponse {
    return {
      code,
      msg,
      data: {
        toolCalls: [],
        appendChatMsg: { role: 'system', content: `错误(${code}): ${msg}` },
      },
    };
  }

  /**
   * 将执行结果转换为上下文追加消息
   */
  executionResultToMessage(result: ExecuteResult): ChatMessage {
    const parts: string[] = [];
    parts.push(`[本地执行${result.success ? '成功' : '失败'}]`);
    if (result.outputText) parts.push(`输出:\n${result.outputText}`);
    if (result.errorText) parts.push(`错误:\n${result.errorText}`);
    if (result.diffPatch) parts.push(`Diff:\n${result.diffPatch}`);
    return { role: 'system', content: parts.join('\n') };
  }

  /**
   * 构建项目文件摘要文本
   * 超过maxContextChunk时自动分块
   */
  buildProjectContext(fileList: Array<{ path: string; content: string }>): string[] {
    const chunks: string[] = [];
    let currentChunk = '';
    const separator = '\n---\n';

    for (const file of fileList) {
      const entry = `文件: ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n`;

      if (currentChunk.length + entry.length > this.config.maxContextChunk) {
        if (currentChunk) {
          chunks.push(currentChunk);
          currentChunk = '';
        }
        // 单个文件超过限制，单独成块
        if (entry.length > this.config.maxContextChunk) {
          chunks.push(entry.slice(0, this.config.maxContextChunk) + '\n... (文件过大已截断)');
          continue;
        }
      }

      currentChunk += entry + separator;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /** 验证是否为有效的工具调用对象 */
  isValidToolCall(obj: unknown): boolean {
    if (typeof obj !== 'object' || obj === null) return false;
    const record = obj as Record<string, unknown>;
    if (typeof record['tool'] !== 'string') return false;

    const validTools: ToolType[] = ['read', 'edit', 'write', 'bash', 'git', 'glob'];
    if (!validTools.includes(record['tool'] as ToolType)) return false;

    const tool = record['tool'] as ToolType;
    switch (tool) {
      case 'read':
      case 'edit':
      case 'write':
        return typeof record['filePath'] === 'string';
      case 'bash':
      case 'git':
        return typeof record['command'] === 'string';
      case 'glob':
        return typeof record['globPattern'] === 'string';
      default:
        return false;
    }
  }

  /**
   * 增量上下文同步（5.2 性能核心优化）
   * 仅将变更文件、最新执行报错片段追加至AI上下文，不重复传输完整项目代码
   * @param projectPath 项目根目录
   * @param changes 本轮文件变更记录
   * @param previousContext 上一轮上下文摘要（可选）
   * @returns 增量上下文文本
   */
  buildIncrementalContext(
    projectPath: string,
    changes: FileChangeRecord[],
    previousContext?: string,
  ): string {
    if (changes.length === 0 && !previousContext) {
      return '';
    }

    const parts: string[] = [];

    // 如果有上一轮上下文，添加引用标记
    if (previousContext) {
      parts.push('[上轮上下文已缓存，以下仅包含增量变更]');
    }

    // 按变更类型分组
    const created = changes.filter(c => c.changeType === 'created');
    const modified = changes.filter(c => c.changeType === 'modified');
    const deleted = changes.filter(c => c.changeType === 'deleted');

    if (created.length > 0) {
      parts.push('\n--- 新增文件 ---');
      for (const f of created) {
        parts.push(`文件: ${f.filePath}`);
        if (f.contentSnippet) {
          parts.push('```');
          parts.push(f.contentSnippet);
          parts.push('```');
        }
      }
    }

    if (modified.length > 0) {
      parts.push('\n--- 修改文件 ---');
      for (const f of modified) {
        parts.push(`文件: ${f.filePath}`);
        if (f.contentSnippet) {
          parts.push('```');
          parts.push(f.contentSnippet);
          parts.push('```');
        }
      }
    }

    if (deleted.length > 0) {
      parts.push('\n--- 删除文件 ---');
      for (const f of deleted) {
        parts.push(`文件: ${f.filePath}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * 从文件变更记录和执行结果构建增量上下文
   * 自动读取变更文件的内容摘要
   */
  buildIncrementalContextFromFiles(
    projectPath: string,
    changedFiles: string[],
    lastResult?: ExecuteResult,
  ): string {
    const changes: FileChangeRecord[] = [];

    for (const filePath of changedFiles) {
      const fullPath = path.resolve(projectPath, filePath);
      const exists = fs.existsSync(fullPath);

      if (exists) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            // 截取前50行作为摘要
            const lines = content.split('\n').slice(0, 50);
            const snippet = lines.join('\n');
            changes.push({
              filePath,
              changeType: 'modified',
              contentSnippet: snippet.length > 2000 ? snippet.slice(0, 2000) + '\n... (截断)' : snippet,
              timestamp: Date.now(),
            });
          }
        } catch {
          // 读取失败，仅记录路径
          changes.push({ filePath, changeType: 'modified', timestamp: Date.now() });
        }
      } else {
        changes.push({ filePath, changeType: 'deleted', timestamp: Date.now() });
      }
    }

    let context = this.buildIncrementalContext(projectPath, changes);

    // 追加执行报错片段
    if (lastResult && !lastResult.success && lastResult.errorText) {
      context += `\n\n--- 最近执行错误 ---\n${lastResult.errorText}\n--- 结束 ---`;
    }

    return context;
  }
}

/**
 * 流式工具调用解析器
 * 实现AI流式响应边解析边执行（README 5.3 性能核心优化）
 * 基于StreamBuffer增量缓冲，检测到完整代码块时立即解析工具调用
 */
export class StreamingToolCallParser {
  private buffer: StreamBuffer;
  private protocol: ProtocolConverter;
  private parsedToolCalls: ToolCall[] = [];
  private onToolCallCallback?: (toolCall: ToolCall, index: number) => void;

  constructor(config: GlobalConfig) {
    this.buffer = new StreamBuffer();
    this.protocol = new ProtocolConverter(config);
  }

  /**
   * 设置工具调用回调
   * 当流式解析出完整工具调用时立即触发
   */
  onToolCall(callback: (toolCall: ToolCall, index: number) => void): void {
    this.onToolCallCallback = callback;
  }

  /**
   * 追加流式文本块
   * 检测到完整代码块时自动解析并触发回调
   * @returns 本次追加新解析出的工具调用数量
   */
  append(chunk: string): number {
    this.buffer.append(chunk);

    // 检查是否有完整的代码块
    if (!this.buffer.hasCompleteCodeBlock()) {
      return 0;
    }

    // 尝试提取工具调用文本
    const toolText = this.buffer.tryExtractToolText();
    if (!toolText) {
      return 0;
    }

    // 解析工具调用
    const newCalls = this.parseFromText(toolText);
    const beforeCount = this.parsedToolCalls.length;

    for (const call of newCalls) {
      // 避免重复解析（通过JSON序列化去重）
      const isDuplicate = this.parsedToolCalls.some(
        existing => JSON.stringify(existing) === JSON.stringify(call)
      );
      if (!isDuplicate) {
        this.parsedToolCalls.push(call);
        const index = this.parsedToolCalls.length - 1;
        this.onToolCallCallback?.(call, index);
      }
    }

    return this.parsedToolCalls.length - beforeCount;
  }

  /**
   * 获取目前已解析的所有工具调用
   */
  getParsedToolCalls(): ToolCall[] {
    return [...this.parsedToolCalls];
  }

  /**
   * 获取当前缓冲区中的纯文本内容（非工具调用部分）
   * 用于提取AI的文本回复
   */
  getTextContent(): string {
    const content = this.buffer.getContent();
    // 移除代码块部分，保留纯文本
    return content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 完成流式解析，返回最终结果
   * 对缓冲区剩余内容做最终解析
   */
  finalize(): ToolCall[] {
    // 对完整缓冲区做最终解析（处理可能遗漏的行内JSON）
    const fullContent = this.buffer.getContent();
    const finalCalls = this.protocol.parseToolCalls(fullContent);

    // 合并去重
    for (const call of finalCalls) {
      const isDuplicate = this.parsedToolCalls.some(
        existing => JSON.stringify(existing) === JSON.stringify(call)
      );
      if (!isDuplicate) {
        this.parsedToolCalls.push(call);
        const index = this.parsedToolCalls.length - 1;
        this.onToolCallCallback?.(call, index);
      }
    }

    return this.getParsedToolCalls();
  }

  /**
   * 重置解析器状态
   */
  reset(): void {
    this.buffer.clear();
    this.parsedToolCalls = [];
  }

  /**
   * 从文本解析工具调用
   */
  private parseFromText(text: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    // 尝试解析为JSON数组或对象
    const parsed = safeParseJSON(text);
    if (parsed) {
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (this.protocol.isValidToolCall(item)) {
            toolCalls.push(item as ToolCall);
          }
        }
      } else if (this.protocol.isValidToolCall(parsed)) {
        toolCalls.push(parsed as ToolCall);
      }
    }

    // 如果JSON解析失败，尝试行内JSON
    if (toolCalls.length === 0) {
      const inlineJSONs = extractInlineJSON(text);
      for (const jsonStr of inlineJSONs) {
        const inlineParsed = safeParseJSON(jsonStr);
        if (inlineParsed && this.protocol.isValidToolCall(inlineParsed)) {
          toolCalls.push(inlineParsed as ToolCall);
        }
      }
    }

    return toolCalls;
  }
}