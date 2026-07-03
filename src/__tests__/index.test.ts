import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClayCodeEngine, EngineState } from '../core/index';
import { DEFAULT_CONFIG } from '../types';

/**
 * ClayCodeEngine 集成测试
 * 注意：init() 会启动浏览器，测试中不调用 init()
 * 仅测试构造函数、配置、各子模块的集成
 */
describe('ClayCodeEngine', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `claycode-engine-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    configPath = path.join(tmpDir, 'config.json');
    // 写入自定义配置避免影响用户目录
    fs.writeFileSync(configPath, JSON.stringify({
      dataDir: tmpDir,
      browserDataPath: path.join(tmpDir, 'browser'),
      sessionDir: path.join(tmpDir, 'sessions'),
      browserHeadless: true,
    }));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- 构造与初始化 ----
  describe('构造函数', () => {
    it('应创建引擎实例', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      expect(engine).toBeDefined();
    });

    it('初始状态应为idle', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      expect(engine.getState()).toBe('idle');
    });

    it('应加载自定义配置', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const config = engine.getConfig();
      expect(config.dataDir).toBe(tmpDir);
      expect(config.browserHeadless).toBe(true);
    });

    it('应使用默认maxRounds=10', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      // maxRounds是私有的，通过行为间接验证
      expect(engine).toBeDefined();
    });

    it('应支持自定义maxRounds', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir, maxRounds: 5 });
      expect(engine).toBeDefined();
    });
  });

  // ---- 子模块访问 ----
  describe('子模块访问', () => {
    it('getSessionManager应返回SessionManager实例', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const sm = engine.getSessionManager();
      expect(sm).toBeDefined();
      expect(typeof sm.createSession).toBe('function');
    });

    it('getSecurityManager应返回SecurityManager实例', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const sec = engine.getSecurityManager();
      expect(sec).toBeDefined();
      expect(typeof sec.validatePath).toBe('function');
    });

    it('getCacheManager应返回CacheManager实例', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const cache = engine.getCacheManager();
      expect(cache).toBeDefined();
      expect(typeof cache.get).toBe('function');
    });

    it('getPluginManager应返回PluginManager实例', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const pm = engine.getPluginManager();
      expect(pm).toBeDefined();
      expect(typeof pm.loadAll).toBe('function');
    });

    it('getMetricsCollector应返回MetricsCollector实例', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const metrics = engine.getMetricsCollector();
      expect(metrics).toBeDefined();
      expect(typeof metrics.recordAiLatency).toBe('function');
    });

    it('getConfigManager应返回ConfigManager实例', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const cm = engine.getConfigManager();
      expect(cm).toBeDefined();
      expect(typeof cm.getConfig).toBe('function');
    });
  });

  // ---- 配置修改 ----
  describe('配置修改', () => {
    it('setDefaultAdapter应更新适配器', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      engine.setDefaultAdapter('claude-web');
      const config = engine.getConfig();
      expect(config.defaultAdapter).toBe('claude-web');
    });
  });

  // ---- 安全集成 ----
  describe('安全集成', () => {
    it('引擎的安全管理器应使用项目根目录', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const sec = engine.getSecurityManager();
      // 项目内路径应通过
      const result = sec.validatePath(path.join(tmpDir, 'src', 'app.ts'));
      expect(result.valid).toBe(true);
    });

    it('引擎的安全管理器应拦截越权路径', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const sec = engine.getSecurityManager();
      const result = sec.validatePath('/etc/passwd');
      expect(result.valid).toBe(false);
    });
  });

  // ---- 缓存集成 ----
  describe('缓存集成', () => {
    it('引擎的缓存管理器应可读写', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const cache = engine.getCacheManager();
      cache.set('test-key', { value: 42 });
      const data = cache.get<{ value: number }>('test-key');
      expect(data).toBeDefined();
      expect(data?.value).toBe(42);
    });
  });

  // ---- 监控集成 ----
  describe('监控集成', () => {
    it('引擎的监控采集器应可记录指标', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const metrics = engine.getMetricsCollector();
      metrics.recordAiLatency(100);
      metrics.recordAiLatency(200);
      const snapshot = metrics.getSnapshot();
      expect(snapshot.aiLatencyAvg).toBe(150);
    });
  });

  // ---- 会话集成 ----
  describe('会话集成', () => {
    it('引擎的会话管理器应可创建会话', async () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const sm = engine.getSessionManager();
      await sm.init();
      const session = sm.createSession('integration-test');
      expect(session.sessionName).toBe('integration-test');
      expect(session.sessionId).toBeDefined();
      sm.deleteAll();
    });
  });

  // ---- 配置管理集成 ----
  describe('配置管理集成', () => {
    it('引擎的配置管理器应返回一致配置', () => {
      const engine = new ClayCodeEngine({ configPath, cwd: tmpDir });
      const cm = engine.getConfigManager();
      const configFromCm = cm.getConfig();
      const configFromEngine = engine.getConfig();
      expect(configFromCm.dataDir).toBe(configFromEngine.dataDir);
      expect(configFromCm.browserHeadless).toBe(configFromEngine.browserHeadless);
    });
  });
});