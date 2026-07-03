import { describe, it, expect, vi } from 'vitest';
import { getErrorGuide, formatErrorGuide, printErrorGuide, getAllErrorGuides } from '../core/error-guide';
import { ErrorCode } from '../types';

describe('getErrorGuide', () => {
  it('应返回SUCCESS错误指引', () => {
    const guide = getErrorGuide(ErrorCode.SUCCESS);
    expect(guide).toBeDefined();
    expect(guide.code).toBe(ErrorCode.SUCCESS);
    expect(guide.message).toBe('操作成功完成');
  });

  it('应返回BROWSER_LOCK_CONFLICT错误指引', () => {
    const guide = getErrorGuide(ErrorCode.BROWSER_LOCK_CONFLICT);
    expect(guide).toBeDefined();
    expect(guide.code).toBe(ErrorCode.BROWSER_LOCK_CONFLICT);
    expect(guide.fixCommand).toBe('clay doctor');
  });

  it('应返回HUMAN_VERIFICATION错误指引', () => {
    const guide = getErrorGuide(ErrorCode.HUMAN_VERIFICATION);
    expect(guide).toBeDefined();
    expect(guide.fixCommand).toBe('clay login');
  });

  it('应返回RESPONSE_TIMEOUT错误指引', () => {
    const guide = getErrorGuide(ErrorCode.RESPONSE_TIMEOUT);
    expect(guide).toBeDefined();
    expect(guide.message).toContain('超时');
  });

  it('应返回FILE_PERMISSION_DENIED错误指引', () => {
    const guide = getErrorGuide(ErrorCode.FILE_PERMISSION_DENIED);
    expect(guide).toBeDefined();
    expect(guide.message).toContain('文件');
  });

  it('应返回COMMAND_NOT_IN_WHITELIST错误指引', () => {
    const guide = getErrorGuide(ErrorCode.COMMAND_NOT_IN_WHITELIST);
    expect(guide).toBeDefined();
    expect(guide.fixCommand).toContain('execWhiteList');
  });

  it('应返回SHELL_EXECUTION_ERROR错误指引', () => {
    const guide = getErrorGuide(ErrorCode.SHELL_EXECUTION_ERROR);
    expect(guide).toBeDefined();
  });

  it('应返回ADAPTER_NOT_FOUND错误指引', () => {
    const guide = getErrorGuide(ErrorCode.ADAPTER_NOT_FOUND);
    expect(guide).toBeDefined();
    expect(guide.fixSuggestion).toContain('适配器');
  });

  it('应返回SESSION_DECRYPT_FAILED错误指引', () => {
    const guide = getErrorGuide(ErrorCode.SESSION_DECRYPT_FAILED);
    expect(guide).toBeDefined();
    expect(guide.message).toContain('解密');
  });

  it('未知错误码应返回fallback指引', () => {
    const guide = getErrorGuide(99999);
    expect(guide).toBeDefined();
    expect(guide.code).toBe(99999);
    expect(guide.message).toContain('未知错误');
    expect(guide.fixSuggestion).toBeDefined();
  });
});

describe('formatErrorGuide', () => {
  it('应格式化SUCCESS错误指引', () => {
    const formatted = formatErrorGuide(ErrorCode.SUCCESS);
    expect(formatted).toContain('操作成功完成');
    expect(formatted).toContain(String(ErrorCode.SUCCESS));
  });

  it('应格式化有修复命令的错误指引', () => {
    const formatted = formatErrorGuide(ErrorCode.BROWSER_LOCK_CONFLICT);
    expect(formatted).toContain('clay doctor');
    expect(formatted).toContain('修复');
  });

  it('未知错误码应返回未知错误提示', () => {
    const formatted = formatErrorGuide(99999);
    expect(formatted).toContain('未知错误');
  });
});

describe('printErrorGuide', () => {
  it('应打印错误指引到控制台', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    printErrorGuide(ErrorCode.BROWSER_LOCK_CONFLICT);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('getAllErrorGuides', () => {
  it('应返回所有错误指引数组', () => {
    const guides = getAllErrorGuides();
    expect(Array.isArray(guides)).toBe(true);
    expect(guides.length).toBeGreaterThanOrEqual(8);
    // 验证包含已知错误码的指引
    const codes = guides.map(g => g.code);
    expect(codes).toContain(ErrorCode.SUCCESS);
    expect(codes).toContain(ErrorCode.BROWSER_LOCK_CONFLICT);
  });
});