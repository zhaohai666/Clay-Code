import { describe, it, expect } from 'vitest';
import {
  getPlatform, isWindows, normalizeNewlines, normalizePath,
  resolveHome, ensureDir, getNewLine,
  cleanStreamOutput, extractCodeBlocks, extractInlineJSON,
  safeParseJSON, detectCaptcha, StreamBuffer,
  Logger,
} from '../utils';

// ---- 平台工具 ----
describe('平台工具', () => {
  describe('getPlatform', () => {
    it('应返回macos/linux/windows之一', () => {
      const platform = getPlatform();
      expect(['macos', 'linux', 'windows']).toContain(platform);
    });
  });

  describe('isWindows', () => {
    it('应返回布尔值', () => {
      const result = isWindows();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('normalizeNewlines', () => {
    it('应将\\r\\n转为\\n', () => {
      expect(normalizeNewlines('hello\r\nworld')).toBe('hello\nworld');
    });

    it('应将\\r转为\\n', () => {
      expect(normalizeNewlines('hello\rworld')).toBe('hello\nworld');
    });

    it('无换行符应不变', () => {
      expect(normalizeNewlines('hello world')).toBe('hello world');
    });

    it('混合换行符应统一为\\n', () => {
      expect(normalizeNewlines('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    });
  });

  describe('normalizePath', () => {
    it('非Windows应不变', () => {
      // 在macOS/linux上测试
      if (!isWindows()) {
        expect(normalizePath('/usr/local/bin')).toBe('/usr/local/bin');
      }
    });

    it('空字符串应返回空', () => {
      expect(normalizePath('')).toBe('');
    });
  });

  describe('resolveHome', () => {
    it('~开头应替换为主目录', () => {
      const result = resolveHome('~/Documents');
      expect(result).not.toContain('~');
      expect(result).toContain('Documents');
    });

    it('非~开头应不变', () => {
      expect(resolveHome('/usr/local')).toBe('/usr/local');
    });

    it('~单独应返回主目录', () => {
      const result = resolveHome('~');
      expect(result).not.toContain('~');
    });
  });

  describe('ensureDir', () => {
    it('应创建不存在的目录', () => {
      const { mkdirSync, existsSync, rmSync } = require('fs');
      const { join } = require('path');
      const { tmpdir } = require('os');
      const testDir = join(tmpdir(), `claycode-ensureDir-test-${Date.now()}`);
      try {
        ensureDir(testDir);
        expect(existsSync(testDir)).toBe(true);
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  describe('getNewLine', () => {
    it('应返回换行符字符串', () => {
      const nl = getNewLine();
      expect(['\n', '\r\n']).toContain(nl);
    });
  });
});

// ---- 流处理工具 ----
describe('流处理工具', () => {
  describe('cleanStreamOutput', () => {
    it('应去除ANSI转义字符', () => {
      const input = '\x1b[32mHello\x1b[0m World';
      expect(cleanStreamOutput(input)).toBe('Hello World');
    });

    it('应去除进度条残留', () => {
      const input = 'start\r===   \rend';
      const cleaned = cleanStreamOutput(input);
      expect(cleaned).not.toContain('\r');
    });

    it('应统一换行符', () => {
      const input = 'line1\r\nline2\rline3';
      const cleaned = cleanStreamOutput(input);
      expect(cleaned).not.toContain('\r');
    });

    it('应去除多余空行', () => {
      const input = 'a\n\n\n\nb';
      const cleaned = cleanStreamOutput(input);
      expect(cleaned).not.toMatch(/\n{3,}/);
    });

    it('应去除首尾空白', () => {
      const input = '  \n  hello  \n  ';
      expect(cleanStreamOutput(input)).toBe('hello');
    });
  });

  describe('extractCodeBlocks', () => {
    it('应提取JSON代码块', () => {
      const text = '结果如下：\n```json\n{"tool": "read"}\n```\n请执行。';
      const blocks = extractCodeBlocks(text);
      expect(blocks.length).toBe(1);
      expect(blocks[0]).toBe('{"tool": "read"}');
    });

    it('应提取通用代码块(无JSON代码块时)', () => {
      const text = '```javascript\nconsole.log("hi");\n```';
      const blocks = extractCodeBlocks(text);
      expect(blocks.length).toBe(1);
      expect(blocks[0]).toContain('console.log');
    });

    it('无代码块应返回空数组', () => {
      const blocks = extractCodeBlocks('纯文本，无代码块');
      expect(blocks).toEqual([]);
    });

    it('应提取多个JSON代码块', () => {
      const text = '```json\n{"a": 1}\n```\n中间文本\n```json\n{"b": 2}\n```';
      const blocks = extractCodeBlocks(text);
      expect(blocks.length).toBe(2);
    });
  });

  describe('extractInlineJSON', () => {
    it('应提取包含tool字段的JSON', () => {
      const text = '执行 { "tool": "bash", "command": "ls" } 命令';
      const results = extractInlineJSON(text);
      expect(results.length).toBe(1);
      expect(results[0]).toContain('"tool"');
    });

    it('无匹配应返回空数组', () => {
      const results = extractInlineJSON('普通文本');
      expect(results).toEqual([]);
    });
  });

  describe('safeParseJSON', () => {
    it('应解析有效JSON', () => {
      expect(safeParseJSON('{"a":1}')).toEqual({ a: 1 });
    });

    it('应解析数组JSON', () => {
      expect(safeParseJSON('[1,2,3]')).toEqual([1, 2, 3]);
    });

    it('无效JSON应返回null', () => {
      expect(safeParseJSON('not json')).toBeNull();
    });

    it('空字符串应返回null', () => {
      expect(safeParseJSON('')).toBeNull();
    });
  });

  describe('detectCaptcha', () => {
    it('应检测captcha关键词', () => {
      expect(detectCaptcha('请输入captcha验证码')).toBe(true);
    });

    it('应检测验证码关键词', () => {
      expect(detectCaptcha('请完成人机验证')).toBe(true);
    });

    it('应检测cloudflare关键词', () => {
      expect(detectCaptcha('Cloudflare challenge page')).toBe(true);
    });

    it('正常文本应返回false', () => {
      expect(detectCaptcha('欢迎使用AI助手')).toBe(false);
    });

    it('应忽略大小写', () => {
      expect(detectCaptcha('CAPTCHA REQUIRED')).toBe(true);
    });
  });

  describe('StreamBuffer', () => {
    it('应追加和获取内容', () => {
      const buf = new StreamBuffer();
      buf.append('hello');
      buf.append(' world');
      expect(buf.getContent()).toBe('hello world');
    });

    it('应清空缓冲区', () => {
      const buf = new StreamBuffer();
      buf.append('content');
      buf.clear();
      expect(buf.getContent()).toBe('');
    });

    it('应检测完整代码块', () => {
      const buf = new StreamBuffer();
      expect(buf.hasCompleteCodeBlock()).toBe(false);
      buf.append('```json\n{"tool":"read"}\n```');
      expect(buf.hasCompleteCodeBlock()).toBe(true);
    });

    it('不完整代码块应返回false', () => {
      const buf = new StreamBuffer();
      buf.append('```json\n{"tool":"read"}');
      expect(buf.hasCompleteCodeBlock()).toBe(false);
    });

    it('tryExtractToolText应提取工具调用文本', () => {
      const buf = new StreamBuffer();
      buf.append('```json\n{"tool": "read", "filePath": "test.ts"}\n```');
      const result = buf.tryExtractToolText();
      expect(result).not.toBeNull();
      expect(result).toContain('tool');
    });

    it('tryExtractToolText无完整块应返回null', () => {
      const buf = new StreamBuffer();
      buf.append('不完整的内容');
      expect(buf.tryExtractToolText()).toBeNull();
    });
  });
});

// ---- Logger ----
describe('Logger', () => {
  it('应创建Logger实例', () => {
    const log = new Logger('debug');
    expect(log.getLevel()).toBe('debug');
  });

  it('应设置日志级别', () => {
    const log = new Logger('debug');
    log.setLevel('warn');
    expect(log.getLevel()).toBe('warn');
  });

  it('debug级别应能记录所有日志', () => {
    const log = new Logger('debug');
    // 不应抛出异常
    expect(() => {
      log.debug('debug msg');
      log.info('info msg');
      log.warn('warn msg');
      log.error('error msg');
    }).not.toThrow();
  });

  it('error级别应只记录error', () => {
    const log = new Logger('error');
    expect(() => {
      log.debug('should be filtered');
      log.info('should be filtered');
      log.warn('should be filtered');
      log.error('should show');
    }).not.toThrow();
  });

  it('init和close不应抛出异常', () => {
    const log = new Logger('info');
    expect(() => {
      log.init();
      log.info('test');
      log.close();
    }).not.toThrow();
  });
});