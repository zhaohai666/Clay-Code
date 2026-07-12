/**
 * ClayCode 监控指标模块
 * Prometheus格式指标采集：AI延迟/内存/文件操作/命令成功率/浏览器重启
 * 支持HTTP端点暴露/metrics供Prometheus采集（README 8.4节）
 */

import * as os from 'os';
import * as http from 'http';
import { MetricsData } from '../types';
import { logger } from '../utils';

/** 指标采集器配置 */
export interface MetricsCollectorOptions {
  /** 采集间隔(毫秒)，默认30000 */
  collectInterval?: number;
  /** 是否启用，默认true */
  enabled?: boolean;
  /** Prometheus HTTP端点端口，默认9090，设为0则不启动 */
  httpPort?: number;
}

/**
 * Prometheus格式监控指标采集器
 * 采集AI延迟、内存使用、文件操作、命令成功率、浏览器重启次数
 */
export class MetricsCollector {
  private enabled: boolean;
  private collectInterval: number;
  private timer?: ReturnType<typeof setInterval>;
  private httpPort: number;
  private httpServer?: http.Server;

  // ---- 指标存储 ----
  private aiLatencies: number[] = [];
  private fileOperations = { read: 0, write: 0, edit: 0, bash: 0 };
  private commandResults = { success: 0, failed: 0 };
  private browserRestarts = 0;
  private startTime: number;
  private lastCollectTime: number;

  constructor(options?: MetricsCollectorOptions) {
    this.enabled = options?.enabled ?? true;
    this.collectInterval = options?.collectInterval ?? 30_000;
    this.httpPort = options?.httpPort ?? 0;
    this.startTime = Date.now();
    this.lastCollectTime = Date.now();

    if (this.enabled) {
      this.timer = setInterval(() => this.collect(), this.collectInterval);
    }
  }

  /**
   * 启动Prometheus HTTP端点
   * 暴露/metrics端点供Prometheus采集指标
   * README 8.4节：内置性能监控指标，可对接Prometheus采集
   */
  startHttpServer(port?: number): Promise<void> {
    const listenPort = port ?? this.httpPort;
    if (!listenPort || listenPort <= 0) {
      logger.debug('[MetricsCollector] HTTP端点未配置，跳过启动');
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        if (req.url === '/metrics' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          });
          res.end(this.toPrometheusFormat());
        } else if (req.url === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', uptime: Math.floor((Date.now() - this.startTime) / 1000) }));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      });

      this.httpServer.on('error', (err: Error) => {
        logger.error(`[MetricsCollector] HTTP端点启动失败: ${err.message}`);
        reject(err);
      });

      this.httpServer.listen(listenPort, () => {
        logger.info(`[MetricsCollector] Prometheus HTTP端点已启动: http://localhost:${listenPort}/metrics`);
        resolve();
      });
    });
  }

  /**
   * 停止Prometheus HTTP端点
   */
  stopHttpServer(): Promise<void> {
    if (!this.httpServer) return Promise.resolve();
    return new Promise((resolve) => {
      this.httpServer!.close(() => {
        this.httpServer = undefined;
        logger.info('[MetricsCollector] Prometheus HTTP端点已停止');
        resolve();
      });
    });
  }

  // ---- 指标记录API ----

  /** 记录AI请求延迟(ms) */
  recordAiLatency(latencyMs: number): void {
    if (!this.enabled) return;
    this.aiLatencies.push(latencyMs);
    // 只保留最近1000条
    if (this.aiLatencies.length > 1000) {
      this.aiLatencies = this.aiLatencies.slice(-1000);
    }
  }

  /** 记录文件操作 */
  recordFileOperation(type: 'read' | 'write' | 'edit' | 'bash'): void {
    if (!this.enabled) return;
    this.fileOperations[type]++;
  }

  /** 记录命令执行结果 */
  recordCommandResult(success: boolean): void {
    if (!this.enabled) return;
    if (success) {
      this.commandResults.success++;
    } else {
      this.commandResults.failed++;
    }
  }

  /** 记录浏览器重启 */
  recordBrowserRestart(): void {
    if (!this.enabled) return;
    this.browserRestarts++;
    logger.info(`[MetricsCollector] 浏览器重启次数: ${this.browserRestarts}`);
  }

  // ---- 指标查询API ----

  /** 获取当前指标快照 */
  getSnapshot(): MetricsData {
    const now = Date.now();
    const memUsage = process.memoryUsage();
    const totalCmd = this.commandResults.success + this.commandResults.failed;

    return {
      aiLatencyAvg: this.average(this.aiLatencies),
      aiLatencyP95: this.percentile(this.aiLatencies, 95),
      memoryUsageMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      fileOpsRead: this.fileOperations.read,
      fileOpsWrite: this.fileOperations.write,
      commandSuccessRate: totalCmd > 0 ? this.commandResults.success / totalCmd : 1,
      browserRestarts: this.browserRestarts,
    };
  }

  /** 生成Prometheus格式文本 */
  toPrometheusFormat(): string {
    const data = this.getSnapshot();
    const lines: string[] = [];

    lines.push('# HELP claycode_ai_latency_avg Average AI request latency in milliseconds');
    lines.push('# TYPE claycode_ai_latency_avg gauge');
    lines.push(`claycode_ai_latency_avg ${data.aiLatencyAvg.toFixed(2)}`);

    lines.push('# HELP claycode_ai_latency_p95 P95 AI request latency in milliseconds');
    lines.push('# TYPE claycode_ai_latency_p95 gauge');
    lines.push(`claycode_ai_latency_p95 ${data.aiLatencyP95.toFixed(2)}`);

    lines.push('# HELP claycode_memory_usage_mb Process memory usage in MB');
    lines.push('# TYPE claycode_memory_usage_mb gauge');
    lines.push(`claycode_memory_usage_mb ${data.memoryUsageMB}`);

    lines.push('# HELP claycode_file_ops_total Total file operations');
    lines.push('# TYPE claycode_file_ops_total counter');
    lines.push(`claycode_file_ops_total{type="read"} ${data.fileOpsRead}`);
    lines.push(`claycode_file_ops_total{type="write"} ${data.fileOpsWrite}`);

    lines.push('# HELP claycode_command_success_rate Command execution success rate');
    lines.push('# TYPE claycode_command_success_rate gauge');
    lines.push(`claycode_command_success_rate ${data.commandSuccessRate.toFixed(4)}`);

    lines.push('# HELP claycode_browser_restarts_total Total browser restart count');
    lines.push('# TYPE claycode_browser_restarts_total counter');
    lines.push(`claycode_browser_restarts_total ${data.browserRestarts}`);

    lines.push('# HELP claycode_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE claycode_uptime_seconds gauge');
    lines.push(`claycode_uptime_seconds ${Math.floor((Date.now() - this.startTime) / 1000)}`);

    return lines.join('\n');
  }

  /** 采集指标（定时调用） */
  private collect(): void {
    const snapshot = this.getSnapshot();
    logger.debug(
      `[MetricsCollector] 采集: AI延迟avg=${snapshot.aiLatencyAvg.toFixed(0)}ms, ` +
      `内存=${snapshot.memoryUsageMB}MB, ` +
      `命令成功率=${(snapshot.commandSuccessRate * 100).toFixed(1)}%, ` +
      `浏览器重启=${snapshot.browserRestarts}`
    );
    this.lastCollectTime = Date.now();
  }

  // ---- 统计工具 ----

  /** 计算平均值 */
  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /** 计算百分位数 */
  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  /** 重置所有指标 */
  reset(): void {
    this.aiLatencies = [];
    this.fileOperations = { read: 0, write: 0, edit: 0, bash: 0 };
    this.commandResults = { success: 0, failed: 0 };
    this.browserRestarts = 0;
    this.startTime = Date.now();
    this.lastCollectTime = Date.now();
  }

  /** 销毁采集器 */
  async destroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.stopHttpServer();
    this.enabled = false;
  }
}