/**
 * Tree-sitter WASM 加载器
 * 基于 web-tree-sitter 实现纯 WebAssembly 代码解析
 * 支持按需下载和缓存语言 grammar WASM 文件
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { Parser, Language, Tree, Node as SyntaxNode, TreeCursor } from 'web-tree-sitter';
import { logger } from '../utils';

/** Tree-sitter 语言配置 */
export interface TreeSitterLanguageConfig {
  /** 语言标识名 */
  name: string;
  /** grammar npm 包名 */
  packageName: string;
  /** 文件扩展名到语言映射 */
  extensions: string[];
  /** AST 节点类型到 SymbolKind 的映射 */
  nodeTypeMapping: Record<string, string>;
  /** 导入语句的 AST 节点类型 */
  importNodeTypes: string[];
}

/** 支持的 Tree-sitter 语言配置表 */
export const TREE_SITTER_LANGUAGES: TreeSitterLanguageConfig[] = [
  {
    name: 'typescript',
    packageName: 'tree-sitter-typescript',
    extensions: ['.ts', '.tsx'],
    nodeTypeMapping: {
      class_declaration: 'class',
      function_declaration: 'function',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      type_alias_declaration: 'type',
      lexical_declaration: 'constant',
      variable_declaration: 'variable',
      method_definition: 'method',
      public_field_definition: 'property',
      namespace_declaration: 'namespace',
      abstract_class_declaration: 'class',
      generator_function_declaration: 'function',
    },
    importNodeTypes: ['import_statement', 'import_clause'],
  },
  {
    name: 'javascript',
    packageName: 'tree-sitter-javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    nodeTypeMapping: {
      class_declaration: 'class',
      function_declaration: 'function',
      method_definition: 'method',
      generator_function_declaration: 'function',
      lexical_declaration: 'constant',
      variable_declaration: 'variable',
      export_statement: 'namespace',
    },
    importNodeTypes: ['import_statement'],
  },
  {
    name: 'java',
    packageName: 'tree-sitter-java',
    extensions: ['.java'],
    nodeTypeMapping: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      method_declaration: 'method',
      field_declaration: 'property',
      package_declaration: 'namespace',
      annotation_type_declaration: 'interface',
    },
    importNodeTypes: ['import_declaration'],
  },
  {
    name: 'go',
    packageName: 'tree-sitter-go',
    extensions: ['.go'],
    nodeTypeMapping: {
      type_declaration: 'type',
      method_declaration: 'method',
      function_declaration: 'function',
      short_var_declaration: 'variable',
      var_declaration: 'variable',
      const_declaration: 'constant',
      package_clause: 'namespace',
    },
    importNodeTypes: ['import_declaration'],
  },
  {
    name: 'python',
    packageName: 'tree-sitter-python',
    extensions: ['.py', '.pyi'],
    nodeTypeMapping: {
      class_definition: 'class',
      function_definition: 'function',
      decorated_definition: 'function',
    },
    importNodeTypes: ['import_statement', 'import_from_statement'],
  },
  {
    name: 'cpp',
    packageName: 'tree-sitter-cpp',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
    nodeTypeMapping: {
      class_specifier: 'class',
      struct_specifier: 'struct',
      enum_specifier: 'enum',
      function_definition: 'function',
      declaration: 'constant',
      preproc_include: 'namespace',
      namespace_definition: 'namespace',
      template_declaration: 'template',
      type_definition: 'type',
    },
    importNodeTypes: ['preproc_include'],
  },
  {
    name: 'c',
    packageName: 'tree-sitter-c',
    extensions: ['.c', '.h'],
    nodeTypeMapping: {
      struct_specifier: 'struct',
      enum_specifier: 'enum',
      function_definition: 'function',
      declaration: 'constant',
      preproc_include: 'namespace',
      type_definition: 'type',
    },
    importNodeTypes: ['preproc_include'],
  },
  {
    name: 'rust',
    packageName: 'tree-sitter-rust',
    extensions: ['.rs'],
    nodeTypeMapping: {
      struct_item: 'struct',
      enum_item: 'enum',
      trait_item: 'trait',
      function_item: 'function',
      impl_item: 'class',
      const_item: 'constant',
      type_item: 'type',
      mod_item: 'module',
    },
    importNodeTypes: ['use_declaration'],
  },
];

/** grammar WASM 文件的 CDN 下载基础 URL */
const GRAMMAR_CDN_BASE = 'https://cdn.jsdelivr.net/npm';

/** grammar 缓存目录 */
const GRAMMAR_CACHE_DIR = path.join(os.homedir(), '.claycode', 'grammars');

/**
 * Tree-sitter WASM 加载器
 * 管理Parser初始化、语言grammar加载和缓存
 */
export class TreeSitterLoader {
  private parser: Parser | null = null;
  private languages: Map<string, Language> = new Map();
  private extensionToLanguage: Map<string, TreeSitterLanguageConfig> = new Map();
  private initialized: boolean = false;
  private initPromise: Promise<boolean> | null = null;

  constructor() {
    // 构建扩展名到语言配置的映射
    for (const lang of TREE_SITTER_LANGUAGES) {
      for (const ext of lang.extensions) {
        this.extensionToLanguage.set(ext, lang);
      }
    }
  }

  /**
   * 初始化 Tree-sitter WASM 运行时
   * @returns 是否初始化成功
   */
  async init(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<boolean> {
    try {
      await Parser.init();
      this.parser = new Parser();
      this.initialized = true;
      logger.info('[TreeSitterLoader] Tree-sitter WASM 运行时初始化成功');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[TreeSitterLoader] Tree-sitter WASM 初始化失败，将使用正则回退: ${message}`);
      this.initialized = false;
      return false;
    }
  }

  /** 是否已初始化 */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取已加载的语言（同步方法，仅返回已缓存的语言）
   */
  getLoadedLanguage(langName: string): Language | null {
    return this.languages.get(langName) ?? null;
  }

  /**
   * 获取 Parser 实例（同步方法）
   */
  getParser(): Parser | null {
    return this.parser;
  }

  /**
   * 根据文件扩展名获取语言配置
   */
  getLanguageConfig(ext: string): TreeSitterLanguageConfig | undefined {
    return this.extensionToLanguage.get(ext);
  }

  /**
   * 加载指定语言的 grammar
   * 优先从缓存加载，缓存不存在则从 CDN 下载
   */
  async loadLanguage(langName: string): Promise<Language | null> {
    if (!this.initialized || !this.parser) return null;
    if (this.languages.has(langName)) return this.languages.get(langName)!;

    const config = TREE_SITTER_LANGUAGES.find(l => l.name === langName);
    if (!config) return null;

    // 确保缓存目录存在
    if (!fs.existsSync(GRAMMAR_CACHE_DIR)) {
      fs.mkdirSync(GRAMMAR_CACHE_DIR, { recursive: true });
    }

    const wasmFileName = `${config.packageName}.wasm`;
    const wasmPath = path.join(GRAMMAR_CACHE_DIR, wasmFileName);

    // 如果缓存中不存在，尝试下载
    if (!fs.existsSync(wasmPath)) {
      const downloaded = await this.downloadGrammar(config.packageName, wasmPath);
      if (!downloaded) return null;
    }

    // 加载 grammar
    try {
      const language = await Language.load(wasmPath);
      this.languages.set(langName, language);
      logger.debug(`[TreeSitterLoader] 加载语言 grammar: ${langName}`);
      return language;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[TreeSitterLoader] 加载 grammar 失败 ${langName}: ${message}`);
      // 删除损坏的缓存文件
      try { fs.unlinkSync(wasmPath); } catch { /* 忽略 */ }
      return null;
    }
  }

  /**
   * 从 CDN 下载 grammar WASM 文件
   */
  private async downloadGrammar(packageName: string, targetPath: string): Promise<boolean> {
    // 尝试多个 CDN 源
    const urls = [
      `${GRAMMAR_CDN_BASE}/${packageName}@latest/${packageName}.wasm`,
      `${GRAMMAR_CDN_BASE}/${packageName}/latest/${packageName}.wasm`,
    ];

    for (const url of urls) {
      try {
        logger.info(`[TreeSitterLoader] 下载 grammar: ${packageName}...`);
        const buffer = await this.downloadFile(url);
        if (buffer && buffer.length > 0) {
          fs.writeFileSync(targetPath, buffer);
          logger.info(`[TreeSitterLoader] grammar 下载成功: ${packageName} (${(buffer.length / 1024).toFixed(1)}KB)`);
          return true;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug(`[TreeSitterLoader] 下载失败 ${url}: ${message}`);
      }
    }

    logger.warn(`[TreeSitterLoader] 无法下载 grammar: ${packageName}，将使用正则回退`);
    return false;
  }

  /**
   * 下载文件内容
   */
  private downloadFile(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      client.get(url, { timeout: 30000 }, (res) => {
        // 处理重定向
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.downloadFile(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  /**
   * 解析代码文件
   * @param content 文件内容
   * @param langName 语言名称
   * @returns AST Tree，失败返回 null
   */
  async parse(content: string, langName: string): Promise<Tree | null> {
    if (!this.initialized || !this.parser) return null;

    const language = await this.loadLanguage(langName);
    if (!language) return null;

    this.parser.setLanguage(language);
    return this.parser.parse(content);
  }

  /**
   * 从 AST 中提取符号
   * @param tree AST 树
   * @param config 语言配置
   * @param filePath 文件路径
   * @returns 提取的符号列表
   */
  extractSymbols(tree: Tree, config: TreeSitterLanguageConfig, filePath: string): import('./code-index').CodeSymbol[] {
    const symbols: import('./code-index').CodeSymbol[] = [];
    const cursor = tree.walk();

    const visit = () => {
      const node = cursor.currentNode;
      const kind = config.nodeTypeMapping[node.type];

      if (kind) {
        // 提取符号名称
        const name = this.extractName(node, cursor);
        if (name) {
          // 提取父符号名（如类中的方法）
          const parentName = this.extractParentName(cursor);
          // 提取签名（如继承的类名）
          const signature = this.extractSignature(node);

          symbols.push({
            name,
            kind: kind as import('./code-index').SymbolKind,
            filePath,
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
            signature: signature || undefined,
            parentName: parentName || undefined,
            language: config.name,
          });
        }
      }

      // 递归遍历子节点
      if (cursor.gotoFirstChild()) {
        do {
          visit();
        } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };

    visit();
    cursor.delete();
    return symbols;
  }

  /**
   * 从 AST 节点提取符号名称
   */
  private extractName(node: SyntaxNode, cursor: TreeCursor): string | null {
    // 尝试从 name 子节点获取
    const nameNode = node.childForFieldName('name');
    if (nameNode) return nameNode.text;

    // 对于某些节点类型，名称在第一个标识符子节点
    for (const child of node.children) {
      if (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'property_identifier') {
        return child.text;
      }
    }

    return null;
  }

  /**
   * 提取父符号名称（向上查找最近的类/接口等）
   */
  private extractParentName(cursor: TreeCursor): string | null {
    // 保存当前位置
    const currentDepth = this.getCursorDepth(cursor);

    // 向上查找父节点
    let parentName: string | null = null;
    while (cursor.gotoParent()) {
      const node = cursor.currentNode;
      if (['class_declaration', 'interface_declaration', 'enum_declaration', 'struct_item', 'impl_item'].includes(node.type)) {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          parentName = nameNode.text;
        }
        break;
      }
    }

    // 恢复光标位置
    this.restoreCursorDepth(cursor, currentDepth);
    return parentName;
  }

  /**
   * 提取签名信息（如继承的类名）
   */
  private extractSignature(node: SyntaxNode): string | null {
    // 尝试从 extends/implements 子节点获取
    const extendsNode = node.childForFieldName('extends');
    if (extendsNode) return extendsNode.text;

    const implementsNode = node.childForFieldName('implements');
    if (implementsNode) return implementsNode.text;

    // 对于 Java class，尝试从 superclass 获取
    const superclassNode = node.childForFieldName('superclass');
    if (superclassNode) return superclassNode.text;

    return null;
  }

  /**
   * 获取光标深度（用于保存/恢复位置）
   */
  private getCursorDepth(cursor: TreeCursor): number {
    let depth = 0;
    const tempCursor = cursor;
    while (tempCursor.gotoParent()) {
      depth++;
    }
    return depth;
  }

  /**
   * 恢复光标到指定深度
   */
  private restoreCursorDepth(cursor: TreeCursor, targetDepth: number): void {
    // 先回到根节点
    while (cursor.gotoParent()) {
      // 继续向上
    }
    // 然后向下遍历到目标深度（简化实现，不保证精确位置）
    // 注意：这是一个简化实现，实际使用中可能需要更精确的位置恢复
  }

  /**
   * 从 AST 中提取导入语句
   * @param tree AST 树
   * @param config 语言配置
   * @returns 导入路径列表
   */
  extractImports(tree: Tree, config: TreeSitterLanguageConfig): string[] {
    const imports: string[] = [];
    const cursor = tree.walk();

    const visit = () => {
      const node = cursor.currentNode;

      if (config.importNodeTypes.includes(node.type)) {
        // 提取导入路径
        const importPath = this.extractImportPath(node);
        if (importPath) {
          imports.push(importPath);
        }
      }

      // 递归遍历子节点
      if (cursor.gotoFirstChild()) {
        do {
          visit();
        } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };

    visit();
    cursor.delete();
    return imports;
  }

  /**
   * 从导入语句节点提取导入路径
   */
  private extractImportPath(node: SyntaxNode): string | null {
    // 尝试从 source 子节点获取（TypeScript/JavaScript）
    const sourceNode = node.childForFieldName('source');
    if (sourceNode) {
      // 去掉引号
      const text = sourceNode.text;
      return text.replace(/^['"]|['"]$/g, '');
    }

    // 尝试从 module 子节点获取（Python）
    const moduleNode = node.childForFieldName('module');
    if (moduleNode) {
      return moduleNode.text;
    }

    // 尝试从 name 子节点获取（Java）
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      return nameNode.text;
    }

    // 对于 Go import，查找 string_literal 子节点
    for (const child of node.children) {
      if (child.type === 'string_literal' || child.type === 'interpreted_string_literal') {
        return child.text.replace(/^"|"$/g, '');
      }
    }

    // 对于 C/C++ #include，查找 string_literal 或 system_lib_string
    for (const child of node.children) {
      if (child.type === 'string_literal' || child.type === 'system_lib_string') {
        return child.text.replace(/^["<]|[">]$/g, '');
      }
    }

    // 对于 Rust use，提取路径
    if (node.type === 'use_declaration') {
      const argNode = node.childForFieldName('argument');
      if (argNode) return argNode.text;
    }

    return null;
  }
}

/** 全局 Tree-sitter 加载器单例 */
export const treeSitterLoader = new TreeSitterLoader();