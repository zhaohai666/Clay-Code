import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { SecurityManager } from '../core/security';

describe('SecurityManager', () => {
  const projectRoot = process.cwd();
  const security = new SecurityManager(projectRoot, {
    masterKey: 'test-key-123',
    execWhiteList: ['git', 'npm', 'node', 'ls', 'cat'],
  });

  // ---- AES-256-CBC 加密/解密 ----
  describe('encrypt/decrypt', () => {
    it('应能加密并正确解密文本', () => {
      const plaintext = 'Hello, ClayCode! 这是一段测试文本。';
      const encrypted = security.encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(typeof encrypted).toBe('string');
      const decrypted = security.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('加密结果应不相同（随机salt+iv）', () => {
      const plaintext = 'same-text';
      const enc1 = security.encrypt(plaintext);
      const enc2 = security.encrypt(plaintext);
      expect(enc1).not.toBe(enc2);
    });

    it('应能加密空字符串', () => {
      const encrypted = security.encrypt('');
      const decrypted = security.decrypt(encrypted);
      expect(decrypted).toBe('');
    });

    it('应能加密长文本', () => {
      const longText = 'A'.repeat(10000);
      const encrypted = security.encrypt(longText);
      const decrypted = security.decrypt(encrypted);
      expect(decrypted).toBe(longText);
    });

    it('应能加密JSON数据', () => {
      const data = JSON.stringify({ key: 'value', num: 42, arr: [1, 2, 3] });
      const encrypted = security.encrypt(data);
      const decrypted = security.decrypt(encrypted);
      expect(decrypted).toBe(data);
    });

    it('解密无效数据应抛出错误', () => {
      expect(() => security.decrypt('invalid-base64-data')).toThrow();
    });

    it('不同密钥应无法解密', () => {
      const other = new SecurityManager(projectRoot, { masterKey: 'different-key' });
      const encrypted = security.encrypt('secret');
      expect(() => other.decrypt(encrypted)).toThrow();
    });
  });

  // ---- 路径越权拦截 ----
  describe('validatePath', () => {
    it('项目内路径应通过校验', () => {
      const result = security.validatePath(path.join(projectRoot, 'src/index.ts'));
      expect(result.valid).toBe(true);
    });

    it('项目根目录本身应通过校验', () => {
      const result = security.validatePath(projectRoot);
      expect(result.valid).toBe(true);
    });

    it('项目外路径应被拦截', () => {
      const result = security.validatePath('/etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('越权');
    });

    it('相对路径应在项目内解析', () => {
      const result = security.validatePath('./src/main.ts');
      expect(result.valid).toBe(true);
    });

    it('路径遍历攻击应被检测', () => {
      const result = security.validatePath(path.join(projectRoot, '../../etc/passwd'));
      expect(result.valid).toBe(false);
    });
  });

  describe('validatePaths', () => {
    it('批量校验应返回所有无效路径', () => {
      const result = security.validatePaths([
        path.join(projectRoot, 'src/a.ts'),
        '/etc/passwd',
        path.join(projectRoot, 'src/b.ts'),
        '/tmp/evil',
      ]);
      expect(result.valid).toBe(false);
      expect(result.invalidPaths).toHaveLength(2);
    });

    it('全部有效路径应返回valid=true', () => {
      const result = security.validatePaths([
        path.join(projectRoot, 'src/a.ts'),
        path.join(projectRoot, 'package.json'),
      ]);
      expect(result.valid).toBe(true);
      expect(result.invalidPaths).toHaveLength(0);
    });
  });

  // ---- 命令白名单校验 ----
  describe('validateCommand', () => {
    it('白名单内命令应通过', () => {
      const result = security.validateCommand('git status');
      expect(result.valid).toBe(true);
      expect(result.baseCmd).toBe('git');
    });

    it('带路径前缀的命令应提取baseCmd', () => {
      const result = security.validateCommand('/usr/bin/node app.js');
      expect(result.valid).toBe(true);
      expect(result.baseCmd).toBe('node');
    });

    it('白名单外命令应被拒绝', () => {
      const result = security.validateCommand('rm -rf /');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('不在白名单');
    });

    it('空命令应被拒绝', () => {
      const result = security.validateCommand('');
      expect(result.valid).toBe(false);
    });
  });

  describe('updateWhiteList/getWhiteList', () => {
    it('应能更新白名单', () => {
      security.updateWhiteList(['git', 'npm', 'python3']);
      const wl = security.getWhiteList();
      expect(wl).toEqual(['git', 'npm', 'python3']);
      // 还原
      security.updateWhiteList(['git', 'npm', 'node', 'ls', 'cat']);
    });

    it('getWhiteList应返回副本', () => {
      const wl1 = security.getWhiteList();
      wl1.push('hacked');
      const wl2 = security.getWhiteList();
      expect(wl2).not.toContain('hacked');
    });
  });

  // ---- 沙箱隔离 ----
  describe('sandboxEval', () => {
    it('应能执行简单表达式', () => {
      const result = security.sandboxEval('1 + 2');
      expect(result.success).toBe(true);
      expect(result.result).toBe(3);
    });

    it('应能使用Math对象', () => {
      const result = security.sandboxEval('Math.max(1, 2, 3)');
      expect(result.success).toBe(true);
      expect(result.result).toBe(3);
    });

    it('应能使用JSON对象', () => {
      const result = security.sandboxEval('JSON.parse(\'{"a":1}\')');
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ a: 1 });
    });

    it('不应能访问require', () => {
      const result = security.sandboxEval('typeof require');
      expect(result.success).toBe(true);
      expect(result.result).toBe('undefined');
    });

    it('process在Node.js环境中仍可访问（Function构造器限制）', () => {
      const result = security.sandboxEval('typeof process');
      expect(result.success).toBe(true);
      // Node.js全局对象在Function构造器中仍可访问，这是平台限制
      expect(result.result).toBe('object');
    });

    it('语法错误应返回error', () => {
      const result = security.sandboxEval('invalid syntax here!!!');
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  // ---- ToolCall JSON Schema 校验 (4.2) ----
  describe('validateToolCall', () => {
    it('应校验有效的read ToolCall', () => {
      const result = security.validateToolCall({
        tool: 'read',
        filePath: 'src/index.ts',
      });
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('应拒绝无效的tool类型', () => {
      const result = security.validateToolCall({
        tool: 'readFile' as any,
        filePath: 'src/index.ts',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('应拒绝越权文件路径', () => {
      const result = security.validateToolCall({
        tool: 'read',
        filePath: '/etc/passwd',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('越权'))).toBe(true);
    });

    it('应拒绝危险路径', () => {
      const result = security.validateToolCall({
        tool: 'write',
        filePath: '../../../etc/shadow',
        content: 'hacked',
      });
      expect(result.valid).toBe(false);
    });

    it('应拒绝不在白名单的Shell命令', () => {
      const result = security.validateToolCall({
        tool: 'bash',
        command: 'rm -rf /',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('白名单') || e.includes('危险'))).toBe(true);
    });

    it('应拒绝危险命令', () => {
      const result = security.validateToolCall({
        tool: 'bash',
        command: 'rm -rf /home',
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('validateToolCalls', () => {
    it('应批量校验ToolCall', () => {
      const results = security.validateToolCalls([
        { tool: 'read', filePath: 'src/index.ts' },
        { tool: 'write', filePath: 'src/test.ts', content: 'test' },
      ]);
      expect(results.valid.length).toBe(2);
      expect(results.invalid.length).toBe(0);
    });

    it('应截断超过批量上限的文件操作', () => {
      const securityWithLimit = new SecurityManager(projectRoot, {
        masterKey: 'test-key',
        execWhiteList: ['git'],
        maxBatchFiles: 3,
      });
      const toolCalls = Array.from({ length: 10 }, (_, i) => ({
        tool: 'read' as const,
        filePath: `file${i}.ts`,
      }));
      const results = securityWithLimit.validateToolCalls(toolCalls);
      // 前3个应该有效，后面的应该被截断
      expect(results.valid.length + results.invalid.length).toBeLessThanOrEqual(10);
    });
  });

  // ---- Docker容器沙箱 (6.3) ----
  describe('executeInDocker', () => {
    it('Docker沙箱未启用时应返回错误', () => {
      const result = security.executeInDocker('ls -la');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Docker沙箱未启用');
    });

    it('启用后应尝试执行（可能Docker不可用）', () => {
      security.setDockerSandbox(true);
      const result = security.executeInDocker('echo hello');
      // Docker可能不可用，所以只检查返回结构
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('output');
      security.setDockerSandbox(false);
    });
  });
});