/**
 * ClayCode 流处理工具模块
 * 内存级输出流清洗：去除ANSI转义、进度条、广告提示、日志杂讯
 * 提取结构化JSON与代码块
 */

/** ANSI 转义字符正则 */
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/** JSON 代码块正则 ```json ... ``` */
const JSON_CODE_BLOCK_REGEX = /```json\s*\n([\s\S]*?)\n```/g;

/** 通用代码块正则 ```... ``` */
const CODE_BLOCK_REGEX = /```\w*\s*\n([\s\S]*?)\n```/g;

/** 行内 JSON 对象正则 */
const INLINE_JSON_REGEX = /\{[^{}]*"tool"[^{}]*\}/g;

/**
 * 清洗原始输出流
 * 1. 去除 ANSI 转义字符
 * 2. 去除进度条残留
 * 3. 统一换行符
 * 4. 去除多余空行
 */
export function cleanStreamOutput(raw: string): string {
  let cleaned = raw;
  // 去除 ANSI 转义字符
  cleaned = cleaned.replace(ANSI_REGEX, '');
  // 去除进度条残留（\r===  \r）
  cleaned = cleaned.replace(/\r[^\n]*\r/g, '');
  // 统一换行符
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 去除多余空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  // 去除首尾空白
  cleaned = cleaned.trim();
  return cleaned;
}

/**
 * 从清洗后的文本中提取代码块内容
 */
export function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;

  // 优先提取 JSON 代码块
  JSON_CODE_BLOCK_REGEX.lastIndex = 0;
  while ((match = JSON_CODE_BLOCK_REGEX.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }

  // 如果没有 JSON 代码块，提取所有代码块
  if (blocks.length === 0) {
    CODE_BLOCK_REGEX.lastIndex = 0;
    while ((match = CODE_BLOCK_REGEX.exec(text)) !== null) {
      blocks.push(match[1].trim());
    }
  }

  return blocks;
}

/**
 * 从文本中提取行内 JSON 对象
 */
export function extractInlineJSON(text: string): string[] {
  const results: string[] = [];
  INLINE_JSON_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_JSON_REGEX.exec(text)) !== null) {
    results.push(match[0]);
  }
  return results;
}

/**
 * 安全的 JSON 解析
 */
export function safeParseJSON(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 检测文本中是否包含人机验证关键词
 */
export function detectCaptcha(text: string): boolean {
  const captchaKeywords = [
    'captcha',
    '验证码',
    '人机验证',
    'robot check',
    'are you human',
    'verify you are not a robot',
    'cloudflare',
    'challenge',
  ];
  const lower = text.toLowerCase();
  return captchaKeywords.some((kw) => lower.includes(kw));
}

/**
 * 流式文本增量缓冲区
 * 用于边接收AI响应边解析工具指令
 */
export class StreamBuffer {
  private buffer: string = '';

  /** 追加文本 */
  append(chunk: string): void {
    this.buffer += chunk;
  }

  /** 获取当前缓冲区内容 */
  getContent(): string {
    return this.buffer;
  }

  /** 清空缓冲区 */
  clear(): void {
    this.buffer = '';
  }

  /** 检查缓冲区是否包含完整的代码块 */
  hasCompleteCodeBlock(): boolean {
    const openCount = (this.buffer.match(/```/g) || []).length;
    return openCount >= 2 && openCount % 2 === 0;
  }

  /** 尝试从缓冲区提取工具调用文本 */
  tryExtractToolText(): string | null {
    if (!this.hasCompleteCodeBlock()) return null;
    const cleaned = cleanStreamOutput(this.buffer);
    const blocks = extractCodeBlocks(cleaned);
    return blocks.length > 0 ? blocks.join('\n') : null;
  }
}