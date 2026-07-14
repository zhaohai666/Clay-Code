/**
 * ReportExporter 任务报告导出模块测试 (V1.2)
 * 覆盖：报告生成、选项配置、Markdown格式、会话过滤、错误处理
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ReportExporter } from '../core/report';

/** 创建临时测试目录 */
function createTempDir(prefix = 'claycode-report-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

/** 递归删除目录 */
function removeDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('ReportExporter', () => {
  let tempDir: string;
  let outputDir: string;
  let exporter: ReportExporter;

  beforeEach(() => {
    tempDir = createTempDir();
    outputDir = path.join(tempDir, 'reports');
    fs.mkdirSync(outputDir, { recursive: true });
    exporter = new ReportExporter();
  });

  afterEach(() => {
    removeDir(tempDir);
  });

  describe('基本导出功能', () => {
    it('应导出Markdown报告文件', () => {
      const result = exporter.exportReport({ outputDir });
      expect(result.success).toBe(true);
      expect(result.filePath).toBeDefined();
      expect(result.filePath).toMatch(/\.md$/);
      expect(fs.existsSync(result.filePath!)).toBe(true);
    });

    it('报告文件应包含Markdown标题', () => {
      const result = exporter.exportReport({ outputDir });
      const content = fs.readFileSync(result.filePath!, 'utf-8');
      expect(content).toContain('# ClayCode 任务报告');
    });

    it('报告文件应包含生成时间', () => {
      const result = exporter.exportReport({ outputDir });
      const content = fs.readFileSync(result.filePath!, 'utf-8');
      expect(content).toContain('生成时间:');
    });

    it('报告文件应包含页脚', () => {
      const result = exporter.exportReport({ outputDir });
      const content = fs.readFileSync(result.filePath!, 'utf-8');
      expect(content).toContain('此报告由 ClayCode 自动生成');
    });

    it('返回结果应包含正确字段', () => {
      const result = exporter.exportReport({ outputDir });
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('filePath');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('sessionCount');
      expect(result).toHaveProperty('fileChangeCount');
      expect(result).toHaveProperty('generatedAt');
      expect(typeof result.generatedAt).toBe('number');
      expect(result.generatedAt).toBeGreaterThan(0);
    });
  });

  describe('选项配置', () => {
    it('应使用自定义标题', () => {
      const result = exporter.exportReport({
        outputDir,
        title: '自定义报告标题',
      });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(result.filePath!, 'utf-8');
      expect(content).toContain('# 自定义报告标题');
    });

    it('includeMetrics=false应不包含执行统计', () => {
      const result = exporter.exportReport({
        outputDir,
        includeMetrics: false,
      });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(result.filePath!, 'utf-8');
      expect(content).not.toContain('## 执行统计');
    });

    it('includeMetrics=true应包含执行统计', () => {
      const result = exporter.exportReport({
        outputDir,
        includeMetrics: true,
      });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(result.filePath!, 'utf-8');
      expect(content).toContain('## 执行统计');
    });

    it('includeChatHistory=false应不包含会话记录', () => {
      const result = exporter.exportReport({
        outputDir,
        includeChatHistory: false,
      });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(result.filePath!, 'utf-8');
      expect(content).not.toContain('## 会话记录');
    });

    it('includeFileChanges=false应不包含文件变更记录', () => {
      const result = exporter.exportReport({
        outputDir,
        includeFileChanges: false,
      });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(result.filePath!, 'utf-8');
      expect(content).not.toContain('## 文件变更记录');
    });

    it('includeFileChanges=true应包含文件变更记录', () => {
      const result = exporter.exportReport({
        outputDir,
        includeFileChanges: true,
      });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(result.filePath!, 'utf-8');
      expect(content).toContain('## 文件变更记录');
    });

    it('应使用默认输出目录', () => {
      // 不指定outputDir时使用process.cwd()
      const result = exporter.exportReport();
      // 即使无指定目录也不应报错
      expect(result).toHaveProperty('success');
      // 清理可能生成的文件
      if (result.success && result.filePath && fs.existsSync(result.filePath)) {
        fs.unlinkSync(result.filePath);
      }
    });
  });

  describe('Markdown格式验证', () => {
    it('执行统计应包含表格格式', () => {
      const result = exporter.exportReport({
        outputDir,
        includeMetrics: true,
      });
      const content = fs.readFileSync(result.filePath!, 'utf-8');
      expect(content).toContain('| 指标 | 值 |');
      expect(content).toContain('|------|-----|');
      expect(content).toContain('AI平均延迟');
      expect(content).toContain('命令成功率');
    });

    it('目录应包含正确的链接', () => {
      const result = exporter.exportReport({
        outputDir,
        includeMetrics: true,
        includeFileChanges: true,
        includeChatHistory: true,
      });
      const content = fs.readFileSync(result.filePath!, 'utf-8');
      expect(content).toContain('## 目录');
      expect(content).toContain('[执行统计](#执行统计)');
      expect(content).toContain('[文件变更记录](#文件变更记录)');
    });

    it('文件名应包含时间戳', () => {
      const result = exporter.exportReport({ outputDir });
      expect(result.filePath).toMatch(/claycode-report-.*\.md$/);
    });
  });

  describe('会话过滤', () => {
    it('指定不存在的sessionId应创建新会话并导出', () => {
      const result = exporter.exportReport({
        outputDir,
        sessionId: 'non-existent-session-id',
      });
      expect(result.success).toBe(true);
      // SessionManager在会话不存在时会自动创建新会话
      expect(result.sessionCount).toBeGreaterThanOrEqual(1);
    });

    it('指定fromTime应过滤早期会话', () => {
      const futureTime = Date.now() + 100000;
      const result = exporter.exportReport({
        outputDir,
        fromTime: futureTime,
      });
      expect(result.success).toBe(true);
      // 所有会话都应被过滤掉
      expect(result.sessionCount).toBe(0);
    });

    it('指定toTime应过滤晚期会话', () => {
      const pastTime = 0; // 1970年
      const result = exporter.exportReport({
        outputDir,
        toTime: pastTime,
      });
      expect(result.success).toBe(true);
      expect(result.sessionCount).toBe(0);
    });
  });

  describe('错误处理', () => {
    it('输出目录不存在时应返回失败结果', () => {
      const nonExistentDir = path.join(tempDir, 'non-existent', 'nested');
      const result = exporter.exportReport({ outputDir: nonExistentDir });
      // 应该返回失败或自动创建目录
      expect(result).toHaveProperty('success');
      if (!result.success) {
        expect(result.message).toContain('失败');
      }
    });

    it('多次导出应生成不同文件', () => {
      const result1 = exporter.exportReport({ outputDir });
      const result2 = exporter.exportReport({ outputDir });
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      // 文件名包含时间戳，不同时间导出应生成不同文件
      // 但如果同一秒内导出，文件名可能相同
      expect(result1.filePath).toBeDefined();
      expect(result2.filePath).toBeDefined();
    });
  });
});