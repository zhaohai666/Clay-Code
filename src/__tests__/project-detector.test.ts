import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectProject, ProjectInfo } from '../core/project-detector';

describe('ProjectDetector', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `claycode-project-detector-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- Node.js 项目识别 ----
  describe('Node.js项目识别', () => {
    it('应识别npm项目(package.json)', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project' }));
      const info = detectProject(tmpDir);
      expect(info.type).toBe('node');
      expect(info.packageManager).toBe('npm');
      expect(info.markerFiles).toContain('package.json');
      expect(info.buildCommand).toContain('npm');
      expect(info.testCommand).toContain('npm');
    });

    it('应识别pnpm项目(pnpm-lock.yaml优先)', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project' }));
      fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '');
      const info = detectProject(tmpDir);
      expect(info.type).toBe('node');
      expect(info.packageManager).toBe('pnpm');
      expect(info.markerFiles).toContain('package.json');
      expect(info.markerFiles).toContain('pnpm-lock.yaml');
    });

    it('应识别yarn项目(yarn.lock)', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project' }));
      fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), '');
      const info = detectProject(tmpDir);
      expect(info.type).toBe('node');
      expect(info.packageManager).toBe('yarn');
    });

    it('应从package.json scripts中提取命令', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        name: 'test-project',
        scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' },
      }));
      const info = detectProject(tmpDir);
      expect(info.buildCommand).toContain('build');
      expect(info.testCommand).toContain('test');
      expect(info.lintCommand).toContain('lint');
    });

    it('应检测TypeScript项目', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project' }));
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
      const info = detectProject(tmpDir);
      expect(info.isTypeScript).toBe(true);
    });

    it('非TypeScript项目应返回isTypeScript=false', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project' }));
      const info = detectProject(tmpDir);
      expect(info.isTypeScript).toBe(false);
    });

    it('应提取依赖信息到metadata', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
        name: 'test-project',
        dependencies: { express: '^4.18.0' },
        devDependencies: { vitest: '^1.0.0' },
      }));
      const info = detectProject(tmpDir);
      expect(info.metadata.dependencies).toContain('express');
      expect(info.metadata.devDependencies).toContain('vitest');
    });
  });

  // ---- Java 项目识别 ----
  describe('Java项目识别', () => {
    it('应识别Maven项目(pom.xml)', () => {
      fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
      const info = detectProject(tmpDir);
      expect(info.type).toBe('java');
      expect(info.packageManager).toBe('maven');
      expect(info.buildCommand).toContain('mvn');
      expect(info.testCommand).toContain('mvn test');
      expect(info.sourceDirs).toContain('src/main/java');
    });

    it('应识别Gradle项目(build.gradle)', () => {
      fs.writeFileSync(path.join(tmpDir, 'build.gradle'), '');
      const info = detectProject(tmpDir);
      expect(info.type).toBe('java');
      expect(info.packageManager).toBe('gradle');
      expect(info.buildCommand).toContain('gradle');
    });

    it('应识别Gradle Kotlin项目(build.gradle.kts)', () => {
      fs.writeFileSync(path.join(tmpDir, 'build.gradle.kts'), '');
      const info = detectProject(tmpDir);
      expect(info.type).toBe('java');
      expect(info.packageManager).toBe('gradle');
    });
  });

  // ---- Go 项目识别 ----
  describe('Go项目识别', () => {
    it('应识别Go项目(go.mod)', () => {
      fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21');
      const info = detectProject(tmpDir);
      expect(info.type).toBe('go');
      expect(info.packageManager).toBe('go-mod');
      expect(info.buildCommand).toContain('go build');
      expect(info.testCommand).toContain('go test');
    });
  });

  // ---- Rust 项目识别 ----
  describe('Rust项目识别', () => {
    it('应识别Rust项目(Cargo.toml)', () => {
      fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');
      const info = detectProject(tmpDir);
      expect(info.type).toBe('rust');
      expect(info.packageManager).toBe('cargo');
      expect(info.buildCommand).toContain('cargo build');
      expect(info.testCommand).toContain('cargo test');
    });
  });

  // ---- Python 项目识别 ----
  describe('Python项目识别', () => {
    it('应识别Python项目(setup.py)', () => {
      fs.writeFileSync(path.join(tmpDir, 'setup.py'), 'from setuptools import setup');
      const info = detectProject(tmpDir);
      expect(info.type).toBe('python');
      expect(info.packageManager).toBe('pip');
      expect(info.testCommand).toContain('pytest');
    });

    it('应识别Python项目(pyproject.toml)', () => {
      fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[build-system]');
      const info = detectProject(tmpDir);
      expect(info.type).toBe('python');
      expect(info.packageManager).toBe('pip');
    });

    it('应识别Python项目(requirements.txt)', () => {
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask==2.0');
      const info = detectProject(tmpDir);
      expect(info.type).toBe('python');
    });
  });

  // ---- 未识别项目 ----
  describe('未识别项目', () => {
    it('空目录应返回unknown类型', () => {
      const info = detectProject(tmpDir);
      expect(info.type).toBe('unknown');
      expect(info.packageManager).toBe('unknown');
      expect(info.markerFiles).toEqual([]);
      expect(info.buildCommand).toBe('');
      expect(info.isTypeScript).toBe(false);
    });

    it('未识别项目应包含默认忽略目录', () => {
      const info = detectProject(tmpDir);
      expect(info.ignoreDirs).toContain('.git');
      expect(info.ignoreDirs).toContain('node_modules');
    });
  });

  // ---- 通用属性 ----
  describe('通用属性', () => {
    it('rootDir应为绝对路径', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      const info = detectProject(tmpDir);
      expect(path.isAbsolute(info.rootDir)).toBe(true);
    });

    it('ignoreDirs应包含.git', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
      const info = detectProject(tmpDir);
      expect(info.ignoreDirs).toContain('.git');
    });
  });
});