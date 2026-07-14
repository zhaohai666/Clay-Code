/**
 * ClayCode 人性化错误提示与修复指引模块 (9.3)
 * 原始数字错误码映射自然语言中文提示 + 一键修复操作命令
 */

import { ErrorCode, ERROR_MESSAGES, ErrorGuide } from '../types';
import { logger } from '../utils';

/** 完整错误提示映射表 */
const ERROR_GUIDES: Record<number, ErrorGuide> = {
  [ErrorCode.SUCCESS]: {
    code: ErrorCode.SUCCESS,
    message: '操作成功完成',
    fixSuggestion: '无需操作',
  },
  [ErrorCode.BROWSER_LOCK_CONFLICT]: {
    code: ErrorCode.BROWSER_LOCK_CONFLICT,
    message: '浏览器锁文件冲突，可能是上次异常退出导致缓存锁未清理',
    fixSuggestion: '正在自动清理缓存锁文件并重启Chrome浏览器...',
    fixCommand: 'clay doctor',
  },
  [ErrorCode.HUMAN_VERIFICATION]: {
    code: ErrorCode.HUMAN_VERIFICATION,
    message: '网页AI需要人机验证或未登录，无法自动继续对话',
    fixSuggestion: '请在浏览器中完成登录或人机验证',
    fixCommand: 'clay login',
  },
  [ErrorCode.RESPONSE_TIMEOUT]: {
    code: ErrorCode.RESPONSE_TIMEOUT,
    message: 'AI回复超时，可能是网络波动或AI服务响应缓慢',
    fixSuggestion: '正在自动指数退避重试(最多3次)，如持续失败请检查网络连接',
    fixCommand: 'clay config set requestTimeout 120000',
  },
  [ErrorCode.CONTEXT_TOO_LONG]: {
    code: ErrorCode.CONTEXT_TOO_LONG,
    message: '上下文内容超长，已超过AI对话长度限制',
    fixSuggestion: '正在自动拆分项目分块重新请求AI，也可手动减小 maxContextChunk 配置',
    fixCommand: 'clay config set maxContextChunk 8000',
  },
  [ErrorCode.FILE_PERMISSION_DENIED]: {
    code: ErrorCode.FILE_PERMISSION_DENIED,
    message: '文件越权或权限不足，尝试访问项目目录以外的系统文件',
    fixSuggestion: 'AI已收到权限错误信息，将自动生成权限修复方案。请确认文件路径在项目目录内',
    fixCommand: 'clay doctor',
  },
  [ErrorCode.COMMAND_NOT_IN_WHITELIST]: {
    code: ErrorCode.COMMAND_NOT_IN_WHITELIST,
    message: 'Shell命令不在执行白名单中，已被安全策略拦截',
    fixSuggestion: '如需放行该命令，请将其添加到白名单配置中',
    fixCommand: 'clay config set execWhiteList \'["git","npm","pnpm","yarn","node","npx","tsc","eslint","prettier","mvn","gradle"]\'',
  },
  [ErrorCode.SHELL_EXECUTION_ERROR]: {
    code: ErrorCode.SHELL_EXECUTION_ERROR,
    message: 'Shell命令执行异常，可能是指令错误或环境问题',
    fixSuggestion: '执行错误已同步至AI，将自动迭代修复代码。可查看日志获取详细错误信息',
    fixCommand: 'clay log --level error',
  },
  [ErrorCode.ADAPTER_NOT_FOUND]: {
    code: ErrorCode.ADAPTER_NOT_FOUND,
    message: '指定的AI适配器不存在，请切换到合法的适配器',
    fixSuggestion: '当前支持的适配器: doubao(豆包), chatgpt-web(ChatGPT网页版), claude-web(Claude网页版), ollama(本地模型)',
    fixCommand: 'clay config set defaultAdapter doubao',
  },
  [ErrorCode.SESSION_DECRYPT_FAILED]: {
    code: ErrorCode.SESSION_DECRYPT_FAILED,
    message: '会话数据解密失败，可能是加密密钥变更或数据损坏',
    fixSuggestion: '请重新登录同步会话，或使用 clay session recover 恢复备份快照',
    fixCommand: 'clay session recover',
  },
  [ErrorCode.PATCH_CONFLICT]: {
    code: ErrorCode.PATCH_CONFLICT,
    message: '多条补丁存在文件修改冲突，修改同一文件的代码行区间重叠',
    fixSuggestion: '终止批量执行，请调整工具调用顺序或修改补丁行号范围',
    fixCommand: 'clay log --level warn',
  },
  [ErrorCode.CHECKPOINT_CORRUPT]: {
    code: ErrorCode.CHECKPOINT_CORRUPT,
    message: '检查点数据损坏，无法恢复到该执行现场',
    fixSuggestion: '将自动加载上一个有效快照继续运行，或使用 clay session checkpoint list 查看可用检查点',
    fixCommand: 'clay session checkpoint list',
  },
};

/**
 * 获取错误提示与修复指引
 * @param code 错误码
 * @returns ErrorGuide 错误提示与修复指引
 */
export function getErrorGuide(code: number): ErrorGuide {
  const guide = ERROR_GUIDES[code];
  if (guide) return guide;

  // 未知错误码
  return {
    code,
    message: ERROR_MESSAGES[code] || `未知错误 (代码: ${code})`,
    fixSuggestion: '请查看日志获取详细错误信息，或执行 clay doctor 进行环境诊断',
    fixCommand: 'clay doctor',
  };
}

/**
 * 格式化错误提示输出（终端友好格式）
 * @param code 错误码
 * @returns 格式化的错误提示文本
 */
export function formatErrorGuide(code: number): string {
  const guide = getErrorGuide(code);
  const lines: string[] = [];

  lines.push(`\n❌ 错误(${guide.code}): ${guide.message}`);
  lines.push(`💡 建议: ${guide.fixSuggestion}`);
  if (guide.fixCommand) {
    lines.push(`🔧 修复: ${guide.fixCommand}`);
  }

  return lines.join('\n');
}

/**
 * 打印错误提示到终端
 */
export function printErrorGuide(code: number): void {
  const text = formatErrorGuide(code);
  console.error(text);
  logger.error(`[ErrorGuide] 错误码=${code}, 建议=${getErrorGuide(code).fixSuggestion}`);
}

/**
 * 获取所有错误提示映射
 */
export function getAllErrorGuides(): ErrorGuide[] {
  return Object.values(ERROR_GUIDES);
}