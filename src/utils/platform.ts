/**
 * ClayCode 跨平台工具模块
 * 统一处理路径分隔符、换行符、编码、环境变量等跨平台差异
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/** 当前操作系统类型 */
export type PlatformType = 'macos' | 'linux' | 'windows';

/** 获取当前平台类型 */
export function getPlatform(): PlatformType {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/** 是否为 Windows 平台 */
export function isWindows(): boolean {
  return os.platform() === 'win32';
}

/**
 * 统一换行符为 \n
 * 过滤 Windows \r\n，标准化为 \n
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 统一路径分隔符
 * Windows 下将反斜杠转为正斜杠
 */
export function normalizePath(filePath: string): string {
  if (isWindows()) {
    return filePath.replace(/\\/g, '/');
  }
  return filePath;
}

/**
 * 解析路径中的 ~ 为用户主目录
 */
export function resolveHome(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * 确保目录存在，不存在则递归创建
 */
export function ensureDir(dirPath: string): void {
  const resolved = resolveHome(dirPath);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
}

/**
 * 读取文件内容，统一 UTF-8 编码和换行符
 */
export function readFileNormalized(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return normalizeNewlines(content);
}

/**
 * 写入文件，统一换行符为 \n
 */
export function writeFileNormalized(filePath: string, content: string): void {
  const normalized = normalizeNewlines(content);
  // 确保父目录存在
  const dir = path.dirname(filePath);
  ensureDir(dir);
  fs.writeFileSync(filePath, normalized, 'utf-8');
}

/**
 * 获取用户 Shell 环境变量
 * 自动加载 ~/.zshrc / ~/.bash_profile 中的 PATH
 */
export function getUserShellEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  const homeDir = os.homedir();
  const rcFiles: string[] = [];

  if (os.platform() === 'darwin') {
    rcFiles.push(
      path.join(homeDir, '.zshrc'),
      path.join(homeDir, '.bash_profile'),
    );
  } else if (os.platform() === 'linux') {
    rcFiles.push(
      path.join(homeDir, '.bashrc'),
      path.join(homeDir, '.profile'),
    );
  }

  for (const rcFile of rcFiles) {
    if (!fs.existsSync(rcFile)) continue;
    try {
      const content = fs.readFileSync(rcFile, 'utf-8');
      const pathMatch = content.match(/^\s*export\s+PATH=["']?([^"']+)["']?/m);
      if (pathMatch) {
        const extraPaths = pathMatch[1]
          .split(path.delimiter)
          .filter((p) => !p.startsWith('$'));
        env.PATH = [...extraPaths, env.PATH || ''].join(path.delimiter);
      }
    } catch {
      // 忽略读取错误
    }
  }

  return env;
}

/**
 * 获取 Chrome 用户数据目录路径
 */
export function getChromeUserDataDir(): string {
  const platform = getPlatform();
  switch (platform) {
    case 'macos':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    case 'linux':
      return path.join(os.homedir(), '.config', 'google-chrome');
    case 'windows':
      return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
}

/**
 * 获取当前平台的换行符
 */
export function getNewLine(): string {
  return isWindows() ? '\r\n' : '\n';
}

/**
 * 获取 Puppeteer 可执行的 Chrome 路径
 */
export function findChromePath(): string | null {
  const platform = getPlatform();
  const candidates: string[] = [];

  switch (platform) {
    case 'macos':
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      );
      break;
    case 'linux':
      candidates.push(
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
      );
      break;
    case 'windows':
      candidates.push(
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      );
      break;
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}