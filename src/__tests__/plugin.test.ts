import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PluginManager } from '../core/plugin';
import { PluginInstance, ToolCall, ExecuteResult } from '../types';

describe('PluginManager', () => {
  let tmpDir: string;
  let pm: PluginManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `claycode-plugin-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    pm = new PluginManager(tmpDir);
  });

  afterEach(async () => {
    if (pm.isInitialized()) {
      await pm.destroyAll();
    }
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- 插件发现与加载 ----
  describe('loadAll', () => {
    it('插件目录不存在时应返回loaded=0', async () => {
      const emptyPm = new PluginManager('/nonexistent/path');
      const result = await emptyPm.loadAll();
      expect(result.loaded).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('空插件目录应返回loaded=0', async () => {
      const result = await pm.loadAll();
      expect(result.loaded).toBe(0);
    });

    it('应能加载合法插件', async () => {
      // 创建测试插件目录
      const pluginDir = path.join(tmpDir, 'test-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });

      // 写入plugin.json
      const descriptor = {
        name: 'test-plugin',
        version: '1.0.0',
        type: 'hook',
        description: 'A test plugin',
        main: 'index.js',
      };
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(descriptor));

      // 写入入口文件
      const entryCode = `
        async function setup() { globalThis.__pluginSetup = true; }
        async function destroy() { globalThis.__pluginDestroyed = true; }
        module.exports = { setup, destroy };
      `;
      fs.writeFileSync(path.join(pluginDir, 'index.js'), entryCode);

      const result = await pm.loadAll();
      expect(result.loaded).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('缺少plugin.json应加载失败', async () => {
      const pluginDir = path.join(tmpDir, 'bad-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      // 不写plugin.json

      const result = await pm.loadAll();
      expect(result.failed).toBe(1);
      expect(result.errors.length).toBe(1);
    });

    it('无效的plugin.json应加载失败', async () => {
      const pluginDir = path.join(tmpDir, 'invalid-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: '' }));

      const result = await pm.loadAll();
      expect(result.failed).toBe(1);
    });

    it('type不是adapter/tool/hook应失败', async () => {
      const pluginDir = path.join(tmpDir, 'bad-type-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'bad-type', version: '1.0.0', type: 'invalid', main: 'index.js',
      }));

      const result = await pm.loadAll();
      expect(result.failed).toBe(1);
    });

    it('入口文件不存在应加载失败', async () => {
      const pluginDir = path.join(tmpDir, 'no-entry-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'no-entry', version: '1.0.0', type: 'hook', main: 'nonexistent.js',
      }));

      const result = await pm.loadAll();
      expect(result.failed).toBe(1);
    });
  });

  // ---- 生命周期管理 ----
  describe('setupAll/destroyAll', () => {
    it('setupAll应将插件状态设为active', async () => {
      const pluginDir = path.join(tmpDir, 'lifecycle-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'lifecycle', version: '1.0.0', type: 'hook', main: 'index.js',
      }));
      fs.writeFileSync(path.join(pluginDir, 'index.js'), `
        async function setup() {}
        module.exports = { setup };
      `);

      await pm.loadAll();
      await pm.setupAll();

      const plugins = pm.getPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0].state).toBe('active');
      expect(pm.isInitialized()).toBe(true);
    });

    it('destroyAll应将插件状态设为destroyed并清空', async () => {
      const pluginDir = path.join(tmpDir, 'destroy-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'destroy-test', version: '1.0.0', type: 'hook', main: 'index.js',
      }));
      fs.writeFileSync(path.join(pluginDir, 'index.js'), `
        async function setup() {}
        async function destroy() {}
        module.exports = { setup, destroy };
      `);

      await pm.loadAll();
      await pm.setupAll();
      await pm.destroyAll();

      expect(pm.getPlugins().length).toBe(0);
      expect(pm.isInitialized()).toBe(false);
    });
  });

  // ---- 钩子调度 ----
  describe('dispatchHook', () => {
    it('beforeAiRequest应调用插件钩子', async () => {
      const pluginDir = path.join(tmpDir, 'hook-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'hook-test', version: '1.0.0', type: 'hook', main: 'index.js',
      }));
      fs.writeFileSync(path.join(pluginDir, 'index.js'), `
        async function setup() {}
        async function beforeAiRequest(ctx) {
          return { proceed: true, modifiedData: ctx };
        }
        module.exports = { setup, beforeAiRequest };
      `);

      await pm.loadAll();
      await pm.setupAll();

      const result = await pm.beforeAiRequest({
        sessionId: 'test-session',
        timestamp: Date.now(),
      });
      expect(result.proceed).toBe(true);
    });

    it('afterToolExecute应调用插件钩子', async () => {
      const pluginDir = path.join(tmpDir, 'after-hook-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'after-hook', version: '1.0.0', type: 'hook', main: 'index.js',
      }));
      fs.writeFileSync(path.join(pluginDir, 'index.js'), `
        async function setup() {}
        async function afterToolExecute(data) {
          return { proceed: true };
        }
        module.exports = { setup, afterToolExecute };
      `);

      await pm.loadAll();
      await pm.setupAll();

      const tc: ToolCall = { tool: 'read', filePath: '/tmp/test.txt' };
      const er: ExecuteResult = { success: true, outputText: 'ok', errorText: '', exitCode: 0, operateFiles: [] };
      const result = await pm.afterToolExecute(tc, er, {
        sessionId: 'test',
        timestamp: Date.now(),
      });
      expect(result.proceed).toBe(true);
    });
  });

  // ---- 查询接口 ----
  describe('getPlugins/getPlugin/unloadPlugin', () => {
    it('getPlugins应返回所有已加载插件', async () => {
      const pluginDir = path.join(tmpDir, 'query-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'query-test', version: '1.0.0', type: 'tool', main: 'index.js',
      }));
      fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = {};');

      await pm.loadAll();
      const plugins = pm.getPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0].descriptor.name).toBe('query-test');
    });

    it('getPluginsByType应按类型过滤', async () => {
      const pluginDir = path.join(tmpDir, 'type-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'type-test', version: '1.0.0', type: 'adapter', main: 'index.js',
      }));
      fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = {};');

      await pm.loadAll();
      const adapters = pm.getPluginsByType('adapter');
      const hooks = pm.getPluginsByType('hook');
      expect(adapters.length).toBe(1);
      expect(hooks.length).toBe(0);
    });

    it('getPlugin应返回指定插件', async () => {
      const pluginDir = path.join(tmpDir, 'get-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'get-test', version: '1.0.0', type: 'hook', main: 'index.js',
      }));
      fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = {};');

      await pm.loadAll();
      const plugin = pm.getPlugin('get-test');
      expect(plugin).toBeDefined();
      expect(plugin?.descriptor.name).toBe('get-test');
      expect(pm.getPlugin('nonexistent')).toBeUndefined();
    });

    it('unloadPlugin应卸载指定插件', async () => {
      const pluginDir = path.join(tmpDir, 'unload-plugin');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
        name: 'unload-test', version: '1.0.0', type: 'hook', main: 'index.js',
      }));
      fs.writeFileSync(path.join(pluginDir, 'index.js'), `
        async function destroy() {}
        module.exports = { destroy };
      `);

      await pm.loadAll();
      expect(pm.getPlugins().length).toBe(1);

      const unloaded = await pm.unloadPlugin('unload-test');
      expect(unloaded).toBe(true);
      expect(pm.getPlugins().length).toBe(0);

      const unloadedAgain = await pm.unloadPlugin('unload-test');
      expect(unloadedAgain).toBe(false);
    });
  });
});