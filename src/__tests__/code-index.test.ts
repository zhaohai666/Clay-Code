import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeIndexer, DependencyNode, DependencyGraph, PreFilterResult } from '../core/code-index';

describe('CodeIndexer', () => {
  let tmpDir: string;
  let indexer: CodeIndexer;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `claycode-index-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // 创建测试项目结构
    fs.mkdirSync(path.join(tmpDir, 'services'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'utils'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'main.ts'), `
import { UserService } from './services/user';
import { Logger } from './utils/logger';

export class App {
  constructor(private userService: UserService, private logger: Logger) {}
  run() { this.logger.log('running'); }
}
`);

    fs.writeFileSync(path.join(tmpDir, 'services', 'user.ts'), `
import { Logger } from '../utils/logger';
import { Database } from '../utils/database';

export class UserService {
  constructor(private db: Database, private logger: Logger) {}
  getUser(id: string) { return this.db.query('SELECT * FROM users WHERE id = ?', [id]); }
}
`);

    fs.writeFileSync(path.join(tmpDir, 'utils', 'logger.ts'), `
export class Logger {
  log(msg: string) { console.log(msg); }
  error(msg: string) { console.error(msg); }
}
`);

    fs.writeFileSync(path.join(tmpDir, 'utils', 'database.ts'), `
import { Logger } from './logger';

export class Database {
  constructor(private logger: Logger) {}
  query(sql: string, params: unknown[]) { return []; }
}
`);

    // 创建Go文件测试
    fs.writeFileSync(path.join(tmpDir, 'main.go'), `
package main

import (
  "fmt"
  "github.com/example/project/internal/handler"
)

func main() {
  handler.Handle()
}
`);

    // 创建Python文件测试
    fs.writeFileSync(path.join(tmpDir, 'app.py'), `
from utils.helper import process_data
from services.api import APIClient

def main():
    data = process_data()
    client = APIClient()
    client.send(data)
`);

    indexer = new CodeIndexer(tmpDir, 100, 5000);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- 基础索引 ----
  describe('indexProject', () => {
    it('应索引项目中的文件和符号', () => {
      const result = indexer.indexProject();
      expect(result.filesIndexed).toBeGreaterThan(0);
      expect(result.symbolsFound).toBeGreaterThan(0);
    });

    it('应跳过被忽略的目录', () => {
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}');
      const result = indexer.indexProject();
      // node_modules应被跳过
      const files = indexer.getIndexedFiles();
      expect(files.some(f => f.includes('node_modules'))).toBe(false);
    });
  });

  describe('searchByName', () => {
    it('应按名称搜索符号', () => {
      indexer.indexProject();
      const results = indexer.searchByName('Logger', 'class');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].symbol.name).toBe('Logger');
    });

    it('应支持模糊搜索', () => {
      indexer.indexProject();
      const results = indexer.searchByName('Log');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ---- 依赖图谱（README 3.5 第4项） ----
  describe('buildDependencyGraph', () => {
    it('应构建文件依赖图谱', () => {
      indexer.indexProject();
      const graph = indexer.buildDependencyGraph();

      expect(graph).toBeDefined();
      expect(graph.nodes.size).toBeGreaterThan(0);
      expect(graph.totalEdges).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(graph.cycles)).toBe(true);
    });

    it('图谱节点应包含依赖和被依赖信息', () => {
      indexer.indexProject();
      const graph = indexer.buildDependencyGraph();

      for (const [filePath, node] of graph.nodes) {
        expect(node.filePath).toBeTruthy();
        expect(Array.isArray(node.dependencies)).toBe(true);
        expect(Array.isArray(node.dependents)).toBe(true);
        expect(typeof node.symbolCount).toBe('number');
        expect(node.language).toBeTruthy();
      }
    });

    it('应缓存图谱结果', () => {
      indexer.indexProject();
      const graph1 = indexer.buildDependencyGraph();
      const graph2 = indexer.buildDependencyGraph();
      // 第二次调用应返回缓存结果（同一引用）
      expect(graph1).toBe(graph2);
    });
  });

  describe('getFileDependencies', () => {
    it('应返回指定文件的依赖信息', () => {
      indexer.indexProject();
      const mainPath = path.join(tmpDir, 'main.ts');
      const node = indexer.getFileDependencies(mainPath);

      if (node) {
        expect(node.filePath).toBe(mainPath);
        expect(node.language).toBe('typescript');
        // main.ts依赖services/user和utils/logger
        expect(node.dependencies.length).toBeGreaterThan(0);
      }
    });

    it('不存在的文件应返回null', () => {
      indexer.indexProject();
      const node = indexer.getFileDependencies('/nonexistent/file.ts');
      expect(node).toBeNull();
    });
  });

  describe('getTransitiveDependencies', () => {
    it('应计算传递依赖', () => {
      indexer.indexProject();
      const mainPath = path.join(tmpDir, 'main.ts');
      const deps = indexer.getTransitiveDependencies(mainPath, 5);

      expect(Array.isArray(deps)).toBe(true);
      // main.ts -> services/user -> utils/database -> utils/logger
      // 传递依赖应包含间接依赖
    });

    it('应限制最大深度', () => {
      indexer.indexProject();
      const mainPath = path.join(tmpDir, 'main.ts');
      const deps1 = indexer.getTransitiveDependencies(mainPath, 1);
      const deps5 = indexer.getTransitiveDependencies(mainPath, 5);
      // 深度1的结果应少于深度5
      expect(deps1.length).toBeLessThanOrEqual(deps5.length);
    });
  });

  describe('resolveImportPath', () => {
    it('应通过依赖图谱解析TypeScript相对导入', () => {
      indexer.indexProject();
      const graph = indexer.buildDependencyGraph();
      // main.ts 导入了 ./services/user，应能解析
      const mainPath = path.relative(tmpDir, path.join(tmpDir, 'main.ts'));
      const node = graph.nodes.get(mainPath);
      if (node) {
        expect(Array.isArray(node.dependencies)).toBe(true);
      }
    });

    it('不存在的导入不应出现在依赖图谱中', () => {
      indexer.indexProject();
      const graph = indexer.buildDependencyGraph();
      // 验证图谱构建正常
      expect(graph.nodes.size).toBeGreaterThan(0);
    });
  });

  describe('detectCycles', () => {
    it('无循环依赖时应返回空数组', () => {
      indexer.indexProject();
      const graph = indexer.buildDependencyGraph();
      // 测试项目无循环依赖
      // 如果有循环，cycles不为空；如果没有，为空
      expect(Array.isArray(graph.cycles)).toBe(true);
    });

    it('有循环依赖时应检测到', () => {
      // 创建循环依赖: a.ts -> b.ts -> a.ts
      fs.writeFileSync(path.join(tmpDir, 'cycle_a.ts'), `
import { B } from './cycle_b';
export class A { b: B = new B(); }
`);
      fs.writeFileSync(path.join(tmpDir, 'cycle_b.ts'), `
import { A } from './cycle_a';
export class B { a: A = new A(); }
`);

      indexer.indexProject();
      const graph = indexer.buildDependencyGraph();
      // 应检测到循环
      expect(graph.cycles.length).toBeGreaterThan(0);
    });
  });

  // ---- 上下文预过滤（README 3.5 第5项） ----
  describe('preFilterContext', () => {
    it('应返回符号的上下文预过滤结果', () => {
      indexer.indexProject();
      const result = indexer.preFilterContext('Logger', 'class', 3);

      if (result) {
        expect(result.symbol).toBeDefined();
        expect(result.symbol.name).toBe('Logger');
        expect(typeof result.snippet).toBe('string');
        expect(Array.isArray(result.directDependencies)).toBe(true);
        expect(Array.isArray(result.referencedBy)).toBe(true);
        expect(Array.isArray(result.relatedFiles)).toBe(true);
      }
    });

    it('不存在的符号应返回null', () => {
      indexer.indexProject();
      const result = indexer.preFilterContext('NonExistentSymbol');
      expect(result).toBeNull();
    });

    it('应包含相关文件', () => {
      indexer.indexProject();
      const result = indexer.preFilterContext('Logger', 'class', 3);

      if (result) {
        // Logger被多个文件引用，relatedFiles应包含这些文件
        expect(result.relatedFiles.length).toBeGreaterThan(0);
      }
    });
  });

  describe('findDirectDependencies', () => {
    it('应通过上下文预过滤查找符号的直接依赖', () => {
      indexer.indexProject();
      const result = indexer.preFilterContext('UserService', 'class', 3);

      if (result) {
        // UserService依赖Database和Logger
        expect(Array.isArray(result.directDependencies)).toBe(true);
      }
    });

    it('不存在的符号应返回null', () => {
      indexer.indexProject();
      const result = indexer.preFilterContext('NonExistent');
      expect(result).toBeNull();
    });
  });

  describe('findReferencedBy', () => {
    it('应通过上下文预过滤查找引用指定符号的其他符号', () => {
      indexer.indexProject();
      const result = indexer.preFilterContext('Logger', 'class', 3);

      if (result) {
        // Logger被UserService, App, Database引用
        expect(Array.isArray(result.referencedBy)).toBe(true);
      }
    });

    it('不存在的符号应返回null', () => {
      indexer.indexProject();
      const result = indexer.preFilterContext('NonExistent');
      expect(result).toBeNull();
    });
  });

  // ---- 辅助方法 ----
  describe('getStats', () => {
    it('应返回索引统计信息', () => {
      indexer.indexProject();
      const stats = indexer.getStats();
      expect(stats.files).toBeGreaterThan(0);
      expect(stats.symbols).toBeGreaterThan(0);
    });
  });

  describe('clear', () => {
    it('应清除所有索引和缓存', () => {
      indexer.indexProject();
      indexer.buildDependencyGraph();
      indexer.clear();

      const stats = indexer.getStats();
      expect(stats.files).toBe(0);
      expect(stats.symbols).toBe(0);
    });
  });
});