/**
 * ClayCode V1.2 批量导出Markdown报告模块
 * 导出会话记录、文件变更记录、执行统计为Markdown报告
 * README 10.2第3项：批量导出任务修改记录Markdown报告
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ReportExportOptions, ReportExportResult,
  SessionState, FileChangeRecord, MetricsData,
} from '../types';
import { ConfigManager } from './config';
import { SessionManager } from './session';
import { MetricsCollector } from './metrics';
import { logger } from '../utils';

/** 默认报告标题 */
const DEFAULT_TITLE = 'ClayCode 任务报告';
/** 默认输出目录 */
const DEFAULT_OUTPUT_DIR = process.cwd();

/**
 * 报告导出器
 * 将会话记录、文件变更、执行统计导出为Markdown格式报告
 */
export class ReportExporter {
  private configManager: ConfigManager;
  private sessionManager: SessionManager;
  private metricsCollector: MetricsCollector;

  constructor() {
    this.configManager = new ConfigManager();
    this.sessionManager = new SessionManager(this.configManager.getSessionDir());
    this.metricsCollector = new MetricsCollector({ enabled: false });
  }

  /**
   * 导出Markdown报告
   */
  exportReport(options?: ReportExportOptions): ReportExportResult {
    const opts = this.normalizeOptions(options);
    const timestamp = Date.now();
    const dateStr = this.formatDate(timestamp);

    try {
      // 收集数据
      const sessions = this.collectSessions(opts);
      const metrics = this.metricsCollector.getSnapshot();

      // 生成Markdown
      const markdown = this.generateMarkdown({
        title: opts.title,
        dateStr,
        sessions,
        metrics,
        options: opts,
      });

      // 写入文件
      const fileName = `claycode-report-${dateStr.replace(/[ :]/g, '-').replace(/\//g, '')}.md`;
      const filePath = path.join(opts.outputDir, fileName);
      // 确保输出目录存在
      if (!fs.existsSync(opts.outputDir)) {
        fs.mkdirSync(opts.outputDir, { recursive: true });
      }
      fs.writeFileSync(filePath, markdown, 'utf-8');

      // 统计文件变更数
      const fileChangeCount = sessions.reduce((sum, s) => {
        return sum + (s.fileChanges ? s.fileChanges.length : 0);
      }, 0);

      logger.info(`报告已导出: ${filePath}`);

      return {
        success: true,
        filePath,
        message: `报告已导出至 ${filePath}`,
        sessionCount: sessions.length,
        fileChangeCount,
        generatedAt: timestamp,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`报告导出失败: ${message}`);
      return {
        success: false,
        message: `报告导出失败: ${message}`,
        sessionCount: 0,
        fileChangeCount: 0,
        generatedAt: timestamp,
      };
    }
  }

  /**
   * 规范化选项
   */
  private normalizeOptions(options?: ReportExportOptions): Required<Pick<ReportExportOptions, 'outputDir' | 'title' | 'includeChatHistory' | 'includeFileChanges' | 'includeMetrics'>> & ReportExportOptions {
    return {
      outputDir: options?.outputDir ?? DEFAULT_OUTPUT_DIR,
      title: options?.title ?? DEFAULT_TITLE,
      includeChatHistory: options?.includeChatHistory ?? true,
      includeFileChanges: options?.includeFileChanges ?? true,
      includeMetrics: options?.includeMetrics ?? true,
      sessionId: options?.sessionId,
      fromTime: options?.fromTime,
      toTime: options?.toTime,
    };
  }

  /**
   * 收集会话数据
   */
  private collectSessions(opts: Required<Pick<ReportExportOptions, 'outputDir' | 'title' | 'includeChatHistory' | 'includeFileChanges' | 'includeMetrics'>> & ReportExportOptions): SessionState[] {
    let sessions: SessionState[];

    if (opts.sessionId) {
      // 指定会话
      const session = this.sessionManager.getSession(opts.sessionId);
      sessions = session ? [session] : [];
    } else {
      // 所有会话
      sessions = this.sessionManager.listSessions();
    }

    // 时间范围过滤
    if (opts.fromTime) {
      sessions = sessions.filter(s => s.lastActiveAt >= opts.fromTime!);
    }
    if (opts.toTime) {
      sessions = sessions.filter(s => s.lastActiveAt <= opts.toTime!);
    }

    return sessions;
  }

  /**
   * 生成Markdown内容
   */
  private generateMarkdown(params: {
    title: string;
    dateStr: string;
    sessions: SessionState[];
    metrics: MetricsData;
    options: Required<Pick<ReportExportOptions, 'outputDir' | 'title' | 'includeChatHistory' | 'includeFileChanges' | 'includeMetrics'>> & ReportExportOptions;
  }): string {
    const { title, dateStr, sessions, metrics, options: opts } = params;
    const lines: string[] = [];

    // 标题
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(`> 生成时间: ${dateStr}`);
    lines.push(`> 会话数量: ${sessions.length}`);
    lines.push('');

    // 目录
    lines.push('## 目录');
    lines.push('');
    if (opts.includeMetrics) lines.push('- [执行统计](#执行统计)');
    if (opts.includeChatHistory && sessions.length > 0) lines.push('- [会话记录](#会话记录)');
    if (opts.includeFileChanges) lines.push('- [文件变更记录](#文件变更记录)');
    lines.push('');

    // 执行统计
    if (opts.includeMetrics) {
      lines.push('## 执行统计');
      lines.push('');
      lines.push('| 指标 | 值 |');
      lines.push('|------|-----|');
      lines.push(`| AI平均延迟 | ${metrics.aiLatencyAvg.toFixed(0)}ms |`);
      lines.push(`| AI P95延迟 | ${metrics.aiLatencyP95.toFixed(0)}ms |`);
      lines.push(`| 内存使用 | ${metrics.memoryUsageMB.toFixed(1)}MB |`);
      lines.push(`| 文件读取次数 | ${metrics.fileOpsRead} |`);
      lines.push(`| 文件写入次数 | ${metrics.fileOpsWrite} |`);
      lines.push(`| 文件编辑次数 | ${metrics.fileOpsEdit} |`);
      lines.push(`| Bash命令次数 | ${metrics.fileOpsBash} |`);
      lines.push(`| Git操作次数 | ${metrics.fileOpsGit} |`);
      lines.push(`| 命令成功率 | ${(metrics.commandSuccessRate * 100).toFixed(1)}% |`);
      lines.push(`| 浏览器重启次数 | ${metrics.browserRestarts} |`);
      lines.push('');
    }

    // 会话记录
    if (opts.includeChatHistory && sessions.length > 0) {
      lines.push('## 会话记录');
      lines.push('');

      for (const session of sessions) {
        lines.push(`### ${session.sessionName} (${session.sessionId})`);
        lines.push('');
        lines.push(`- 适配器: ${session.adapter}`);
        lines.push(`- 创建时间: ${this.formatDate(session.createdAt)}`);
        lines.push(`- 最后活跃: ${this.formatDate(session.lastActiveAt)}`);
        lines.push(`- 消息数量: ${session.messages.length}`);
        lines.push('');

        if (session.messages.length > 0) {
          lines.push('#### 对话内容');
          lines.push('');
          for (const msg of session.messages) {
            const roleLabel = msg.role === 'user' ? '👤 用户' : msg.role === 'ai' ? '🤖 AI' : '📋 系统';
            lines.push(`**${roleLabel}**: ${msg.content}`);
            lines.push('');
          }
        }
      }
    }

    // 文件变更记录
    if (opts.includeFileChanges) {
      lines.push('## 文件变更记录');
      lines.push('');

      let totalChanges = 0;
      for (const session of sessions) {
        if (session.fileChanges && session.fileChanges.length > 0) {
          lines.push(`### ${session.sessionName}`);
          lines.push('');
          lines.push('| 文件路径 | 变更类型 | 时间 |');
          lines.push('|----------|----------|------|');
          for (const fc of session.fileChanges) {
            const typeLabel = fc.changeType === 'created' ? '✅ 新增' : fc.changeType === 'modified' ? '📝 修改' : '❌ 删除';
            lines.push(`| ${fc.filePath} | ${typeLabel} | ${this.formatDate(fc.timestamp)} |`);
            totalChanges++;
          }
          lines.push('');
        }
      }

      if (totalChanges === 0) {
        lines.push('> 无文件变更记录');
        lines.push('');
      } else {
        lines.push(`> 共计 ${totalChanges} 个文件变更`);
        lines.push('');
      }
    }

    // 页脚
    lines.push('---');
    lines.push('');
    lines.push('*此报告由 ClayCode 自动生成*');

    return lines.join('\n');
  }

  /**
   * 格式化时间戳
   */
  private formatDate(timestamp: number): string {
    const d = new Date(timestamp);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hour = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const sec = String(d.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${min}:${sec}`;
  }
}