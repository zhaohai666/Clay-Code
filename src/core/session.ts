/**
 * ClayCode 会话管理模块
 * 会话创建、切换、恢复、AES加密持久化存储
 * 存储路径：~/.claycode/sessions/[session-id].json.enc
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SessionState, ChatMessage, AdapterType, ErrorCode, Checkpoint, ToolCall, ExecuteResult, Workspace } from '../types';
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

  // ---- 检查点管理 ----

  /** 创建检查点（每轮工具执行后调用） */
  createCheckpoint(
    toolCalls: ToolCall[],
    executeResults: ExecuteResult[],
    label?: string
  ): Checkpoint | null {
    const session = this.getActiveSession();
    if (!session) {
      logger.warn('[SessionManager] 无活跃会话，无法创建检查点');
      return null;
    }
    if (!session.checkpoints) {
      session.checkpoints = [];
    }
    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      sessionId: session.sessionId,
      timestamp: Date.now(),
      roundIndex: session.checkpoints.length,
      toolCalls,
      executeResults,
      messageCount: session.messages.length,
      fileChangeCount: session.fileChanges?.length ?? 0,
      label,
    };
    session.checkpoints.push(checkpoint);
    this.saveSession(session);
    logger.info(
      `[SessionManager] 创建检查点: round=${checkpoint.roundIndex}, id=${checkpoint.id.slice(0, 8)}${label ? `, label="${label}"` : ''}`
    );
    return checkpoint;
  }

  /** 恢复到指定检查点（断点续跑） */
  restoreCheckpoint(checkpointId: string): SessionState | null {
    const session = this.getActiveSession();
    if (!session) {
      logger.warn('[SessionManager] 无活跃会话，无法恢复检查点');
      return null;
    }
    if (!session.checkpoints || session.checkpoints.length === 0) {
      logger.warn('[SessionManager] 当前会话无检查点');
      return null;
    }
    const idx = session.checkpoints.findIndex((cp) => cp.id === checkpointId);
    if (idx === -1) {
      logger.warn(`[SessionManager] 检查点不存在: ${checkpointId}`);
      // V1.2: 检查点数据损坏 - 尝试加载上一个有效快照
      if (session.checkpoints.length > 0) {
        const lastValid = session.checkpoints[session.checkpoints.length - 1];
        logger.info(`[SessionManager] 检查点数据可能损坏(ErrorCode=${ErrorCode.CHECKPOINT_CORRUPT})，尝试恢复到最近有效检查点: ${lastValid.id.slice(0, 8)}`);
        return this.restoreCheckpoint(lastValid.id);
      }
      return null;
    }
    // 校验检查点数据完整性
    const checkpoint = session.checkpoints[idx];
    if (!checkpoint.toolCalls || !checkpoint.executeResults || checkpoint.messageCount === undefined) {
      logger.warn(`[SessionManager] 检查点数据损坏(ErrorCode=${ErrorCode.CHECKPOINT_CORRUPT}): ${checkpointId.slice(0, 8)}`);
      // 尝试回退到前一个有效检查点
      if (idx > 0) {
        const prevCheckpoint = session.checkpoints[idx - 1];
        logger.info(`[SessionManager] 回退到前一个有效检查点: ${prevCheckpoint.id.slice(0, 8)}`);
        return this.restoreCheckpoint(prevCheckpoint.id);
      }
      return null;
    }
    // 截断检查点列表至目标位置（丢弃目标之后的检查点）
    session.checkpoints = session.checkpoints.slice(0, idx + 1);
    // 截断消息至检查点时的数量
    if (session.messages.length > session.checkpoints[idx].messageCount) {
      session.messages = session.messages.slice(0, session.checkpoints[idx].messageCount);
    }
    // 截断文件变更记录至检查点时的数量
    if (session.fileChanges && session.fileChanges.length > session.checkpoints[idx].fileChangeCount) {
      session.fileChanges = session.fileChanges.slice(0, session.checkpoints[idx].fileChangeCount);
    }
    session.lastActiveAt = Date.now();
    this.saveSession(session);
    logger.info(
      `[SessionManager] 恢复检查点: round=${session.checkpoints[idx].roundIndex}, id=${checkpointId.slice(0, 8)}`
    );
    return session;
  }

  /** 列出当前会话的所有检查点 */
  listCheckpoints(): Checkpoint[] {
    const session = this.getActiveSession();
    if (!session || !session.checkpoints) return [];
    return [...session.checkpoints];
  }

  /** 获取指定检查点 */
  getCheckpoint(checkpointId: string): Checkpoint | null {
    const session = this.getActiveSession();
    if (!session || !session.checkpoints) return null;
    return session.checkpoints.find((cp) => cp.id === checkpointId) ?? null;
  }

  /** 获取最近的检查点（用于断点续跑恢复） */
  getLatestCheckpoint(): Checkpoint | null {
    const session = this.getActiveSession();
    if (!session || !session.checkpoints || session.checkpoints.length === 0) return null;
    return session.checkpoints[session.checkpoints.length - 1];
  }

  /** 删除指定检查点 */
  deleteCheckpoint(checkpointId: string): boolean {
    const session = this.getActiveSession();
    if (!session || !session.checkpoints) return false;
    const idx = session.checkpoints.findIndex((cp) => cp.id === checkpointId);
    if (idx === -1) return false;
    session.checkpoints.splice(idx, 1);
    // 重新编号roundIndex
    session.checkpoints.forEach((cp, i) => {
      cp.roundIndex = i;
    });
    this.saveSession(session);
    logger.info(`[SessionManager] 删除检查点: ${checkpointId.slice(0, 8)}`);
    return true;
  }

  /** 清除当前会话所有检查点 */
  clearCheckpoints(): void {
    const session = this.getActiveSession();
    if (!session) return;
    session.checkpoints = [];
    this.saveSession(session);
    logger.info('[SessionManager] 已清除所有检查点');
  }

  /** 从检查点恢复会话（按会话ID+检查点ID，用于非活跃会话恢复） */
  restoreSessionCheckpoint(sessionId: string, checkpointId: string): SessionState | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn(`[SessionManager] 会话不存在: ${sessionId}`);
      return null;
    }
    this.activeSessionId = sessionId;
    return this.restoreCheckpoint(checkpointId);
  }

  /** 获取检查点摘要信息（用于CLI展示） */
  getCheckpointSummary(): string {
    const checkpoints = this.listCheckpoints();
    if (checkpoints.length === 0) return '当前会话无检查点';
    const lines = checkpoints.map((cp) => {
      const time = new Date(cp.timestamp).toLocaleString();
      const toolNames = cp.toolCalls.map((tc) => tc.tool).join(', ');
      const label = cp.label ? ` [${cp.label}]` : '';
      return `  #${cp.roundIndex} | ${time} | tools: ${toolNames} | msgs: ${cp.messageCount}${label}`;
    });
    return `检查点列表 (${checkpoints.length}个):\n${lines.join('\n')}`;
  }

  // ---- 工作区管理 (V1.2: 多工作区分隔) ----

  /** 创建新工作区 */
  createWorkspace(name: string, projectPath: string): Workspace | null {
    const session = this.getActiveSession();
    if (!session) {
      logger.warn('[SessionManager] 无活跃会话，无法创建工作区');
      return null;
    }
    if (!session.workspaces) {
      session.workspaces = [];
    }
    // 将现有活跃工作区设为非活跃
    for (const ws of session.workspaces) {
      ws.active = false;
    }
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name,
      projectPath,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      active: true,
    };
    session.workspaces.push(workspace);
    session.activeWorkspaceId = workspace.id;
    // 同步更新会话的projectPath
    session.projectPath = projectPath;
    this.saveSession(session);
    logger.info(`[SessionManager] 创建工作区: ${name} (${workspace.id.slice(0, 8)}), 路径: ${projectPath}`);
    return workspace;
  }

  /** 切换到指定工作区 */
  switchWorkspace(workspaceId: string): Workspace | null {
    const session = this.getActiveSession();
    if (!session || !session.workspaces) return null;
    const workspace = session.workspaces.find((ws) => ws.id === workspaceId);
    if (!workspace) {
      logger.warn(`[SessionManager] 工作区不存在: ${workspaceId}`);
      return null;
    }
    // 将所有工作区设为非活跃
    for (const ws of session.workspaces) {
      ws.active = false;
    }
    workspace.active = true;
    workspace.lastActiveAt = Date.now();
    session.activeWorkspaceId = workspace.id;
    session.projectPath = workspace.projectPath;
    this.saveSession(session);
    logger.info(`[SessionManager] 切换到工作区: ${workspace.name} (${workspace.id.slice(0, 8)})`);
    return workspace;
  }

  /** 获取当前活跃工作区 */
  getActiveWorkspace(): Workspace | null {
    const session = this.getActiveSession();
    if (!session || !session.workspaces) return null;
    return session.workspaces.find((ws) => ws.active) ?? null;
  }

  /** 列出所有工作区 */
  listWorkspaces(): Workspace[] {
    const session = this.getActiveSession();
    if (!session || !session.workspaces) return [];
    return [...session.workspaces];
  }

  /** 删除指定工作区 */
  deleteWorkspace(workspaceId: string): boolean {
    const session = this.getActiveSession();
    if (!session || !session.workspaces) return false;
    const idx = session.workspaces.findIndex((ws) => ws.id === workspaceId);
    if (idx === -1) return false;
    const wasActive = session.workspaces[idx].active;
    session.workspaces.splice(idx, 1);
    // 如果删除的是活跃工作区，切换到第一个
    if (wasActive && session.workspaces.length > 0) {
      session.workspaces[0].active = true;
      session.activeWorkspaceId = session.workspaces[0].id;
      session.projectPath = session.workspaces[0].projectPath;
    } else if (session.workspaces.length === 0) {
      session.activeWorkspaceId = undefined;
    }
    this.saveSession(session);
    logger.info(`[SessionManager] 删除工作区: ${workspaceId.slice(0, 8)}`);
    return true;
  }

  /** 获取工作区摘要信息 */
  getWorkspaceSummary(): string {
    const workspaces = this.listWorkspaces();
    if (workspaces.length === 0) return '当前会话无工作区';
    const lines = workspaces.map((ws) => {
      const active = ws.active ? ' *' : '';
      const time = new Date(ws.lastActiveAt).toLocaleString();
      return `  ${ws.name}${active} | ${ws.projectPath} | ${time}`;
    });
    return `工作区列表 (${workspaces.length}个):\n${lines.join('\n')}`;
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