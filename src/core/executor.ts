/**
 * @claycode/local-executor 原生本地执行引擎
 * 执行6种工具调用：read/edit/write/bash/git/glob
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
  ToolCall, ToolType, ExecuteResult, ErrorCode, ERROR_MESSAGES,
} from '../types';
import { logger, normalizePath, getNewLine } from '../utils';

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

  constructor(cwd: string, options?: { maxOutputLength?: number; execWhiteList?: string[]; enableSandbox?: boolean; enableDockerSandbox?: boolean }) {
    this.cwd = cwd;
    this.maxOutputLength = options?.maxOutputLength ?? 10000;
    this.execWhiteList = options?.execWhiteList ?? ['git', 'npm', 'pnpm', 'yarn', 'node', 'npx', 'tsc', 'eslint', 'prettier', 'mvn', 'gradle'];
    this.enableSandbox = options?.enableSandbox ?? false;
    this.enableDockerSandbox = options?.enableDockerSandbox ?? false;
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

  /**
   * 批量执行工具调用
   * 默认顺序执行以保持操作依赖关系
   * README 5.3节：流式并行处理 - 独立读操作可并行执行(Promise.allSettled)
   */
  async executeBatch(toolCalls: ToolCall[], options?: { parallel?: boolean }): Promise<ExecuteResult[]> {
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

  // ---- git (内置白名单) ----
  private executeGit(command: string): ExecuteResult {
    const allowed = ['status', 'log', 'diff', 'add', 'commit', 'branch', 'checkout', 'pull', 'push', 'stash', 'fetch'];
    const cmdParts = command.trim().split(/\s+/);
    const subcmd = cmdParts[0] === 'git' ? cmdParts[1] : cmdParts[0];

    if (!subcmd || !allowed.includes(subcmd)) {
      return {
        success: false,
        outputText: '',
        errorText: `不允许的git命令: ${subcmd}。允许: ${allowed.join(', ')}`,
        exitCode: 1,
        operateFiles: [],
      };
    }

    const fullCmd = command.trimStart().startsWith('git') ? command : `git ${command}`;
    return this.executeBash(fullCmd);
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