#!/usr/bin/env node
/**
 * ClayCode CLI 入口
 * clay agent/chat/login/config/session/log/doctor/plugin
 */

import { Command } from 'commander';
import { ClayCodeEngine } from '../core/index';
import { ConfigManager } from '../core/config';
import { SessionManager } from '../core/session';
import { PluginManager } from '../core/plugin';
import { MetricsCollector } from '../core/metrics';
import { logger, LogLevel } from '../utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

const VERSION = '1.0.0';

const program = new Command();

program
  .name('clay')
  .description('ClayCode - 免API Key的终端AI编码引擎')
  .version(VERSION);

// ---- clay agent <task> ----
program
  .command('agent')
  .description('Agent模式：自主执行编码任务')
  .argument('<task>', '任务描述')
  .option('-a, --adapter <name>', 'AI适配器名称', 'doubao')
  .option('-s, --session <id>', '会话ID（继续已有会话）')
  .option('-r, --rounds <n>', '最大执行轮次', '10')
  .option('--cwd <path>', '工作目录', process.cwd())
  .action(async (task: string, opts: { adapter: string; session?: string; rounds: string; cwd: string }) => {
    const engine = new ClayCodeEngine({
      cwd: opts.cwd,
      maxRounds: parseInt(opts.rounds, 10),
    });

    try {
      await engine.init();

      if (opts.adapter) {
        engine.setDefaultAdapter(opts.adapter);
      }

      console.log(`\n🤖 ClayCode Agent 模式启动`);
      console.log(`任务: ${task}\n`);

      const response = await engine.agent(task, opts.session, (state, msg) => {
        const stateIcons: Record<string, string> = {
          thinking: '🤔',
          executing: '⚡',
          idle: '✅',
          error: '❌',
        };
        const icon = stateIcons[state] || '⏳';
        process.stdout.write(`\r${icon} ${msg}`);
      });

      console.log('\n');
      printResponse(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ 错误: ${message}`);
      process.exit(1);
    } finally {
      await engine.dispose();
    }
  });

// ---- clay chat ----
program
  .command('chat')
  .description('交互式对话模式')
  .option('-a, --adapter <name>', 'AI适配器名称', 'doubao')
  .option('-s, --session <id>', '会话ID（继续已有会话）')
  .option('--cwd <path>', '工作目录', process.cwd())
  .action(async (opts: { adapter: string; session?: string; cwd: string }) => {
    const engine = new ClayCodeEngine({ cwd: opts.cwd });

    try {
      await engine.init();

      if (opts.adapter) {
        engine.setDefaultAdapter(opts.adapter);
      }

      const sessionManager = engine.getSessionManager();
      const session = opts.session
        ? sessionManager.getSession(opts.session)
        : sessionManager.createSession();

      console.log(`\n💬 ClayCode 对话模式 (会话: ${session.sessionId})`);
      console.log('输入消息开始对话，输入 .quit 退出，输入 .clear 清空会话\n');

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> ',
      });

      rl.prompt();

      rl.on('line', async (line: string) => {
        const input = line.trim();
        if (!input) {
          rl.prompt();
          return;
        }

        if (input === '.quit') {
          console.log('再见！');
          rl.close();
          return;
        }

        if (input === '.clear') {
          session.messages = [];
          console.log('会话已清空');
          rl.prompt();
          return;
        }

        try {
          const response = await engine.chat(input, session.sessionId, (state, msg) => {
            const stateIcons: Record<string, string> = {
              thinking: '🤔',
              executing: '⚡',
              idle: '',
              error: '❌',
            };
            const icon = stateIcons[state] || '';
            if (icon) process.stdout.write(`\r${icon} ${msg}`);
          });

          console.log('\n');
          printResponse(response);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`错误: ${message}`);
        }

        rl.prompt();
      });

      rl.on('close', async () => {
        sessionManager.persistSession(session.sessionId);
        await engine.dispose();
        process.exit(0);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`❌ 错误: ${message}`);
      process.exit(1);
    }
  });

// ---- clay login ----
program
  .command('login')
  .description('打开浏览器登录AI平台')
  .option('-a, --adapter <name>', 'AI适配器名称', 'doubao')
  .action(async (opts: { adapter: string }) => {
    const engine = new ClayCodeEngine();

    try {
      console.log(`\n🔐 正在打开 ${opts.adapter} 登录页面...`);
      const url = await engine.login(opts.adapter);
      console.log(`浏览器已打开: ${url}`);
      console.log('请在浏览器中完成登录，登录完成后按 Ctrl+C 退出\n');

      // 等待用户手动关闭
      await new Promise<void>(() => {});
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`❌ 登录失败: ${message}`);
      process.exit(1);
    }
  });

// ---- clay config ----
const configCmd = program
  .command('config')
  .description('查看或修改配置');

configCmd
  .command('set')
  .description('设置配置项')
  .argument('<key>', '配置键名')
  .argument('<value>', '配置值')
  .action((key: string, value: string) => {
    const cm = new ConfigManager();
    cm.set(key, value);
    console.log(`✅ 已设置 ${key} = ${value}`);
  });

configCmd
  .command('get')
  .description('获取配置项')
  .argument('<key>', '配置键名')
  .action((key: string) => {
    const cm = new ConfigManager();
    const config = cm.getConfig();
    const value = (config as unknown as Record<string, unknown>)[key];
    console.log(`${key} = ${JSON.stringify(value)}`);
  });

configCmd
  .command('list')
  .description('列出所有配置')
  .action(() => {
    const cm = new ConfigManager();
    const config = cm.getConfig();
    console.log('\n📋 ClayCode 配置:\n');
    for (const [key, value] of Object.entries(config)) {
      console.log(`  ${key} = ${JSON.stringify(value)}`);
    }
    console.log('');
  });

configCmd
  .command('reset')
  .description('重置为默认配置')
  .action(() => {
    const cm = new ConfigManager();
    cm.reset();
    console.log('✅ 配置已重置为默认值');
  });

// ---- clay session ----
const sessionCmd = program
  .command('session')
  .description('管理会话');

sessionCmd
  .command('new')
  .description('新建会话')
  .argument('[session-name]', '会话名称')
  .option('-a, --adapter <name>', 'AI适配器名称', 'doubao')
  .action(async (sessionName?: string, opts?: { adapter?: string }) => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    const session = sm.createSession(sessionName || undefined);
    if (opts?.adapter) {
      session.adapter = opts.adapter as any;
    }
    sm.persistSession(session.sessionId);
    console.log(`✅ 已创建会话: ${session.sessionName} (${session.sessionId})`);
  });

sessionCmd
  .command('use')
  .description('切换到指定会话')
  .argument('<session-id>', '会话ID或名称')
  .action((sessionId: string) => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    const session = sm.getSession(sessionId);
    if (session) {
      // 更新最后活跃时间，标记为当前会话
      session.lastActiveAt = Date.now();
      sm.persistSession(session.sessionId);
      console.log(`✅ 已切换到会话: ${session.sessionName} (${session.sessionId})`);
      console.log(`   消息数: ${session.messages.length}, 最后活跃: ${new Date(session.lastActiveAt).toLocaleString()}`);
    } else {
      console.log(`❌ 会话不存在: ${sessionId}`);
    }
  });

sessionCmd
  .command('recover')
  .description('恢复最近一次会话')
  .action(() => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    const session = sm.recoverSession();
    if (session) {
      console.log(`✅ 已恢复会话: ${session.sessionName} (${session.sessionId})`);
      console.log(`   消息数: ${session.messages.length}, 最后活跃: ${new Date(session.lastActiveAt).toLocaleString()}`);
    } else {
      console.log('❌ 没有可恢复的会话');
    }
  });

sessionCmd
  .command('list')
  .description('列出所有会话')
  .action(() => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    const sessions = sm.listSessions();
    if (sessions.length === 0) {
      console.log('暂无会话');
      return;
    }
    console.log('\n📋 会话列表:\n');
    for (const s of sessions) {
      const msgCount = s.messages.length;
      const lastMsg = s.messages[s.messages.length - 1];
      const preview = lastMsg ? lastMsg.content.slice(0, 50) : '(空)';
      console.log(`  ${s.sessionId}  消息:${msgCount}  最后:${preview}...`);
    }
    console.log('');
  });

sessionCmd
  .command('delete')
  .description('删除指定会话')
  .argument('<session-id>', '会话ID')
  .action((sessionId: string) => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    sm.deleteSession(sessionId);
    console.log(`✅ 会话 ${sessionId} 已删除`);
  });

// ---- clay log ----
program
  .command('log')
  .description('查看日志')
  .option('-n, --lines <n>', '显示行数', '50')
  .option('-f, --follow', '持续跟踪日志')
  .option('--level <level>', '过滤日志级别(debug/info/warn/error)')
  .action(async (opts: { lines: string; follow?: boolean; level?: string }) => {
    const cm = new ConfigManager();
    const logDir = cm.getLogDir();
    // 使用按日期命名的日志文件
    const today = new Date();
    const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    const logFile = path.join(logDir, `claycode-${dateStr}.log`);

    if (!fs.existsSync(logFile)) {
      console.log('暂无日志文件');
      return;
    }

    if (opts.follow) {
      console.log(`跟踪日志: ${logFile} (Ctrl+C 退出)\n`);
      const { execSync } = await import('child_process');
      try {
        execSync(`tail -f ${logFile}`, { stdio: 'inherit' });
      } catch {
        // 用户Ctrl+C退出
      }
      return;
    }

    const lineCount = parseInt(opts.lines, 10);
    const content = fs.readFileSync(logFile, 'utf-8');
    let allLines = content.split('\n');

    // 按级别过滤
    if (opts.level) {
      const level = opts.level.toUpperCase();
      allLines = allLines.filter(line => line.includes(`[${level}]`));
    }

    const tailLines = allLines.slice(-lineCount);
    console.log(tailLines.join('\n'));
  });

// ---- clay doctor ----
program
  .command('doctor')
  .description('诊断环境配置')
  .action(async () => {
    console.log('\n🔍 ClayCode 环境诊断\n');

    const checks: { name: string; status: string; detail?: string }[] = [];

    // 1. Node.js版本
    const nodeVersion = process.version;
    const nodeOk = parseInt(nodeVersion.slice(1).split('.')[0]) >= 18;
    checks.push({
      name: 'Node.js版本',
      status: nodeOk ? '✅' : '❌',
      detail: `${nodeVersion} (需要 >=18.0.0)`,
    });

    // 2. 配置文件
    const configDir = path.join(os.homedir(), '.claycode');
    const configFile = path.join(configDir, 'config.json');
    const configExists = fs.existsSync(configFile);
    checks.push({
      name: '配置文件',
      status: configExists ? '✅' : '⚠️',
      detail: configFile,
    });

    // 3. 目录结构
    const requiredDirs = ['sessions', 'logs', 'cache', 'plugins', 'temp', 'browser-cache'];
    for (const dir of requiredDirs) {
      const dirPath = path.join(configDir, dir);
      const exists = fs.existsSync(dirPath);
      checks.push({
        name: `目录 ${dir}/`,
        status: exists ? '✅' : '⚠️',
        detail: dirPath,
      });
    }

    // 4. Chrome浏览器
    try {
      const { findChromePath } = await import('../utils/platform');
      const chromePath = findChromePath();
      checks.push({
        name: 'Chrome浏览器',
        status: chromePath ? '✅' : '❌',
        detail: chromePath || '未找到，请安装Chrome或通过config设置chromePath',
      });
    } catch {
      checks.push({
        name: 'Chrome浏览器',
        status: '⚠️',
        detail: '检测失败',
      });
    }

    // 5. 配置项检查
    try {
      const cm = new ConfigManager();
      const config = cm.getConfig();
      checks.push({
        name: '默认适配器',
        status: '✅',
        detail: config.defaultAdapter,
      });
      checks.push({
        name: '浏览器无头模式',
        status: config.browserHeadless ? '✅' : '⚠️',
        detail: String(config.browserHeadless),
      });
      checks.push({
        name: '命令白名单',
        status: config.execWhiteList.length > 0 ? '✅' : '❌',
        detail: `${config.execWhiteList.length}个命令: ${config.execWhiteList.slice(0, 5).join(', ')}...`,
      });
      checks.push({
        name: '缓存级别',
        status: '✅',
        detail: config.cacheLevel,
      });
    } catch {
      checks.push({
        name: '配置加载',
        status: '❌',
        detail: '配置加载失败',
      });
    }

    // 输出结果
    for (const check of checks) {
      console.log(`  ${check.status} ${check.name}: ${check.detail || ''}`);
    }

    const failCount = checks.filter(c => c.status === '❌').length;
    const warnCount = checks.filter(c => c.status === '⚠️').length;

    console.log(`\n  总计: ${checks.length}项, ✅通过 ${checks.length - failCount - warnCount}, ⚠️警告 ${warnCount}, ❌失败 ${failCount}\n`);

    if (failCount > 0) {
      console.log('  请修复上述❌项后重试。\n');
    }
  });

// ---- clay plugin ----
program
  .command('plugin')
  .description('管理插件')
  .option('-l, --list', '列出已加载插件')
  .option('-i, --install <path>', '安装插件（指定插件目录路径）')
  .option('-u, --uninstall <name>', '卸载插件')
  .action(async (opts: { list?: boolean; install?: string; uninstall?: string }) => {
    const cm = new ConfigManager();
    const pluginsDir = cm.getPluginsDir();
    const pm = new PluginManager(pluginsDir);

    if (opts.install) {
      console.log(`\n📦 安装插件: ${opts.install}`);
      try {
        const plugin = await pm.loadPlugin(opts.install);
        await pm.setupAll();
        console.log(`✅ 插件已安装: ${plugin.descriptor.name} v${plugin.descriptor.version}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`❌ 插件安装失败: ${message}`);
      }
      return;
    }

    if (opts.uninstall) {
      const removed = await pm.unloadPlugin(opts.uninstall);
      if (removed) {
        console.log(`✅ 插件已卸载: ${opts.uninstall}`);
      } else {
        console.log(`❌ 插件不存在: ${opts.uninstall}`);
      }
      return;
    }

    // 默认列出所有插件
    const loadResult = await pm.loadAll();
    const plugins = pm.getPlugins();

    if (plugins.length === 0) {
      console.log('\n暂无已安装插件');
      console.log(`插件目录: ${pluginsDir}\n`);
      return;
    }

    console.log('\n📋 已安装插件:\n');
    for (const p of plugins) {
      const stateIcon = p.state === 'active' ? '✅' : p.state === 'error' ? '❌' : '⚠️';
      console.log(`  ${stateIcon} ${p.descriptor.name} v${p.descriptor.version} (${p.descriptor.type})`);
      if (p.descriptor.description) {
        console.log(`     ${p.descriptor.description}`);
      }
    }
    console.log(`\n  加载: ${loadResult.loaded}成功, ${loadResult.failed}失败\n`);
  });

// ---- clay metrics ----
program
  .command('metrics')
  .description('查看监控指标（Prometheus格式）')
  .option('--prometheus', '输出Prometheus格式')
  .action((opts: { prometheus?: boolean }) => {
    const mc = new MetricsCollector({ enabled: false });
    const snapshot = mc.getSnapshot();

    if (opts.prometheus) {
      console.log(mc.toPrometheusFormat());
      return;
    }

    console.log('\n📊 ClayCode 监控指标:\n');
    console.log(`  AI平均延迟: ${snapshot.aiLatencyAvg.toFixed(0)}ms`);
    console.log(`  AI P95延迟: ${snapshot.aiLatencyP95.toFixed(0)}ms`);
    console.log(`  内存使用: ${snapshot.memoryUsageMB}MB`);
    console.log(`  文件读取: ${snapshot.fileOpsRead}次`);
    console.log(`  文件写入: ${snapshot.fileOpsWrite}次`);
    console.log(`  命令成功率: ${(snapshot.commandSuccessRate * 100).toFixed(1)}%`);
    console.log(`  浏览器重启: ${snapshot.browserRestarts}次\n`);
  });

// ---- 辅助函数 ----

function printResponse(response: { code: number; msg: string; data?: { toolCalls?: unknown[]; appendChatMsg?: { role: string; content: string } } }): void {
  if (response.code !== 0) {
    console.log(`❌ 错误(${response.code}): ${response.msg}`);
    return;
  }

  if (response.data?.appendChatMsg?.content) {
    console.log(`🤖 ${response.data.appendChatMsg.content}`);
  }

  if (response.data?.toolCalls && response.data.toolCalls.length > 0) {
    console.log(`\n🔧 执行了 ${response.data.toolCalls.length} 个工具调用`);
  }

  console.log(`\n${response.msg}`);
}

// ---- 启动 ----
program.parse();