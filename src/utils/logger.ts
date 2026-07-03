/**
 * ClayCode 统一日志模块
 * winston分级滚动日志(Debug/Info/Warn/Error)
 * 日志目录：~/.claycode/logs/
 * 按大小切割，默认最大10MB，保留5个文件
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

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

/** 日志目录 */
const LOG_DIR = path.join(os.homedir(), '.claycode', 'logs');
/** 日志文件最大大小(10MB) */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
/** 最大日志文件数(按日期保留天数) */
const MAX_FILES = 5;

/** 获取当前日期字符串 YYYYMMDD */
function getDateString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 获取当前日志文件路径（按日期命名） */
function getLogFilePath(date: Date = new Date()): string {
  return path.join(LOG_DIR, `claycode-${getDateString(date)}.log`);
}

/** 清理过期日志文件（超过MAX_FILES天） */
function cleanOldLogFiles(): void {
  if (!fs.existsSync(LOG_DIR)) return;
  const files = fs.readdirSync(LOG_DIR);
  const logFiles = files
    .filter(f => f.startsWith('claycode-') && f.endsWith('.log'))
    .sort()
    .reverse(); // 最新的在前

  // 保留最近MAX_FILES天的日志
  const toDelete = logFiles.slice(MAX_FILES);
  for (const f of toDelete) {
    try {
      fs.unlinkSync(path.join(LOG_DIR, f));
    } catch {
      // 忽略删除失败
    }
  }
}

export class Logger {
  private minLevel: LogLevel;
  private fileStream: fs.WriteStream | null = null;
  private currentFileSize: number = 0;
  private currentDate: string = '';

  constructor(minLevel: LogLevel = 'info') {
    this.minLevel = minLevel;
  }

  /** 初始化日志文件流 */
  init(): void {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    cleanOldLogFiles();
    this.openStream();
  }

  /** 打开日志流 */
  private openStream(): void {
    const logFile = getLogFilePath();
    this.currentDate = getDateString();

    // 检查现有日志文件大小，决定是否需要轮转
    if (fs.existsSync(logFile)) {
      const stat = fs.statSync(logFile);
      this.currentFileSize = stat.size;
      if (this.currentFileSize >= MAX_FILE_SIZE) {
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
      // 跨日：关闭旧流，打开新日期的日志文件
      if (this.fileStream) {
        this.fileStream.end();
        this.fileStream = null;
      }
      cleanOldLogFiles();
      this.openStream();
    }
  }

  /** 日志轮转（大小切割） */
  private rotateLog(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }

    const logFile = getLogFilePath();

    // 当前日志 → .1 备份（同日期内按大小切割）
    if (fs.existsSync(logFile)) {
      const backupFile = `${logFile}.1`;
      if (fs.existsSync(backupFile)) {
        fs.unlinkSync(backupFile);
      }
      fs.renameSync(logFile, backupFile);
    }

    this.currentFileSize = 0;
  }

  /** 关闭日志流 */
  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
  }

  /** 设置日志级别 */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /** 获取当前日志级别 */
  getLevel(): LogLevel {
    return this.minLevel;
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
      // 检查日期变更
      this.checkDateChange();

      const line = `${prefix} ${fullMsg}\n`;
      this.fileStream.write(line);
      this.currentFileSize += Buffer.byteLength(line, 'utf8');

      // 检查是否需要轮转
      if (this.currentFileSize >= MAX_FILE_SIZE) {
        this.rotateLog();
        this.openStream();
      }
    }
  }
}

/** 全局日志单例 */
export const logger = new Logger();