/**
 * ClayCode 统一日志模块
 * 基于 winston 日志组件实现
 * 分级滚动日志(Debug/Info/Warn/Error)
 * 日志目录：~/.claycode/logs/
 * 按日期+大小切割，默认最大10MB，每日最多3个备份文件，保留7天
 * 支持旧备份gzip压缩
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** winston 自定义日志级别（数值越小优先级越高） */
const WINSTON_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
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

/**
 * 将 LogLevel 映射到 winston 级别字符串
 * winston npm levels: error=0, warn=1, info=2, verbose=3, debug=4, silly=5
 * 我们的级别: error=0, warn=1, info=2, debug=3
 */
function toWinstonLevel(level: LogLevel): string {
  return level;
}

/**
 * 从 winston 级别字符串映射回 LogLevel
 */
function fromWinstonLevel(level: string): LogLevel {
  if (level === 'error' || level === 'warn' || level === 'info' || level === 'debug') {
    return level as LogLevel;
  }
  // winston 内部级别映射到我们的级别
  if (level === 'silly' || level === 'verbose') return 'debug';
  return 'info';
}

export class Logger {
  private minLevel: LogLevel;
  private config: LogConfig;
  private initialized: boolean = false;
  private winstonLogger: winston.Logger | null = null;
  private dailyRotateTransport: DailyRotateFile | null = null;

  constructor(minLevel: LogLevel = 'info', config?: Partial<LogConfig>) {
    this.minLevel = minLevel;
    this.config = { ...DEFAULT_LOG_CONFIG, ...config };
  }

  /** 初始化日志（创建 winston logger 实例） */
  init(): void {
    if (this.initialized) return;

    if (!fs.existsSync(this.config.logDir)) {
      fs.mkdirSync(this.config.logDir, { recursive: true });
    }

    // 清理过期日志文件
    this.cleanOldLogFiles();

    // 创建 DailyRotateFile transport
    // 文件命名格式：claycode-YYYYMMDD.log
    // 超过 maxFileSize 时自动轮转，保留 maxBackupsPerDay 个备份
    this.dailyRotateTransport = new DailyRotateFile({
      dirname: this.config.logDir,
      filename: 'claycode-%DATE%.log',
      datePattern: 'YYYYMMDD',
      maxSize: `${this.config.maxFileSize / 1024 / 1024}m`, // 如 '10m'
      maxFiles: `${this.config.retainDays}d`, // 按天数保留
      zippedArchive: this.config.compressBackups,
      extension: '.log',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const extra = Object.keys(meta).length > 0 ? ' ' + Object.values(meta).join(' ') : '';
          return `[${timestamp}] [${level.toUpperCase()}] ${message}${extra}`;
        }),
      ),
    });

    // 创建 winston logger
    this.winstonLogger = winston.createLogger({
      levels: WINSTON_LEVELS,
      level: toWinstonLevel(this.minLevel),
      transports: [
        // 终端彩色输出
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
              const logLevel = fromWinstonLevel(level);
              const color = COLORS[logLevel] || '';
              const extra = Object.keys(meta).length > 0 ? ' ' + Object.values(meta).join(' ') : '';
              return `${color}[${timestamp}] [${level.toUpperCase()}]${RESET} ${message}${extra}`;
            }),
          ),
        }),
        // 文件持久化（日期+大小滚动）
        this.dailyRotateTransport,
      ],
    });

    this.initialized = true;
  }

  /**
   * 清理过期日志文件（超过retainDays天）
   * 同时清理 .log、.log.N、.log.N.gz、.gz 文件
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

  /** 关闭日志 */
  close(): void {
    if (this.winstonLogger) {
      this.winstonLogger.close();
      this.winstonLogger = null;
    }
    this.dailyRotateTransport = null;
    this.initialized = false;
  }

  /** 设置日志级别 */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
    if (this.winstonLogger) {
      this.winstonLogger.level = toWinstonLevel(level);
    }
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
   * DailyRotateFile 不直接暴露文件大小，通过文件系统获取
   */
  getCurrentFileSize(): number {
    const today = getDateString();
    const logFile = path.join(this.config.logDir, `claycode-${today}.log`);
    try {
      if (fs.existsSync(logFile)) {
        return fs.statSync(logFile).size;
      }
    } catch {
      // 忽略
    }
    return 0;
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
    // 延迟初始化
    if (!this.initialized) {
      this.init();
    }

    if (WINSTON_LEVELS[level] > WINSTON_LEVELS[this.minLevel]) {
      return;
    }

    // 将额外参数附加到消息中（兼容原有 API: logger.info('msg', arg1, arg2)）
    const fullMsg = args.length > 0 ? `${msg} ${args.map(String).join(' ')}` : msg;

    if (this.winstonLogger) {
      this.winstonLogger.log(toWinstonLevel(level), fullMsg);
    }
  }
}

/** 获取当前日期字符串 YYYYMMDD */
function getDateString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 全局日志单例 */
export const logger = new Logger();