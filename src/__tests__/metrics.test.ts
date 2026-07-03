import { describe, it, expect, afterEach } from 'vitest';
import { MetricsCollector } from '../core/metrics';

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  afterEach(() => {
    metrics?.destroy();
  });

  describe('recordAiLatency', () => {
    it('应记录AI延迟', () => {
      metrics = new MetricsCollector({ enabled: true, collectInterval: 60000 });
      metrics.recordAiLatency(100);
      metrics.recordAiLatency(200);
      metrics.recordAiLatency(300);
      const snapshot = metrics.getSnapshot();
      expect(snapshot.aiLatencyAvg).toBeCloseTo(200, 0);
    });

    it('无延迟记录时avg应为0', () => {
      metrics = new MetricsCollector({ enabled: true, collectInterval: 60000 });
      const snapshot = metrics.getSnapshot();
      expect(snapshot.aiLatencyAvg).toBe(0);
      expect(snapshot.aiLatencyP95).toBe(0);
    });

    it('应只保留最近1000条', () => {
      metrics = new MetricsCollector({ enabled: true, collectInterval: 60000 });
      for (let i = 0; i < 1500; i++) {
        metrics.recordAiLatency(i);
      }
      const snapshot = metrics.getSnapshot();
      // 最近1000条: 500~1499, avg应接近1000
      expect(snapshot.aiLatencyAvg).toBeGreaterThan(500);
    });
  });

  describe('recordFileOperation', () => {
    it('应记录文件操作计数', () => {
      metrics = new MetricsCollector({ enabled: true, collectInterval: 60000 });
      metrics.recordFileOperation('read');
      metrics.recordFileOperation('read');
      metrics.recordFileOperation('write');
      const snapshot = metrics.getSnapshot();
      expect(snapshot.fileOpsRead).toBe(2);
      expect(snapshot.fileOpsWrite).toBe(1);
    });
  });

  describe('recordCommandResult', () => {
    it('应计算命令成功率', () => {
      metrics = new MetricsCollector({ enabled: true, collectInterval: 60000 });
      metrics.recordCommandResult(true);
      metrics.recordCommandResult(true);
      metrics.recordCommandResult(false);
      const snapshot = metrics.getSnapshot();
      expect(snapshot.commandSuccessRate).toBeCloseTo(2 / 3, 2);
    });

    it('无命令记录时成功率应为1', () => {
      metrics = new MetricsCollector({ enabled: true, collectInterval: 60000 });
      const snapshot = metrics.getSnapshot();
      expect(snapshot.commandSuccessRate).toBe(1);
    });
  });

  describe('recordBrowserRestart', () => {
    it('应记录浏览器重启次数', () => {
      metrics = new MetricsCollector({ enabled: true, collectInterval: 60000 });
      metrics.recordBrowserRestart();
      metrics.recordBrowserRestart();
      metrics.recordBrowserRestart();
      const snapshot = metrics.getSnapshot();
      expect(snapshot.browserRestarts).toBe(3);
    });
  });

  describe('getSnapshot', () => {
    it('应返回完整指标快照', () => {
      metrics = new MetricsCollector({ enabled: true, collectInterval: 60000 });
      metrics.recordAiLatency(50);
      metrics.recordFileOperation('read');
      metrics.recordFileOperation('write');
      metrics.recordCommandResult(true);
      metrics.recordBrowserRestart();
      const snapshot = metrics.getSnapshot();
      expect(snapshot).toHaveProperty('aiLatencyAvg');
      expect(snapshot).toHaveProperty('aiLatencyP95');
      expect(snapshot).toHaveProperty('memoryUsageMB');
      expect(snapshot).toHaveProperty('fileOpsRead');
      expect(snapshot).toHaveProperty('fileOpsWrite');
      expect(snapshot).toHaveProperty('commandSuccessRate');
      expect(snapshot).toHaveProperty('browserRestarts');
      expect(snapshot.memoryUsageMB).toBeGreaterThan(0);
    });
  });

  describe('toPrometheusFormat', () => {
    it('应生成Prometheus格式文本', () => {
      metrics = new MetricsCollector({ enabled: true, collectInterval: 60000 });
      metrics.recordAiLatency(100);
      const prom = metrics.toPrometheusFormat();
      expect(prom).toContain('claycode_ai_latency_avg');
      expect(prom).toContain('claycode_ai_latency_p95');
      expect(prom).toContain('claycode_memory_usage_mb');
      expect(prom).toContain('claycode_file_ops_total');
      expect(prom).toContain('claycode_command_success_rate');
      expect(prom).toContain('claycode_browser_restarts_total');
      expect(prom).toContain('claycode_uptime_seconds');
      expect(prom).toContain('# HELP');
      expect(prom).toContain('# TYPE');
    });
  });

  describe('reset', () => {
    it('应重置所有指标', () => {
      metrics = new MetricsCollector({ enabled: true, collectInterval: 60000 });
      metrics.recordAiLatency(100);
      metrics.recordFileOperation('read');
      metrics.recordCommandResult(true);
      metrics.recordBrowserRestart();
      metrics.reset();
      const snapshot = metrics.getSnapshot();
      expect(snapshot.aiLatencyAvg).toBe(0);
      expect(snapshot.fileOpsRead).toBe(0);
      expect(snapshot.commandSuccessRate).toBe(1);
      expect(snapshot.browserRestarts).toBe(0);
    });
  });

  describe('enabled=false', () => {
    it('禁用后应忽略所有记录', () => {
      metrics = new MetricsCollector({ enabled: false });
      metrics.recordAiLatency(100);
      metrics.recordFileOperation('read');
      metrics.recordCommandResult(true);
      metrics.recordBrowserRestart();
      const snapshot = metrics.getSnapshot();
      expect(snapshot.aiLatencyAvg).toBe(0);
      expect(snapshot.fileOpsRead).toBe(0);
      expect(snapshot.browserRestarts).toBe(0);
    });
  });
});