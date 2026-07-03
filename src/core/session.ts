/**
 * ClayCode 会话管理模块
 * 会话创建、切换、恢复、AES加密持久化存储
 * 存储路径：~/.claycode/sessions/[session-id].json.enc
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SessionState, ChatMessage, AdapterType, ErrorCode } from '../types';
import { ensureDir, logger } from '../utils';
import { SecurityManager } from './security';

/** 会话文件扩展名（加密） */
const SESSION_EXT = '.json.enc';
/** 会话文件扩展名（明文，向后兼容） */
const SESSION_EXT_PLAIN = '.json';

export class SessionManager {
  /** 内存中的会话缓存 */
  private sessions: Map<string, SessionState> = new Map();

  /** 当前活跃会话ID */
  private activeSessionId: string | null = null;

  /** 最大上下文长度 */
  private maxContextChunk: number;

  /** 会话存储目录 */
  private sessionDir: string;

  /** 安全管理器（用于AES加密） */
  private security: SecurityManager;

  /** 是否启用加密 */
  private enableEncryption: boolean;

  constructor(sessionDir?: string, maxContextChunk: number = 12000, security?: SecurityManager) {
    this.sessionDir = sessionDir || path.join(os.homedir(), '.claycode', 'sessions');
    this.maxContextChunk = maxContextChunk;
    this.security = security ?? new SecurityManager(process.cwd());
    this.enableEncryption = true;
  }

  /** 初始化：加载持久化会话 */
  async init(): Promise<void> {
    ensureDir(this.sessionDir);
    await this.loadSessions();
    logger.info(`[SessionManager] 初始化完成，已加载 ${this.sessions.size} 个会话`);
  }

  /** 创建新会话 */
  createSession(name?: string, adapter?: AdapterType, projectPath?: string): SessionState {
    const sessionId = crypto.randomUUID();
    const session: SessionState = {
      sessionId,
      sessionName: name || `session-${sessionId.slice(0, 8)}`,
      messages: [],
      adapter: adapter ?? 'doubao',
      projectPath,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    this.activeSessionId = sessionId;
    this.saveSession(session);
    logger.info(`[SessionManager] 创建新会话: ${session.sessionName} (${sessionId.slice(0, 8)})`);
    return session;
  }

  /** 获取指定会话（不存在则创建） */
  getSession(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn(`[SessionManager] 会话不存在: ${sessionId}，创建新会话`);
      session = this.createSession();
    }
    return session;
  }

  /** 获取当前活跃会话 */
  getActiveSession(): SessionState | null {
    if (!this.activeSessionId) return null;
    return this.sessions.get(this.activeSessionId) ?? null;
  }

  /** 切换到指定会话 */
  useSession(sessionId: string): SessionState | null {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.activeSessionId = sessionId;
      logger.info(`[SessionManager] 切换到会话: ${session.sessionName}`);
      return session;
    }
    logger.warn(`[SessionManager] 会话不存在: ${sessionId}`);
    return null;
  }

  /** 通过名称查找会话 */
  findSessionByName(name: string): SessionState | null {
    for (const [, session] of this.sessions) {
      if (session.sessionName === name) {
        return session;
      }
    }
    return null;
  }

  /**
   * 通用消息追加方法
   * 支持 user/ai/system 三种角色
   */
  addMessage(sessionId: string, message: ChatMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn(`[SessionManager] 会话不存在: ${sessionId}，无法追加消息`);
      return;
    }
    session.messages.push(message);
    session.lastActiveAt = Date.now();
    this.trimMessages(session);
    this.saveSession(session);
  }

  /** 追加用户消息（便捷方法） */
  appendUserMessage(content: string): void {
    const session = this.getActiveSession();
    if (!session) return;
    this.addMessage(session.sessionId, { role: 'user', content });
  }

  /** 追加AI回复消息（便捷方法） */
  appendAIMessage(content: string): void {
    const session = this.getActiveSession();
    if (!session) return;
    this.addMessage(session.sessionId, { role: 'ai', content });
  }

  /** 追加系统消息（便捷方法） */
  appendSystemMessage(content: string): void {
    const session = this.getActiveSession();
    if (!session) return;
    this.addMessage(session.sessionId, { role: 'system', content });
  }

  /** 删除指定会话 */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    // 删除加密文件和明文文件
    this.deleteSessionFile(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
    logger.info(`[SessionManager] 删除会话: ${sessionId.slice(0, 8)}`);
  }

  /** 删除所有会话 */
  deleteAll(): void {
    for (const [sessionId] of this.sessions) {
      this.deleteSessionFile(sessionId);
    }
    this.sessions.clear();
    this.activeSessionId = null;
    logger.info('[SessionManager] 已删除所有会话');
  }

  /** 恢复最近一次会话 */
  recoverSession(): SessionState | null {
    let latestSession: SessionState | null = null;
    let latestTime = 0;
    for (const [, session] of this.sessions) {
      if (session.lastActiveAt > latestTime) {
        latestTime = session.lastActiveAt;
        latestSession = session;
      }
    }
    if (latestSession) {
      this.activeSessionId = latestSession.sessionId;
      logger.info(`[SessionManager] 恢复会话: ${latestSession.sessionName}`);
    }
    return latestSession;
  }

  /** 获取所有会话列表 */
  listSessions(): SessionState[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt
    );
  }

  /** 持久化指定会话到磁盘 */
  persistSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.saveSession(session);
    }
  }

  /** 持久化所有会话 */
  async saveAll(): Promise<void> {
    for (const [, session] of this.sessions) {
      this.saveSession(session);
    }
  }

  // ---- 私有方法 ----

  /** 裁剪消息以保持在最大上下文长度内 */
  private trimMessages(session: SessionState): void {
    let totalLength = session.messages.reduce((sum, msg) => sum + msg.content.length, 0);
    while (totalLength > this.maxContextChunk && session.messages.length > 1) {
      const idx = session.messages.findIndex((m) => m.role !== 'system');
      if (idx === -1) break;
      totalLength -= session.messages[idx].content.length;
      session.messages.splice(idx, 1);
    }
  }

  /** 持久化单个会话（AES加密） */
  private saveSession(session: SessionState): void {
    try {
      ensureDir(this.sessionDir);
      const sessionFile = path.join(this.sessionDir, `${session.sessionId}${SESSION_EXT}`);
      const jsonData = JSON.stringify(session, null, 2);

      if (this.enableEncryption) {
        // AES加密存储
        const encrypted = this.security.encrypt(jsonData);
        fs.writeFileSync(sessionFile, encrypted, 'utf-8');
        // 删除旧的明文文件（如果存在）
        const plainFile = path.join(this.sessionDir, `${session.sessionId}${SESSION_EXT_PLAIN}`);
        if (fs.existsSync(plainFile)) {
          fs.unlinkSync(plainFile);
        }
      } else {
        // 明文存储（向后兼容）
        const plainFile = path.join(this.sessionDir, `${session.sessionId}${SESSION_EXT_PLAIN}`);
        fs.writeFileSync(plainFile, jsonData, 'utf-8');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[SessionManager] 保存会话失败: ${message}`);
    }
  }

  /** 从磁盘加载所有会话 */
  private async loadSessions(): Promise<void> {
    if (!fs.existsSync(this.sessionDir)) return;
    const files = fs.readdirSync(this.sessionDir);

    for (const file of files) {
      try {
        const filePath = path.join(this.sessionDir, file);
        let session: SessionState;

        if (file.endsWith(SESSION_EXT)) {
          // 加密会话文件
          const encrypted = fs.readFileSync(filePath, 'utf-8');
          const decrypted = this.security.decrypt(encrypted);
          session = JSON.parse(decrypted) as SessionState;
        } else if (file.endsWith(SESSION_EXT_PLAIN)) {
          // 明文会话文件（向后兼容）
          const raw = fs.readFileSync(filePath, 'utf-8');
          session = JSON.parse(raw) as SessionState;
          // 迁移为加密格式
          this.saveSession(session);
        } else {
          continue;
        }

        this.sessions.set(session.sessionId, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[SessionManager] 加载会话失败 ${file}: ${message}`);
        if (err instanceof Error && err.message.includes('解密失败')) {
          logger.error(`[SessionManager] 会话解密失败 ${file}，ErrorCode=${ErrorCode.SESSION_DECRYPT_FAILED}`);
        }
      }
    }
  }

  /** 删除会话文件（加密+明文） */
  private deleteSessionFile(sessionId: string): void {
    const encFile = path.join(this.sessionDir, `${sessionId}${SESSION_EXT}`);
    const plainFile = path.join(this.sessionDir, `${sessionId}${SESSION_EXT_PLAIN}`);
    if (fs.existsSync(encFile)) fs.unlinkSync(encFile);
    if (fs.existsSync(plainFile)) fs.unlinkSync(plainFile);
  }
}

/** 会话管理单例 */
export const sessionManager = new SessionManager();