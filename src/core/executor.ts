/**
 * @claycode/local-executor 原生本地执行引擎
 * 执行9种工具调用：read/edit/write/bash/git/glob/view/run_test/symbol_search
 * 增量Diff补丁编辑 + 命令白名单安全校验 + 路径越权拦截 + 可选沙箱隔离
 * 
 * 沙箱隔离（README 6.3节）：
 * 1. Node.js vm隔离：简单场景下隔离代码片段执行
 * 2. Docker容器隔离：高危Shell命令在临时容器中执行，隔离主机文件系统
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, exec } from 'child_process';
import * as glob from 'glob';
import * as vm from 'vm';
import * as stream from 'stream';
import * as util from 'util';
import {
  ToolCall, ToolType, ExecuteResult, ErrorCode, ERROR_MESSAGES, FileChangeRecord,
} from '../types';
import { logger, normalizePath, getNewLine } from '../utils';
import { CodeIndexer, SymbolKind } from './code-index';

/** 大文件阈值：超过此大小(1MB)使用Stream分片读写 */
const LARGE_FILE_THRESHOLD = 1024 * 1024;
/** 流式读取分片大小：64KB */
const STREAM_CHUNK_SIZE = 64 * 1024;

const pipeline = util.promisify(stream.pipeline);

/** 编辑操作的单个变更块 */
interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  oldLines: string[];
  newLines: string[];
}

export class LocalExecutor {
  private cwd: string;
  private maxOutputLength: number;
  private execWhiteList: string[];
  private enableSandbox: boolean;
  private enableDockerSandbox: boolean;
  /** V1.1: 是否启用文件变更Diff交互式预审确认 */
  private requireChangeReview: boolean;
  /** V1.1: Diff预审确认回调函数（返回true确认变更，false拒绝变更） */
  private changeReviewCallback?: (diff: string, filePath: string, operation: string) => Promise<boolean>;
  /** V1.2: 代码符号索引器实例（懒初始化） */
  private codeIndexer: CodeIndexer | null = null;

  constructor(cwd: string, options?: { maxOutputLength?: number; execWhiteList?: string[]; enableSandbox?: boolean; enableDockerSandbox?: boolean; requireChangeReview?: boolean }) {
    this.cwd = cwd;
    this.maxOutputLength = options?.maxOutputLength ?? 10000;
    this.execWhiteList = options?.execWhiteList ?? ['git', 'npm', 'pnpm', 'yarn', 'node', 'npx', 'tsc', 'eslint', 'prettier', 'mvn', 'gradle'];
    this.enableSandbox = options?.enableSandbox ?? false;
    this.enableDockerSandbox = options?.enableDockerSandbox ?? false;
    this.requireChangeReview = options?.requireChangeReview ?? false;
  }

  /**
   * V1.1: 设置Diff预审确认回调
   * @param callback 回调函数，接收diff内容、文件路径、操作类型，返回true确认/false拒绝
   */
  setChangeReviewCallback(callback: (diff: string, filePath: string, operation: string) => Promise<boolean>): void {
    this.changeReviewCallback = callback;
    this.requireChangeReview = true;
    logger.info('[LocalExecutor] 已设置Diff预审确认回调');
  }

  /**
   * V1.1: 生成文件变更Diff预览
   */
  private generateDiffPreview(filePath: string, originalContent: string, newContent: string, operation: string): string {
    const NL = getNewLine();
    const origLines = originalContent.split(/\r?\n/);
    const newLines = newContent.split(/\r?\n/);
    const maxLen = Math.max(origLines.length, newLines.length);

    const diffLines: string[] = [];
    diffLines.push(`--- a/${filePath} (${operation})`);
    diffLines.push(`+++ b/${filePath}`);

    // 简化Diff：逐行对比
    for (let i = 0; i < maxLen; i++) {
      const origLine = origLines[i];
      const newLine = newLines[i];

      if (origLine === undefined && newLine !== undefined) {
        diffLines.push(`+${newLine}`);
      } else if (origLine !== undefined && newLine === undefined) {
        diffLines.push(`-${origLine}`);
      } else if (origLine !== newLine) {
        diffLines.push(`-${origLine}`);
        diffLines.push(`+${newLine}`);
      } else {
        diffLines.push(` ${origLine}`);
      }
    }

    return diffLines.join(NL);
  }

  /**
   * V1.1: 交互式变更预审确认
   * @returns true=确认变更, false=拒绝变更
   */
  private async confirmChange(filePath: string, originalContent: string, newContent: string, operation: string): Promise<boolean> {
    if (!this.requireChangeReview) {
      return true; // 未启用预审，直接通过
    }

    const diff = this.generateDiffPreview(filePath, originalContent, newContent, operation);

    if (this.changeReviewCallback) {
      // 使用回调确认
      const approved = await this.changeReviewCallback(diff, filePath, operation);
      if (!approved) {
        logger.info(`[LocalExecutor] 变更被拒绝: ${filePath} (${operation})`);
      }
      return approved;
    }

    // 无回调时，默认通过（日志记录）
    logger.info(`[LocalExecutor] 文件变更预审(diff预览):\n${diff.substring(0, 500)}...`);
    return true;
  }

  /**
   * 执行单个工具调用
   */
  async execute(toolCall: ToolCall): Promise<ExecuteResult> {
    logger.info(`[LocalExecutor] 执行工具: ${toolCall.tool}`);

    try {
      switch (toolCall.tool) {
        case 'read':
          return await this.executeRead(toolCall.filePath!);
        case 'write':
          return await this.executeWrite(toolCall.filePath!, toolCall.content!);
        case 'edit':
          return await this.executeEdit(toolCall.filePath!, toolCall.patch!);
        case 'bash':
          return this.executeBash(toolCall.command!);
        case 'git':
          return this.executeGit(toolCall.command!);
        case 'glob':
          return this.executeGlob(toolCall.globPattern!);
        case 'view':
          return await this.executeView(toolCall.filePath!, toolCall.lineRange, toolCall.showLineNumbers);
        case 'run_test':
          return this.executeRunTest(toolCall.testFilter, toolCall.testWatch);
        case 'symbol_search':
          return this.executeSymbolSearch(toolCall.symbolName!, toolCall.symbolKind, toolCall.symbolLimit);
        default:
          return {
            success: false,
            outputText: '',
            errorText: `不支持的工具类型: ${toolCall.tool}`,
            exitCode: 1,
            operateFiles: [],
          };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[LocalExecutor] 执行失败: ${message}`);
      return {
        success: false,
        outputText: '',
        errorText: message,
        exitCode: 1,
        operateFiles: [],
      };
    }
  }

  // ---- V1.1 批量Patch冲突预检测 (README 6.1) ----

  /**
   * 冲突检测结果
   */

  /**
   * 批量Patch冲突预检测 (V1.1 README 6.1)
   * 多条补丁修改同一文件时，内存预合并检测代码行区间冲突
   * @param toolCalls 待执行的工具调用列表
   * @returns 冲突列表（空列表表示无冲突）
   */
  detectPatchConflicts(toolCalls: ToolCall[]): Array<{
    filePath: string;
    conflictType: 'line_overlap' | 'same_line_edit' | 'delete_after_delete';
    description: string;
    hunkIndices: number[];
    lineRange: { start: number; end: number };
  }> {
    // 筛选所有edit操作，按文件分组
    const editOps = toolCalls
      .map((tc, idx) => ({ tc, idx }))
      .filter(item => item.tc.tool === 'edit' && item.tc.filePath && item.tc.patch);

    const fileEdits = new Map<string, Array<{ idx: number; patch: string; toolIdx: number }>>();
    for (const item of editOps) {
      const fp = normalizePath(path.resolve(this.cwd, item.tc.filePath!));
      if (!fileEdits.has(fp)) {
        fileEdits.set(fp, []);
      }
      fileEdits.get(fp)!.push({ idx: item.idx, patch: item.tc.patch!, toolIdx: item.idx });
    }

    const conflicts: Array<{
      filePath: string;
      conflictType: 'line_overlap' | 'same_line_edit' | 'delete_after_delete';
      description: string;
      hunkIndices: number[];
      lineRange: { start: number; end: number };
    }> = [];

    // 对每个有多条edit的文件进行冲突检测
    for (const [filePath, edits] of fileEdits) {
      if (edits.length < 2) continue; // 单条edit无需检测

      // 解析所有edit的hunk行范围
      const allHunks: Array<{
        editIdx: number;
        toolIdx: number;
        hunks: Array<{ oldStart: number; oldEnd: number; newStart: number; newEnd: number }>;
      }> = [];

      for (const edit of edits) {
        const parsed = this.parseDiffPatch(edit.patch);
        const hunkRanges = parsed.map(h => ({
          oldStart: h.oldStart,
          oldEnd: h.oldStart + h.oldLines.length - 1,
          newStart: h.newStart,
          newEnd: h.newStart + h.newLines.length - 1,
        }));
        allHunks.push({ editIdx: edit.idx, toolIdx: edit.toolIdx, hunks: hunkRanges });
      }

      // 两两比较hunk行范围，检测重叠
      for (let i = 0; i < allHunks.length; i++) {
        for (let j = i + 1; j < allHunks.length; j++) {
          const a = allHunks[i];
          const b = allHunks[j];

          for (const hunkA of a.hunks) {
            for (const hunkB of b.hunks) {
              // 检测行范围重叠
              const overlapStart = Math.max(hunkA.oldStart, hunkB.oldStart);
              const overlapEnd = Math.min(hunkA.oldEnd, hunkB.oldEnd);

              if (overlapStart <= overlapEnd) {
                // 行范围重叠
                let conflictType: 'line_overlap' | 'same_line_edit' | 'delete_after_delete' = 'line_overlap';
                if (hunkA.oldStart === hunkB.oldStart && hunkA.oldEnd === hunkB.oldEnd) {
                  conflictType = 'same_line_edit';
                }

                const relPath = path.relative(this.cwd, filePath);
                conflicts.push({
                  filePath: relPath || filePath,
                  conflictType,
                  description: `文件 ${relPath || filePath} 的第${overlapStart}-${overlapEnd}行存在${conflictType === 'same_line_edit' ? '同位置编辑' : '行区间重叠'}冲突`,
                  hunkIndices: [a.toolIdx, b.toolIdx],
                  lineRange: { start: overlapStart, end: overlapEnd },
                });

                logger.warn(`[LocalExecutor] Patch冲突检测: ${relPath || filePath} 行${overlapStart}-${overlapEnd} ` +
                  `(${conflictType}, 工具#${a.toolIdx} vs #${b.toolIdx})`);
              }
            }
          }
        }
      }
    }

    if (conflicts.length > 0) {
      logger.warn(`[LocalExecutor] 检测到 ${conflicts.length} 个Patch冲突`);
    } else {
      logger.info('[LocalExecutor] Patch冲突预检测通过，无冲突');
    }

    return conflicts;
  }

  /**
   * 批量执行工具调用
   * 默认顺序执行以保持操作依赖关系
   * README 5.3节：流式并行处理 - 独立读操作可并行执行(Promise.allSettled)
   */
  async executeBatch(toolCalls: ToolCall[], options?: { parallel?: boolean }): Promise<ExecuteResult[]> {
    // V1.1: 批量Patch冲突预检测
    const conflicts = this.detectPatchConflicts(toolCalls);
    if (conflicts.length > 0) {
      logger.warn(`[LocalExecutor] 检测到${conflicts.length}个Patch冲突，建议调整工具调用顺序`);
      // 冲突不阻断执行，仅警告（由上层决定是否中止）
    }

    // 如果启用并行模式且所有操作都是读操作，则并行执行
    if (options?.parallel && toolCalls.length > 1 && toolCalls.every(tc => tc.tool === 'read' || tc.tool === 'glob')) {
      return this.executeBatchParallel(toolCalls);
    }

    // 默认顺序执行（保持操作依赖关系：write后read需要顺序）
    const results: ExecuteResult[] = [];
    for (const tc of toolCalls) {
      const result = await this.execute(tc);
      results.push(result);
      if (!result.success) {
        logger.warn(`[LocalExecutor] 工具 ${tc.tool} 执行失败，继续下一项`);
      }
    }
    return results;
  }

  /**
   * 并行执行批量工具调用（仅用于独立读操作）
   * README 5.3节：文件读取并行执行 Promise.allSettled
   */
  private async executeBatchParallel(toolCalls: ToolCall[]): Promise<ExecuteResult[]> {
    logger.info(`[LocalExecutor] 并行执行 ${toolCalls.length} 个独立读操作`);
    const promises = toolCalls.map(tc => this.execute(tc));
    const settled = await Promise.allSettled(promises);

    return settled.map((result, i) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      logger.warn(`[LocalExecutor] 并行执行工具 ${toolCalls[i].tool} 失败: ${result.reason?.message || '未知错误'}`);
      return {
        success: false,
        outputText: '',
        errorText: result.reason?.message || '并行执行失败',
        exitCode: 1,
        operateFiles: [],
      };
    });
  }

  // ---- 路径安全校验 ----

  /** 校验路径不超出项目根目录 */
  private validatePath(filePath: string): { valid: boolean; absPath: string } {
    const absPath = this.resolvePath(filePath);
    const normalizedCwd = normalizePath(path.resolve(this.cwd));
    if (!absPath.toLowerCase().startsWith(normalizedCwd.toLowerCase())) {
      return { valid: false, absPath };
    }
    return { valid: true, absPath };
  }

  /** 校验Shell命令是否在白名单内 */
  private validateCommand(command: string): { valid: boolean; baseCmd: string } {
    const baseCmd = command.trim().split(/\s+/)[0];
    // 去掉路径前缀，只取命令名
    const cmdName = path.basename(baseCmd);
    return {
      valid: this.execWhiteList.includes(cmdName),
      baseCmd: cmdName,
    };
  }

  // ---- read ----
  private async executeRead(filePath: string): Promise<ExecuteResult> {
    const { valid, absPath } = this.validatePath(filePath);
    if (!valid) {
      return {
        success: false,
        outputText: '',
        errorText: `路径越权拦截: ${absPath} 不在项目目录 ${this.cwd} 内`,
        exitCode: 1,
        operateFiles: [],
      };
    }

    if (!fs.existsSync(absPath)) {
      return {
        success: false,
        outputText: '',
        errorText: `文件不存在: ${absPath}`,
        exitCode: 1,
        operateFiles: [],
      };
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(absPath);
      return {
        success: true,
        outputText: entries.join('\n'),
        errorText: '',
        exitCode: 0,
        operateFiles: [absPath],
      };
    }

    // README 5.3节：大文件采用Node Stream分片读写
    if (stat.size > LARGE_FILE_THRESHOLD) {
      return this.executeReadStream(absPath, stat.size);
    }

    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');

    return {
      success: true,
      outputText: numbered,
      errorText: '',
      exitCode: 0,
      operateFiles: [absPath],
    };
  }

  /**
   * V1.2: 终端内置文件阅读器 view_file
   * 支持行号显示、行范围选择、文件元信息、行号跳转
   * 输出格式：[文件元信息头] + [行号: 内容]
   */
  private async executeView(
    filePath: string,
    lineRange?: string,
    showLineNumbers: boolean = true
  ): Promise<ExecuteResult> {
    const { valid, absPath } = this.validatePath(filePath);
    if (!valid) {
      return {
        success: false,
        outputText: '',
        errorText: `路径越权拦截: ${absPath} 不在项目目录 ${this.cwd} 内`,
        exitCode: 1,
        operateFiles: [],
      };
    }

    if (!fs.existsSync(absPath)) {
      return {
        success: false,
        outputText: '',
        errorText: `文件不存在: ${absPath}`,
        exitCode: 1,
        operateFiles: [],
      };
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      return {
        success: false,
        outputText: '',
        errorText: `view不支持目录，请使用glob工具: ${absPath}`,
        exitCode: 1,
        operateFiles: [],
      };
    }

    // 文件元信息头
    const ext = path.extname(absPath);
    const sizeKB = (stat.size / 1024).toFixed(1);
    const modified = new Date(stat.mtimeMs).toLocaleString();
    const header = `─── ${path.relative(this.cwd, absPath)} ───\n  大小: ${sizeKB}KB | 修改: ${modified} | 类型: ${ext || '未知'}`;

    // 大文件流式读取
    if (stat.size > LARGE_FILE_THRESHOLD) {
      const streamResult = await this.executeReadStream(absPath, stat.size);
      return {
        ...streamResult,
        outputText: `${header}\n${streamResult.outputText}`,
      };
    }

    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split(/\r?\n/);

    // 解析行范围
    let startLine = 1;
    let endLine = lines.length;
    if (lineRange) {
      const rangeMatch = lineRange.match(/^(\d+)(?:-(\d+))?$/);
      if (rangeMatch) {
        startLine = Math.max(1, parseInt(rangeMatch[1], 10));
        endLine = rangeMatch[2] ? Math.min(lines.length, parseInt(rangeMatch[2], 10)) : lines.length;
      } else {
        return {
          success: false,
          outputText: '',
          errorText: `行范围格式无效: "${lineRange}"，应为 "start-end" 或 "start" 格式，如 "10-50" 或 "100"`,
          exitCode: 1,
          operateFiles: [],
        };
      }
    }

    // 行号跳转提示（当范围不包含文件开头时）
    let jumpHint = '';
    if (startLine > 1) {
      jumpHint = `\n  ... 省略前 ${startLine - 1} 行 ...\n`;
    }
    if (endLine < lines.length) {
      jumpHint += `\n  ... 省略后 ${lines.length - endLine} 行 (共 ${lines.length} 行) ...\n`;
    }

    // 格式化输出
    const selectedLines = lines.slice(startLine - 1, endLine);
    let output: string;
    if (showLineNumbers) {
      // 行号右对齐，宽度根据最大行号确定
      const maxLineNum = endLine;
      const width = String(maxLineNum).length;
      output = selectedLines
        .map((line, i) => {
          const lineNum = String(startLine + i).padStart(width, ' ');
          return `${lineNum} │ ${line}`;
        })
        .join('\n');
    } else {
      output = selectedLines.join('\n');
    }

    const totalInfo = `\n  显示 ${startLine}-${endLine} / 共 ${lines.length} 行`;

    return {
      success: true,
      outputText: `${header}${jumpHint}\n${output}${totalInfo}`,
      errorText: '',
      exitCode: 0,
      operateFiles: [absPath],
    };
  }

  /**
   * 大文件流式读取（README 5.3节）
   * 使用Node Stream分片读取，避免一次性加载超大文本占用内存
   * 读取前N行和后N行，中间用省略标记
   */
  private async executeReadStream(absPath: string, fileSize: number): Promise<ExecuteResult> {
    logger.info(`[LocalExecutor] 流式读取大文件: ${absPath} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);

    try {
      const maxLines = 500; // 最多显示500行
      const headLines: string[] = [];
      const tailLines: string[] = [];
      let totalLines = 0;
      let lineBuffer = '';

      const readStream = fs.createReadStream(absPath, { encoding: 'utf-8', highWaterMark: STREAM_CHUNK_SIZE });

      await new Promise<void>((resolve, reject) => {
        readStream.on('data', (chunk: string | Buffer) => {
          const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
          lineBuffer += chunkStr;
          let newlineIdx: number;
          while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
            const line = lineBuffer.substring(0, newlineIdx);
            lineBuffer = lineBuffer.substring(newlineIdx + 1);
            totalLines++;

            if (totalLines <= maxLines / 2) {
              headLines.push(line);
            }
            // 尾部行在最后处理
          }
        });

        readStream.on('end', () => {
          // 处理最后一行（无换行符结尾）
          if (lineBuffer.length > 0) {
            totalLines++;
            if (totalLines <= maxLines / 2) {
              headLines.push(lineBuffer);
            }
          }
          resolve();
        });

        readStream.on('error', reject);
      });

      // 如果总行数超过maxLines，需要读取尾部行
      if (totalLines > maxLines) {
        // 从文件末尾读取尾部行
        const tailCount = maxLines / 2;
        const tailContent = fs.readFileSync(absPath, 'utf-8');
        const allLines = tailContent.split(/\r?\n/);
        const tailStart = Math.max(0, allLines.length - tailCount);
        for (let i = tailStart; i < allLines.length; i++) {
          tailLines.push(allLines[i]);
        }
      }

      // 组装输出
      let output: string;
      if (totalLines > maxLines) {
        const headNumbered = headLines.map((line, i) => `${i + 1}: ${line}`).join('\n');
        const tailNumbered = tailLines.map((line, i) => `${totalLines - tailLines.length + i + 1}: ${line}`).join('\n');
        const skipped = totalLines - headLines.length - tailLines.length;
        output = `${headNumbered}\n\n... (省略 ${skipped} 行，文件共 ${totalLines} 行) ...\n\n${tailNumbered}`;
      } else {
        output = headLines.map((line, i) => `${i + 1}: ${line}`).join('\n');
      }

      return {
        success: true,
        outputText: output,
        errorText: '',
        exitCode: 0,
        operateFiles: [absPath],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[LocalExecutor] 流式读取失败: ${message}`);
      return {
        success: false,
        outputText: '',
        errorText: `流式读取失败: ${message}`,
        exitCode: 1,
        operateFiles: [],
      };
    }
  }

  // ---- write ----
  private async executeWrite(filePath: string, content: string): Promise<ExecuteResult> {
    const { valid, absPath } = this.validatePath(filePath);
    if (!valid) {
      return {
        success: false,
        outputText: '',
        errorText: `路径越权拦截: ${absPath} 不在项目目录 ${this.cwd} 内`,
        exitCode: 1,
        operateFiles: [],
      };
    }

    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // README 5.3节：大文件采用Node Stream分片写入
    if (content.length > LARGE_FILE_THRESHOLD) {
      return this.executeWriteStream(absPath, content);
    }

    // V1.1: Diff预审确认（仅当文件已存在时）
    if (this.requireChangeReview && fs.existsSync(absPath)) {
      const original = fs.readFileSync(absPath, 'utf-8');
      const approved = await this.confirmChange(filePath, original, content, 'write');
      if (!approved) {
        return {
          success: false,
          outputText: '',
          errorText: `变更被拒绝: ${absPath} (write操作被预审拒绝)`,
          exitCode: 1,
          operateFiles: [],
        };
      }
    }

    fs.writeFileSync(absPath, content, 'utf-8');
    logger.info(`[LocalExecutor] 写入文件: ${absPath} (${content.length} 字符)`);

    return {
      success: true,
      outputText: `文件已写入: ${absPath}`,
      errorText: '',
      exitCode: 0,
      operateFiles: [absPath],
    };
  }

  /**
   * 大文件流式写入（README 5.3节）
   * 使用Node Stream分片写入，避免一次性写入超大文本占用内存
   */
  private async executeWriteStream(absPath: string, content: string): Promise<ExecuteResult> {
    logger.info(`[LocalExecutor] 流式写入大文件: ${absPath} (${(content.length / 1024 / 1024).toFixed(2)}MB)`);

    try {
      const writeStream = fs.createWriteStream(absPath, { encoding: 'utf-8' });
      let offset = 0;

      while (offset < content.length) {
        const chunk = content.substring(offset, offset + STREAM_CHUNK_SIZE);
        const canWrite = writeStream.write(chunk);
        offset += STREAM_CHUNK_SIZE;

        // 背压处理：如果缓冲区满，等待drain事件
        if (!canWrite) {
          await new Promise<void>(resolve => writeStream.once('drain', resolve));
        }
      }

      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.on('error', reject);
      });

      return {
        success: true,
        outputText: `文件已流式写入: ${absPath} (${(content.length / 1024 / 1024).toFixed(2)}MB)`,
        errorText: '',
        exitCode: 0,
        operateFiles: [absPath],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[LocalExecutor] 流式写入失败: ${message}`);
      return {
        success: false,
        outputText: '',
        errorText: `流式写入失败: ${message}`,
        exitCode: 1,
        operateFiles: [],
      };
    }
  }

  // ---- edit (增量Diff补丁) ----
  private async executeEdit(filePath: string, patch: string): Promise<ExecuteResult> {
    const { valid, absPath } = this.validatePath(filePath);
    if (!valid) {
      return {
        success: false,
        outputText: '',
        errorText: `路径越权拦截: ${absPath} 不在项目目录 ${this.cwd} 内`,
        exitCode: 1,
        operateFiles: [],
      };
    }

    if (!fs.existsSync(absPath)) {
      return {
        success: false,
        outputText: '',
        errorText: `文件不存在: ${absPath}`,
        exitCode: 1,
        operateFiles: [],
      };
    }

    const original = fs.readFileSync(absPath, 'utf-8');
    const hunks = this.parseDiffPatch(patch);

    if (hunks.length === 0) {
      return {
        success: false,
        outputText: '',
        errorText: '无法解析Diff补丁',
        exitCode: 1,
        operateFiles: [],
      };
    }

    const { result, diffPatch } = this.applyHunks(original, hunks);

    // V1.1: Diff预审确认
    if (this.requireChangeReview) {
      const approved = await this.confirmChange(filePath, original, result, 'edit');
      if (!approved) {
        return {
          success: false,
          outputText: '',
          errorText: `变更被拒绝: ${absPath} (edit操作被预审拒绝)`,
          exitCode: 1,
          operateFiles: [],
        };
      }
    }

    fs.writeFileSync(absPath, result, 'utf-8');

    return {
      success: true,
      outputText: `文件已编辑: ${absPath}`,
      errorText: '',
      exitCode: 0,
      diffPatch,
      operateFiles: [absPath],
    };
  }

  // ---- bash (白名单校验 + 沙箱隔离) ----
  private executeBash(command: string): ExecuteResult {
    // 命令白名单校验
    const { valid, baseCmd } = this.validateCommand(command);
    if (!valid) {
      const errMsg = ERROR_MESSAGES[ErrorCode.COMMAND_NOT_IN_WHITELIST];
      logger.warn(`[LocalExecutor] 命令不在白名单: ${baseCmd}`);
      return {
        success: false,
        outputText: '',
        errorText: `${errMsg}。命令 "${baseCmd}" 未加入白名单，执行以下命令放行:\nclay config set execWhiteList '["git","npm","${baseCmd}"]'`,
        exitCode: ErrorCode.COMMAND_NOT_IN_WHITELIST,
        operateFiles: [],
      };
    }

    // Docker沙箱隔离：高危命令在Docker临时容器中执行
    if (this.enableDockerSandbox) {
      return this.executeInDockerSandbox(command);
    }

    // Node.js vm沙箱隔离：简单场景隔离代码片段
    if (this.enableSandbox && this.isVmSafeCommand(command)) {
      return this.executeInVmSandbox(command);
    }

    // 常规执行
    return this.executeBashDirect(command);
  }

  /**
   * 常规直接执行Shell命令
   */
  private executeBashDirect(command: string): ExecuteResult {
    try {
      const output = execSync(command, {
        cwd: this.cwd,
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });

      const truncated = this.truncateOutput(output);
      return {
        success: true,
        outputText: truncated,
        errorText: '',
        exitCode: 0,
        operateFiles: [],
      };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      const stdout = execErr.stdout ? this.truncateOutput(execErr.stdout) : '';
      const stderr = execErr.stderr ? this.truncateOutput(execErr.stderr) : String(err);

      return {
        success: false,
        outputText: stdout,
        errorText: stderr,
        exitCode: execErr.status ?? 1,
        operateFiles: [],
      };
    }
  }

  /**
   * Node.js vm沙箱隔离执行
   * 适用于简单代码片段执行，在隔离的vm上下文中运行
   * 限制：无法访问文件系统、网络、子进程等Node.js核心模块
   */
  private executeInVmSandbox(command: string): ExecuteResult {
    logger.info(`[LocalExecutor] vm沙箱隔离执行: ${command}`);

    try {
      // 构建安全的vm上下文，仅暴露基本计算能力
      const sandbox = {
        console: {
          log: (...args: unknown[]) => args.map(String).join(' '),
          error: (...args: unknown[]) => args.map(String).join(' '),
          warn: (...args: unknown[]) => args.map(String).join(' '),
        },
        setTimeout,
        clearTimeout,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        Math,
        JSON,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Date,
        RegExp,
        Map,
        Set,
        Error,
        TypeError,
        RangeError,
      };

      // 创建vm上下文
      const vmContext = vm.createContext(sandbox);

      // 执行命令（限制超时5秒）
      const result = vm.runInContext(command, vmContext, {
        timeout: 5000,
        filename: 'claycode-sandbox',
      });

      const output = result !== undefined ? String(result) : '';
      return {
        success: true,
        outputText: this.truncateOutput(output),
        errorText: '',
        exitCode: 0,
        operateFiles: [],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[LocalExecutor] vm沙箱执行失败: ${message}`);

      // vm沙箱执行失败，回退到常规执行
      logger.info('[LocalExecutor] 回退到常规执行模式');
      return this.executeBashDirect(command);
    }
  }

  /**
   * Docker容器沙箱隔离执行
   * 高危Shell命令在Docker临时容器中执行，隔离主机文件系统
   * 使用docker run --rm临时容器，执行完毕自动清理
   */
  private executeInDockerSandbox(command: string): ExecuteResult {
    logger.info(`[LocalExecutor] Docker沙箱隔离执行: ${command}`);

    try {
      // 检查Docker是否可用
      try {
        execSync('docker --version', { encoding: 'utf-8', timeout: 5000 });
      } catch {
        logger.warn('[LocalExecutor] Docker不可用，回退到常规执行模式');
        return this.executeBashDirect(command);
      }

      // 构建Docker执行命令
      // --rm: 执行完毕自动删除容器
      // --network=none: 禁用网络访问
      // -v: 只读挂载项目目录（安全隔离）
      // --memory=512m: 限制内存
      // --cpus=1: 限制CPU
      const projectDir = normalizePath(path.resolve(this.cwd));
      const dockerCommand = [
        'docker run --rm',
        '--network=none',
        `--memory=512m`,
        `--cpus=1`,
        `--workdir=/workspace`,
        `-v "${projectDir}:/workspace:ro"`,
        'node:20-slim',
        'sh', '-c',
        `"${command.replace(/"/g, '\\"')}"`,
      ].join(' ');

      const output = execSync(dockerCommand, {
        cwd: this.cwd,
        encoding: 'utf-8',
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });

      return {
        success: true,
        outputText: this.truncateOutput(output),
        errorText: '',
        exitCode: 0,
        operateFiles: [],
      };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      const stdout = execErr.stdout ? this.truncateOutput(execErr.stdout) : '';
      const stderr = execErr.stderr ? this.truncateOutput(execErr.stderr) : String(err);

      // Docker沙箱执行失败，回退到常规执行
      logger.warn(`[LocalExecutor] Docker沙箱执行失败，回退到常规执行: ${stderr}`);
      return this.executeBashDirect(command);
    }
  }

  /**
   * 判断命令是否适合在vm沙箱中执行
   * 仅允许简单的JS表达式/语句，不允许require/import等模块操作
   */
  private isVmSafeCommand(command: string): boolean {
    // 检查是否包含危险操作关键词
    const dangerousKeywords = [
      'require(', 'import ', 'process.', 'child_process',
      'fs.', 'fs.', 'net.', 'http.', 'https.',
      'exec(', 'execSync(', 'spawn(', 'fork(',
    ];
    return !dangerousKeywords.some(kw => command.includes(kw));
  }

  // ---- git (原生封装安全Git指令，变更记录自动同步至AI上下文) ----
  // README 3.4.3节：原生封装安全Git指令，变更记录自动同步至AI上下文

  /** Git子命令白名单 */
  private static readonly GIT_ALLOWED_SUBCMDS = [
    'status', 'log', 'diff', 'add', 'commit', 'branch',
    'checkout', 'pull', 'push', 'stash', 'fetch',
  ];

  /** Git status 状态码映射 */
  private static readonly GIT_STATUS_MAP: Record<string, string> = {
    'M': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed',
    'C': 'copied', 'U': 'unmerged', '?': 'untracked', '!': 'ignored',
  };

  private executeGit(command: string): ExecuteResult {
    const cmdParts = command.trim().split(/\s+/);
    const subcmd = cmdParts[0] === 'git' ? cmdParts[1] : cmdParts[0];

    if (!subcmd || !LocalExecutor.GIT_ALLOWED_SUBCMDS.includes(subcmd)) {
      return {
        success: false,
        outputText: '',
        errorText: `不允许的git命令: ${subcmd}。允许: ${LocalExecutor.GIT_ALLOWED_SUBCMDS.join(', ')}`,
        exitCode: 1,
        operateFiles: [],
      };
    }

    // 原生封装各子命令，解析输出并追踪变更
    try {
      switch (subcmd) {
        case 'status': return this.executeGitStatus();
        case 'log': return this.executeGitLog(cmdParts);
        case 'diff': return this.executeGitDiff(cmdParts);
        case 'add': return this.executeGitAdd(cmdParts);
        case 'commit': return this.executeGitCommit(cmdParts);
        case 'branch': return this.executeGitBranch(cmdParts);
        case 'checkout': return this.executeGitCheckout(cmdParts);
        case 'pull': return this.executeGitPull();
        case 'push': return this.executeGitPush(cmdParts);
        case 'stash': return this.executeGitStash(cmdParts);
        case 'fetch': return this.executeGitFetch();
        default:
          return {
            success: false,
            outputText: '',
            errorText: `不支持的git子命令: ${subcmd}`,
            exitCode: 1,
            operateFiles: [],
          };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[LocalExecutor] Git ${subcmd} 执行失败: ${message}`);
      return {
        success: false,
        outputText: '',
        errorText: `Git ${subcmd} 执行失败: ${message}`,
        exitCode: 1,
        operateFiles: [],
      };
    }
  }

  /** 原生Git status：解析porcelain输出，生成结构化变更记录 */
  private executeGitStatus(): ExecuteResult {
    const output = this.runGitCommand(['status', '--porcelain']);
    if (output === null) {
      return {
        success: false,
        outputText: '',
        errorText: 'Git status 执行失败，可能不在Git仓库中',
        exitCode: 1,
        operateFiles: [],
      };
    }

    const fileChanges: FileChangeRecord[] = [];
    const operateFiles: string[] = [];
    const lines = output.trim().split('\n').filter(l => l.length > 0);

    for (const line of lines) {
      const statusCode = line.substring(0, 2);
      const filePath = line.substring(3);
      const indexStatus = statusCode[0];
      const workTreeStatus = statusCode[1];

      // 优先使用工作区状态，其次索引状态
      const changeCode = workTreeStatus !== ' ' ? workTreeStatus : indexStatus;
      const changeType = this.mapGitStatusToChangeType(changeCode);

      fileChanges.push({
        filePath,
        changeType,
        contentSnippet: undefined,
        timestamp: Date.now(),
      });
      operateFiles.push(filePath);
    }

    // 生成格式化输出
    const formattedOutput = this.formatGitStatus(output, lines.length);

    return {
      success: true,
      outputText: formattedOutput,
      errorText: '',
      exitCode: 0,
      operateFiles,
      fileChanges,
    };
  }

  /** 原生Git log：结构化提交历史 */
  private executeGitLog(cmdParts: string[]): ExecuteResult {
    const args = ['log', '--format=%H|%an|%ae|%at|%s'];
    // 解析用户指定的参数（如 -n 数量、--oneline 等）
    for (let i = (cmdParts[0] === 'git' ? 2 : 1); i < cmdParts.length; i++) {
      const part = cmdParts[i];
      // 安全过滤：只允许已知安全的参数
      if (part.startsWith('-') || part.match(/^\d+$/)) {
        args.push(part);
      }
    }
    // 默认限制10条，防止输出过长
    if (!args.some(a => a.startsWith('-n') || a === '--max-count')) {
      args.push('-10');
    }

    const output = this.runGitCommand(args);
    if (output === null) {
      return {
        success: false,
        outputText: '',
        errorText: 'Git log 执行失败',
        exitCode: 1,
        operateFiles: [],
      };
    }

    const formattedOutput = this.formatGitLog(output);
    return {
      success: true,
      outputText: formattedOutput,
      errorText: '',
      exitCode: 0,
      operateFiles: [],
    };
  }

  /** 原生Git diff：解析变更差异 */
  private executeGitDiff(cmdParts: string[]): ExecuteResult {
    const args = ['diff'];
    for (let i = (cmdParts[0] === 'git' ? 2 : 1); i < cmdParts.length; i++) {
      const part = cmdParts[i];
      // 安全过滤：允许 --stat, --name-only, --cached, 文件路径等
      if (part.startsWith('--') || part.startsWith('HEAD') || part.startsWith('origin/') || !part.startsWith('-')) {
        args.push(part);
      }
    }

    const output = this.runGitCommand(args);
    if (output === null) {
      return {
        success: false,
        outputText: '',
        errorText: 'Git diff 执行失败',
        exitCode: 1,
        operateFiles: [],
      };
    }

    // 解析涉及的文件
    const operateFiles = this.extractDiffFiles(output);
    const fileChanges: FileChangeRecord[] = operateFiles.map(f => ({
      filePath: f,
      changeType: 'modified' as const,
      contentSnippet: undefined,
      timestamp: Date.now(),
    }));

    return {
      success: true,
      outputText: this.truncateOutput(output),
      errorText: '',
      exitCode: 0,
      diffPatch: output.length > 0 ? output : undefined,
      operateFiles,
      fileChanges,
    };
  }

  /** 原生Git add：暂存文件并追踪变更 */
  private executeGitAdd(cmdParts: string[]): ExecuteResult {
    const args = ['add'];
    const filePaths: string[] = [];
    for (let i = (cmdParts[0] === 'git' ? 2 : 1); i < cmdParts.length; i++) {
      const part = cmdParts[i];
      if (part === '.' || part === '--all' || part === '-A') {
        args.push(part);
      } else {
        // 校验路径安全性
        const { valid, absPath } = this.validatePath(part);
        if (!valid) {
          return {
            success: false,
            outputText: '',
            errorText: `路径越权拦截: ${absPath} 不在项目目录 ${this.cwd} 内`,
            exitCode: 1,
            operateFiles: [],
          };
        }
        args.push(part);
        filePaths.push(part);
      }
    }

    if (args.length === 1) {
      args.push('.');
    }

    const output = this.runGitCommand(args);
    if (output === null) {
      return {
        success: false,
        outputText: '',
        errorText: 'Git add 执行失败',
        exitCode: 1,
        operateFiles: [],
      };
    }

    // 获取暂存后的状态以确定变更文件
    const statusOutput = this.runGitCommand(['diff', '--cached', '--name-only']);
    const stagedFiles = statusOutput ? statusOutput.trim().split('\n').filter(l => l.length > 0) : filePaths;

    const fileChanges: FileChangeRecord[] = stagedFiles.map(f => ({
      filePath: f,
      changeType: 'modified' as const,
      contentSnippet: undefined,
      timestamp: Date.now(),
    }));

    return {
      success: true,
      outputText: `已暂存 ${stagedFiles.length} 个文件: ${stagedFiles.join(', ')}`,
      errorText: '',
      exitCode: 0,
      operateFiles: stagedFiles,
      fileChanges,
    };
  }

  /** 原生Git commit：提交变更并追踪变更记录 */
  private executeGitCommit(cmdParts: string[]): ExecuteResult {
    const args = ['commit'];
    let message = '';

    // 解析 -m 参数
    for (let i = (cmdParts[0] === 'git' ? 2 : 1); i < cmdParts.length; i++) {
      const part = cmdParts[i];
      if (part === '-m' && i + 1 < cmdParts.length) {
        message = cmdParts[++i];
        args.push('-m', message);
      } else if (part.startsWith('-')) {
        args.push(part);
      }
    }

    // 如果没有提供 -m，使用默认消息
    if (!message) {
      message = `claycode auto-commit ${new Date().toISOString()}`;
      args.push('-m', message);
    }

    // 获取提交前的文件列表
    const diffBefore = this.runGitCommand(['diff', '--cached', '--name-only']);
    const filesBefore = diffBefore ? diffBefore.trim().split('\n').filter(l => l.length > 0) : [];

    const output = this.runGitCommand(args);
    if (output === null) {
      return {
        success: false,
        outputText: '',
        errorText: 'Git commit 执行失败，可能没有暂存的变更',
        exitCode: 1,
        operateFiles: [],
      };
    }

    const fileChanges: FileChangeRecord[] = filesBefore.map(f => ({
      filePath: f,
      changeType: 'modified' as const,
      contentSnippet: undefined,
      timestamp: Date.now(),
    }));

    // 提取commit hash
    const hashMatch = output.match(/\[?\w+ (?<hash>[0-9a-f]{7,})/);
    const commitHash = hashMatch?.groups?.hash || 'unknown';

    return {
      success: true,
      outputText: `提交成功: ${commitHash} - ${message}\n变更文件: ${filesBefore.join(', ')}`,
      errorText: '',
      exitCode: 0,
      operateFiles: filesBefore,
      fileChanges,
    };
  }

  /** 原生Git branch：分支管理 */
  private executeGitBranch(cmdParts: string[]): ExecuteResult {
    const args = ['branch'];
    for (let i = (cmdParts[0] === 'git' ? 2 : 1); i < cmdParts.length; i++) {
      const part = cmdParts[i];
      // 安全过滤：允许 -a, -r, --list, 分支名等
      if (part.startsWith('-') || part === '--list' || !part.startsWith('-')) {
        args.push(part);
      }
    }

    const output = this.runGitCommand(args);
    if (output === null) {
      return {
        success: false,
        outputText: '',
        errorText: 'Git branch 执行失败',
        exitCode: 1,
        operateFiles: [],
      };
    }

    return {
      success: true,
      outputText: output.trim(),
      errorText: '',
      exitCode: 0,
      operateFiles: [],
    };
  }

  /** 原生Git checkout：切换分支并追踪文件变更 */
  private executeGitCheckout(cmdParts: string[]): ExecuteResult {
    const args = ['checkout'];
    let targetBranch = '';
    for (let i = (cmdParts[0] === 'git' ? 2 : 1); i < cmdParts.length; i++) {
      const part = cmdParts[i];
      if (part.startsWith('-b') || part.startsWith('--')) {
        args.push(part);
      } else {
        targetBranch = part;
        args.push(part);
      }
    }

    // 获取切换前的文件列表
    const statusBefore = this.runGitCommand(['status', '--porcelain']);
    const filesBefore = statusBefore ? statusBefore.trim().split('\n').filter(l => l.length > 0).map(l => l.substring(3)) : [];

    const output = this.runGitCommand(args);
    if (output === null) {
      return {
        success: false,
        outputText: '',
        errorText: `Git checkout 执行失败，可能分支 '${targetBranch}' 不存在或有未提交的变更`,
        exitCode: 1,
        operateFiles: [],
      };
    }

    // 获取切换后的变更文件
    const statusAfter = this.runGitCommand(['status', '--porcelain']);
    const filesAfter = statusAfter ? statusAfter.trim().split('\n').filter(l => l.length > 0).map(l => l.substring(3)) : [];
    const allFiles = [...new Set([...filesBefore, ...filesAfter])];

    const fileChanges: FileChangeRecord[] = allFiles.map(f => ({
      filePath: f,
      changeType: 'modified' as const,
      contentSnippet: undefined,
      timestamp: Date.now(),
    }));

    return {
      success: true,
      outputText: `已切换到分支: ${targetBranch}\n${output.trim()}`,
      errorText: '',
      exitCode: 0,
      operateFiles: allFiles,
      fileChanges,
    };
  }

  /** 原生Git pull：拉取远程变更并追踪文件变更 */
  private executeGitPull(): ExecuteResult {
    // 获取pull前的HEAD
    const headBefore = this.runGitCommand(['rev-parse', 'HEAD']);

    const output = this.runGitCommand(['pull']);
    if (output === null) {
      return {
        success: false,
        outputText: '',
        errorText: 'Git pull 执行失败',
        exitCode: 1,
        operateFiles: [],
      };
    }

    // 获取pull后的HEAD和变更文件
    const headAfter = this.runGitCommand(['rev-parse', 'HEAD']);
    const changedFiles: string[] = [];

    if (headBefore !== headAfter && headBefore && headAfter) {
      const diffOutput = this.runGitCommand(['diff', '--name-only', headBefore.trim(), headAfter.trim()]);
      if (diffOutput) {
        changedFiles.push(...diffOutput.trim().split('\n').filter(l => l.length > 0));
      }
    }

    const fileChanges: FileChangeRecord[] = changedFiles.map(f => ({
      filePath: f,
      changeType: 'modified' as const,
      contentSnippet: undefined,
      timestamp: Date.now(),
    }));

    return {
      success: true,
      outputText: output.trim(),
      errorText: '',
      exitCode: 0,
      operateFiles: changedFiles,
      fileChanges,
    };
  }

  /** 原生Git push：推送变更 */
  private executeGitPush(cmdParts: string[]): ExecuteResult {
    const args = ['push'];
    for (let i = (cmdParts[0] === 'git' ? 2 : 1); i < cmdParts.length; i++) {
      const part = cmdParts[i];
      // 安全过滤：允许远程名和分支名
      if (!part.startsWith('-') || part === '--force' || part === '--force-with-lease') {
        args.push(part);
      }
    }

    const output = this.runGitCommand(args);
    if (output === null) {
      return {
        success: false,
        outputText: '',
        errorText: 'Git push 执行失败',
        exitCode: 1,
        operateFiles: [],
      };
    }

    return {
      success: true,
      outputText: output.trim() || '推送成功',
      errorText: '',
      exitCode: 0,
      operateFiles: [],
    };
  }

  /** 原生Git stash：暂存工作区变更 */
  private executeGitStash(cmdParts: string[]): ExecuteResult {
    const args = ['stash'];
    for (let i = (cmdParts[0] === 'git' ? 2 : 1); i < cmdParts.length; i++) {
      const part = cmdParts[i];
      if (part === 'pop' || part === 'list' || part === 'drop' || part === 'apply' || part.startsWith('-')) {
        args.push(part);
      }
    }

    // 获取stash前的变更文件
    const statusBefore = this.runGitCommand(['status', '--porcelain']);
    const filesBefore = statusBefore ? statusBefore.trim().split('\n').filter(l => l.length > 0).map(l => l.substring(3)) : [];

    const output = this.runGitCommand(args);
    if (output === null) {
      return {
        success: false,
        outputText: '',
        errorText: 'Git stash 执行失败',
        exitCode: 1,
        operateFiles: [],
      };
    }

    const fileChanges: FileChangeRecord[] = filesBefore.map(f => ({
      filePath: f,
      changeType: 'modified' as const,
      contentSnippet: undefined,
      timestamp: Date.now(),
    }));

    return {
      success: true,
      outputText: output.trim(),
      errorText: '',
      exitCode: 0,
      operateFiles: filesBefore,
      fileChanges,
    };
  }

  /** 原生Git fetch：获取远程更新 */
  private executeGitFetch(): ExecuteResult {
    const output = this.runGitCommand(['fetch']);
    if (output === null) {
      return {
        success: false,
        outputText: '',
        errorText: 'Git fetch 执行失败',
        exitCode: 1,
        operateFiles: [],
      };
    }

    return {
      success: true,
      outputText: output.trim() || '已获取远程更新',
      errorText: '',
      exitCode: 0,
      operateFiles: [],
    };
  }

  // ---- Git 辅助方法 ----

  /** 安全执行Git命令，返回stdout或null（失败时） */
  private runGitCommand(args: string[]): string | null {
    try {
      const result = execSync(`git ${args.join(' ')}`, {
        cwd: this.cwd,
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      return result;
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      // 有些git命令（如diff无变更时）返回非零退出码但有有效输出
      if (execErr.stdout && execErr.stdout.trim().length > 0) {
        return execErr.stdout;
      }
      logger.warn(`[LocalExecutor] Git命令失败: git ${args.join(' ')} - ${execErr.stderr || String(err)}`);
      return null;
    }
  }

  /** 映射Git状态码到变更类型 */
  private mapGitStatusToChangeType(statusCode: string): 'created' | 'modified' | 'deleted' {
    const mapped = LocalExecutor.GIT_STATUS_MAP[statusCode];
    if (mapped === 'added' || mapped === 'untracked') return 'created';
    if (mapped === 'deleted') return 'deleted';
    return 'modified';
  }

  /** 格式化Git status输出 */
  private formatGitStatus(rawOutput: string, fileCount: number): string {
    if (fileCount === 0) {
      return '工作区干净，无待提交变更';
    }

    const lines = rawOutput.trim().split('\n');
    const sections: Record<string, string[]> = {
      '已修改': [],
      '已暂存': [],
      '未跟踪': [],
      '已删除': [],
    };

    for (const line of lines) {
      if (line.length < 4) continue;
      const statusCode = line.substring(0, 2);
      const filePath = line.substring(3);
      const indexStatus = statusCode[0];
      const workTreeStatus = statusCode[1];

      if (workTreeStatus === '?' && indexStatus === '?') {
        sections['未跟踪'].push(filePath);
      } else if (workTreeStatus === 'D' || indexStatus === 'D') {
        sections['已删除'].push(filePath);
      } else if (indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '!') {
        sections['已暂存'].push(filePath);
      } else {
        sections['已修改'].push(filePath);
      }
    }

    let output = `共 ${fileCount} 个变更文件:\n`;
    for (const [label, files] of Object.entries(sections)) {
      if (files.length > 0) {
        output += `\n${label} (${files.length}):\n`;
        output += files.map(f => `  ${f}`).join('\n');
      }
    }

    return output;
  }

  /** 格式化Git log输出 */
  private formatGitLog(rawOutput: string): string {
    if (!rawOutput.trim()) {
      return '无提交历史';
    }

    const lines = rawOutput.trim().split('\n');
    const formatted: string[] = [];

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length >= 5) {
        const [hash, author, , timestamp, subject] = parts;
        const date = new Date(parseInt(timestamp, 10) * 1000).toLocaleString('zh-CN');
        formatted.push(`${hash.substring(0, 7)} ${subject} (${author}, ${date})`);
      }
    }

    return formatted.join('\n');
  }

  /** 从diff输出提取涉及的文件列表 */
  private extractDiffFiles(diffOutput: string): string[] {
    const files: string[] = [];
    const diffFileRegex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
    let match: RegExpExecArray | null;
    while ((match = diffFileRegex.exec(diffOutput)) !== null) {
      const filePath = match[2];
      if (!files.includes(filePath)) {
        files.push(filePath);
      }
    }
    return files;
  }

  // ---- run_test (V1.2: 标准化内置测试工具) ----

  /**
   * V1.2: 标准化测试工具
   * 自动识别项目测试命令（复用project-detector），执行测试并捕获失败堆栈
   * 支持测试过滤和监听模式
   */
  private executeRunTest(testFilter?: string, testWatch?: boolean): ExecuteResult {
    // 自动识别项目测试命令
    const testCommand = this.detectTestCommand();
    if (!testCommand) {
      return {
        success: false,
        outputText: '',
        errorText: '无法识别项目测试命令。请确保项目包含 package.json/pom.xml/build.gradle/Cargo.toml/go.mod 等标志文件，或手动使用 bash 工具执行测试命令。',
        exitCode: 1,
        operateFiles: [],
      };
    }

    // 构建完整测试命令
    let fullCommand = testCommand;

    // 添加测试过滤参数
    if (testFilter) {
      if (testCommand.includes('npm') || testCommand.includes('pnpm') || testCommand.includes('yarn')) {
        // Node.js: -- --testNamePattern="filter"
        fullCommand += ` -- --testNamePattern="${testFilter}"`;
      } else if (testCommand.includes('pytest')) {
        // Python pytest: -k "filter"
        fullCommand += ` -k "${testFilter}"`;
      } else if (testCommand.includes('go test')) {
        // Go: -run "filter"
        fullCommand += ` -run "${testFilter}"`;
      } else if (testCommand.includes('cargo test')) {
        // Rust: -- filter
        fullCommand += ` -- "${testFilter}"`;
      } else if (testCommand.includes('mvn') || testCommand.includes('gradle')) {
        // Java Maven/Gradle: -Dtest=filter
        fullCommand += ` -Dtest="${testFilter}"`;
      } else if (testCommand.includes('dotnet test')) {
        // .NET: --filter "filter"
        fullCommand += ` --filter "${testFilter}"`;
      }
    }

    // 监听模式（仅Node.js生态支持）
    if (testWatch && (testCommand.includes('npm') || testCommand.includes('pnpm') || testCommand.includes('yarn'))) {
      fullCommand += ' --watch';
    }

    logger.info(`[LocalExecutor] 执行测试: ${fullCommand}`);

    try {
      const output = execSync(fullCommand, {
        cwd: this.cwd,
        encoding: 'utf-8',
        timeout: 120000, // 测试超时2分钟
        maxBuffer: 5 * 1024 * 1024, // 测试输出可能较大
      });

      // 解析测试结果摘要
      const summary = this.parseTestSummary(output, testCommand);
      return {
        success: true,
        outputText: summary || this.truncateOutput(output),
        errorText: '',
        exitCode: 0,
        operateFiles: [],
      };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      const stdout = execErr.stdout || '';
      const stderr = execErr.stderr || '';
      const exitCode = execErr.status ?? 1;

      // 测试失败时提取失败堆栈摘要
      const failureSummary = this.extractTestFailures(stdout || stderr, testCommand);
      return {
        success: false,
        outputText: failureSummary || this.truncateOutput(stdout),
        errorText: this.truncateOutput(stderr) || `测试失败 (exit code: ${exitCode})`,
        exitCode,
        operateFiles: [],
      };
    }
  }

  /**
   * 自动识别项目测试命令
   * 基于 project-detector 的标志文件检测逻辑
   */
  private detectTestCommand(): string | null {
    // Node.js (npm/pnpm/yarn)
    if (fs.existsSync(path.join(this.cwd, 'package.json'))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(this.cwd, 'package.json'), 'utf-8'));
        if (pkg.scripts?.test) {
          // 检测包管理器
          if (fs.existsSync(path.join(this.cwd, 'pnpm-lock.yaml'))) return 'pnpm test';
          if (fs.existsSync(path.join(this.cwd, 'yarn.lock'))) return 'yarn test';
          return 'npm test';
        }
        // 无test脚本但有vitest/jest依赖
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps?.vitest) return 'npx vitest run';
        if (deps?.jest) return 'npx jest';
      } catch {
        // package.json 解析失败，忽略
      }
    }

    // Java Maven
    if (fs.existsSync(path.join(this.cwd, 'pom.xml'))) return 'mvn test';

    // Java Gradle
    if (fs.existsSync(path.join(this.cwd, 'build.gradle')) || fs.existsSync(path.join(this.cwd, 'build.gradle.kts'))) {
      return 'gradle test';
    }

    // Go
    if (fs.existsSync(path.join(this.cwd, 'go.mod'))) return 'go test ./...';

    // Rust
    if (fs.existsSync(path.join(this.cwd, 'Cargo.toml'))) return 'cargo test';

    // Python pytest
    if (
      fs.existsSync(path.join(this.cwd, 'pytest.ini')) ||
      fs.existsSync(path.join(this.cwd, 'pyproject.toml')) ||
      fs.existsSync(path.join(this.cwd, 'setup.cfg'))
    ) {
      return 'pytest';
    }

    // .NET
    if (fs.existsSync(path.join(this.cwd, '*.csproj')) || fs.existsSync(path.join(this.cwd, '*.fsproj'))) {
      return 'dotnet test';
    }

    return null;
  }

  /**
   * 解析测试输出摘要
   * 提取测试通过/失败/总数等关键信息
   */
  private parseTestSummary(output: string, testCommand: string): string {
    const lines = output.split('\n');
    const summaryLines: string[] = [];

    // Node.js (vitest/jest) 摘要行
    if (testCommand.includes('npm') || testCommand.includes('pnpm') || testCommand.includes('yarn') || testCommand.includes('vitest') || testCommand.includes('jest')) {
      for (const line of lines) {
        if (
          /Tests|Test Files|test suites|passed|failed|skipped|\d+ passed|\d+ failed/i.test(line) &&
          line.trim().length > 0
        ) {
          summaryLines.push(line.trim());
        }
      }
    }

    // Go test 摘要
    if (testCommand.includes('go test')) {
      for (const line of lines) {
        if (/^ok\s+|^FAIL\s+|^---\s+FAIL/i.test(line)) {
          summaryLines.push(line.trim());
        }
      }
    }

    // Maven/Gradle 摘要
    if (testCommand.includes('mvn') || testCommand.includes('gradle')) {
      for (const line of lines) {
        if (/Tests run:|BUILD/i.test(line)) {
          summaryLines.push(line.trim());
        }
      }
    }

    // Rust cargo test 摘要
    if (testCommand.includes('cargo')) {
      for (const line of lines) {
        if (/running \d+ test|test result:/i.test(line)) {
          summaryLines.push(line.trim());
        }
      }
    }

    // pytest 摘要
    if (testCommand.includes('pytest')) {
      for (const line of lines) {
        if (/passed|failed|error|warning/i.test(line) && /=/i.test(line)) {
          summaryLines.push(line.trim());
        }
      }
    }

    if (summaryLines.length > 0) {
      return `测试结果摘要:\n${summaryLines.join('\n')}\n\n完整输出:\n${this.truncateOutput(output)}`;
    }

    return this.truncateOutput(output);
  }

  /**
   * 提取测试失败堆栈摘要
   * 捕获失败测试名称、文件位置、错误信息
   */
  private extractTestFailures(output: string, testCommand: string): string {
    const failures: string[] = [];
    const lines = output.split('\n');

    // 通用失败模式提取
    let inFailure = false;
    let failureBlock: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 检测失败开始标记
      const isFailureStart = (
        /FAIL|✗|✕|×|FAILED|Error:|AssertionError|Expect|AssertionError/i.test(line) &&
        !/passed|ok\s/i.test(line)
      ) || (
        /---\s+FAIL/i.test(line) // Go test
      );

      if (isFailureStart && !inFailure) {
        inFailure = true;
        failureBlock = [line];
      } else if (inFailure) {
        failureBlock.push(line);
        // 失败块结束：空行或下一个测试开始
        if (line.trim() === '' || /^(PASS|ok\s|✓|✔|●)/i.test(line)) {
          inFailure = false;
          if (failureBlock.length > 1) {
            failures.push(failureBlock.join('\n'));
          }
          failureBlock = [];
        }
      }

      // 提取文件位置信息（通用模式）
      const fileMatch = line.match(/(?:at\s+)?(?:.+?\s+\()?([^\s(]+\.(?:ts|js|py|java|go|rs|cs)):(\d+)/);
      if (fileMatch && !failures.some(f => f.includes(fileMatch[0]))) {
        failures.push(`  位置: ${fileMatch[1]}:${fileMatch[2]}`);
      }
    }

    // 处理最后一个未关闭的失败块
    if (inFailure && failureBlock.length > 1) {
      failures.push(failureBlock.join('\n'));
    }

    if (failures.length > 0) {
      const uniqueFailures = [...new Set(failures)].slice(0, 10); // 最多10个失败
      return `测试失败详情:\n${uniqueFailures.join('\n\n')}\n\n---\n完整输出:\n${this.truncateOutput(output)}`;
    }

    return this.truncateOutput(output);
  }

  // ---- V1.2 symbol_search ----

  /**
   * 执行代码符号搜索
   * 基于轻量级正则索引器，支持6种语言符号精准定位
   * @param name 符号名称（精确/前缀/包含匹配）
   * @param kind 符号类型过滤（可选）
   * @param limit 结果上限（默认20）
   */
  private executeSymbolSearch(name: string, kind?: string, limit?: number): ExecuteResult {
    try {
      // 懒初始化代码索引器
      if (!this.codeIndexer) {
        this.codeIndexer = new CodeIndexer(this.cwd);
        const { filesIndexed, symbolsFound } = this.codeIndexer.indexProject();
        if (filesIndexed === 0) {
          return {
            success: false,
            outputText: '',
            errorText: '项目索引为空，未找到可索引的源代码文件',
            exitCode: 1,
            operateFiles: [],
          };
        }
        logger.info(`[LocalExecutor] 符号索引初始化: ${filesIndexed}个文件, ${symbolsFound}个符号`);
      }

      // 解析符号类型过滤
      let symbolKind: SymbolKind | undefined;
      if (kind) {
        const validKinds: SymbolKind[] = ['class', 'interface', 'function', 'method', 'constant', 'variable', 'type', 'enum', 'struct', 'trait', 'namespace', 'module', 'macro', 'template', 'property'];
        const normalizedKind = kind.toLowerCase() as SymbolKind;
        if (validKinds.includes(normalizedKind)) {
          symbolKind = normalizedKind;
        } else {
          return {
            success: false,
            outputText: '',
            errorText: `无效的符号类型: ${kind}。支持的类型: ${validKinds.join(', ')}`,
            exitCode: 1,
            operateFiles: [],
          };
        }
      }

      const searchLimit = limit ?? 20;
      const results = this.codeIndexer.searchByName(name, symbolKind, searchLimit);

      if (results.length === 0) {
        // 返回索引统计信息辅助诊断
        const stats = this.codeIndexer.getStats();
        return {
          success: true,
          outputText: `未找到符号 "${name}"${symbolKind ? ` (类型: ${symbolKind})` : ''}\n\n索引统计: ${stats.files}个文件, ${stats.symbols}个符号\n语言分布: ${Object.entries(stats.languages).map(([k, v]) => `${k}(${v})`).join(', ')}`,
          errorText: '',
          exitCode: 0,
          operateFiles: [],
        };
      }

      // 格式化输出
      const outputLines: string[] = [
        `找到 ${results.length} 个符号匹配 "${name}"${symbolKind ? ` (类型: ${symbolKind})` : ''}:`,
        '',
      ];

      for (const result of results) {
        const { symbol, snippet, score } = result;
        const kindLabel = symbol.kind.toUpperCase();
        const parentInfo = symbol.parentName ? ` in ${symbol.parentName}` : '';
        const sigInfo = symbol.signature ? ` extends/implements ${symbol.signature}` : '';
        
        outputLines.push(`─── ${kindLabel}: ${symbol.name}${parentInfo}${sigInfo} ───`);
        outputLines.push(`    文件: ${symbol.filePath}:${symbol.line}:${symbol.column}`);
        outputLines.push(`    语言: ${symbol.language}  匹配度: ${score}`);

        // 上下文预过滤：附加依赖和引用信息 (README 3.5 第5项)
        const preFilter = this.codeIndexer.preFilterContext(symbol.name, symbol.kind);
        if (preFilter) {
          if (preFilter.directDependencies.length > 0) {
            const depNames = preFilter.directDependencies.map(d => `${d.name}(${d.kind})`).join(', ');
            outputLines.push(`    依赖符号: ${depNames}`);
          }
          if (preFilter.referencedBy.length > 0) {
            const refNames = preFilter.referencedBy.map(r => `${r.name}(${r.kind})`).join(', ');
            outputLines.push(`    被引用: ${refNames}`);
          }
        }

        outputLines.push('');
        outputLines.push(snippet);
        outputLines.push('');
      }

      return {
        success: true,
        outputText: outputLines.join('\n'),
        errorText: '',
        exitCode: 0,
        operateFiles: results.map(r => r.symbol.filePath),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[LocalExecutor] 符号搜索失败: ${message}`);
      return {
        success: false,
        outputText: '',
        errorText: `符号搜索失败: ${message}`,
        exitCode: 1,
        operateFiles: [],
      };
    }
  }

  // ---- glob ----
  private executeGlob(globPattern: string): ExecuteResult {
    try {
      const files = glob.sync(globPattern, {
        cwd: this.cwd,
        absolute: false,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      });

      return {
        success: true,
        outputText: files.join('\n'),
        errorText: '',
        exitCode: 0,
        operateFiles: files,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        outputText: '',
        errorText: `glob匹配失败: ${message}`,
        exitCode: 1,
        operateFiles: [],
      };
    }
  }

  // ---- Diff补丁解析 ----

  /** 解析统一Diff格式的补丁 */
  private parseDiffPatch(patch: string): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    const lines = patch.split(/\r?\n/);
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (hunkMatch) {
        const hunk: DiffHunk = {
          oldStart: parseInt(hunkMatch[1], 10),
          oldCount: parseInt(hunkMatch[2] || '1', 10),
          newStart: parseInt(hunkMatch[3], 10),
          newCount: parseInt(hunkMatch[4] || '1', 10),
          oldLines: [],
          newLines: [],
        };

        i++;
        while (i < lines.length && !lines[i].startsWith('@@')) {
          const changeLine = lines[i];
          if (changeLine.startsWith('-')) {
            hunk.oldLines.push(changeLine.slice(1));
          } else if (changeLine.startsWith('+')) {
            hunk.newLines.push(changeLine.slice(1));
          } else if (changeLine.startsWith(' ')) {
            hunk.oldLines.push(changeLine.slice(1));
            hunk.newLines.push(changeLine.slice(1));
          }
          i++;
        }

        hunks.push(hunk);
        continue;
      }

      i++;
    }

    return hunks;
  }

  /** 应用所有变更块到原始内容 */
  private applyHunks(original: string, hunks: DiffHunk[]): { result: string; diffPatch: string } {
    const lines = original.split(/\r?\n/);
    const NL = getNewLine();
    let offset = 0;
    const patchParts: string[] = [];

    for (const hunk of hunks) {
      const startIdx = hunk.oldStart - 1 + offset;
      const endIdx = startIdx + hunk.oldLines.length;

      let contextMatch = true;
      for (let j = 0; j < hunk.oldLines.length; j++) {
        const origLine = lines[startIdx + j] ?? '';
        const patchLine = hunk.oldLines[j];
        if (origLine !== patchLine) {
          contextMatch = false;
          logger.warn(`[LocalExecutor] 上下文不匹配 行${startIdx + j + 1}: 期望="${patchLine}" 实际="${origLine}"`);
          break;
        }
      }

      if (!contextMatch) {
        const foundIdx = this.fuzzyFindBlock(lines, hunk.oldLines, startIdx - 3, startIdx + 3);
        if (foundIdx >= 0) {
          lines.splice(foundIdx, hunk.oldLines.length, ...hunk.newLines);
          offset += hunk.newLines.length - hunk.oldLines.length;
          patchParts.push(`@@ -${foundIdx + 1},${hunk.oldLines.length} +${foundIdx + 1},${hunk.newLines.length} @@`);
          continue;
        }
        logger.error(`[LocalExecutor] 跳过无法匹配的hunk: @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
        continue;
      }

      lines.splice(startIdx, hunk.oldLines.length, ...hunk.newLines);
      offset += hunk.newLines.length - hunk.oldLines.length;
      patchParts.push(`@@ -${hunk.oldStart},${hunk.oldLines.length} +${hunk.oldStart},${hunk.newLines.length} @@`);
    }

    return {
      result: lines.join(NL),
      diffPatch: patchParts.join('\n'),
    };
  }

  /** 模糊搜索：在指定范围内查找匹配块 */
  private fuzzyFindBlock(lines: string[], target: string[], center: number, range: number): number {
    for (let delta = 0; delta <= range; delta++) {
      for (const dir of [1, -1]) {
        const start = center + delta * dir;
        if (start < 0 || start + target.length > lines.length) continue;

        let match = true;
        for (let j = 0; j < target.length; j++) {
          if (lines[start + j] !== target[j]) {
            match = false;
            break;
          }
        }
        if (match) return start;
      }
    }
    return -1;
  }

  // ---- 工具方法 ----

  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return normalizePath(filePath);
    return normalizePath(path.resolve(this.cwd, filePath));
  }

  private truncateOutput(output: string): string {
    if (output.length <= this.maxOutputLength) return output;
    const half = Math.floor(this.maxOutputLength / 2);
    return output.slice(0, half) + '\n\n... (输出已截断) ...\n\n' + output.slice(-half);
  }
}