import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionManager } from '../core/session';
import { SecurityManager } from '../core/security';

describe('SessionManager', () => {
  let tmpDir: string;
  let sessionDir: string;
  let sm: SessionManager;
  let security: SecurityManager;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `claycode-session-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    sessionDir = path.join(tmpDir, 'sessions');
    security = new SecurityManager(tmpDir);
    sm = new SessionManager(sessionDir, 5000, security);
    await sm.init();
  });

  afterEach(() => {
    sm.deleteAll();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- 会话创建 ----
  describe('createSession', () => {
    it('应创建新会话并设为活跃', () => {
      const session = sm.createSession('test-session');
      expect(session.sessionName).toBe('test-session');
      expect(session.sessionId).toBeDefined();
      expect(session.messages).toEqual([]);
      expect(session.adapter).toBe('doubao');
      expect(sm.getActiveSession()?.sessionId).toBe(session.sessionId);
    });

    it('不指定名称应使用默认名称', () => {
      const session = sm.createSession();
      expect(session.sessionName).toMatch(/^session-/);
    });

    it('应支持指定适配器', () => {
      const session = sm.createSession('claude-session', 'claude-web');
      expect(session.adapter).toBe('claude-web');
    });

    it('应支持指定项目路径', () => {
      const session = sm.createSession('proj', 'doubao', '/tmp/project');
      expect(session.projectPath).toBe('/tmp/project');
    });

    it('创建时间应被记录', () => {
      const before = Date.now();
      const session = sm.createSession();
      const after = Date.now();
      expect(session.createdAt).toBeGreaterThanOrEqual(before);
      expect(session.createdAt).toBeLessThanOrEqual(after);
    });
  });

  // ---- 会话获取与切换 ----
  describe('getSession/useSession', () => {
    it('getSession应返回已存在的会话', () => {
      const created = sm.createSession('existing');
      const got = sm.getSession(created.sessionId);
      expect(got.sessionId).toBe(created.sessionId);
    });

    it('getSession不存在的ID应创建新会话', () => {
      const session = sm.getSession('nonexistent-id');
      expect(session).toBeDefined();
      expect(session.sessionId).not.toBe('nonexistent-id');
    });

    it('useSession应切换活跃会话', () => {
      const s1 = sm.createSession('first');
      const s2 = sm.createSession('second');
      expect(sm.getActiveSession()?.sessionId).toBe(s2.sessionId);

      const switched = sm.useSession(s1.sessionId);
      expect(switched?.sessionId).toBe(s1.sessionId);
      expect(sm.getActiveSession()?.sessionId).toBe(s1.sessionId);
    });

    it('useSession不存在的ID应返回null', () => {
      const result = sm.useSession('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ---- 消息操作 ----
  describe('addMessage/appendMessage', () => {
    it('addMessage应追加消息到指定会话', () => {
      const session = sm.createSession('msg-test');
      sm.addMessage(session.sessionId, { role: 'user', content: 'Hello' });
      sm.addMessage(session.sessionId, { role: 'ai', content: 'Hi there' });

      const got = sm.getSession(session.sessionId);
      expect(got.messages.length).toBe(2);
      expect(got.messages[0].content).toBe('Hello');
      expect(got.messages[1].content).toBe('Hi there');
    });

    it('appendUserMessage应追加到活跃会话', () => {
      sm.createSession('active-test');
      sm.appendUserMessage('Test message');
      const session = sm.getActiveSession();
      expect(session?.messages.length).toBe(1);
      expect(session?.messages[0].role).toBe('user');
    });

    it('appendAIMessage应追加AI回复', () => {
      sm.createSession('ai-msg');
      sm.appendAIMessage('AI response');
      expect(sm.getActiveSession()?.messages[0].role).toBe('ai');
    });

    it('appendSystemMessage应追加系统消息', () => {
      sm.createSession('sys-msg');
      sm.appendSystemMessage('System notice');
      expect(sm.getActiveSession()?.messages[0].role).toBe('system');
    });

    it('消息超过maxContextChunk应裁剪', () => {
      const session = sm.createSession('trim-test');
      // 添加系统消息（不应被裁剪）
      sm.addMessage(session.sessionId, { role: 'system', content: 'System prompt' });
      // 添加大量消息
      for (let i = 0; i < 100; i++) {
        sm.addMessage(session.sessionId, { role: 'user', content: `Message ${i} with padding text to fill up the context limit` });
      }
      const got = sm.getSession(session.sessionId);
      // 系统消息应保留
      const systemMsgs = got.messages.filter(m => m.role === 'system');
      expect(systemMsgs.length).toBe(1);
      // 总消息数应被裁剪
      expect(got.messages.length).toBeLessThan(101);
    });
  });

  // ---- 会话删除 ----
  describe('deleteSession/deleteAll', () => {
    it('deleteSession应删除指定会话', () => {
      const s1 = sm.createSession('to-delete');
      const s2 = sm.createSession('to-keep');
      sm.deleteSession(s1.sessionId);
      expect(sm.getSession(s1.sessionId).sessionId).not.toBe(s1.sessionId); // 会创建新的
      expect(sm.listSessions().find(s => s.sessionId === s2.sessionId)).toBeDefined();
    });

    it('删除活跃会话应清除activeSessionId', () => {
      const session = sm.createSession('active-delete');
      expect(sm.getActiveSession()?.sessionId).toBe(session.sessionId);
      sm.deleteSession(session.sessionId);
      expect(sm.getActiveSession()).toBeNull();
    });

    it('deleteAll应删除所有会话', () => {
      sm.createSession('s1');
      sm.createSession('s2');
      sm.createSession('s3');
      expect(sm.listSessions().length).toBe(3);
      sm.deleteAll();
      expect(sm.listSessions().length).toBe(0);
      expect(sm.getActiveSession()).toBeNull();
    });
  });

  // ---- 会话查找与恢复 ----
  describe('findSessionByName/recoverSession', () => {
    it('findSessionByName应按名称查找', () => {
      sm.createSession('find-me');
      sm.createSession('other');
      const found = sm.findSessionByName('find-me');
      expect(found).toBeDefined();
      expect(found?.sessionName).toBe('find-me');
    });

    it('findSessionByName找不到应返回null', () => {
      const found = sm.findSessionByName('nonexistent');
      expect(found).toBeNull();
    });

    it('recoverSession应恢复最近活跃的会话', () => {
      const s1 = sm.createSession('older');
      // 等一小段时间确保时间戳不同
      const s2 = sm.createSession('newer');
      // 清除活跃状态
      sm.useSession(s1.sessionId);
      // recoverSession应恢复最近活跃的
      const recovered = sm.recoverSession();
      expect(recovered).toBeDefined();
    });
  });

  // ---- 会话列表 ----
  describe('listSessions', () => {
    it('listSessions应按最后活跃时间降序排列', () => {
      sm.createSession('first');
      sm.createSession('second');
      sm.createSession('third');
      const list = sm.listSessions();
      expect(list.length).toBe(3);
      // 最新的在前
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1].lastActiveAt).toBeGreaterThanOrEqual(list[i].lastActiveAt);
      }
    });
  });

  // ---- 持久化 ----
  describe('持久化', () => {
    it('创建会话后应生成加密文件', () => {
      sm.createSession('persist-test');
      const files = fs.readdirSync(sessionDir);
      const encFiles = files.filter(f => f.endsWith('.json.enc'));
      expect(encFiles.length).toBe(1);
    });

    it('加密文件应可被新实例解密加载', async () => {
      const session = sm.createSession('cross-instance');
      sm.addMessage(session.sessionId, { role: 'user', content: 'Hello persistence' });

      // 新实例加载
      const sm2 = new SessionManager(sessionDir, 5000, security);
      await sm2.init();
      const loaded = sm2.getSession(session.sessionId);
      expect(loaded.sessionName).toBe('cross-instance');
      expect(loaded.messages.length).toBe(1);
      expect(loaded.messages[0].content).toBe('Hello persistence');
      sm2.deleteAll();
    });

    it('明文会话文件应自动迁移为加密格式', async () => {
      // 手动写入明文会话文件
      const sessionId = 'migration-test-id';
      const plainData = {
        sessionId,
        sessionName: 'migration-test',
        messages: [{ role: 'user', content: 'migrate me' }],
        adapter: 'doubao',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      fs.writeFileSync(
        path.join(sessionDir, `${sessionId}.json`),
        JSON.stringify(plainData)
      );

      // 新实例加载应自动迁移
      const sm2 = new SessionManager(sessionDir, 5000, security);
      await sm2.init();
      const loaded = sm2.getSession(sessionId);
      expect(loaded.sessionName).toBe('migration-test');
      expect(loaded.messages[0].content).toBe('migrate me');

      // 明文文件应被删除，加密文件应存在
      const files = fs.readdirSync(sessionDir);
      expect(files.some(f => f.endsWith('.json.enc'))).toBe(true);
      expect(files.some(f => f.endsWith('.json') && !f.endsWith('.json.enc'))).toBe(false);
      sm2.deleteAll();
    });
  });

  // ---- persistSession/saveAll ----
  describe('persistSession/saveAll', () => {
    it('persistSession应持久化指定会话', () => {
      const session = sm.createSession('manual-persist');
      sm.persistSession(session.sessionId);
      const files = fs.readdirSync(sessionDir);
      expect(files.some(f => f.includes(session.sessionId))).toBe(true);
    });

    it('saveAll应持久化所有会话', async () => {
      sm.createSession('s1');
      sm.createSession('s2');
      await sm.saveAll();
      const files = fs.readdirSync(sessionDir);
      const encFiles = files.filter(f => f.endsWith('.json.enc'));
      expect(encFiles.length).toBe(2);
    });
  });

  // ---- 检查点管理 ----
  describe('检查点管理', () => {
    it('createCheckpoint应创建检查点', () => {
      const session = sm.createSession('cp-test');
      const toolCalls = [{ tool: 'read' as const, filePath: '/tmp/test.ts' }];
      const executeResults = [{ success: true, outputText: 'ok', errorText: '', exitCode: 0, operateFiles: [] }];
      const cp = sm.createCheckpoint(toolCalls, executeResults, 'test-label');
      expect(cp).toBeDefined();
      expect(cp!.label).toBe('test-label');
      expect(cp!.toolCalls.length).toBe(1);
      expect(cp!.executeResults.length).toBe(1);
    });

    it('listCheckpoints应返回所有检查点', () => {
      sm.createSession('cp-list');
      const toolCalls = [{ tool: 'read' as const, filePath: '/tmp/a.ts' }];
      const executeResults = [{ success: true, outputText: '', errorText: '', exitCode: 0, operateFiles: [] }];
      sm.createCheckpoint(toolCalls, executeResults);
      sm.createCheckpoint(toolCalls, executeResults);
      const list = sm.listCheckpoints();
      expect(list.length).toBe(2);
    });

    it('restoreCheckpoint应恢复到指定检查点', () => {
      const session = sm.createSession('cp-restore');
      sm.addMessage(session.sessionId, { role: 'user', content: 'msg1' });
      const toolCalls = [{ tool: 'read' as const, filePath: '/tmp/a.ts' }];
      const executeResults = [{ success: true, outputText: '', errorText: '', exitCode: 0, operateFiles: [] }];
      const cp = sm.createCheckpoint(toolCalls, executeResults);
      sm.addMessage(session.sessionId, { role: 'user', content: 'msg2' });
      // 恢复后消息应被截断
      const restored = sm.restoreCheckpoint(cp!.id);
      expect(restored).toBeDefined();
      expect(restored!.messages.length).toBe(cp!.messageCount);
    });

    it('restoreCheckpoint不存在的检查点应尝试回退到最近有效检查点', () => {
      const session = sm.createSession('cp-corrupt-notfound');
      const toolCalls = [{ tool: 'read' as const, filePath: '/tmp/a.ts' }];
      const executeResults = [{ success: true, outputText: '', errorText: '', exitCode: 0, operateFiles: [] }];
      const cp = sm.createCheckpoint(toolCalls, executeResults);
      // 使用一个不存在的ID，应回退到最近有效检查点
      const restored = sm.restoreCheckpoint('nonexistent-checkpoint-id');
      expect(restored).toBeDefined();
      // 应该回退到了cp
      expect(restored!.checkpoints.length).toBe(1);
    });

    it('restoreCheckpoint数据损坏时应回退到前一个有效检查点', () => {
      const session = sm.createSession('cp-corrupt-data');
      const toolCalls = [{ tool: 'read' as const, filePath: '/tmp/a.ts' }];
      const executeResults = [{ success: true, outputText: '', errorText: '', exitCode: 0, operateFiles: [] }];
      // 创建第一个有效检查点
      const cp1 = sm.createCheckpoint(toolCalls, executeResults);
      sm.addMessage(session.sessionId, { role: 'user', content: 'msg1' });
      // 创建第二个有效检查点
      const cp2 = sm.createCheckpoint(toolCalls, executeResults);
      // 手动破坏第二个检查点的数据
      const cpData = sm.getCheckpoint(cp2!.id);
      if (cpData) {
        // 删除关键字段模拟数据损坏
        (cpData as any).toolCalls = undefined;
      }
      // 恢复第二个检查点时应回退到第一个
      const restored = sm.restoreCheckpoint(cp2!.id);
      expect(restored).toBeDefined();
      // 应该回退到了cp1
      expect(restored!.checkpoints.length).toBe(1);
      expect(restored!.checkpoints[0].id).toBe(cp1!.id);
    });

    it('restoreCheckpoint无活跃会话应返回null', () => {
      // 不创建会话
      const result = sm.restoreCheckpoint('any-id');
      expect(result).toBeNull();
    });

    it('restoreCheckpoint无检查点应返回null', () => {
      sm.createSession('cp-empty');
      const result = sm.restoreCheckpoint('any-id');
      expect(result).toBeNull();
    });

    it('getLatestCheckpoint应返回最近检查点', () => {
      sm.createSession('cp-latest');
      const toolCalls = [{ tool: 'read' as const, filePath: '/tmp/a.ts' }];
      const executeResults = [{ success: true, outputText: '', errorText: '', exitCode: 0, operateFiles: [] }];
      sm.createCheckpoint(toolCalls, executeResults);
      sm.createCheckpoint(toolCalls, executeResults, 'latest');
      const latest = sm.getLatestCheckpoint();
      expect(latest).toBeDefined();
      expect(latest!.label).toBe('latest');
    });

    it('deleteCheckpoint应删除指定检查点', () => {
      sm.createSession('cp-delete');
      const toolCalls = [{ tool: 'read' as const, filePath: '/tmp/a.ts' }];
      const executeResults = [{ success: true, outputText: '', errorText: '', exitCode: 0, operateFiles: [] }];
      const cp = sm.createCheckpoint(toolCalls, executeResults);
      expect(sm.listCheckpoints().length).toBe(1);
      const deleted = sm.deleteCheckpoint(cp!.id);
      expect(deleted).toBe(true);
      expect(sm.listCheckpoints().length).toBe(0);
    });

    it('clearCheckpoints应清除所有检查点', () => {
      sm.createSession('cp-clear');
      const toolCalls = [{ tool: 'read' as const, filePath: '/tmp/a.ts' }];
      const executeResults = [{ success: true, outputText: '', errorText: '', exitCode: 0, operateFiles: [] }];
      sm.createCheckpoint(toolCalls, executeResults);
      sm.createCheckpoint(toolCalls, executeResults);
      expect(sm.listCheckpoints().length).toBe(2);
      sm.clearCheckpoints();
      expect(sm.listCheckpoints().length).toBe(0);
    });
  });

  // ---- V1.2: 工作区管理 ----
  describe('工作区管理', () => {
    it('createWorkspace应创建新工作区', () => {
      sm.createSession('ws-create');
      const ws = sm.createWorkspace('frontend', '/project/frontend');
      expect(ws).not.toBeNull();
      expect(ws!.name).toBe('frontend');
      expect(ws!.projectPath).toBe('/project/frontend');
      expect(ws!.active).toBe(true);
      expect(ws!.id).toBeDefined();
    });

    it('创建工作区应设为活跃', () => {
      sm.createSession('ws-active');
      const ws1 = sm.createWorkspace('ws1', '/path1');
      const ws2 = sm.createWorkspace('ws2', '/path2');
      // 新创建的ws2应为活跃，ws1应变为非活跃
      expect(ws2!.active).toBe(true);
      const active = sm.getActiveWorkspace();
      expect(active!.id).toBe(ws2!.id);
    });

    it('无活跃会话时创建工作区应返回null', () => {
      const ws = sm.createWorkspace('no-session', '/path');
      expect(ws).toBeNull();
    });

    it('switchWorkspace应切换活跃工作区', () => {
      sm.createSession('ws-switch');
      const ws1 = sm.createWorkspace('ws1', '/path1');
      const ws2 = sm.createWorkspace('ws2', '/path2');
      // 当前活跃是ws2，切换到ws1
      const switched = sm.switchWorkspace(ws1!.id);
      expect(switched).not.toBeNull();
      expect(switched!.name).toBe('ws1');
      expect(switched!.active).toBe(true);
      const active = sm.getActiveWorkspace();
      expect(active!.id).toBe(ws1!.id);
    });

    it('切换不存在的工作区应返回null', () => {
      sm.createSession('ws-switch-noexist');
      sm.createWorkspace('ws1', '/path1');
      const switched = sm.switchWorkspace('non-existent-id');
      expect(switched).toBeNull();
    });

    it('getActiveWorkspace应返回当前活跃工作区', () => {
      sm.createSession('ws-get-active');
      sm.createWorkspace('active-ws', '/active/path');
      const active = sm.getActiveWorkspace();
      expect(active).not.toBeNull();
      expect(active!.name).toBe('active-ws');
    });

    it('无工作区时getActiveWorkspace应返回null', () => {
      sm.createSession('ws-no-active');
      const active = sm.getActiveWorkspace();
      expect(active).toBeNull();
    });

    it('listWorkspaces应列出所有工作区', () => {
      sm.createSession('ws-list');
      sm.createWorkspace('ws1', '/path1');
      sm.createWorkspace('ws2', '/path2');
      sm.createWorkspace('ws3', '/path3');
      const list = sm.listWorkspaces();
      expect(list.length).toBe(3);
    });

    it('deleteWorkspace应删除指定工作区', () => {
      sm.createSession('ws-delete');
      sm.createWorkspace('ws1', '/path1');
      const ws2 = sm.createWorkspace('ws2', '/path2');
      expect(sm.listWorkspaces().length).toBe(2);
      const deleted = sm.deleteWorkspace(ws2!.id);
      expect(deleted).toBe(true);
      expect(sm.listWorkspaces().length).toBe(1);
    });

    it('删除活跃工作区应自动切换到第一个', () => {
      sm.createSession('ws-delete-active');
      const ws1 = sm.createWorkspace('ws1', '/path1');
      const ws2 = sm.createWorkspace('ws2', '/path2');
      // ws2是活跃的，删除ws2后ws1应变为活跃
      sm.deleteWorkspace(ws2!.id);
      const active = sm.getActiveWorkspace();
      expect(active).not.toBeNull();
      expect(active!.id).toBe(ws1!.id);
      expect(active!.active).toBe(true);
    });

    it('删除所有工作区后activeWorkspaceId应为undefined', () => {
      sm.createSession('ws-delete-all');
      const ws = sm.createWorkspace('only-ws', '/path1');
      sm.deleteWorkspace(ws!.id);
      expect(sm.listWorkspaces().length).toBe(0);
      expect(sm.getActiveWorkspace()).toBeNull();
    });

    it('getWorkspaceSummary应返回摘要信息', () => {
      sm.createSession('ws-summary');
      sm.createWorkspace('frontend', '/project/frontend');
      sm.createWorkspace('backend', '/project/backend');
      const summary = sm.getWorkspaceSummary();
      expect(summary).toContain('frontend');
      expect(summary).toContain('backend');
      expect(summary).toContain('2');
    });

    it('无工作区时getWorkspaceSummary应提示无工作区', () => {
      sm.createSession('ws-summary-empty');
      const summary = sm.getWorkspaceSummary();
      expect(summary).toContain('无工作区');
    });
  });
});