/**
 * ClayCode 命令历史持久化模块
 * 支持上下箭头浏览历史命令，持久化至 ~/.claycode/history
 * 去重连续重复项，最大保留条数可配置
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { ensureDir } from './platform';

/** 命令历史管理器 */
export class CommandHistory {
  private historyPath: string;
  private maxEntries: number;
  private entries: string[] = [];
  private currentIndex: number = -1;

  constructor(options?: { historyPath?: string; maxEntries?: number }) {
    this.historyPath = options?.historyPath || path.join(os.homedir(), '.claycode', 'history');
    this.maxEntries = options?.maxEntries || 1000;
    this.load();
  }

  /**
   * 从磁盘加载历史记录
   */
  private load(): void {
    try {
      if (fs.existsSync(this.historyPath)) {
        const content = fs.readFileSync(this.historyPath, 'utf-8');
        this.entries = content.split('\n').filter(Boolean);
        // 超出上限时截断
        if (this.entries.length > this.maxEntries) {
          this.entries = this.entries.slice(-this.maxEntries);
        }
      }
    } catch {
      this.entries = [];
    }
    this.currentIndex = this.entries.length;
  }

  /**
   * 持久化历史记录到磁盘
   */
  private save(): void {
    try {
      const dir = path.dirname(this.historyPath);
      ensureDir(dir);
      fs.writeFileSync(this.historyPath, this.entries.join('\n'), 'utf-8');
    } catch (err) {
      // 静默失败，历史记录不是关键功能
    }
  }

  /**
   * 添加一条命令到历史记录
   * 自动去重连续重复项
   */
  add(command: string): void {
    const trimmed = command.trim();
    if (!trimmed) return;

    // 去重：不添加与最后一条相同的命令
    if (this.entries.length > 0 && this.entries[this.entries.length - 1] === trimmed) {
      return;
    }

    this.entries.push(trimmed);

    // 超出上限时移除最早的记录
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    this.currentIndex = this.entries.length;
    this.save();
  }

  /**
   * 获取上一条历史命令（上箭头）
   */
  getPrevious(): string | null {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      return this.entries[this.currentIndex] || null;
    }
    return null;
  }

  /**
   * 获取下一条历史命令（下箭头）
   */
  getNext(): string | null {
    if (this.currentIndex < this.entries.length - 1) {
      this.currentIndex++;
      return this.entries[this.currentIndex] || null;
    }
    // 回到当前输入位置
    this.currentIndex = this.entries.length;
    return null;
  }

  /**
   * 重置浏览位置到末尾
   */
  resetPosition(): void {
    this.currentIndex = this.entries.length;
  }

  /**
   * 获取所有历史记录
   */
  getAll(): string[] {
    return [...this.entries];
  }

  /**
   * 搜索历史记录（模糊匹配）
   */
  search(keyword: string): string[] {
    const lower = keyword.toLowerCase();
    return this.entries.filter(entry => entry.toLowerCase().includes(lower));
  }

  /**
   * 清空历史记录
   */
  clear(): void {
    this.entries = [];
    this.currentIndex = 0;
    this.save();
  }

  /**
   * 获取历史记录条数
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * 将历史记录注入readline接口
   * 使上下箭头可浏览历史命令
   */
  injectToReadline(rl: readline.Interface): void {
    // Node.js readline 的 history 是一个数组，最新的在前面
    // 我们的历史记录最旧的在前面，需要反转
    // Note: readline.Interface 运行时存在 history 属性，但类型定义中未声明
    (rl as unknown as { history: string[] }).history = [...this.entries].reverse();
  }
}