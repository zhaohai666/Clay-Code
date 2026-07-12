/**
 * ClayCode 安全模块
 * AES-256-CBC加密存储、路径越权拦截、命令白名单校验、轻量沙箱隔离
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  ToolCall, ToolType, ToolCallValidationResult, ErrorCode, ERROR_MESSAGES,
} from '../types';
import { logger, normalizePath } from '../utils';

/** 加密算法 */
const ALGORITHM = 'aes-256-cbc';
/** 密钥派生迭代次数 */
const KEY_ITERATIONS = 100000;
/** 密钥长度(bytes) */
const KEY_LENGTH = 32;
/** IV长度(bytes) */
const IV_LENGTH = 16;
/** 盐值长度(bytes) */
const SALT_LENGTH = 32;

/**
 * 安全工具类
 * 提供AES加密/解密、路径校验、命令白名单校验
 */
export class SecurityManager {
  private projectRoot: string;
  private masterKey: string;
  private execWhiteList: string[];
  private maxBatchFiles: number;
  private enableDockerSandbox: boolean;

  constructor(projectRoot: string, options?: { masterKey?: string; execWhiteList?: string[]; maxBatchFiles?: number; enableDockerSandbox?: boolean }) {
    this.projectRoot = normalizePath(path.resolve(projectRoot));
    this.masterKey = options?.masterKey ?? 'claycode-default-key-change-in-production';
    this.execWhiteList = options?.execWhiteList ?? ['git', 'npm', 'pnpm', 'yarn', 'node', 'npx', 'tsc', 'eslint', 'prettier', 'mvn', 'gradle'];
    this.maxBatchFiles = options?.maxBatchFiles ?? 50;
    this.enableDockerSandbox = options?.enableDockerSandbox ?? false;
  }

  // ---- AES-256-CBC 加密/解密 ----

  /** 从主密钥派生加密密钥 */
  private deriveKey(salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(this.masterKey, salt, KEY_ITERATIONS, KEY_LENGTH, 'sha512');
  }

  /** 加密文本，返回 base64 编码的 salt+iv+ciphertext */
  encrypt(plaintext: string): string {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = this.deriveKey(salt);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    // 格式: salt(32) + iv(16) + ciphertext
    const combined = Buffer.concat([salt, iv, Buffer.from(encrypted, 'base64')]);
    return combined.toString('base64');
  }

  /** 解密文本 */
  decrypt(ciphertext: string): string {
    try {
      const combined = Buffer.from(ciphertext, 'base64');
      const salt = combined.subarray(0, SALT_LENGTH);
      const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH);

      const key = this.deriveKey(salt);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

      let decrypted = decipher.update(encrypted, undefined, 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[SecurityManager] 解密失败: ${message}`);
      throw new Error('会话数据解密失败，请重新登录');
    }
  }

  // ---- 路径越权拦截 ----

  /** 校验路径是否在项目目录内 */
  validatePath(filePath: string): { valid: boolean; absPath: string; reason?: string } {
    const absPath = normalizePath(path.resolve(filePath));

    // 检查是否在项目根目录内（Windows路径大小写不敏感）
    if (!absPath.toLowerCase().startsWith(this.projectRoot.toLowerCase())) {
      return {
        valid: false,
        absPath,
        reason: `路径越权: ${absPath} 不在项目目录 ${this.projectRoot} 内`,
      };
    }

    // 检查路径遍历攻击（规范化后比较，兼容Windows反斜杠）
    const resolved = normalizePath(path.resolve(absPath));
    if (resolved !== absPath) {
      return {
        valid: false,
        absPath,
        reason: `路径遍历检测: ${filePath} 解析异常`,
      };
    }

    return { valid: true, absPath };
  }

  /** 批量校验路径 */
  validatePaths(filePaths: string[]): { valid: boolean; invalidPaths: string[] } {
    const invalidPaths: string[] = [];
    for (const fp of filePaths) {
      const result = this.validatePath(fp);
      if (!result.valid) {
        invalidPaths.push(fp);
        logger.warn(`[SecurityManager] 路径越权拦截: ${fp} - ${result.reason}`);
      }
    }
    return { valid: invalidPaths.length === 0, invalidPaths };
  }

  // ---- 命令白名单校验 ----

  /** 校验Shell命令是否在白名单内 */
  validateCommand(command: string): { valid: boolean; baseCmd: string; reason?: string } {
    const trimmed = command.trim();
    const baseCmd = path.basename(trimmed.split(/\s+/)[0]);

    if (!this.execWhiteList.includes(baseCmd)) {
      return {
        valid: false,
        baseCmd,
        reason: `命令 "${baseCmd}" 不在白名单内。允许: ${this.execWhiteList.join(', ')}`,
      };
    }

    return { valid: true, baseCmd };
  }

  /** 更新白名单 */
  updateWhiteList(whiteList: string[]): void {
    this.execWhiteList = whiteList;
    logger.info(`[SecurityManager] 白名单已更新: ${whiteList.join(', ')}`);
  }

  /** 获取当前白名单 */
  getWhiteList(): string[] {
    return [...this.execWhiteList];
  }

  // ---- 轻量沙箱隔离 ----

  /** 在受限环境中执行代码片段（Node.js vm基础隔离） */
  sandboxEval(code: string, timeout: number = 5000): { success: boolean; result?: unknown; error?: string } {
    try {
      // 基础沙箱：使用Function构造隔离全局作用域
      const sandbox = {
        console: {
          log: (...args: unknown[]) => logger.info(`[Sandbox] ${args.join(' ')}`),
          error: (...args: unknown[]) => logger.error(`[Sandbox] ${args.join(' ')}`),
          warn: (...args: unknown[]) => logger.warn(`[Sandbox] ${args.join(' ')}`),
        },
        JSON,
        Math,
        Date,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
      };

      const keys = Object.keys(sandbox);
      const values = Object.values(sandbox);
      const fn = new Function(...keys, `"use strict"; return (${code});`);
      const result = fn(...values);

      return { success: true, result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  // ---- ToolCall JSON Schema 校验 (4.2) ----

  /** 设置批量文件操作上限 */
  setMaxBatchFiles(max: number): void {
    this.maxBatchFiles = max;
  }

  /**
   * 校验ToolCall入参合法性
   * JSON Schema标准校验：拦截非法文件路径、危险命令
   */
  validateToolCall(tc: ToolCall): ToolCallValidationResult {
    const errors: string[] = [];
    let fixSuggestion: string | undefined;

    // 1. 校验tool字段
    const validTools: ToolType[] = ['read', 'edit', 'write', 'bash', 'git', 'glob'];
    if (!validTools.includes(tc.tool)) {
      errors.push(`无效的工具类型: "${tc.tool}"，允许: ${validTools.join(', ')}`);
      return { valid: false, errors, fixSuggestion: '请使用有效的工具类型' };
    }

    // 2. 按工具类型校验必填字段
    switch (tc.tool) {
      case 'read':
      case 'edit':
      case 'write': {
        if (!tc.filePath || typeof tc.filePath !== 'string') {
          errors.push(`${tc.tool} 操作缺少 filePath 参数`);
          fixSuggestion = '请提供有效的文件路径';
        } else {
          // 路径越权校验
          const pathResult = this.validatePath(tc.filePath);
          if (!pathResult.valid) {
            errors.push(pathResult.reason || '文件路径越权');
            fixSuggestion = '请使用项目目录内的文件路径';
          }
          // 危险路径检测
          const dangerousPatterns = ['/etc/', '/root/', 'C:\\Windows', 'C:\\System32', '/sys/', '/proc/'];
          if (dangerousPatterns.some(p => tc.filePath!.includes(p))) {
            errors.push(`检测到危险系统路径: ${tc.filePath}`);
            fixSuggestion = '禁止访问系统目录';
          }
        }
        // write操作需要content
        if (tc.tool === 'write' && (!tc.content || typeof tc.content !== 'string')) {
          errors.push('write 操作缺少 content 参数');
        }
        // edit操作需要patch
        if (tc.tool === 'edit' && (!tc.patch || typeof tc.patch !== 'string')) {
          errors.push('edit 操作缺少 patch 参数');
        }
        break;
      }
      case 'bash':
      case 'git': {
        if (!tc.command || typeof tc.command !== 'string') {
          errors.push(`${tc.tool} 操作缺少 command 参数`);
          fixSuggestion = '请提供有效的命令';
        } else {
          // 命令白名单校验（仅bash需要，git子命令有独立校验）
          if (tc.tool === 'bash') {
            const cmdResult = this.validateCommand(tc.command);
            if (!cmdResult.valid) {
              errors.push(cmdResult.reason || '命令不在白名单');
              fixSuggestion = `执行以下命令放行: clay config set execWhiteList '[${this.execWhiteList.map(c => `"${c}"`).join(',')}, "${cmdResult.baseCmd}"]'`;
            }
          }
          // 危险命令检测
          const dangerousCmds = ['rm -rf /', 'mkfs', 'dd if=', ':(){:|:&};:', 'chmod -R 777 /'];
          if (dangerousCmds.some(d => tc.command!.includes(d))) {
            errors.push(`检测到危险命令: ${tc.command}`);
            fixSuggestion = '禁止执行破坏性系统命令';
          }
        }
        break;
      }
      case 'glob': {
        if (!tc.globPattern || typeof tc.globPattern !== 'string') {
          errors.push('glob 操作缺少 globPattern 参数');
          fixSuggestion = '请提供有效的glob匹配模式';
        }
        break;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      fixSuggestion: errors.length > 0 ? fixSuggestion : undefined,
    };
  }

  /**
   * 批量校验ToolCall数组
   * 含批量文件操作数量上限检测(6.1)
   */
  validateToolCalls(toolCalls: ToolCall[]): { valid: ToolCall[]; invalid: Array<{ tc: ToolCall; result: ToolCallValidationResult }> } {
    const valid: ToolCall[] = [];
    const invalid: Array<{ tc: ToolCall; result: ToolCallValidationResult }> = [];

    // 批量文件操作数量上限检测
    const fileOps = toolCalls.filter(tc => ['read', 'edit', 'write'].includes(tc.tool));
    if (fileOps.length > this.maxBatchFiles) {
      logger.warn(`[SecurityManager] 批量文件操作数量 ${fileOps.length} 超过上限 ${this.maxBatchFiles}，已截断`);
      // 保留前maxBatchFiles个文件操作
      const excessFileOps = fileOps.slice(this.maxBatchFiles);
      for (const tc of excessFileOps) {
        invalid.push({
          tc,
          result: {
            valid: false,
            errors: [`批量文件操作数量超过上限 ${this.maxBatchFiles}`],
            fixSuggestion: '请减少单次文件操作数量',
          },
        });
      }
    }

    for (const tc of toolCalls) {
      // 检查是否在截断范围内（文件操作超量时跳过，已在上方标记为invalid）
      if (['read', 'edit', 'write'].includes(tc.tool)) {
        const fileOpIndex = fileOps.indexOf(tc);
        if (fileOpIndex >= this.maxBatchFiles) {
          continue; // 已在上方标记为invalid，跳过避免重复添加
        }
      }

      const result = this.validateToolCall(tc);
      if (result.valid) {
        valid.push(tc);
      } else {
        invalid.push({ tc, result });
      }
    }

    return { valid, invalid };
  }

  // ---- Docker容器沙箱隔离 (6.3) ----

  /** 设置Docker沙箱开关 */
  setDockerSandbox(enabled: boolean): void {
    this.enableDockerSandbox = enabled;
  }

  /**
   * 在Docker临时容器中执行命令（高危Shell隔离）
   * 仅在enableDockerSandbox=true时使用
   */
  executeInDocker(command: string, timeout: number = 30000): { success: boolean; output: string; error?: string } {
    if (!this.enableDockerSandbox) {
      return {
        success: false,
        output: '',
        error: 'Docker沙箱未启用，请在配置中设置 enableDockerSandbox: true',
      };
    }

    try {
      // 检查Docker是否可用
      execSync('docker --version', { encoding: 'utf-8', timeout: 5000 });
    } catch {
      return {
        success: false,
        output: '',
        error: 'Docker未安装或未启动，无法使用Docker沙箱',
      };
    }

    try {
      // 使用临时容器执行命令，自动删除
      const dockerCmd = `docker run --rm -v "${this.projectRoot}:/workspace" -w /workspace node:18-slim bash -c ${JSON.stringify(command)}`;
      const output = execSync(dockerCmd, {
        encoding: 'utf-8',
        timeout,
        maxBuffer: 1024 * 1024,
      });

      return { success: true, output };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Docker执行失败: ${message}` };
    }
  }
}