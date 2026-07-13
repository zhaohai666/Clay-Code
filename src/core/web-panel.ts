/**
 * ClayCode V1.2 轻量化Web管理面板
 * 内置HTTP服务器，提供会话查看、资源监控、配置可视化修改
 * README 10.2第2项：内置轻量化Web管理面板
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import {
  WebPanelOptions, WebPanelApiResponse, SessionSummary,
  AdapterType, GlobalConfig,
} from '../types';
import { ConfigManager } from './config';
import { SessionManager } from './session';
import { MetricsCollector } from './metrics';
import { logger } from '../utils';

/** 默认Web面板端口 */
const DEFAULT_PORT = 18080;
/** 默认绑定主机 */
const DEFAULT_HOST = 'localhost';

/**
 * Web管理面板服务器
 * 提供RESTful API和内嵌前端HTML页面
 */
export class WebPanelManager {
  private port: number;
  private host: string;
  private openBrowser: boolean;
  private server?: http.Server;
  private configManager: ConfigManager;
  private sessionManager: SessionManager;
  private metricsCollector: MetricsCollector;

  constructor(options?: WebPanelOptions) {
    this.port = options?.port ?? DEFAULT_PORT;
    this.host = options?.host ?? DEFAULT_HOST;
    this.openBrowser = options?.openBrowser ?? true;
    this.configManager = new ConfigManager();
    this.sessionManager = new SessionManager(this.configManager.getSessionDir());
    this.metricsCollector = new MetricsCollector({ enabled: false });
  }

  /**
   * 启动Web面板HTTP服务器
   */
  async start(): Promise<void> {
    if (this.server) {
      logger.warn('Web面板已在运行中');
      return;
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => {
        const url = `http://${this.host}:${this.port}`;
        logger.info(`Web管理面板已启动: ${url}`);

        if (this.openBrowser) {
          this.openUrl(url);
        }

        resolve();
      });

      this.server!.on('error', (err: Error) => {
        logger.error(`Web面板启动失败: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * 停止Web面板服务器
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        this.server = undefined;
        logger.info('Web管理面板已停止');
        resolve();
      });
    });
  }

  /**
   * 获取面板URL
   */
  getUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * 处理HTTP请求
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // CORS头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // API路由
      if (pathname.startsWith('/api/')) {
        this.handleApiRequest(pathname, method, req, res, url);
        return;
      }

      // 前端页面
      if (pathname === '/' || pathname === '/index.html') {
        this.serveHtml(res);
        return;
      }

      // 404
      this.sendJson(res, 404, { success: false, message: 'Not Found' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Web面板请求处理错误: ${message}`);
      this.sendJson(res, 500, { success: false, message: 'Internal Server Error' });
    }
  }

  /**
   * 处理API请求
   */
  private handleApiRequest(
    pathname: string,
    method: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): void {
    // GET /api/sessions - 会话列表
    if (pathname === '/api/sessions' && method === 'GET') {
      const sessions = this.sessionManager.listSessions();
      const summaries: SessionSummary[] = sessions.map(s => ({
        sessionId: s.sessionId,
        sessionName: s.sessionName,
        adapter: s.adapter as AdapterType,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        lastMessagePreview: s.messages.length > 0
          ? s.messages[s.messages.length - 1].content.slice(0, 100)
          : '(空)',
      }));
      this.sendJson(res, 200, { success: true, data: summaries });
      return;
    }

    // GET /api/sessions/:id - 会话详情
    const sessionMatch = pathname.match(/^\/api\/sessions\/(.+)$/);
    if (sessionMatch && method === 'GET') {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const session = this.sessionManager.getSession(sessionId);
      if (session) {
        this.sendJson(res, 200, { success: true, data: session });
      } else {
        this.sendJson(res, 404, { success: false, message: `会话不存在: ${sessionId}` });
      }
      return;
    }

    // DELETE /api/sessions/:id - 删除会话
    if (sessionMatch && method === 'DELETE') {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      this.sessionManager.deleteSession(sessionId);
      this.sendJson(res, 200, { success: true, message: `会话已删除: ${sessionId}` });
      return;
    }

    // GET /api/metrics - 资源监控指标
    if (pathname === '/api/metrics' && method === 'GET') {
      const snapshot = this.metricsCollector.getSnapshot();
      const prometheus = this.metricsCollector.toPrometheusFormat();
      this.sendJson(res, 200, {
        success: true,
        data: {
          snapshot,
          prometheus,
          uptime: Date.now() - ((this.metricsCollector as any).startTime ?? Date.now()),
        },
      });
      return;
    }

    // GET /api/config - 获取配置
    if (pathname === '/api/config' && method === 'GET') {
      const config = this.configManager.getConfig();
      // 隐藏敏感字段
      const safeConfig = { ...config } as Record<string, unknown>;
      if (safeConfig.apiKey) safeConfig.apiKey = '********';
      this.sendJson(res, 200, { success: true, data: safeConfig });
      return;
    }

    // POST /api/config - 修改配置
    if (pathname === '/api/config' && method === 'POST') {
      this.readBody(req).then(body => {
        try {
          const updates = JSON.parse(body);
          if (typeof updates !== 'object' || updates === null) {
            this.sendJson(res, 400, { success: false, message: '无效的配置数据' });
            return;
          }
          for (const [key, value] of Object.entries(updates)) {
            this.configManager.set(key, String(value));
          }
          const updatedConfig = this.configManager.getConfig();
          this.sendJson(res, 200, { success: true, data: updatedConfig, message: '配置已更新' });
        } catch (e: unknown) {
          this.sendJson(res, 400, { success: false, message: 'JSON解析失败' });
        }
      });
      return;
    }

    // GET /api/health - 健康检查
    if (pathname === '/api/health' && method === 'GET') {
      this.sendJson(res, 200, {
        success: true,
        data: {
          status: 'healthy',
          version: '1.2.0',
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        },
      });
      return;
    }

    // 未知API
    this.sendJson(res, 404, { success: false, message: `API不存在: ${pathname}` });
  }

  /**
   * 读取请求体
   */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  /**
   * 发送JSON响应
   */
  private sendJson(res: http.ServerResponse, statusCode: number, data: WebPanelApiResponse): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * 提供内嵌前端HTML页面
   */
  private serveHtml(res: http.ServerResponse): void {
    const html = this.generateFrontendHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * 生成前端HTML页面（内嵌单页应用）
   */
  private generateFrontendHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ClayCode Web管理面板</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; }
  .header { background: #16213e; padding: 16px 24px; display: flex; align-items: center; border-bottom: 1px solid #0f3460; }
  .header h1 { font-size: 20px; color: #e94560; }
  .header span { margin-left: 12px; font-size: 12px; color: #888; }
  .tabs { display: flex; background: #16213e; padding: 0 24px; border-bottom: 1px solid #0f3460; }
  .tab { padding: 10px 20px; cursor: pointer; color: #888; border-bottom: 2px solid transparent; transition: all 0.2s; }
  .tab:hover { color: #e0e0e0; }
  .tab.active { color: #e94560; border-bottom-color: #e94560; }
  .content { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .panel { display: none; }
  .panel.active { display: block; }
  .card { background: #16213e; border-radius: 8px; padding: 16px; margin-bottom: 16px; border: 1px solid #0f3460; }
  .card h3 { color: #e94560; margin-bottom: 12px; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #0f3460; }
  th { color: #e94560; font-size: 13px; }
  td { font-size: 13px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
  .badge-green { background: #1b4332; color: #52b788; }
  .badge-yellow { background: #4a3800; color: #e9c46a; }
  .badge-red { background: #4a1520; color: #e76f51; }
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .metric-item { background: #0f3460; border-radius: 8px; padding: 16px; text-align: center; }
  .metric-value { font-size: 28px; font-weight: bold; color: #e94560; }
  .metric-label { font-size: 12px; color: #888; margin-top: 4px; }
  .config-row { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid #0f3460; }
  .config-key { flex: 0 0 200px; font-weight: bold; color: #e94560; font-size: 13px; }
  .config-value { flex: 1; font-size: 13px; }
  .btn { padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; transition: all 0.2s; }
  .btn-primary { background: #e94560; color: white; }
  .btn-primary:hover { background: #c73652; }
  .btn-danger { background: #4a1520; color: #e76f51; }
  .btn-danger:hover { background: #6a2030; }
  .empty { text-align: center; padding: 40px; color: #666; }
  #refresh-btn { margin-left: auto; }
</style>
</head>
<body>
<div class="header">
  <h1>ClayCode</h1>
  <span>Web管理面板 v1.2</span>
  <button id="refresh-btn" class="btn btn-primary" onclick="refresh()">刷新</button>
</div>
<div class="tabs">
  <div class="tab active" onclick="switchTab('sessions')">会话管理</div>
  <div class="tab" onclick="switchTab('metrics')">资源监控</div>
  <div class="tab" onclick="switchTab('config')">配置管理</div>
</div>
<div class="content">
  <div id="sessions-panel" class="panel active">
    <div class="card">
      <h3>会话列表</h3>
      <table>
        <thead><tr><th>ID</th><th>名称</th><th>适配器</th><th>消息数</th><th>最后活跃</th><th>操作</th></tr></thead>
        <tbody id="sessions-body"><tr><td colspan="6" class="empty">加载中...</td></tr></tbody>
      </table>
    </div>
  </div>
  <div id="metrics-panel" class="panel">
    <div class="card">
      <h3>实时监控指标</h3>
      <div class="metric-grid" id="metrics-grid"></div>
    </div>
  </div>
  <div id="config-panel" class="panel">
    <div class="card">
      <h3>当前配置</h3>
      <div id="config-list"></div>
    </div>
  </div>
</div>
<script>
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', ['sessions','metrics','config'][i]===name));
  document.querySelectorAll('.panel').forEach((p,i) => p.classList.toggle('active', ['sessions','metrics','config'][i]===name));
  if (name==='sessions') loadSessions();
  else if (name==='metrics') loadMetrics();
  else if (name==='config') loadConfig();
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}
async function loadSessions() {
  const r = await api('/api/sessions');
  const tbody = document.getElementById('sessions-body');
  if (!r.success || !r.data.length) { tbody.innerHTML='<tr><td colspan="6" class="empty">暂无会话</td></tr>'; return; }
  tbody.innerHTML = r.data.map(s => '<tr><td>'+s.sessionId.slice(0,8)+'...</td><td>'+s.sessionName+'</td><td><span class="badge badge-green">'+s.adapter+'</span></td><td>'+s.messageCount+'</td><td>'+new Date(s.lastActiveAt).toLocaleString('zh-CN')+'</td><td><button class="btn btn-danger" onclick="delSession(\\''+s.sessionId+'\\')">删除</button></td></tr>').join('');
}
async function delSession(id) {
  if (!confirm('确认删除会话?')) return;
  await api('/api/sessions/'+id, {method:'DELETE'});
  loadSessions();
}
async function loadMetrics() {
  const r = await api('/api/metrics');
  if (!r.success) return;
  const s = r.data.snapshot;
  const grid = document.getElementById('metrics-grid');
  grid.innerHTML = [
    {v:s.aiLatencyAvg.toFixed(0),l:'AI平均延迟(ms)'},
    {v:s.aiLatencyP95.toFixed(0),l:'AI P95延迟(ms)'},
    {v:s.memoryUsageMB.toFixed(1),l:'内存使用(MB)'},
    {v:s.fileOpsRead,l:'文件读取次数'},
    {v:s.fileOpsWrite,l:'文件写入次数'},
    {v:s.fileOpsEdit,l:'文件编辑次数'},
    {v:(s.commandSuccessRate*100).toFixed(1)+'%',l:'命令成功率'},
    {v:s.browserRestarts,l:'浏览器重启次数'},
  ].map(m=>'<div class="metric-item"><div class="metric-value">'+m.v+'</div><div class="metric-label">'+m.l+'</div></div>').join('');
}
async function loadConfig() {
  const r = await api('/api/config');
  if (!r.success) return;
  const list = document.getElementById('config-list');
  list.innerHTML = Object.entries(r.data).map(([k,v])=>'<div class="config-row"><div class="config-key">'+k+'</div><div class="config-value">'+JSON.stringify(v)+'</div></div>').join('');
}
function refresh() { document.querySelector('.tab.active').click(); }
loadSessions();
</script>
</body>
</html>`;
  }

  /**
   * 打开浏览器
   */
  private openUrl(url: string): void {
    try {
      const { exec } = require('child_process') as { exec: (cmd: string, cb: (err: Error | null) => void) => void };
      const platform = process.platform;
      if (platform === 'darwin') {
        exec(`open "${url}"`, () => {});
      } else if (platform === 'win32') {
        exec(`start "" "${url}"`, () => {});
      } else {
        exec(`xdg-open "${url}"`, () => {});
      }
    } catch {
      logger.warn(`无法自动打开浏览器，请手动访问: ${url}`);
    }
  }
}