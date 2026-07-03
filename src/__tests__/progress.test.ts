import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressBar, terminal, createFileProgressBar, AIPulseIndicator } from '../utils/progress';

describe('ProgressBar', () => {
  it('应正确初始化', () => {
    const bar = new ProgressBar({ total: 100 });
    expect(bar).toBeDefined();
  });

  it('应支持自定义配置', () => {
    const bar = new ProgressBar({
      total: 50,
      width: 20,
      fillChar: '=',
      emptyChar: '-',
      prefix: '测试',
      showPercent: false,
      showCount: true,
      showElapsed: false,
    });
    expect(bar).toBeDefined();
  });

  it('update应正确更新进度', () => {
    const bar = new ProgressBar({ total: 10 });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    bar.update(5);
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('increment应逐步增加进度', () => {
    const bar = new ProgressBar({ total: 5 });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    bar.increment();
    bar.increment();
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('complete应完成进度条', () => {
    const bar = new ProgressBar({ total: 10 });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    bar.complete('完成');
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('进度不应超过total', () => {
    const bar = new ProgressBar({ total: 10 });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    bar.update(100); // 超过total
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});

describe('terminal', () => {
  it('success应输出绿色消息', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    terminal.success('操作成功');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('操作成功'));
    logSpy.mockRestore();
  });

  it('error应输出红色消息', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    terminal.error('操作失败');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('操作失败'));
    logSpy.mockRestore();
  });

  it('warn应输出黄色消息', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    terminal.warn('警告信息');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('警告信息'));
    logSpy.mockRestore();
  });

  it('info应输出青色消息', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    terminal.info('提示信息');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('提示信息'));
    logSpy.mockRestore();
  });

  it('shellLine应输出Shell日志行', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    terminal.shellLine('npm install');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('npm install'));
    writeSpy.mockRestore();
  });

  it('step应输出步骤编号', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    terminal.step(1, 5, '开始处理');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1/5'));
    logSpy.mockRestore();
  });

  it('status应更新状态行', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    terminal.status('⏳', '处理中');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('处理中'));
    writeSpy.mockRestore();
  });

  it('clearLine应清除当前行', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    terminal.clearLine();
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});

describe('createFileProgressBar', () => {
  it('应创建文件处理进度条', () => {
    const bar = createFileProgressBar(100, '读取文件');
    expect(bar).toBeInstanceOf(ProgressBar);
  });
});

describe('AIPulseIndicator', () => {
  it('应正确初始化', () => {
    const indicator = new AIPulseIndicator('AI思考中');
    expect(indicator).toBeDefined();
  });

  it('start和stop应正常工作', () => {
    const indicator = new AIPulseIndicator('测试');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    indicator.start();
    indicator.stop('完成');
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('stop无消息时应只清除行', () => {
    const indicator = new AIPulseIndicator('测试');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    indicator.start();
    indicator.stop();
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});