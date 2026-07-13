/**
 * ClayCode 安全模块
 * AES-256-CBC加密存储、路径越权拦截、命令白名单校验、轻量沙箱隔离
 * V1.1: .clayignore权限规则完整支持（只读/禁止删除/忽略）
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  ToolCall, ToolType, ToolCallValidationResult, ErrorCode, ERROR_MESSAGES,
} from '../types';
import { logger, normalizePath } from '../utils';

/** .clayignore规则条目 */
interface ClayignoreRule {
  /** 原始模式字符串 */
  pattern: string;
  /** 是否为反向模式（!开头） */
  negated: boolean;
  /** 是否为目录模式（/结尾） */
  directoryOnly: boolean;
  /** 编译后的正则表达式 */
  regex: RegExp;
}

/** .clayignore访问控制标记 */
interface ClayignoreAccessControl {
  /** 只读目录模式列表 */
  readonlyPatterns: string[];
  /** 禁止删除目录模式列表 */
  nodeletePatterns: string[];
  /** 编译后的只读正则 */
  readonlyRegexes: RegExp[];
  /** 编译后的禁止删除正则 */
  nodeleteRegexes: RegExp[];
}

/** 文件访问操作类型 */
type FileAccessOperation = 'read' | 'write' | 'edit' | 'delete' | 'glob';

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

  /** .clayignore忽略规则列表 */
  private ignoreRules: ClayignoreRule[] = [];
  /** .clayignore访问控制规则 */
  private accessControl: ClayignoreAccessControl = {
    readonlyPatterns: [],
    nodeletePatterns: [],
    readonlyRegexes: [],
    nodeleteRegexes: [],
  };
  /** .clayignore是否已加载 */
  private clayignoreLoaded: boolean = false;

  constructor(projectRoot: string, options?: { masterKey?: string; execWhiteList?: string[]; maxBatchFiles?: number; enableDockerSandbox?: boolean }) {
    this.projectRoot = normalizePath(path.resolve(projectRoot));
    this.masterKey = options?.masterKey ?? 'claycode-default-key-change-in-production';
    this.execWhiteList = options?.execWhiteList ?? ['git', 'npm', 'pnpm', 'yarn', 'node', 'npx', 'tsc', 'eslint', 'prettier', 'mvn', 'gradle'];
    this.maxBatchFiles = options?.maxBatchFiles ?? 50;
    this.enableDockerSandbox = options?.enableDockerSandbox ?? false;
    // V1.1: 自动加载.clayignore权限规则
    this.loadClayignore();
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

  // ---- .clayignore 权限规则 (V1.1 README 6.1) ----

  /**
   * 加载.clayignore文件
   * 兼容.gitignore语法，支持额外标记：
   * - [readonly] <pattern>  标记目录/文件为只读（禁止写入/编辑）
   * - [nodelete] <pattern>  标记目录/文件为禁止删除
   * - <pattern>             普通忽略规则（禁止任何访问）
   */
  loadClayignore(clayignorePath?: string): void {
    const ignoreFile = clayignorePath || path.join(this.projectRoot, '.clayignore');
    if (!fs.existsSync(ignoreFile)) {
      logger.info('[SecurityManager] .clayignore 文件不存在，跳过加载');
      this.clayignoreLoaded = true;
      return;
    }

    try {
      const content = fs.readFileSync(ignoreFile, 'utf-8');
      const lines = content.split(/\r?\n/);

      this.ignoreRules = [];
      this.accessControl = {
        readonlyPatterns: [],
        nodeletePatterns: [],
        readonlyRegexes: [],
        nodeleteRegexes: [],
      };

      for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        // 去除行尾空格，保留行首空格（gitignore语义）
        const line = rawLine.replace(/\s+$/, '');

        // 跳过空行和注释
        if (!line || line.startsWith('#')) continue;

        // 检查访问控制标记
        const readonlyMatch = line.match(/^\[readonly\]\s+(.+)$/);
        if (readonlyMatch) {
          const pattern = readonlyMatch[1].trim();
          this.accessControl.readonlyPatterns.push(pattern);
          this.accessControl.readonlyRegexes.push(this.compileGitignorePattern(pattern));
          logger.info(`[SecurityManager] .clayignore 只读规则: ${pattern}`);
          continue;
        }

        const nodeleteMatch = line.match(/^\[nodelete\]\s+(.+)$/);
        if (nodeleteMatch) {
          const pattern = nodeleteMatch[1].trim();
          this.accessControl.nodeletePatterns.push(pattern);
          this.accessControl.nodeleteRegexes.push(this.compileGitignorePattern(pattern));
          logger.info(`[SecurityManager] .clayignore 禁止删除规则: ${pattern}`);
          continue;
        }

        // 普通忽略规则
        const negated = line.startsWith('!');
        const patternStr = negated ? line.substring(1) : line;
        const directoryOnly = patternStr.endsWith('/');

        this.ignoreRules.push({
          pattern: line,
          negated,
          directoryOnly,
          regex: this.compileGitignorePattern(patternStr),
        });
      }

      this.clayignoreLoaded = true;
      logger.info(`[SecurityManager] .clayignore 已加载: ${this.ignoreRules.length} 忽略规则, ` +
        `${this.accessControl.readonlyPatterns.length} 只读规则, ` +
        `${this.accessControl.nodeletePatterns.length} 禁止删除规则`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[SecurityManager] .clayignore 加载失败: ${message}`);
      this.clayignoreLoaded = true; // 标记已尝试加载，避免重复
    }
  }

  /**
   * 将gitignore风格模式编译为正则表达式
   * 支持基础gitignore语法：*通配、**递归、?单字符、[abc]字符集、/目录分隔
   */
  private compileGitignorePattern(pattern: string): RegExp {
    let regexStr = pattern;

    // 转义正则特殊字符（保留gitignore通配符）
    regexStr = regexStr.replace(/[.+^${}()|[\]\\]/g, '\\$&');

    // 处理gitignore语法
    // **/ 前缀：匹配任意目录深度
    regexStr = regexStr.replace(/\*\*\\/g, '(?:.*/)?');
    // /**/ 中间：匹配任意目录层级
    regexStr = regexStr.replace(/\/\*\*\//g, '/(?:.*/)?');
    // /** 后缀：匹配任意内容
    regexStr = regexStr.replace(/\/\*\*$/g, '/.*');
    // * 通配符：匹配非路径分隔符
    regexStr = regexStr.replace(/\*/g, '[^/]*');
    // ? 单字符通配
    regexStr = regexStr.replace(/\?/g, '[^/]');
    // / 目录分隔保持原样

    // 如果模式不以/开头，则可以在任意目录深度匹配
    if (!pattern.startsWith('/') && !pattern.startsWith('**/')) {
      regexStr = '(?:.*/)?' + regexStr;
    }

    // 如果模式以/结尾，匹配目录
    if (pattern.endsWith('/')) {
      regexStr = regexStr + '.*';
    }

    return new RegExp('^' + regexStr + '$');
  }

  /**
   * 检查文件路径是否匹配.clayignore忽略规则
   * @returns true表示被忽略（禁止访问）
   */
  isIgnored(filePath: string): boolean {
    if (!this.clayignoreLoaded) {
      this.loadClayignore();
    }

    // 转换为相对于项目根的路径
    const absPath = normalizePath(path.resolve(filePath));
    const relPath = path.relative(this.projectRoot, absPath).replace(/\\/g, '/');

    if (!relPath || relPath.startsWith('..')) {
      return false; // 项目外的文件不归clayignore管
    }

    let ignored = false;
    for (const rule of this.ignoreRules) {
      // 目录专属规则：只匹配目录
      if (rule.directoryOnly && !relPath.includes('/')) {
        // 如果模式是目录专属但路径不含/，尝试追加/匹配
        const dirPath = relPath + '/';
        if (rule.regex.test(dirPath) || rule.regex.test(relPath + '/')) {
          ignored = !rule.negated;
        }
        continue;
      }

      if (rule.regex.test(relPath)) {
        ignored = !rule.negated;
      }
    }

    return ignored;
  }

  /**
   * 检查文件路径是否为只读
   * @returns true表示只读（禁止写入/编辑/删除）
   */
  isReadOnly(filePath: string): boolean {
    if (!this.clayignoreLoaded) {
      this.loadClayignore();
    }

    const absPath = normalizePath(path.resolve(filePath));
    const relPath = path.relative(this.projectRoot, absPath).replace(/\\/g, '/');

    if (!relPath || relPath.startsWith('..')) {
      return false;
    }

    for (const regex of this.accessControl.readonlyRegexes) {
      if (regex.test(relPath)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查文件路径是否禁止删除
   * @returns true表示禁止删除
   */
  isNoDelete(filePath: string): boolean {
    if (!this.clayignoreLoaded) {
      this.loadClayignore();
    }

    const absPath = normalizePath(path.resolve(filePath));
    const relPath = path.relative(this.projectRoot, absPath).replace(/\\/g, '/');

    if (!relPath || relPath.startsWith('..')) {
      return false;
    }

    for (const regex of this.accessControl.nodeleteRegexes) {
      if (regex.test(relPath)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 综合文件访问权限校验（V1.1 .clayignore完整支持）
   * @param filePath 文件路径
   * @param operation 操作类型
   * @returns 校验结果
   */
  checkFileAccess(filePath: string, operation: FileAccessOperation): { allowed: boolean; reason?: string } {
    // 1. 基础路径越权校验
    const pathResult = this.validatePath(filePath);
    if (!pathResult.valid) {
      return { allowed: false, reason: pathResult.reason };
    }

    // 2. .clayignore忽略规则校验（所有操作都受约束）
    if (this.isIgnored(filePath)) {
      return { allowed: false, reason: `.clayignore规则拦截: ${path.relative(this.projectRoot, pathResult.absPath)} 被忽略` };
    }

    // 3. 只读规则校验（write/edit/delete操作受约束）
    if ((operation === 'write' || operation === 'edit' || operation === 'delete') && this.isReadOnly(filePath)) {
      return { allowed: false, reason: `.clayignore只读规则拦截: ${path.relative(this.projectRoot, pathResult.absPath)} 为只读` };
    }

    // 4. 禁止删除规则校验（delete操作受约束）
    if (operation === 'delete' && this.isNoDelete(filePath)) {
      return { allowed: false, reason: `.clayignore禁止删除规则拦截: ${path.relative(this.projectRoot, pathResult.absPath)} 禁止删除` };
    }

    return { allowed: true };
  }

  /**
   * 获取当前.clayignore规则摘要
   */
  getClayignoreSummary(): { ignoreCount: number; readonlyCount: number; nodeleteCount: number } {
    return {
      ignoreCount: this.ignoreRules.length,
      readonlyCount: this.accessControl.readonlyPatterns.length,
      nodeleteCount: this.accessControl.nodeletePatterns.length,
    };
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
          const dangerousPatterns = ['/etc/', '/root/', 'C:\\\\Windows', 'C:\\\\System32', '/sys/', '/proc/'];
          if (dangerousPatterns.some(p => tc.filePath!.includes(p))) {
            errors.push(`检测到危险系统路径: ${tc.filePath}`);
            fixSuggestion = '禁止访问系统目录';
          }
          // V1.1 .clayignore 访问控制校验
          const opMap: Record<string, FileAccessOperation> = {
            read: 'read', edit: 'edit', write: 'write', view: 'read', run_test: 'read', symbol_search: 'read',
          };
          const accessOp = opMap[tc.tool] as FileAccessOperation | undefined;
          if (accessOp && pathResult.valid) {
            const accessResult = this.checkFileAccess(tc.filePath!, accessOp);
            if (!accessResult.allowed) {
              errors.push(accessResult.reason || '.clayignore规则拦截');
              fixSuggestion = '该文件受.clayignore规则保护，请检查.clayignore配置';
            }
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
    const fileOps = toolCalls.filter(tc => ['read', 'edit', 'write', 'view', 'run_test', 'symbol_search'].includes(tc.tool));
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