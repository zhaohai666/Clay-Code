/**
 * ClayCode 统一日志模块
 * 分级滚动日志(Debug/Info/Warn/Error)
 * 日志目录：~/.claycode/logs/
 * 按日期+大小切割，默认最大10MB，每日最多3个备份文件，保留7天
 * 支持旧备份gzip压缩
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as zlib from 'zlib';

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 终端颜色代码 */
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // 青色
  info: '\x1b[32m',  // 绿色
  warn: '\x1b[33m',  // 黄色
  error: '\x1b[31m', // 红色
};
const RESET = '\x1b[0m';

/** 日志配置 */
interface LogConfig {
  /** 日志目录 */
  logDir: string;
  /** 单个日志文件最大大小(字节) */
  maxFileSize: number;
  /** 每日最大备份文件数 */
  maxBackupsPerDay: number;
  /** 日志保留天数 */
  retainDays: number;
  /** 是否压缩旧备份 */
  compressBackups: boolean;
}

/** 默认日志配置 */
const DEFAULT_LOG_CONFIG: LogConfig = {
  logDir: path.join(os.homedir(), '.claycode', 'logs'),
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxBackupsPerDay: 3,
  retainDays: 7,
  compressBackups: true,
};

/** 获取当前日期字符串 YYYYMMDD */
function getDateString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 获取当前日志文件路径（按日期命名） */
function getLogFilePath(date: Date, logDir: string): string {
  return path.join(logDir, `claycode-${getDateString(date)}.log`);
}

export class Logger {
  private minLevel: LogLevel;
  private fileStream: fs.WriteStream | null = null;
  private currentFileSize: number = 0;
  private currentDate: string = '';
  private config: LogConfig;
  private initialized: boolean = false;

  constructor(minLevel: LogLevel = 'info', config?: Partial<LogConfig>) {
    this.minLevel = minLevel;
    this.config = { ...DEFAULT_LOG_CONFIG, ...config };
  }

  /** 初始化日志文件流 */
  init(): void {
    if (this.initialized) return;
    if (!fs.existsSync(this.config.logDir)) {
      fs.mkdirSync(this.config.logDir, { recursive: true });
    }
    this.cleanOldLogFiles();
    this.openStream();
    this.initialized = true;
  }

  /** 打开日志流 */
  private openStream(): void {
    const logFile = getLogFilePath(new Date(), this.config.logDir);
    this.currentDate = getDateString();

    // 检查现有日志文件大小，决定是否需要轮转
    if (fs.existsSync(logFile)) {
      const stat = fs.statSync(logFile);
      this.currentFileSize = stat.size;
      if (this.currentFileSize >= this.config.maxFileSize) {
        this.rotateLog();
      }
    } else {
      this.currentFileSize = 0;
    }
    this.fileStream = fs.createWriteStream(logFile, { flags: 'a' });
  }

  /** 检查日期是否变更，跨日自动切换新日志文件 */
  private checkDateChange(): void {
    const today = getDateString();
    if (this.currentDate !== today) {
      // 跨日：压缩旧备份文件，关闭旧流，打开新日期的日志文件
      if (this.config.compressBackups) {
        this.compressOldBackups(this.currentDate);
      }
      if (this.fileStream) {
        this.fileStream.end();
        this.fileStream = null;
      }
      this.cleanOldLogFiles();
      this.openStream();
    }
  }

  /**
   * 日志轮转（大小切割）
   * 支持多级备份：.log → .log.1 → .log.2 → ... → .log.N
   * 旧备份可选gzip压缩：.log.1.gz, .log.2.gz, ...
   */
  private rotateLog(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }

    const logFile = getLogFilePath(new Date(), this.config.logDir);
    const dateStr = this.currentDate;

    // 移位备份文件：.N → .N+1
    for (let i = this.config.maxBackupsPerDay - 1; i >= 1; i--) {
      const olderBackup = `${logFile}.${i}${this.config.compressBackups ? '.gz' : ''}`;
      const newerBackup = i === 1 ? logFile : `${logFile}.${i - 1}${this.config.compressBackups ? '.gz' : ''}`;

      if (fs.existsSync(olderBackup)) {
        // 超过最大备份数，删除最旧的
        if (i === this.config.maxBackupsPerDay - 1) {
          try { fs.unlinkSync(olderBackup); } catch { /* 忽略 */ }
          continue;
        }
      }
    }

    // 当前日志 → .1（压缩或直接重命名）
    if (fs.existsSync(logFile)) {
      if (this.config.compressBackups) {
        // 压缩当前日志到 .1.gz
        const backupGz = `${logFile}.1.gz`;
        try {
          const content = fs.readFileSync(logFile);
          const compressed = zlib.gzipSync(content);
          fs.writeFileSync(backupGz, compressed);
          fs.unlinkSync(logFile);
        } catch (err) {
          // 压缩失败，直接重命名
          const backupPlain = `${logFile}.1`;
          if (fs.existsSync(backupPlain)) { try { fs.unlinkSync(backupPlain); } catch { /* 忽略 */ } }
          fs.renameSync(logFile, backupPlain);
        }
      } else {
        // 直接重命名
        const backupFile = `${logFile}.1`;
        if (fs.existsSync(backupFile)) { try { fs.unlinkSync(backupFile); } catch { /* 忽略 */ } }
        fs.renameSync(logFile, backupFile);
      }
    }

    this.currentFileSize = 0;
  }

  /**
   * 压缩指定日期的旧备份文件
   */
  private compressOldBackups(dateStr: string): void {
    const logFile = path.join(this.config.logDir, `claycode-${dateStr}.log`);
    
    for (let i = 1; i <= this.config.maxBackupsPerDay; i++) {
      const plainBackup = `${logFile}.${i}`;
      const gzBackup = `${logFile}.${i}.gz`;
      
      // 如果有未压缩的备份，进行压缩
      if (fs.existsSync(plainBackup) && !fs.existsSync(gzBackup)) {
        try {
          const content = fs.readFileSync(plainBackup);
          const compressed = zlib.gzipSync(content);
          fs.writeFileSync(gzBackup, compressed);
          fs.unlinkSync(plainBackup);
        } catch {
          // 压缩失败，保留原文件
        }
      }
    }
  }

  /**
   * 清理过期日志文件（超过retainDays天）
   * 同时清理.log、.log.N、.log.N.gz文件
   */
  private cleanOldLogFiles(): void {
    if (!fs.existsSync(this.config.logDir)) return;
    const files = fs.readdirSync(this.config.logDir);
    const logFiles = files
      .filter(f => f.startsWith('claycode-') && (f.endsWith('.log') || f.endsWith('.gz') || /\.log\.\d+$/.test(f)))
      .sort()
      .reverse(); // 最新的在前

    // 计算截止日期
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retainDays);
    const cutoffStr = getDateString(cutoffDate);

    // 删除超过保留天数的日志
    for (const f of logFiles) {
      // 从文件名提取日期: claycode-YYYYMMDD.log 或 claycode-YYYYMMDD.log.1.gz
      const dateMatch = f.match(/claycode-(\d{8})/);
      if (dateMatch && dateMatch[1] < cutoffStr) {
        try {
          fs.unlinkSync(path.join(this.config.logDir, f));
        } catch {
          // 忽略删除失败
        }
      }
    }
  }

  /** 关闭日志流 */
  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
    this.initialized = false;
  }

  /** 设置日志级别 */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /** 获取当前日志级别 */
  getLevel(): LogLevel {
    return this.minLevel;
  }

  /**
   * 获取日志目录路径
   */
  getLogDir(): string {
    return this.config.logDir;
  }

  /**
   * 获取当前日志文件大小(字节)
   */
  getCurrentFileSize(): number {
    return this.currentFileSize;
  }

  /**
   * 列出所有日志文件
   */
  listLogFiles(): string[] {
    if (!fs.existsSync(this.config.logDir)) return [];
    return fs.readdirSync(this.config.logDir)
      .filter(f => f.startsWith('claycode-'))
      .sort()
      .reverse();
  }

  debug(msg: string, ...args: unknown[]): void {
    this.log('debug', msg, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    this.log('info', msg, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    this.log('warn', msg, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    this.log('error', msg, ...args);
  }

  /** 核心日志方法 */
  private log(level: LogLevel, msg: string, ...args: unknown[]): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    const fullMsg = args.length > 0 ? `${msg} ${args.map(String).join(' ')}` : msg;

    // 终端彩色输出
    const color = COLORS[level];
    console.log(`${color}${prefix}${RESET} ${fullMsg}`);

    // 文件持久化（无颜色）
    if (this.fileStream) {
      // 延迟初始化检查
      if (!this.initialized) {
        this.init();
      }

      // 检查日期变更
      this.checkDateChange();

      const line = `${prefix} ${fullMsg}\n`;
      this.fileStream.write(line);
      this.currentFileSize += Buffer.byteLength(line, 'utf8');

      // 检查是否需要轮转
      if (this.currentFileSize >= this.config.maxFileSize) {
        this.rotateLog();
        this.openStream();
      }
    }
  }
}

/** 全局日志单例 */
export const logger = new Logger();