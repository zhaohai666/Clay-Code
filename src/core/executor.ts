/**
 * @claycode/local-executor 原生本地执行引擎
 * 执行6种工具调用：read/edit/write/bash/git/glob
 * 增量Diff补丁编辑 + 命令白名单安全校验 + 路径越权拦截 + 可选沙箱隔离
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as glob from 'glob';
import {
  ToolCall, ToolType, ExecuteResult, ErrorCode, ERROR_MESSAGES,
} from '../types';
import { logger, normalizePath, getNewLine } from '../utils';

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

  constructor(cwd: string, options?: { maxOutputLength?: number; execWhiteList?: string[]; enableSandbox?: boolean }) {
    this.cwd = cwd;
    this.maxOutputLength = options?.maxOutputLength ?? 10000;
    this.execWhiteList = options?.execWhiteList ?? ['git', 'npm', 'pnpm', 'yarn', 'node', 'npx', 'tsc', 'eslint', 'prettier', 'mvn', 'gradle'];
    this.enableSandbox = options?.enableSandbox ?? false;
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
   */
  async executeBatch(toolCalls: ToolCall[]): Promise<ExecuteResult[]> {
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

  // ---- 路径安全校验 ----

  /** 校验路径不超出项目根目录 */
  private validatePath(filePath: string): { valid: boolean; absPath: string } {
    const absPath = this.resolvePath(filePath);
    const normalizedCwd = normalizePath(path.resolve(this.cwd));
    if (!absPath.startsWith(normalizedCwd)) {
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

    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split(getNewLine());
    const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');

    return {
      success: true,
      outputText: numbered,
      errorText: '',
      exitCode: 0,
      operateFiles: [absPath],
    };
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

  // ---- bash (白名单校验) ----
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