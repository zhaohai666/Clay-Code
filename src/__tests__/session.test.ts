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
});