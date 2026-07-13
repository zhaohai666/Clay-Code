/**
 * @claycode/code-index 代码符号索引模块 (V1.2)
 * 基于 Tree-sitter WASM 实现代码符号索引，纯 WebAssembly 运行
 * 提取类、函数、接口、常量、类型定义符号，构建内存索引
 * 支持 symbol_search 工具精准定位代码片段
 * 支持 TypeScript/JavaScript, Java, Go, Python, C/C++, Rust
 * 当 Tree-sitter 不可用时，自动回退到正则解析
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils';
import { treeSitterLoader, TreeSitterLanguageConfig } from './tree-sitter-loader';

// ============================================================
// 类型定义
// ============================================================

/** 符号类型 */
export type SymbolKind = 'class' | 'interface' | 'function' | 'method' | 'constant' | 'variable' | 'type' | 'enum' | 'struct' | 'trait' | 'namespace' | 'module' | 'macro' | 'template' | 'property';

/** 代码符号 */
export interface CodeSymbol {
  /** 符号名称 */
  name: string;
  /** 符号类型 */
  kind: SymbolKind;
  /** 所在文件路径（相对路径） */
  filePath: string;
  /** 行号（1-based） */
  line: number;
  /** 列号（1-based） */
  column: number;
  /** 符号签名（函数参数、类继承等） */
  signature?: string;
  /** 所属父符号（如类中的方法） */
  parentName?: string;
  /** 语言 */
  language: string;
}

/** 文件索引 */
export interface FileIndex {
  /** 文件路径 */
  filePath: string;
  /** 语言 */
  language: string;
  /** 文件中的符号列表 */
  symbols: CodeSymbol[];
  /** 导入/引用的文件列表 */
  imports: string[];
  /** 索引时间戳 */
  indexedAt: number;
}

/** 索引搜索结果 */
export interface SymbolSearchResult {
  /** 匹配的符号 */
  symbol: CodeSymbol;
  /** 代码片段（符号所在行及上下文） */
  snippet: string;
  /** 相关性分数 */
  score: number;
}

/** 依赖图谱节点 */
export interface DependencyNode {
  /** 文件路径 */
  filePath: string;
  /** 该文件导入的依赖列表 */
  dependencies: string[];
  /** 依赖该文件的反向引用列表 */
  dependents: string[];
  /** 文件中的符号数量 */
  symbolCount: number;
  /** 语言 */
  language: string;
}

/** 依赖图谱 */
export interface DependencyGraph {
  /** 图谱节点映射（文件路径 -> 节点） */
  nodes: Map<string, DependencyNode>;
  /** 总依赖关系数 */
  totalEdges: number;
  /** 环检测：循环依赖路径列表 */
  cycles: string[][];
}

/** 上下文预过滤结果 */
export interface PreFilterResult {
  /** 目标符号信息 */
  symbol: CodeSymbol;
  /** 符号代码片段 */
  snippet: string;
  /** 直接依赖的符号列表 */
  directDependencies: CodeSymbol[];
  /** 被引用的符号列表（反向依赖） */
  referencedBy: CodeSymbol[];
  /** 相关文件路径列表 */
  relatedFiles: string[];
}

// ============================================================
// 语言解析器配置
// ============================================================

interface LanguagePattern {
  language: string;
  extensions: string[];
  patterns: {
    regex: RegExp;
    kind: SymbolKind;
    nameGroup: number;
    signatureGroup?: number;
    parentGroup?: number;
  }[];
  importPattern: RegExp;
}

/** 语言解析器配置表 */
const LANGUAGE_PATTERNS: LanguagePattern[] = [
  // TypeScript / JavaScript
  {
    language: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
    patterns: [
      { regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+[\w,\s]+)?\s*\{/, kind: 'class', nameGroup: 1, signatureGroup: 2 },
      { regex: /^\s*(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?\s*\{/, kind: 'interface', nameGroup: 1 },
      { regex: /^\s*(?:export\s+)?enum\s+(\w+)\s*\{/, kind: 'enum', nameGroup: 1 },
      { regex: /^\s*(?:export\s+)?type\s+(\w+)\s*(?:<[^>]+>)?\s*=/, kind: 'type', nameGroup: 1 },
      { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\(/, kind: 'function', nameGroup: 1 },
      { regex: /^\s*(?:export\s+)?const\s+(\w+)\s*[:=]/, kind: 'constant', nameGroup: 1 },
      { regex: /^\s*(?:export\s+)?let\s+(\w+)\s*[:=]/, kind: 'variable', nameGroup: 1 },
      { regex: /^\s*(?:export\s+)?var\s+(\w+)\s*[:=]/, kind: 'variable', nameGroup: 1 },
      { regex: /^\s*(?:private|public|protected|static|readonly|abstract|override)\s+(?:async\s+)?(\w+)\s*(?:<[^>]+>)?\s*\(/, kind: 'method', nameGroup: 1 },
      { regex: /^\s*(?:private|public|protected|readonly|static)\s+(\w+)\s*[:=]/, kind: 'property', nameGroup: 1 },
      { regex: /^\s*(?:export\s+)?namespace\s+(\w+)\s*\{/, kind: 'namespace', nameGroup: 1 },
    ],
    importPattern: /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g,
  },
  // Java
  {
    language: 'java',
    extensions: ['.java'],
    patterns: [
      { regex: /^\s*(?:public|protected|private)?\s*(?:abstract\s+)?(?:final\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+[\w,\s]+)?\s*\{/, kind: 'class', nameGroup: 1, signatureGroup: 2 },
      { regex: /^\s*(?:public|protected|private)?\s*interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?\s*\{/, kind: 'interface', nameGroup: 1 },
      { regex: /^\s*(?:public|protected|private)?\s*enum\s+(\w+)\s*\{/, kind: 'enum', nameGroup: 1 },
      { regex: /^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:[\w<>\[\]]+\s+)?(\w+)\s*\(/, kind: 'method', nameGroup: 1 },
      { regex: /^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:[\w<>\[\]]+\s+)(\w+)\s*=/, kind: 'constant', nameGroup: 1 },
      { regex: /^\s*package\s+([\w.]+)\s*;/, kind: 'namespace', nameGroup: 1 },
    ],
    importPattern: /import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/g,
  },
  // Go
  {
    language: 'go',
    extensions: ['.go'],
    patterns: [
      { regex: /^\s*type\s+(\w+)\s+struct\s*\{/, kind: 'struct', nameGroup: 1 },
      { regex: /^\s*type\s+(\w+)\s+interface\s*\{/, kind: 'interface', nameGroup: 1 },
      { regex: /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/, kind: 'function', nameGroup: 1 },
      { regex: /^\s*func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)\s*\(/, kind: 'method', nameGroup: 3, parentGroup: 2 },
      { regex: /^\s*const\s+(\w+)\s*=/, kind: 'constant', nameGroup: 1 },
      { regex: /^\s*var\s+(\w+)\s*=/, kind: 'variable', nameGroup: 1 },
      { regex: /^\s*type\s+(\w+)\s+/, kind: 'type', nameGroup: 1 },
      { regex: /^\s*package\s+(\w+)/, kind: 'namespace', nameGroup: 1 },
    ],
    importPattern: /import\s+(?:\([\s\S]*?\)|"([^"]+)")/g,
  },
  // Python
  {
    language: 'python',
    extensions: ['.py', '.pyi'],
    patterns: [
      { regex: /^\s*class\s+(\w+)(?:\([^)]*\))?\s*:/, kind: 'class', nameGroup: 1 },
      { regex: /^\s*def\s+(\w+)\s*\(/, kind: 'function', nameGroup: 1 },
      { regex: /^\s*(\w+)\s*=\s*(?:None|True|False|\d+|['"])/, kind: 'constant', nameGroup: 1 },
      { regex: /^\s*([A-Z_][A-Z0-9_]*)\s*=/, kind: 'constant', nameGroup: 1 },
    ],
    importPattern: /(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/g,
  },
  // C / C++
  {
    language: 'cpp',
    extensions: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'],
    patterns: [
      { regex: /^\s*(?:template\s*<[^>]+>\s*)?(?:class|struct)\s+(\w+)(?:\s*:\s*(?:public|private|protected)\s+\w+)?\s*\{/, kind: 'class', nameGroup: 1 },
      { regex: /^\s*enum\s+(?:class\s+)?(\w+)\s*\{/, kind: 'enum', nameGroup: 1 },
      { regex: /^\s*(?:inline\s+)?(?:static\s+)?(?:[\w:*&<>]+\s+)+(\w+)\s*\(/, kind: 'function', nameGroup: 1 },
      { regex: /^\s*(?:constexpr|const)\s+[\w:*&<>]+\s+(\w+)\s*=/, kind: 'constant', nameGroup: 1 },
      { regex: /^\s*#define\s+(\w+)/, kind: 'macro', nameGroup: 1 },
      { regex: /^\s*namespace\s+(\w+)\s*\{/, kind: 'namespace', nameGroup: 1 },
      { regex: /^\s*typedef\s+[\w\s:*&<>]+\s+(\w+)\s*;/, kind: 'type', nameGroup: 1 },
    ],
    importPattern: /#include\s*[<"]([^>"]+)[>"]/g,
  },
  // Rust
  {
    language: 'rust',
    extensions: ['.rs'],
    patterns: [
      { regex: /^\s*(?:pub\s+)?struct\s+(\w+)/, kind: 'struct', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?enum\s+(\w+)/, kind: 'enum', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?trait\s+(\w+)/, kind: 'trait', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[<(]/, kind: 'function', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?impl\s+(?:<[^>]+>\s+)?(\w+)/, kind: 'class', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?const\s+(\w+)\s*:/, kind: 'constant', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?type\s+(\w+)\s*(?:<[^>]+>)?\s*=/, kind: 'type', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?mod\s+(\w+)/, kind: 'module', nameGroup: 1 },
    ],
    importPattern: /use\s+([\w:]+(?:::\{[\w,\s]+\})?)/g,
  },
];

// ============================================================
// 代码符号索引器
// ============================================================

/** 默认忽略目录 */
const INDEX_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '__pycache__', 'target', '.gradle', 'vendor', 'out', 'bin', 'obj',
  '.cache', '.tmp', '.temp',
]);

/**
 * 代码符号索引器
 * 基于 Tree-sitter WASM 实现，自动回退到正则解析
 */
export class CodeIndexer {
  /** 项目根目录 */
  private projectRoot: string;
  /** 文件索引缓存 */
  private fileIndexes: Map<string, FileIndex> = new Map();
  /** 符号名称索引（名称 -> 符号列表） */
  private symbolByName: Map<string, CodeSymbol[]> = new Map();
  /** 语言扩展名映射（正则回退用） */
  private extensionToLanguage: Map<string, LanguagePattern> = new Map();
  /** 最大索引文件数 */
  private maxFiles: number;
  /** 最大单文件行数（超过跳过） */
  private maxFileLines: number;
  /** Tree-sitter 是否已初始化 */
  private treeSitterReady: boolean = false;

  constructor(projectRoot: string, maxFiles: number = 500, maxFileLines: number = 5000) {
    this.projectRoot = projectRoot;
    this.maxFiles = maxFiles;
    this.maxFileLines = maxFileLines;

    // 构建扩展名到语言映射（正则回退用）
    for (const lang of LANGUAGE_PATTERNS) {
      for (const ext of lang.extensions) {
        this.extensionToLanguage.set(ext, lang);
      }
    }
  }

  /**
   * 初始化 Tree-sitter WASM 运行时
   * 调用此方法后，索引将优先使用 Tree-sitter AST 解析
   * 未调用或初始化失败时，自动回退到正则解析
   */
  async init(): Promise<void> {
    try {
      const success = await treeSitterLoader.init();
      this.treeSitterReady = success;
      if (success) {
        logger.info('[CodeIndexer] Tree-sitter WASM 已就绪，将使用 AST 解析');
      } else {
        logger.info('[CodeIndexer] Tree-sitter 不可用，使用正则解析');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[CodeIndexer] Tree-sitter 初始化异常，使用正则解析: ${message}`);
      this.treeSitterReady = false;
    }
  }

  /** 索引整个项目 */
  indexProject(): { filesIndexed: number; symbolsFound: number } {
    this.fileIndexes.clear();
    this.symbolByName.clear();

    let filesIndexed = 0;
    let symbolsFound = 0;

    this.walkDir(this.projectRoot, (filePath) => {
      if (filesIndexed >= this.maxFiles) return;
      const ext = path.extname(filePath);
      const langPattern = this.extensionToLanguage.get(ext);
      if (!langPattern) return;

      const relPath = path.relative(this.projectRoot, filePath);
      const fileIndex = this.indexFile(relPath, filePath, langPattern);
      if (fileIndex) {
        this.fileIndexes.set(relPath, fileIndex);
        filesIndexed++;
        symbolsFound += fileIndex.symbols.length;

        // 更新符号名称索引
        for (const symbol of fileIndex.symbols) {
          const existing = this.symbolByName.get(symbol.name) ?? [];
          existing.push(symbol);
          this.symbolByName.set(symbol.name, existing);
        }
      }
    });

    logger.info(`[CodeIndexer] 索引完成: ${filesIndexed}个文件, ${symbolsFound}个符号 (模式: ${this.treeSitterReady ? 'Tree-sitter WASM' : '正则'})`);
    return { filesIndexed, symbolsFound };
  }

  /** 索引单个文件 */
  private indexFile(relPath: string, absPath: string, langPattern: LanguagePattern): FileIndex | null {
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const lines = content.split(/\r?\n/);

      // 跳过超大文件
      if (lines.length > this.maxFileLines) {
        logger.debug(`[CodeIndexer] 跳过大文件: ${relPath} (${lines.length}行)`);
        return null;
      }

      // 优先使用 Tree-sitter AST 解析
      if (this.treeSitterReady) {
        const tsResult = this.indexFileWithTreeSitter(relPath, content, langPattern);
        if (tsResult) return tsResult;
        // Tree-sitter 解析失败，回退到正则
        logger.debug(`[CodeIndexer] Tree-sitter 解析失败，回退到正则: ${relPath}`);
      }

      // 正则回退解析
      return this.indexFileWithRegex(relPath, content, lines, langPattern);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`[CodeIndexer] 索引文件失败: ${relPath} - ${message}`);
      return null;
    }
  }

  /**
   * 使用 Tree-sitter WASM 解析文件
   * 基于 AST 遍历提取符号和导入，比正则更准确
   */
  private indexFileWithTreeSitter(relPath: string, content: string, langPattern: LanguagePattern): FileIndex | null {
    try {
      const ext = path.extname(relPath);
      const tsConfig = treeSitterLoader.getLanguageConfig(ext);
      if (!tsConfig) return null;

      // 同步获取已加载的语言（indexProject 前应已调用 init()）
      // 注意：Tree-sitter parse 是同步的，但语言加载是异步的
      // 这里使用已缓存的语言，如果语言未加载则返回 null 回退到正则
      const langName = tsConfig.name;

      // 使用 TreeSitterLoader 的 parse 方法（同步版本）
      // 由于 web-tree-sitter 的 parse 是同步的，我们直接调用
      if (!treeSitterLoader.isInitialized()) return null;

      // 通过 loader 获取已加载的语言
      const language = treeSitterLoader.getLoadedLanguage(langName);
      if (!language) {
        // 语言未加载，尝试标记需要异步加载（下次 init 时加载）
        // 当前回退到正则
        return null;
      }

      const parser = treeSitterLoader.getParser();
      if (!parser) return null;

      parser.setLanguage(language);
      const tree = parser.parse(content);
      if (!tree) return null;

      // 从 AST 提取符号
      const symbols = treeSitterLoader.extractSymbols(tree, tsConfig, relPath);

      // 从 AST 提取导入
      const imports = treeSitterLoader.extractImports(tree, tsConfig);

      tree.delete();

      return {
        filePath: relPath,
        language: langPattern.language,
        symbols,
        imports,
        indexedAt: Date.now(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`[CodeIndexer] Tree-sitter 解析异常: ${relPath} - ${message}`);
      return null;
    }
  }

  /**
   * 使用正则解析文件（回退方案）
   */
  private indexFileWithRegex(relPath: string, content: string, lines: string[], langPattern: LanguagePattern): FileIndex {
    const symbols: CodeSymbol[] = [];
    const imports: string[] = [];

    // 解析符号
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of langPattern.patterns) {
        const match = line.match(pattern.regex);
        if (match) {
          const name = match[pattern.nameGroup];
          if (name && /^\w+$/.test(name)) {
            const symbol: CodeSymbol = {
              name,
              kind: pattern.kind,
              filePath: relPath,
              line: i + 1,
              column: line.indexOf(name) + 1,
              language: langPattern.language,
            };
            if (pattern.signatureGroup && match[pattern.signatureGroup]) {
              symbol.signature = match[pattern.signatureGroup];
            }
            if (pattern.parentGroup && match[pattern.parentGroup]) {
              symbol.parentName = match[pattern.parentGroup];
            }
            symbols.push(symbol);
          }
        }
      }
    }

    // 解析导入
    let importMatch: RegExpExecArray | null;
    const importRegex = new RegExp(langPattern.importPattern.source, langPattern.importPattern.flags);
    while ((importMatch = importRegex.exec(content)) !== null) {
      for (let g = 1; g < importMatch.length; g++) {
        if (importMatch[g]) {
          imports.push(importMatch[g]);
        }
      }
    }

    return {
      filePath: relPath,
      language: langPattern.language,
      symbols,
      imports,
      indexedAt: Date.now(),
    };
  }

  /** 递归遍历目录 */
  private walkDir(dir: string, callback: (filePath: string) => void): void {
    if (!fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (INDEX_IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.clayignore') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.walkDir(fullPath, callback);
        } else if (entry.isFile()) {
          callback(fullPath);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`[CodeIndexer] 遍历目录失败: ${dir} - ${message}`);
    }
  }

  /** 按名称搜索符号 */
  searchByName(name: string, kind?: SymbolKind, limit: number = 20): SymbolSearchResult[] {
    const results: SymbolSearchResult[] = [];

    // 精确匹配
    const exact = this.symbolByName.get(name);
    if (exact) {
      for (const symbol of exact) {
        if (kind && symbol.kind !== kind) continue;
        const snippet = this.getSnippet(symbol);
        results.push({ symbol, snippet, score: 100 });
      }
    }

    // 前缀匹配
    if (results.length < limit) {
      for (const [symbolName, symbols] of this.symbolByName) {
        if (symbolName === name) continue; // 已精确匹配
        if (symbolName.toLowerCase().startsWith(name.toLowerCase())) {
          for (const symbol of symbols) {
            if (kind && symbol.kind !== kind) continue;
            const snippet = this.getSnippet(symbol);
            results.push({ symbol, snippet, score: 80 });
          }
        }
      }
    }

    // 包含匹配
    if (results.length < limit) {
      for (const [symbolName, symbols] of this.symbolByName) {
        if (symbolName === name || symbolName.toLowerCase().startsWith(name.toLowerCase())) continue;
        if (symbolName.toLowerCase().includes(name.toLowerCase())) {
          for (const symbol of symbols) {
            if (kind && symbol.kind !== kind) continue;
            const snippet = this.getSnippet(symbol);
            results.push({ symbol, snippet, score: 60 });
          }
        }
      }
    }

    return results.slice(0, limit);
  }

  /** 获取符号所在行的代码片段（上下文3行） */
  private getSnippet(symbol: CodeSymbol, contextLines: number = 3): string {
    const absPath = path.join(this.projectRoot, symbol.filePath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const startLine = Math.max(0, symbol.line - contextLines - 1);
      const endLine = Math.min(lines.length, symbol.line + contextLines);
      const snippetLines = lines.slice(startLine, endLine);
      return snippetLines
        .map((line, i) => {
          const lineNum = startLine + i + 1;
          const marker = lineNum === symbol.line ? '>>>' : '   ';
          return `${marker} ${String(lineNum).padStart(4, ' ')} │ ${line}`;
        })
        .join('\n');
    } catch {
      return `[无法读取: ${symbol.filePath}:${symbol.line}]`;
    }
  }

  /** 按文件路径获取索引 */
  getFileIndex(filePath: string): FileIndex | undefined {
    return this.fileIndexes.get(filePath);
  }

  /** 获取所有已索引文件路径 */
  getIndexedFiles(): string[] {
    return Array.from(this.fileIndexes.keys());
  }

  /** 获取索引统计信息 */
  getStats(): { files: number; symbols: number; languages: Record<string, number> } {
    const languages: Record<string, number> = {};
    let totalSymbols = 0;
    for (const [, index] of this.fileIndexes) {
      totalSymbols += index.symbols.length;
      languages[index.language] = (languages[index.language] ?? 0) + 1;
    }
    return { files: this.fileIndexes.size, symbols: totalSymbols, languages };
  }

  /** 清除索引 */
  clear(): void {
    this.fileIndexes.clear();
    this.symbolByName.clear();
    this.dependencyGraphCache = null;
    logger.info('[CodeIndexer] 索引已清除');
  }

  // ============================================================
  // 依赖图谱分析 (README 3.5 第4项)
  // ============================================================

  /** 依赖图谱缓存 */
  private dependencyGraphCache: DependencyGraph | null = null;

  /**
   * 构建文件依赖图谱
   * 分析代码导入、引用关系，梳理文件依赖图谱
   * @returns 依赖图谱对象
   */
  buildDependencyGraph(): DependencyGraph {
    // 如果已有缓存且索引未变，直接返回
    if (this.dependencyGraphCache) {
      return this.dependencyGraphCache;
    }

    const nodes = new Map<string, DependencyNode>();
    let totalEdges = 0;

    // 第一遍：构建所有节点
    for (const [filePath, fileIndex] of this.fileIndexes) {
      nodes.set(filePath, {
        filePath,
        dependencies: [],
        dependents: [],
        symbolCount: fileIndex.symbols.length,
        language: fileIndex.language,
      });
    }

    // 第二遍：解析依赖关系，将导入路径解析为项目内文件路径
    for (const [filePath, fileIndex] of this.fileIndexes) {
      const node = nodes.get(filePath)!;
      for (const importPath of fileIndex.imports) {
        const resolvedPath = this.resolveImportPath(importPath, filePath);
        if (resolvedPath && nodes.has(resolvedPath)) {
          node.dependencies.push(resolvedPath);
          nodes.get(resolvedPath)!.dependents.push(filePath);
          totalEdges++;
        }
      }
    }

    // 第三遍：环检测 - 使用DFS检测循环依赖
    const cycles = this.detectCycles(nodes);

    this.dependencyGraphCache = { nodes, totalEdges, cycles };
    logger.info(`[CodeIndexer] 依赖图谱构建完成: ${nodes.size}个节点, ${totalEdges}条边, ${cycles.length}个循环`);
    return this.dependencyGraphCache;
  }

  /**
   * 获取指定文件的依赖信息
   * @param filePath 文件路径（相对路径）
   * @returns 依赖节点，不存在返回null
   */
  getFileDependencies(filePath: string): DependencyNode | null {
    const graph = this.buildDependencyGraph();
    return graph.nodes.get(filePath) || null;
  }

  /**
   * 获取指定文件的完整依赖链（传递依赖）
   * @param filePath 文件路径
   * @param maxDepth 最大深度，默认5
   * @returns 所有传递依赖文件路径列表
   */
  getTransitiveDependencies(filePath: string, maxDepth: number = 5): string[] {
    const graph = this.buildDependencyGraph();
    const visited = new Set<string>();
    const result: string[] = [];

    const dfs = (currentPath: string, depth: number) => {
      if (depth > maxDepth) return;
      const node = graph.nodes.get(currentPath);
      if (!node) return;

      for (const dep of node.dependencies) {
        if (!visited.has(dep)) {
          visited.add(dep);
          result.push(dep);
          dfs(dep, depth + 1);
        }
      }
    };

    visited.add(filePath);
    dfs(filePath, 0);
    return result;
  }

  /**
   * 解析导入路径为项目内相对文件路径
   * 支持 Node.js require/import、Java 全限定名、Go import、Python import 等多种格式
   */
  private resolveImportPath(importSpecifier: string, fromFilePath: string): string | null {
    // Node.js 相对导入: ./xxx, ../xxx
    if (importSpecifier.startsWith('.')) {
      const fromDir = path.dirname(fromFilePath);
      let resolved = path.normalize(path.join(fromDir, importSpecifier));

      // 尝试添加扩展名
      const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
      if (this.fileIndexes.has(resolved)) return resolved;
      for (const ext of extensions) {
        const withExt = resolved + ext;
        if (this.fileIndexes.has(withExt)) return withExt;
      }
      // 尝试 index 文件
      for (const ext of extensions) {
        const indexPath = path.join(resolved, 'index' + ext);
        if (this.fileIndexes.has(indexPath)) return indexPath;
      }
      return null;
    }

    // Node.js 包导入: 尝试匹配 src/ 下的同名路径
    // 例如 'lodash' 不匹配，但 '@/utils' 或项目内路径可能匹配
    if (importSpecifier.startsWith('@/') || importSpecifier.startsWith('~/') || importSpecifier.startsWith('#/')) {
      const stripped = importSpecifier.replace(/^[@~#]\//, '');
      const candidates = [
        stripped,
        'src/' + stripped,
        'lib/' + stripped,
      ];
      const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
      for (const candidate of candidates) {
        if (this.fileIndexes.has(candidate)) return candidate;
        for (const ext of extensions) {
          const withExt = candidate + ext;
          if (this.fileIndexes.has(withExt)) return withExt;
        }
      }
      return null;
    }

    // Go import: github.com/org/repo/pkg -> 尝试匹配 pkg/...
    if (importSpecifier.includes('/')) {
      const parts = importSpecifier.split('/');
      // 尝试最后一段或最后两段作为目录
      for (let i = Math.max(0, parts.length - 3); i < parts.length; i++) {
        const candidate = parts.slice(i).join('/');
        if (this.fileIndexes.has(candidate)) return candidate;
        // 尝试作为目录前缀匹配
        for (const [filePath] of this.fileIndexes) {
          if (filePath.startsWith(candidate + '/') || filePath.startsWith(candidate + '.')) {
            return filePath.split('/').slice(0, candidate.split('/').length).join('/');
          }
        }
      }
    }

    // Java 全限定名: com.example.Class -> 尝试匹配路径
    if (/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*\.[A-Z]/.test(importSpecifier)) {
      const javaPath = importSpecifier.replace(/\./g, '/') + '.java';
      if (this.fileIndexes.has(javaPath)) return javaPath;
      // 尝试 src/main/java/ 下的路径
      const mavenPath = 'src/main/java/' + javaPath;
      if (this.fileIndexes.has(mavenPath)) return mavenPath;
    }

    // Python import: a.b.c -> 尝试匹配 a/b/c.py 或 a/b.py
    if (/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)+$/.test(importSpecifier)) {
      const pyPath = importSpecifier.replace(/\./g, '/') + '.py';
      if (this.fileIndexes.has(pyPath)) return pyPath;
      // 包目录下的 __init__.py
      const initPath = importSpecifier.replace(/\./g, '/') + '/__init__.py';
      if (this.fileIndexes.has(initPath)) return initPath;
      // 父模块
      const parts = importSpecifier.split('.');
      for (let i = parts.length - 1; i > 0; i--) {
        const parentPath = parts.slice(0, i).join('/') + '.py';
        if (this.fileIndexes.has(parentPath)) return parentPath;
      }
    }

    // Rust: crate::module -> 尝试匹配 src/module.rs
    if (importSpecifier.includes('::')) {
      const rustParts = importSpecifier.split('::').filter(p => p !== 'crate' && p !== 'super' && p !== 'self');
      if (rustParts.length > 0) {
        const rustPath = 'src/' + rustParts.join('/') + '.rs';
        if (this.fileIndexes.has(rustPath)) return rustPath;
        const rustModPath = 'src/' + rustParts.join('/') + '/mod.rs';
        if (this.fileIndexes.has(rustModPath)) return rustModPath;
      }
    }

    return null;
  }

  /**
   * DFS环检测：检测循环依赖
   */
  private detectCycles(nodes: Map<string, DependencyNode>): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const stack: string[] = [];

    const dfs = (filePath: string) => {
      if (inStack.has(filePath)) {
        // 发现环
        const cycleStart = stack.indexOf(filePath);
        if (cycleStart >= 0) {
          const cycle = stack.slice(cycleStart).concat([filePath]);
          // 只记录长度>1的环，避免自环
          if (cycle.length > 2) {
            cycles.push(cycle);
          }
        }
        return;
      }
      if (visited.has(filePath)) return;

      visited.add(filePath);
      inStack.add(filePath);
      stack.push(filePath);

      const node = nodes.get(filePath);
      if (node) {
        for (const dep of node.dependencies) {
          dfs(dep);
        }
      }

      stack.pop();
      inStack.delete(filePath);
    };

    for (const filePath of nodes.keys()) {
      if (!visited.has(filePath)) {
        dfs(filePath);
      }
    }

    return cycles;
  }

  // ============================================================
  // 上下文预过滤 (README 3.5 第5项)
  // ============================================================

  /**
   * 上下文预过滤：AI查询指定函数时，仅推送目标代码片段
   * 降低上下文占用，避免加载完整文件
   * @param symbolName 符号名称
   * @param kind 可选符号类型过滤
   * @param contextLines 上下文行数，默认3
   * @returns 预过滤结果，包含符号片段、直接依赖和反向引用
   */
  preFilterContext(symbolName: string, kind?: SymbolKind, contextLines: number = 3): PreFilterResult | null {
    // 1. 查找目标符号
    const symbols = this.symbolByName.get(symbolName);
    if (!symbols || symbols.length === 0) return null;

    const targetSymbol = kind
      ? symbols.find(s => s.kind === kind)
      : symbols[0];
    if (!targetSymbol) return null;

    // 2. 获取符号代码片段
    const snippet = this.getSnippet(targetSymbol, contextLines);

    // 3. 查找直接依赖符号（同文件中引用的其他符号）
    const directDependencies = this.findDirectDependencies(targetSymbol, contextLines);

    // 4. 查找反向引用（哪些符号引用了目标符号）
    const referencedBy = this.findReferencedBy(targetSymbol);

    // 5. 收集相关文件
    const relatedFiles = new Set<string>();
    relatedFiles.add(targetSymbol.filePath);
    for (const dep of directDependencies) {
      relatedFiles.add(dep.filePath);
    }
    for (const ref of referencedBy) {
      relatedFiles.add(ref.filePath);
    }

    return {
      symbol: targetSymbol,
      snippet,
      directDependencies,
      referencedBy,
      relatedFiles: Array.from(relatedFiles),
    };
  }

  /**
   * 查找符号的直接依赖
   * 解析符号所在文件的imports，找出项目内被引用的符号
   */
  private findDirectDependencies(symbol: CodeSymbol, limit: number = 10): CodeSymbol[] {
    const fileIndex = this.fileIndexes.get(symbol.filePath);
    if (!fileIndex) return [];

    const deps: CodeSymbol[] = [];
    const graph = this.buildDependencyGraph();
    const node = graph.nodes.get(symbol.filePath);
    if (!node) return [];

    // 从依赖文件中提取符号
    for (const depPath of node.dependencies) {
      const depIndex = this.fileIndexes.get(depPath);
      if (depIndex) {
        for (const s of depIndex.symbols) {
          if (deps.length >= limit) break;
          // 优先包含导出符号（class, function, interface, type, constant）
          if (['class', 'function', 'interface', 'type', 'constant', 'enum'].includes(s.kind)) {
            deps.push(s);
          }
        }
      }
      if (deps.length >= limit) break;
    }

    return deps.slice(0, limit);
  }

  /**
   * 查找引用了目标符号的其他符号（反向依赖）
   */
  private findReferencedBy(symbol: CodeSymbol, limit: number = 10): CodeSymbol[] {
    const refs: CodeSymbol[] = [];
    const graph = this.buildDependencyGraph();
    const node = graph.nodes.get(symbol.filePath);
    if (!node) return [];

    // 从反向引用文件中提取符号
    for (const depPath of node.dependents) {
      const depIndex = this.fileIndexes.get(depPath);
      if (depIndex) {
        for (const s of depIndex.symbols) {
          if (refs.length >= limit) break;
          // 优先包含函数和方法（最可能引用目标符号）
          if (['function', 'method', 'class'].includes(s.kind)) {
            refs.push(s);
          }
        }
      }
      if (refs.length >= limit) break;
    }

    return refs.slice(0, limit);
  }
}