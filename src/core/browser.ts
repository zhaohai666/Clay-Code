/**
 * ClayCode 网页AI浏览器桥接模块
 * 内置Puppeteer浏览器控制内核，单例托管Chrome实例
 * 自动清理锁文件，复用用户登录态，内存级输出流清洗
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Browser, Page, Protocol } from 'puppeteer-core';
import { GlobalConfig, BrowserStatus, BrowserInfo, ErrorCode } from '../types';
import { logger, ensureDir, resolveHome, findChromePath, cleanStreamOutput, detectCaptcha } from '../utils';
import { SecurityManager } from './security';

/** 最大浏览器重启次数 */
const MAX_RESTART_COUNT = 3;

/** 浏览器重启延迟(ms) */
const RESTART_DELAY = 2000;

export class BrowserBridge {
  private config: GlobalConfig;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private info: BrowserInfo = {
    status: 'idle',
    restartCount: 0,
  };
  private security: SecurityManager;
  /** 是否正在主动关闭浏览器（防止disconnected事件误触发重启） */
  private isClosing = false;
  /** Cookie自动保存定时器 */
  private cookieAutoSaveTimer?: ReturnType<typeof setInterval>;

  constructor(config: GlobalConfig) {
    this.config = config;
    this.security = new SecurityManager(process.cwd());
  }

  /** 获取浏览器状态信息 */
  getInfo(): BrowserInfo {
    return { ...this.info };
  }

  /** 启动浏览器实例（单例） */
  async launch(): Promise<Browser> {
    if (this.browser && this.info.status === 'running') {
      logger.info('[BrowserBridge] 浏览器实例已在运行，复用现有实例');
      return this.browser;
    }

    this.info.status = 'launching';
    this.isClosing = false;
    logger.info('[BrowserBridge] 正在启动浏览器实例...');

    try {
      // 1. 清理锁文件
      await this.cleanLockFiles();

      // 2. 确保浏览器缓存目录存在
      const dataDir = resolveHome(this.config.browserDataPath);
      ensureDir(dataDir);

      // 3. 查找Chrome可执行路径
      const chromePath = findChromePath();
      if (!chromePath) {
        throw new Error('未找到Chrome浏览器，请先安装Google Chrome');
      }
      logger.info(`[BrowserBridge] Chrome路径: ${chromePath}`);

      // 4. 启动Puppeteer
      // 禁止Puppeteer拦截SIGINT，由CLI层统一处理优雅退出（保存Cookie等）
      const launchOptions: Record<string, any> = {
        executablePath: chromePath,
        headless: this.config.browserHeadless ? true : false,
        userDataDir: dataDir,
        defaultViewport: { width: 1280, height: 800 },
        handleSIGINT: false,
        handleSIGHUP: false,
        handleSIGTERM: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1280,800',
        ],
      };

      // 动态导入 puppeteer-core
      const puppeteer = await import('puppeteer-core');
      this.browser = await puppeteer.default.launch(launchOptions);

      // 5. 监听断开事件（仅非主动关闭时触发重启）
      this.browser.on('disconnected', () => {
        if (this.isClosing) {
          logger.info('[BrowserBridge] 浏览器已主动关闭，跳过重启');
          return;
        }
        logger.warn('[BrowserBridge] 浏览器连接断开');
        this.info.status = 'crashed';
        this.attemptRestart();
      });

      this.info.status = 'running';
      this.info.lastStartedAt = Date.now();
      this.info.lastError = undefined;

      logger.info('[BrowserBridge] 浏览器启动成功');
      return this.browser;

    } catch (err) {
      this.info.status = 'crashed';
      this.info.lastError = (err as Error).message;
      logger.error(`[BrowserBridge] 浏览器启动失败: ${(err as Error).message}`);
      throw err;
    }
  }

  /** 获取或创建Page实例 */
  async getPage(): Promise<Page> {
    if (!this.browser || this.info.status !== 'running') {
      await this.launch();
    }
    if (!this.page || this.page.isClosed()) {
      const pages = await this.browser!.pages();
      this.page = pages.length > 0 ? pages[0] : await this.browser!.newPage();
    }
    return this.page;
  }

  /** 导航到指定URL */
  async navigateTo(url: string): Promise<Page> {
    const page = await this.getPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.requestTimeout });
    return page;
  }

  /** 在页面中输入文本并发送 */
  async typeAndSend(inputSelector: string, sendButtonSelector: string, text: string): Promise<void> {
    const page = await this.getPage();

    // 等待输入框可用
    await page.waitForSelector(inputSelector, { timeout: 10000 });

    // 清空输入框
    const inputEl = await page.$(inputSelector);
    if (inputEl) {
      await inputEl.click({ clickCount: 3 }); // 全选
      await page.keyboard.press('Backspace');
    }

    // 快速输入：使用剪贴板粘贴代替逐字符输入
    // 长文本（如含项目上下文的prompt）逐字符输入耗时过长
    try {
      // page.evaluate内的代码运行在浏览器环境，使用字符串形式避免TS类型检查
      await page.evaluate(`
        (function() {
          var el = document.querySelector('${inputSelector.replace(/'/g, "\\'")}');
          if (el) {
            var nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, 'value'
            ) || Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            );
            if (nativeSetter && nativeSetter.set) {
              nativeSetter.set.call(el, ${JSON.stringify(text)});
            } else {
              el.value = ${JSON.stringify(text)};
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()
      `);
    } catch {
      // 降级：逐字符输入（短文本或evaluate失败时）
      await page.type(inputSelector, text, { delay: 10 });
    }

    // 发送消息：有发送按钮选择器则点击按钮，否则用Enter键发送
    if (sendButtonSelector) {
      await page.waitForSelector(sendButtonSelector, { timeout: 5000 });
      await page.click(sendButtonSelector);
    } else {
      await page.keyboard.press('Enter');
    }
  }

  /** 等待AI回复并提取文本 */
  async waitForResponse(responseSelector: string, timeout?: number): Promise<string> {
    const page = await this.getPage();
    const waitTime = timeout ?? this.config.requestTimeout;

    try {
      // 记录发送前的匹配元素数量，用于检测新增的AI回复
      const countBefore = await page.$$eval(responseSelector, (els: any[]) => els.length);
      logger.debug(`[BrowserBridge] 等待AI回复，发送前匹配元素数: ${countBefore}`);

      // 等待新增回复元素出现（元素数量增加）
      const waitForNewElement = async (maxWait: number): Promise<boolean> => {
        const startTime = Date.now();
        while (Date.now() - startTime < maxWait) {
          const currentCount = await page.$$eval(responseSelector, (els: any[]) => els.length);
          if (currentCount > countBefore) {
            logger.debug(`[BrowserBridge] 检测到新回复元素，当前数: ${currentCount}`);
            return true;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        return false;
      };

      // 先等待新元素出现（最多等待超时时间的一半）
      const newElementAppeared = await waitForNewElement(Math.floor(waitTime / 2));
      if (!newElementAppeared) {
        // 如果没有新增元素，也尝试用原有选择器等待（兼容只更新内容的场景）
        logger.debug('[BrowserBridge] 未检测到新增元素，尝试等待现有元素内容更新');
        try {
          await page.waitForSelector(responseSelector, { timeout: Math.floor(waitTime / 2) });
        } catch {
          throw new Error(`等待回复元素超时 (${waitTime}ms)`);
        }
      }

      // 检测到首个新元素后，等待短暂时间看是否有更多元素出现
      // 场景：用户消息和AI回复使用同一选择器时，用户消息先出现（countBefore+1），
      // AI回复随后出现（countBefore+2），需要取最后一个才是AI回复
      if (newElementAppeared) {
        const countAtFirstDetection = await page.$$eval(responseSelector, (els: any[]) => els.length);
        await new Promise((r) => setTimeout(r, 3000)); // 等待3秒让AI回复元素也出现
        const countAfterWait = await page.$$eval(responseSelector, (els: any[]) => els.length);
        if (countAfterWait > countAtFirstDetection) {
          logger.debug(`[BrowserBridge] 等待后检测到更多元素: ${countAtFirstDetection} → ${countAfterWait}`);
        }
      }

      // 等待回复完成（内容不再变化）
      let lastText = '';
      let stableCount = 0;
      const stableThreshold = 3; // 连续3次内容不变视为完成

      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        // 取最后一个匹配元素的文本（AI回复在用户消息之后）
        const currentText = await page.$$eval(responseSelector, (els: any[]) => {
          if (els.length === 0) return '';
          const lastEl = els[els.length - 1];
          return lastEl.textContent || '';
        });
        const cleaned = cleanStreamOutput(currentText);

        if (cleaned === lastText && cleaned.length > 0) {
          stableCount++;
          if (stableCount >= stableThreshold) break;
        } else {
          stableCount = 0;
          lastText = cleaned;
        }
      }

      // 提取最终回复（取最后一个匹配元素）
      const finalText = await page.$$eval(responseSelector, (els: any[]) => {
        if (els.length === 0) return '';
        const lastEl = els[els.length - 1];
        return lastEl.textContent || '';
      });
      const cleanedResponse = cleanStreamOutput(finalText);

      // 检测人机验证
      if (detectCaptcha(cleanedResponse)) {
        throw Object.assign(new Error('网页AI需要人机验证'), { code: ErrorCode.HUMAN_VERIFICATION });
      }

      return cleanedResponse;

    } catch (err) {
      if ((err as any).code === ErrorCode.HUMAN_VERIFICATION) throw err;
      logger.error(`[BrowserBridge] 等待AI回复超时: ${(err as Error).message}`);
      throw Object.assign(new Error('AI请求超时'), { code: ErrorCode.RESPONSE_TIMEOUT });
    }
  }

  /** 关闭浏览器 */
  async close(): Promise<void> {
    this.isClosing = true;
    this.stopCookieAutoSave();
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.info.status = 'idle';
      logger.info('[BrowserBridge] 浏览器已关闭');
    }
  }

  /** 清理浏览器锁文件 */
  private async cleanLockFiles(): Promise<void> {
    const dataDir = resolveHome(this.config.browserDataPath);
    if (!fs.existsSync(dataDir)) return;

    const lockFileNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
    try {
      const entries = fs.readdirSync(dataDir);
      for (const entry of entries) {
        if (lockFileNames.includes(entry) || entry.endsWith('.lock') || entry.endsWith('.incomplete')) {
          const fullPath = path.join(dataDir, entry);
          try {
            fs.unlinkSync(fullPath);
            logger.info(`[BrowserBridge] 已清理锁文件: ${entry}`);
          } catch {
            // 忽略删除失败
          }
        }
      }
    } catch {
      // 忽略目录读取错误
    }
  }

  /** 自动重启浏览器（公开方法，供引擎全链路异常恢复调用） */
  async attemptRestart(): Promise<void> {
    if (this.info.restartCount >= MAX_RESTART_COUNT) {
      logger.error(`[BrowserBridge] 浏览器重启次数已达上限(${MAX_RESTART_COUNT})`);
      this.info.status = 'crashed';
      return;
    }

    this.info.status = 'restarting';
    this.info.restartCount++;
    logger.info(`[BrowserBridge] 正在重启浏览器 (第${this.info.restartCount}次)...`);

    // 延迟重启
    await new Promise((r) => setTimeout(r, RESTART_DELAY));

    try {
      // 先保存Cookie
      await this.saveCookies();

      // 清理旧实例
      if (this.browser) {
        try { await this.browser.close(); } catch { /* 忽略 */ }
        this.browser = null;
        this.page = null;
      }

      // 清理锁文件后重启
      await this.cleanLockFiles();
      await this.launch();

      // 恢复Cookie
      await this.loadCookies();

      logger.info('[BrowserBridge] 浏览器重启成功');
    } catch (err) {
      logger.error(`[BrowserBridge] 浏览器重启失败: ${(err as Error).message}`);
      this.info.status = 'crashed';
    }
  }

  // ---- Cookie加密持久化 (3.2) ----

  /** Cookie加密存储文件路径 */
  private getCookieFilePath(): string {
    const dataDir = resolveHome(this.config.browserDataPath);
    ensureDir(dataDir);
    return path.join(dataDir, 'cookies.enc');
  }

  /**
   * 保存当前页面的Cookie到加密文件
   * AES-256-CBC加密持久化，保留登录态
   */
  async saveCookies(): Promise<void> {
    try {
      if (!this.page) return;

      const cookies = await this.page.cookies();
      if (cookies.length === 0) {
        logger.debug('[BrowserBridge] 无Cookie需要保存');
        return;
      }

      const cookieJson = JSON.stringify(cookies);
      const encrypted = this.security.encrypt(cookieJson);

      const cookiePath = this.getCookieFilePath();
      fs.writeFileSync(cookiePath, encrypted, 'utf-8');
      logger.info(`[BrowserBridge] 已加密保存 ${cookies.length} 个Cookie`);
    } catch (err) {
      logger.warn(`[BrowserBridge] Cookie保存失败: ${(err as Error).message}`);
    }
  }

  /**
   * 从加密文件加载Cookie到当前页面
   * 解密后设置到浏览器，复用登录态
   */
  async loadCookies(): Promise<void> {
    try {
      const cookiePath = this.getCookieFilePath();
      if (!fs.existsSync(cookiePath)) {
        logger.debug('[BrowserBridge] 无Cookie缓存文件');
        return;
      }

      const encrypted = fs.readFileSync(cookiePath, 'utf-8');
      const decrypted = this.security.decrypt(encrypted);
      const cookies: Protocol.Network.Cookie[] = JSON.parse(decrypted);

      // 将Cookie转换为CookieParam格式（去除partitionKey等不兼容字段）
      const cookieParams = cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
        expires: c.expires,
      }));

      if (!this.page) {
        const page = await this.getPage();
        await page.setCookie(...cookieParams);
      } else {
        await this.page.setCookie(...cookieParams);
      }

      logger.info(`[BrowserBridge] 已加载 ${cookies.length} 个Cookie`);
    } catch (err) {
      logger.warn(`[BrowserBridge] Cookie加载失败: ${(err as Error).message}`);
    }
  }

  /**
   * 启动Cookie自动保存定时器
   * 在clay login期间定期保存Cookie，避免Ctrl+C时Chrome已关闭导致保存失败
   */
  startCookieAutoSave(intervalMs: number = 10000): void {
    this.stopCookieAutoSave();
    this.cookieAutoSaveTimer = setInterval(async () => {
      try {
        if (this.page && !this.page.isClosed() && this.browser?.connected) {
          await this.saveCookies();
        }
      } catch {
        // 忽略自动保存错误
      }
    }, intervalMs);
    logger.info(`[BrowserBridge] Cookie自动保存已启动(间隔${intervalMs}ms)`);
  }

  /** 停止Cookie自动保存定时器 */
  stopCookieAutoSave(): void {
    if (this.cookieAutoSaveTimer) {
      clearInterval(this.cookieAutoSaveTimer);
      this.cookieAutoSaveTimer = undefined;
      logger.info('[BrowserBridge] Cookie自动保存已停止');
    }
  }

  /** 检查是否有加密Cookie缓存 */
  hasCookieCache(): boolean {
    const cookiePath = this.getCookieFilePath();
    return fs.existsSync(cookiePath);
  }
}