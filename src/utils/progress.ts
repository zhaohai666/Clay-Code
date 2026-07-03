/**
 * ClayCode 终端可视化进度条模块
 * 支持实时进度条渲染、批量文件处理进度、Shell流式输出
 */

/** 进度条配置 */
export interface ProgressBarOptions {
  /** 总步骤数 */
  total: number;
  /** 进度条宽度（字符数），默认30 */
  width?: number;
  /** 进度条填充字符，默认'█' */
  fillChar?: string;
  /** 进度条空白字符，默认'░' */
  emptyChar?: string;
  /** 描述前缀 */
  prefix?: string;
  /** 是否显示百分比，默认true */
  showPercent?: boolean;
  /** 是否显示计数(如 3/10)，默认true */
  showCount?: boolean;
  /** 是否显示耗时，默认true */
  showElapsed?: boolean;
}

/** 终端颜色代码 */
const FMT = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

/**
 * 终端进度条
 * 支持AI请求进度、批量文件处理进度动态展示
 */
export class ProgressBar {
  private total: number;
  private current: number = 0;
  private width: number;
  private fillChar: string;
  private emptyChar: string;
  private prefix: string;
  private showPercent: boolean;
  private showCount: boolean;
  private showElapsed: boolean;
  private startTime: number;
  private lastRenderTime: number = 0;

  constructor(options: ProgressBarOptions) {
    this.total = options.total;
    this.width = options.width ?? 30;
    this.fillChar = options.fillChar ?? '█';
    this.emptyChar = options.emptyChar ?? '░';
    this.prefix = options.prefix ?? '';
    this.showPercent = options.showPercent ?? true;
    this.showCount = options.showCount ?? true;
    this.showElapsed = options.showElapsed ?? true;
    this.startTime = Date.now();
  }

  /** 更新进度 */
  update(current: number, prefix?: string): void {
    this.current = Math.min(current, this.total);
    if (prefix !== undefined) {
      this.prefix = prefix;
    }
    this.render();
  }

  /** 增加一步 */
  increment(prefix?: string): void {
    this.update(this.current + 1, prefix);
  }

  /** 完成进度条 */
  complete(prefix?: string): void {
    this.current = this.total;
    if (prefix !== undefined) {
      this.prefix = prefix;
    }
    this.render(true);
  }

  /** 渲染进度条 */
  private render(final: boolean = false): void {
    // 节流：非最终渲染时，至少间隔80ms
    const now = Date.now();
    if (!final && now - this.lastRenderTime < 80) return;
    this.lastRenderTime = now;

    const percent = this.total > 0 ? this.current / this.total : 0;
    const filledWidth = Math.round(this.width * percent);
    const emptyWidth = this.width - filledWidth;

    const bar = this.fillChar.repeat(filledWidth) + this.emptyChar.repeat(emptyWidth);
    const percentStr = this.showPercent ? ` ${FMT.bold}${(percent * 100).toFixed(1)}%${FMT.reset}` : '';
    const countStr = this.showCount ? ` ${FMT.gray}${this.current}/${this.total}${FMT.reset}` : '';
    const elapsedStr = this.showElapsed ? ` ${FMT.gray}${this.formatElapsed()}${FMT.reset}` : '';
    const prefixStr = this.prefix ? `${FMT.cyan}${this.prefix}${FMT.reset} ` : '';

    // 使用\r回到行首覆盖渲染
    const line = `\r${prefixStr}${FMT.green}[${bar}]${FMT.reset}${percentStr}${countStr}${elapsedStr}`;
    process.stdout.write(line);

    // 最终渲染换行
    if (final) {
      process.stdout.write('\n');
    }
  }

  /** 格式化耗时 */
  private formatElapsed(): string {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    if (elapsed < 60) return `${elapsed}s`;
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    return `${min}m${sec}s`;
  }
}

/**
 * 终端彩色输出工具
 * 成功绿色、报错红色、提示黄色区分
 */
export const terminal = {
  /** 成功消息（绿色） */
  success(msg: string): void {
    console.log(`${FMT.green}✅ ${msg}${FMT.reset}`);
  },

  /** 错误消息（红色） */
  error(msg: string): void {
    console.log(`${FMT.red}❌ ${msg}${FMT.reset}`);
  },

  /** 警告消息（黄色） */
  warn(msg: string): void {
    console.log(`${FMT.yellow}⚠️ ${msg}${FMT.reset}`);
  },

  /** 信息消息（青色） */
  info(msg: string): void {
    console.log(`${FMT.cyan}ℹ️ ${msg}${FMT.reset}`);
  },

  /** 流式输出Shell日志（逐行打印，灰色） */
  shellLine(line: string): void {
    process.stdout.write(`${FMT.gray}  │ ${line}${FMT.reset}\n`);
  },

  /** 步骤提示（带编号） */
  step(stepNum: number, total: number, msg: string): void {
    const prefix = `${FMT.cyan}[${stepNum}/${total}]${FMT.reset}`;
    console.log(`${prefix} ${msg}`);
  },

  /** 动态状态更新（覆盖当前行） */
  status(icon: string, msg: string): void {
    process.stdout.write(`\r${icon} ${msg}`);
  },

  /** 清除当前行 */
  clearLine(): void {
    process.stdout.write('\r\x1b[2K');
  },
};

/**
 * 创建批量文件处理进度条
 */
export function createFileProgressBar(totalFiles: number, operation: string = '处理文件'): ProgressBar {
  return new ProgressBar({
    total: totalFiles,
    prefix: operation,
    width: 25,
    showPercent: true,
    showCount: true,
    showElapsed: true,
  });
}

/**
 * 创建AI请求进度条（不确定时长的脉冲动画）
 */
export class AIPulseIndicator {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private prefix: string;
  private startTime: number;

  constructor(prefix: string = 'AI思考中') {
    this.prefix = prefix;
    this.startTime = Date.now();
  }

  /** 启动脉冲动画 */
  start(): void {
    this.startTime = Date.now();
    this.timer = setInterval(() => {
      const frame = this.frames[this.frameIndex % this.frames.length];
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      process.stdout.write(`\r${FMT.cyan}${frame} ${this.prefix}... ${FMT.gray}${elapsed}s${FMT.reset}   `);
      this.frameIndex++;
    }, 100);
  }

  /** 停止脉冲动画 */
  stop(finalMsg?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stdout.write('\r\x1b[2K');
    if (finalMsg) {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      console.log(`${FMT.green}✅ ${finalMsg} (${elapsed}s)${FMT.reset}`);
    }
  }
}