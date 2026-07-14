#!/usr/bin/env node
/**
 * ClayCode CLI 入口
 * clay agent/chat/login/config/session/log/doctor/plugin/watch
 */

import { Command } from 'commander';
import { ClayCodeEngine } from '../core/index';
import { ConfigManager } from '../core/config';
import { SessionManager } from '../core/session';
import { PluginManager } from '../core/plugin';
import { PluginMarketManager } from '../core/plugin-market';
import { MetricsCollector } from '../core/metrics';
import { WebPanelManager } from '../core/web-panel';
import { ReportExporter } from '../core/report';
import { FileWatcher } from '../core/watcher';
import { logger, LogLevel } from '../utils';
import { CommandHistory } from '../utils/history';
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

      // 初始化命令历史持久化
      const commandHistory = new CommandHistory();

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> ',
      });

      // 注入历史记录到readline
      commandHistory.injectToReadline(rl);

      rl.prompt();

      rl.on('line', async (line: string) => {
        const input = line.trim();
        if (!input) {
          rl.prompt();
          return;
        }

        // 记录命令到历史
        commandHistory.add(input);

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

    // 先注册SIGINT处理（在login之前，确保任何时候Ctrl+C都能保存状态）
    let isShuttingDown = false;
    const onSigInt = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log('\n💾 正在保存登录状态...');
      try {
        await engine.saveLoginState();
        console.log('✅ 登录状态已保存');
      } catch {
        console.warn('⚠️ Cookie保存失败，但浏览器登录态可能已保留');
      }
      await engine.dispose();
      process.exit(0);
    };
    process.on('SIGINT', onSigInt);

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
    await sm.init();
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
  .action(async (sessionId: string) => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    await sm.init();
    const session = sm.resolveSession(sessionId);
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
  .action(async () => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    await sm.init();
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
  .action(async () => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    await sm.init();
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
  .action(async (sessionId: string) => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    await sm.init();
    const session = sm.resolveSession(sessionId);
    if (session) {
      sm.deleteSession(session.sessionId);
      console.log(`✅ 会话 ${session.sessionName} (${session.sessionId}) 已删除`);
    } else {
      console.log(`❌ 会话不存在: ${sessionId}`);
    }
  });

// ---- clay session checkpoint (V1.2) ----
const checkpointCmd = sessionCmd
  .command('checkpoint')
  .description('管理会话检查点');

checkpointCmd
  .command('list')
  .description('列出当前会话的检查点')
  .option('-s, --session <id>', '会话ID或名称')
  .action(async (opts: { session?: string }) => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    await sm.init();

    const sessionId = opts.session;
    if (sessionId) {
      const session = sm.resolveSession(sessionId);
      if (!session) {
        console.log(`❌ 会话不存在: ${sessionId}`);
        return;
      }
      sm.useSession(session.sessionId);
    }

    const summary = sm.getCheckpointSummary();
    if (!summary) {
      console.log('暂无检查点');
      return;
    }
    console.log('\n📋 检查点列表:\n');
    console.log(summary);
  });

checkpointCmd
  .command('restore')
  .description('从检查点恢复会话')
  .argument('<checkpoint-id>', '检查点ID')
  .option('-s, --session <id>', '会话ID或名称')
  .action(async (checkpointId: string, opts: { session?: string }) => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    await sm.init();

    const sessionId = opts.session;
    if (sessionId) {
      const session = sm.resolveSession(sessionId);
      if (!session) {
        console.log(`❌ 会话不存在: ${sessionId}`);
        return;
      }
      sm.useSession(session.sessionId);
    }

    const restored = sm.restoreSessionCheckpoint(
      sm.getActiveSession()?.sessionId || '',
      checkpointId,
    );
    if (restored) {
      sm.persistSession(restored.sessionId);
      console.log(`✅ 已从检查点 ${checkpointId} 恢复会话`);
      console.log(`   消息数: ${restored.messages.length}, 检查点数: ${restored.checkpoints?.length || 0}`);
    } else {
      console.log(`❌ 检查点不存在或恢复失败: ${checkpointId}`);
    }
  });

// ---- clay session workspace (V1.2) ----
const workspaceCmd = sessionCmd
  .command('workspace')
  .description('管理工作区');

workspaceCmd
  .command('new')
  .description('创建新工作区')
  .argument('<name>', '工作区名称')
  .option('-p, --path <path>', '项目路径', process.cwd())
  .option('-s, --session <id>', '会话ID或名称')
  .action(async (name: string, opts: { path: string; session?: string }) => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    await sm.init();

    const sessionId = opts.session;
    if (sessionId) {
      const session = sm.resolveSession(sessionId);
      if (!session) {
        console.log(`❌ 会话不存在: ${sessionId}`);
        return;
      }
      sm.useSession(session.sessionId);
    }

    const workspace = sm.createWorkspace(name, opts.path);
    if (workspace) {
      console.log(`✅ 已创建工作区: ${workspace.name} (${workspace.id})`);
      console.log(`   项目路径: ${workspace.projectPath}`);
    } else {
      console.log('❌ 创建工作区失败（无活跃会话）');
    }
  });

workspaceCmd
  .command('switch')
  .description('切换到指定工作区')
  .argument('<workspace-id>', '工作区ID')
  .option('-s, --session <id>', '会话ID或名称')
  .action(async (workspaceId: string, opts: { session?: string }) => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    await sm.init();

    const sessionId = opts.session;
    if (sessionId) {
      const session = sm.resolveSession(sessionId);
      if (!session) {
        console.log(`❌ 会话不存在: ${sessionId}`);
        return;
      }
      sm.useSession(session.sessionId);
    }

    const workspace = sm.switchWorkspace(workspaceId);
    if (workspace) {
      console.log(`✅ 已切换到工作区: ${workspace.name} (${workspace.id})`);
      console.log(`   项目路径: ${workspace.projectPath}`);
    } else {
      console.log(`❌ 工作区不存在: ${workspaceId}`);
    }
  });

workspaceCmd
  .command('list')
  .description('列出所有工作区')
  .option('-s, --session <id>', '会话ID或名称')
  .action(async (opts: { session?: string }) => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    await sm.init();

    const sessionId = opts.session;
    if (sessionId) {
      const session = sm.resolveSession(sessionId);
      if (!session) {
        console.log(`❌ 会话不存在: ${sessionId}`);
        return;
      }
      sm.useSession(session.sessionId);
    }

    const summary = sm.getWorkspaceSummary();
    if (!summary) {
      console.log('暂无工作区');
      return;
    }
    console.log('\n📋 工作区列表:\n');
    console.log(summary);
  });

workspaceCmd
  .command('delete')
  .description('删除指定工作区')
  .argument('<workspace-id>', '工作区ID')
  .option('-s, --session <id>', '会话ID或名称')
  .action(async (workspaceId: string, opts: { session?: string }) => {
    const cm = new ConfigManager();
    const sm = new SessionManager(cm.getSessionDir());
    await sm.init();

    const sessionId = opts.session;
    if (sessionId) {
      const session = sm.resolveSession(sessionId);
      if (!session) {
        console.log(`❌ 会话不存在: ${sessionId}`);
        return;
      }
      sm.useSession(session.sessionId);
    }

    const deleted = sm.deleteWorkspace(workspaceId);
    if (deleted) {
      console.log(`✅ 工作区 ${workspaceId} 已删除`);
    } else {
      console.log(`❌ 工作区不存在: ${workspaceId}`);
    }
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

// ---- clay watch (V1.2) ----
program
  .command('watch')
  .description('开启文件变更监听会话')
  .option('-d, --debounce <ms>', '防抖间隔(毫秒)', '300')
  .option('-i, --idle <ms>', '闲置超时(毫秒)', '1800000')
  .option('-r, --recursive', '递归监听子目录', true)
  .action(async (opts: { debounce: string; idle: string; recursive: boolean }) => {
    const projectRoot = process.cwd();
    const debounceMs = parseInt(opts.debounce, 10) || 300;
    const idleTimeoutMs = parseInt(opts.idle, 10) || 30 * 60 * 1000;

    console.log(`\n👁️ ClayCode 文件变更监听`);
    console.log(`   项目目录: ${projectRoot}`);
    console.log(`   防抖间隔: ${debounceMs}ms`);
    console.log(`   闲置超时: ${idleTimeoutMs / 1000}s`);
    console.log(`   按 Ctrl+C 退出\n`);

    const watcher = new FileWatcher({
      projectRoot,
      debounceMs,
      idleTimeoutMs,
      recursive: opts.recursive,
      onChange: (changes) => {
        const now = new Date().toLocaleTimeString();
        for (const change of changes) {
          const icon = change.event === 'create' ? '📄+' : change.event === 'delete' ? '📄-' : '📄~';
          console.log(`  [${now}] ${icon} ${change.event.toUpperCase().padEnd(6)} ${change.filePath}`);
        }
      },
    });

    watcher.start();

    // 监听 Ctrl+C 优雅退出
    process.on('SIGINT', () => {
      console.log('\n\n🛑 正在停止文件监听...');
      watcher.stop();
      console.log('✅ 文件监听已停止');
      process.exit(0);
    });

    // 保持进程运行
    await new Promise(() => { /* 永久等待直到 Ctrl+C */ });
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

// ---- clay deps ----
program
  .command('deps')
  .description('查看文件依赖图谱')
  .option('-f, --file <file>', '查看指定文件的依赖关系')
  .option('-t, --transitive <file>', '查看传递依赖（间接依赖）')
  .option('-d, --depth <depth>', '传递依赖最大深度', '5')
  .option('-c, --cycles', '检测循环依赖')
  .option('-s, --stats', '显示依赖图谱统计信息')
  .action(async (options) => {
    const { CodeIndexer } = await import('../core/code-index');
    const indexer = new CodeIndexer(process.cwd());
    indexer.indexProject();

    if (options.stats) {
      const graph = indexer.buildDependencyGraph();
      console.log('\n📊 依赖图谱统计\n');
      console.log(`  文件节点: ${graph.nodes.size}`);
      console.log(`  依赖边数: ${graph.totalEdges}`);
      console.log(`  循环依赖: ${graph.cycles.length}`);
      if (graph.cycles.length > 0) {
        console.log('\n  ⚠️  检测到循环依赖:');
        for (const cycle of graph.cycles) {
          console.log(`    ${cycle.join(' → ')} → ${cycle[0]}`);
        }
      }
      console.log('');
      return;
    }

    if (options.cycles) {
      const graph = indexer.buildDependencyGraph();
      console.log('\n🔄 循环依赖检测\n');
      if (graph.cycles.length === 0) {
        console.log('  ✅ 未检测到循环依赖\n');
      } else {
        console.log(`  ⚠️  发现 ${graph.cycles.length} 个循环依赖:\n`);
        for (let i = 0; i < graph.cycles.length; i++) {
          const cycle = graph.cycles[i];
          console.log(`  ${i + 1}. ${cycle.join(' → ')} → ${cycle[0]}`);
        }
        console.log('');
      }
      return;
    }

    if (options.transitive) {
      const filePath = path.resolve(options.transitive);
      const relPath = path.relative(process.cwd(), filePath);
      const deps = indexer.getTransitiveDependencies(relPath, parseInt(options.depth));
      console.log(`\n🔗 ${relPath} 的传递依赖 (深度≤${options.depth})\n`);
      if (deps.length === 0) {
        console.log('  (无传递依赖)');
      } else {
        for (const dep of deps) {
          console.log(`  → ${dep}`);
        }
      }
      console.log('');
      return;
    }

    if (options.file) {
      const filePath = path.resolve(options.file);
      const relPath = path.relative(process.cwd(), filePath);
      const node = indexer.getFileDependencies(relPath);
      console.log(`\n📦 ${relPath} 的依赖关系\n`);
      if (!node) {
        console.log('  (文件未在索引中)');
      } else {
        console.log(`  语言: ${node.language}`);
        console.log(`  符号数: ${node.symbolCount}`);
        if (node.dependencies.length > 0) {
          console.log(`\n  依赖 (${node.dependencies.length}):`);
          for (const dep of node.dependencies) {
            console.log(`    → ${dep}`);
          }
        } else {
          console.log('\n  依赖: (无)');
        }
        if (node.dependents.length > 0) {
          console.log(`\n  被依赖 (${node.dependents.length}):`);
          for (const dep of node.dependents) {
            console.log(`    ← ${dep}`);
          }
        } else {
          console.log('\n  被依赖: (无)');
        }
      }
      console.log('');
      return;
    }

    // 默认：显示图谱概览
    const graph = indexer.buildDependencyGraph();
    console.log('\n📊 项目依赖图谱\n');
    console.log(`  文件: ${graph.nodes.size}  依赖边: ${graph.totalEdges}  循环: ${graph.cycles.length}\n`);
    
    const sortedNodes = [...graph.nodes.values()]
      .sort((a, b) => b.dependencies.length - a.dependencies.length)
      .slice(0, 20);
    
    console.log('  依赖最多的文件 (Top 20):');
    for (const node of sortedNodes) {
      console.log(`    ${path.relative(process.cwd(), node.filePath)} (${node.dependencies.length}个依赖)`);
    }
    console.log('');
  });

// ---- clay plugin ----
program
  .command('plugin')
  .description('管理插件')
  .option('-l, --list', '列出已加载插件')
  .option('-i, --install <path>', '安装插件（指定插件目录路径）')
  .option('-u, --uninstall <name>', '卸载插件')
  .option('-r, --reload <name>', '热重载指定插件')
  .option('--reload-all', '热重载所有已变更插件')
  .option('-w, --watch', '启动插件目录文件监听（自动热重载）')
  .action(async (opts: { list?: boolean; install?: string; uninstall?: string; reload?: string; reloadAll?: boolean; watch?: boolean }) => {
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

    if (opts.reload) {
      await pm.loadAll();
      const result = await pm.reloadPlugin(opts.reload);
      if (result) {
        console.log(`✅ 插件热重载成功: ${opts.reload} v${result.descriptor.version}`);
      } else {
        console.log(`❌ 插件热重载失败: ${opts.reload}`);
      }
      return;
    }

    if (opts.reloadAll) {
      await pm.loadAll();
      const result = await pm.hotReload();
      console.log('\n🔄 插件热重载结果:\n');
      if (result.reloaded.length > 0) console.log(`  重载: ${result.reloaded.join(', ')}`);
      if (result.added.length > 0) console.log(`  新增: ${result.added.join(', ')}`);
      if (result.removed.length > 0) console.log(`  移除: ${result.removed.join(', ')}`);
      if (result.errors.length > 0) console.log(`  错误: ${result.errors.join(', ')}`);
      if (result.reloaded.length + result.added.length + result.removed.length === 0) {
        console.log('  无变更');
      }
      console.log('');
      return;
    }

    if (opts.watch) {
      await pm.loadAll();
      await pm.setupAll();
      pm.watchPlugins();
      console.log(`\n👀 正在监听插件目录: ${pluginsDir}`);
      console.log('  插件文件变更将自动触发热重载');
      console.log('  按 Ctrl+C 停止监听\n');

      // 优雅退出
      process.on('SIGINT', () => {
        pm.stopWatching();
        console.log('\n已停止插件监听');
        process.exit(0);
      });

      // 保持进程运行
      setInterval(() => {}, 60000);
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

// ---- clay plugin market (V1.1) ----
program
  .command('market')
  .description('插件市场管理')
  .option('-s, --search <keyword>', '搜索插件')
  .option('-i, --install <name>', '从市场安装插件')
  .option('--info <name>', '查看插件详情')
  .option('-p, --publish <dir>', '发布插件到市场（指定插件目录）')
  .option('-l, --list', '列出市场所有插件')
  .option('--type <type>', '按类型过滤 (adapter/tool/hook)')
  .option('--sync', '从远程注册表同步')
  .action(async (opts: {
    search?: string; install?: string; info?: string; publish?: string;
    list?: boolean; type?: string; sync?: boolean;
  }) => {
    const cm = new ConfigManager();
    const pluginsDir = cm.getPluginsDir();
    const market = new PluginMarketManager({ registryDir: pluginsDir });

    if (opts.search) {
      const result = market.search(opts.search, {
        type: opts.type as 'adapter' | 'tool' | 'hook' | undefined,
      });
      if (result.entries.length === 0) {
        console.log(`\n未找到与 "${opts.search}" 相关的插件\n`);
        return;
      }
      console.log(`\n🔍 搜索 "${opts.search}" (${result.total}个结果):\n`);
      for (const e of result.entries) {
        console.log(`  ${e.name} v${e.version} (${e.type}) - ${e.description}`);
        console.log(`    作者: ${e.author} | 下载: ${e.downloads} | 标签: ${e.tags.join(', ')}`);
      }
      console.log();
      return;
    }

    if (opts.install) {
      console.log(`\n📦 从市场安装插件: ${opts.install}`);
      const result = await market.install(opts.install, pluginsDir);
      if (result.success) {
        console.log(`✅ ${result.message}`);
      } else {
        console.error(`❌ ${result.message}`);
      }
      return;
    }

    if (opts.info) {
      const entry = market.info(opts.info);
      if (!entry) {
        console.log(`\n未找到插件: ${opts.info}\n`);
        return;
      }
      console.log(`\n📋 插件详情:\n`);
      console.log(`  名称: ${entry.name}`);
      console.log(`  版本: ${entry.version}`);
      console.log(`  类型: ${entry.type}`);
      console.log(`  描述: ${entry.description}`);
      console.log(`  作者: ${entry.author}`);
      console.log(`  来源: ${entry.sourceUrl}`);
      console.log(`  下载: ${entry.downloads}`);
      console.log(`  标签: ${entry.tags.join(', ')}`);
      console.log(`  发布: ${new Date(entry.publishedAt).toLocaleString('zh-CN')}`);
      console.log(`  更新: ${new Date(entry.updatedAt).toLocaleString('zh-CN')}`);
      console.log();
      return;
    }

    if (opts.publish) {
      const dir = opts.publish;
      if (!fs.existsSync(path.join(dir, 'plugin.json'))) {
        console.error(`\n❌ 插件目录缺少 plugin.json: ${dir}\n`);
        return;
      }
      try {
        const raw = fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8');
        const descriptor = JSON.parse(raw);
        const result = market.publish({
          name: descriptor.name,
          version: descriptor.version,
          type: descriptor.type,
          description: descriptor.description || '',
          author: descriptor.author || 'unknown',
          sourceUrl: `file://${path.resolve(dir)}`,
          tags: descriptor.tags || [],
        });
        if (result.success) {
          console.log(`\n✅ ${result.message}\n`);
        } else {
          console.error(`\n❌ ${result.message}\n`);
        }
      } catch (err: unknown) {
        console.error(`\n❌ 发布失败: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return;
    }

    if (opts.sync) {
      console.log('\n🔄 同步远程注册表...');
      const result = await market.syncFromRemote();
      if (result.success) {
        console.log(`✅ ${result.message}`);
      } else {
        console.error(`❌ ${result.message}`);
      }
      return;
    }

    // 默认列出市场所有插件
    const entries = market.list({
      type: opts.type as 'adapter' | 'tool' | 'hook' | undefined,
    });
    if (entries.length === 0) {
      console.log('\n市场暂无插件\n');
      return;
    }
    console.log(`\n🏪 插件市场 (${entries.length}个):\n`);
    for (const e of entries) {
      console.log(`  ${e.name} v${e.version} (${e.type}) - ${e.description}`);
      console.log(`    作者: ${e.author} | 下载: ${e.downloads}`);
    }
    console.log();
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

// ---- clay web (V1.2 Web管理面板) ----
program
  .command('web')
  .description('启动Web管理面板')
  .option('-p, --port <port>', 'HTTP端口', '18080')
  .option('--host <host>', '绑定主机', 'localhost')
  .option('--no-open', '不自动打开浏览器')
  .action(async (opts: { port: string; host: string; open?: boolean }) => {
    const panel = new WebPanelManager({
      port: parseInt(opts.port, 10),
      host: opts.host,
      openBrowser: opts.open !== false,
    });

    try {
      await panel.start();
      const url = panel.getUrl();
      console.log(`\n🌐 Web管理面板已启动: ${url}`);
      console.log('按 Ctrl+C 停止服务\n');

      // 优雅关闭
      process.on('SIGINT', async () => {
        console.log('\n正在关闭Web面板...');
        await panel.stop();
        process.exit(0);
      });

      // 保持进程运行
      await new Promise<void>(() => {});
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ Web面板启动失败: ${message}`);
      process.exit(1);
    }
  });

// ---- clay report (V1.2 批量导出Markdown报告) ----
program
  .command('report')
  .description('导出任务修改记录Markdown报告')
  .option('-o, --output <dir>', '输出目录', process.cwd())
  .option('-t, --title <title>', '报告标题', 'ClayCode 任务报告')
  .option('-s, --session <id>', '指定会话ID（默认导出所有会话）')
  .option('--no-chat', '不包含对话记录')
  .option('--no-changes', '不包含文件变更记录')
  .option('--no-metrics', '不包含执行统计')
  .action((opts: { output: string; title: string; session?: string; chat?: boolean; changes?: boolean; metrics?: boolean }) => {
    const exporter = new ReportExporter();

    const result = exporter.exportReport({
      outputDir: opts.output,
      title: opts.title,
      sessionId: opts.session,
      includeChatHistory: opts.chat !== false,
      includeFileChanges: opts.changes !== false,
      includeMetrics: opts.metrics !== false,
    });

    if (result.success) {
      console.log(`\n✅ ${result.message}`);
      console.log(`   会话数: ${result.sessionCount}`);
      console.log(`   文件变更: ${result.fileChangeCount}条`);
      console.log(`   生成时间: ${new Date(result.generatedAt).toLocaleString('zh-CN')}\n`);
    } else {
      console.error(`\n❌ ${result.message}\n`);
      process.exit(1);
    }
  });

// ---- clay completion ----
program
  .command('completion')
  .description('生成Shell自动补全脚本')
  .argument('<shell>', 'Shell类型: bash | zsh')
  .action((shell: string) => {
    if (shell === 'bash') {
      console.log(generateBashCompletion());
    } else if (shell === 'zsh') {
      console.log(generateZshCompletion());
    } else {
      console.error('不支持的Shell类型，请使用 bash 或 zsh');
      process.exit(1);
    }
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

/**
 * 生成Bash自动补全脚本
 */
function generateBashCompletion(): string {
  return `# ClayCode Bash 自动补全
# 安装: clay completion bash >> ~/.bashrc
# 或:   clay completion bash >> ~/.bash_profile

_clay_completion() {
  local cur prev commands options adapters config_keys session_actions
  
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  
  commands="agent chat login config session log doctor deps plugin metrics market web report completion"
  adapters="doubao chatgpt-web claude-web ollama kimi qwen"
  config_keys="defaultAdapter dataDir browserDataPath chromePath sessionDir maxContextChunk maxHistoryMessages requestTimeout responseTimeout autoSyncExecuteLog browserHeadless execWhiteList enableSandbox cacheLevel maxBatchFiles browserIdleTimeout maxRetryCount ollamaEndpoint enableDockerSandbox metricsPort apiKey proxyUrl"
  session_actions="new use recover list delete"
  
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
    return 0
  fi
  
  case "\${prev}" in
    -a|--adapter)
      COMPREPLY=($(compgen -W "\${adapters}" -- "\${cur}"))
      return 0
      ;;
    clay)
      COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
      return 0
      ;;
    config)
      COMPREPLY=($(compgen -W "set get list reset" -- "\${cur}"))
      return 0
      ;;
    session)
      COMPREPLY=($(compgen -W "\${session_actions}" -- "\${cur}"))
      return 0
      ;;
    set)
      COMPREPLY=($(compgen -W "\${config_keys}" -- "\${cur}"))
      return 0
      ;;
    completion)
      COMPREPLY=($(compgen -W "bash zsh" -- "\${cur}"))
      return 0
      ;;
  esac
  
  # 子命令补全
  local subcmd="\${COMP_WORDS[1]}"
  case "\${subcmd}" in
    config|session)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        if [[ "\${subcmd}" == "config" ]]; then
          COMPREPLY=($(compgen -W "set get list reset" -- "\${cur}"))
        else
          COMPREPLY=($(compgen -W "\${session_actions}" -- "\${cur}"))
        fi
      fi
      ;;
  esac
  
  return 0
}

complete -F _clay_completion clay
`;
}

/**
 * 生成Zsh自动补全脚本
 */
function generateZshCompletion(): string {
  return `#compdef clay
# ClayCode Zsh 自动补全
# 安装: clay completion zsh > ~/.zfunc/_clay
# 并确保 ~/.zshrc 中有: fpath+=~/.zfunc && autoload -U compinit && compinit

_clay() {
  local -a commands adapters config_keys session_actions
  
  commands=(
    'agent:Agent模式，自主执行编码任务'
    'chat:交互式对话模式'
    'login:打开浏览器登录AI平台'
    'config:查看或修改配置'
    'session:管理会话'
    'log:查看日志'
    'doctor:诊断环境问题'
    'deps:查看文件依赖图谱'
    'plugin:管理插件'
    'market:插件市场管理'
    'metrics:查看监控指标'
    'web:启动Web管理面板'
    'report:导出任务报告'
    'completion:生成Shell自动补全脚本'
  )
  
  adapters=('doubao:豆包' 'chatgpt-web:ChatGPT网页版' 'claude-web:Claude网页版' 'ollama:Ollama本地模型' 'kimi:Kimi' 'qwen:通义千问')
  
  config_keys=(
    'defaultAdapter:默认AI适配器'
    'dataDir:数据根目录'
    'browserDataPath:浏览器数据路径'
    'chromePath:Chrome路径'
    'sessionDir:会话目录'
    'maxContextChunk:最大上下文分块'
    'maxHistoryMessages:最大历史消息数'
    'requestTimeout:请求超时'
    'responseTimeout:回复超时'
    'browserHeadless:浏览器无头模式'
    'enableSandbox:启用沙箱'
    'cacheLevel:缓存级别'
    'ollamaEndpoint:Ollama端点'
    'apiKey:API密钥'
    'proxyUrl:代理URL'
  )
  
  session_actions=('new:新建会话' 'use:切换会话' 'recover:恢复会话' 'list:列出会话' 'delete:删除会话')
  
  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'
  
  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        agent)
          _arguments \\
            '-a[AI适配器]:adapter:($adapters)' \\
            '-s[会话ID]:session-id:' \\
            '-r[最大轮次]:rounds:' \\
            '--cwd[工作目录]:dir:_dirs' \\
            '1:task:'
          ;;
        chat)
          _arguments \\
            '-a[AI适配器]:adapter:($adapters)' \\
            '-s[会话ID]:session-id:' \\
            '--cwd[工作目录]:dir:_dirs'
          ;;
        login)
          _arguments '-a[AI适配器]:adapter:($adapters)'
          ;;
        config)
          case $words[2] in
            set)
              _arguments \\
                '1:config key:($config_keys)' \\
                '2:config value:'
              ;;
            get)
              _arguments '1:config key:($config_keys)'
              ;;
            *)
              _describe 'config action' 'set:get:list:reset'
              ;;
          esac
          ;;
        session)
          case $words[2] in
            new|use|recover|delete)
              ;;
            *)
              _describe 'session action' session_actions
              ;;
          esac
          ;;
        completion)
          _arguments '1:shell:(bash zsh)'
          ;;
      esac
      ;;
  esac
}

_clay "$@"
`;
}

// ---- 启动 ----
program.parse();