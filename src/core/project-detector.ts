/**
 * 工程技术栈自动识别模块 (V1.1 README 3.1.4)
 * 启动任务时自动扫描项目根目录标志性文件，自动识别项目类型，
 * 填充默认构建、测试命令、目录过滤规则。
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

// ---- 类型定义 ----

/** 项目技术栈类型 */
export type ProjectType =
  | 'node'       // Node.js / JavaScript / TypeScript
  | 'java'       // Java (Maven / Gradle)
  | 'go'         // Go
  | 'rust'       // Rust
  | 'python'     // Python
  | 'dotnet'     // .NET / C#
  | 'unknown';   // 未识别

/** 包管理器类型 */
export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'maven' | 'gradle' | 'cargo' | 'go-mod' | 'pip' | 'dotnet' | 'unknown';

/** 识别到的项目信息 */
export interface ProjectInfo {
  /** 项目类型 */
  type: ProjectType;
  /** 包管理器 */
  packageManager: PackageManager;
  /** 项目根目录 */
  rootDir: string;
  /** 识别到的标志性文件列表 */
  markerFiles: string[];
  /** 默认构建命令 */
  buildCommand: string;
  /** 默认测试命令 */
  testCommand: string;
  /** 默认Lint命令 */
  lintCommand: string;
  /** 目录过滤规则（应忽略的目录） */
  ignoreDirs: string[];
  /** 源代码目录 */
  sourceDirs: string[];
  /** 是否为TypeScript项目 */
  isTypeScript: boolean;
  /** 额外元数据 */
  metadata: Record<string, unknown>;
}

// ---- 标志性文件映射 ----

interface MarkerConfig {
  file: string;
  type: ProjectType;
  packageManager: PackageManager;
  buildCommand: string;
  testCommand: string;
  lintCommand: string;
  ignoreDirs: string[];
  sourceDirs: string[];
}

const MARKER_CONFIGS: MarkerConfig[] = [
  // Node.js 生态
  {
    file: 'package.json',
    type: 'node',
    packageManager: 'npm',
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    lintCommand: 'npx eslint .',
    ignoreDirs: ['node_modules', 'dist', 'build', '.cache'],
    sourceDirs: ['src', 'lib'],
  },
  {
    file: 'pnpm-lock.yaml',
    type: 'node',
    packageManager: 'pnpm',
    buildCommand: 'pnpm build',
    testCommand: 'pnpm test',
    lintCommand: 'pnpm eslint .',
    ignoreDirs: ['node_modules', 'dist', 'build', '.cache'],
    sourceDirs: ['src', 'lib'],
  },
  {
    file: 'yarn.lock',
    type: 'node',
    packageManager: 'yarn',
    buildCommand: 'yarn build',
    testCommand: 'yarn test',
    lintCommand: 'yarn eslint .',
    ignoreDirs: ['node_modules', 'dist', 'build', '.cache'],
    sourceDirs: ['src', 'lib'],
  },
  // Java 生态
  {
    file: 'pom.xml',
    type: 'java',
    packageManager: 'maven',
    buildCommand: 'mvn compile',
    testCommand: 'mvn test',
    lintCommand: 'mvn checkstyle:check',
    ignoreDirs: ['target', '.mvn'],
    sourceDirs: ['src/main/java', 'src/test/java'],
  },
  {
    file: 'build.gradle',
    type: 'java',
    packageManager: 'gradle',
    buildCommand: 'gradle build',
    testCommand: 'gradle test',
    lintCommand: 'gradle checkstyleMain',
    ignoreDirs: ['build', '.gradle'],
    sourceDirs: ['src/main/java', 'src/test/java'],
  },
  {
    file: 'build.gradle.kts',
    type: 'java',
    packageManager: 'gradle',
    buildCommand: 'gradle build',
    testCommand: 'gradle test',
    lintCommand: 'gradle checkstyleMain',
    ignoreDirs: ['build', '.gradle'],
    sourceDirs: ['src/main/java', 'src/test/java'],
  },
  // Go
  {
    file: 'go.mod',
    type: 'go',
    packageManager: 'go-mod',
    buildCommand: 'go build ./...',
    testCommand: 'go test ./...',
    lintCommand: 'go vet ./...',
    ignoreDirs: ['vendor'],
    sourceDirs: ['.'],
  },
  // Rust
  {
    file: 'Cargo.toml',
    type: 'rust',
    packageManager: 'cargo',
    buildCommand: 'cargo build',
    testCommand: 'cargo test',
    lintCommand: 'cargo clippy',
    ignoreDirs: ['target'],
    sourceDirs: ['src'],
  },
  // Python
  {
    file: 'setup.py',
    type: 'python',
    packageManager: 'pip',
    buildCommand: 'python setup.py build',
    testCommand: 'pytest',
    lintCommand: 'pylint src',
    ignoreDirs: ['__pycache__', '.venv', 'venv', '.tox', 'egg-info'],
    sourceDirs: ['src'],
  },
  {
    file: 'pyproject.toml',
    type: 'python',
    packageManager: 'pip',
    buildCommand: 'pip install -e .',
    testCommand: 'pytest',
    lintCommand: 'pylint src',
    ignoreDirs: ['__pycache__', '.venv', 'venv', '.tox'],
    sourceDirs: ['src'],
  },
  {
    file: 'requirements.txt',
    type: 'python',
    packageManager: 'pip',
    buildCommand: 'pip install -r requirements.txt',
    testCommand: 'pytest',
    lintCommand: 'pylint .',
    ignoreDirs: ['__pycache__', '.venv', 'venv'],
    sourceDirs: ['.'],
  },
  // .NET
  {
    file: '*.csproj',
    type: 'dotnet',
    packageManager: 'dotnet',
    buildCommand: 'dotnet build',
    testCommand: 'dotnet test',
    lintCommand: 'dotnet format --verify-no-changes',
    ignoreDirs: ['bin', 'obj'],
    sourceDirs: ['.'],
  },
];

// ---- 核心识别逻辑 ----

/**
 * 检测项目根目录是否包含指定文件
 */
function fileExists(rootDir: string, fileName: string): boolean {
  if (fileName.includes('*')) {
    // glob模式（如*.csproj），简单检测目录中是否有匹配文件
    try {
      const files = fs.readdirSync(rootDir);
      const pattern = fileName.replace(/\./g, '\\.').replace(/\*/g, '.*');
      const regex = new RegExp(`^${pattern}$`);
      return files.some(f => regex.test(f));
    } catch {
      return false;
    }
  }
  return fs.existsSync(path.join(rootDir, fileName));
}

/**
 * 从package.json中提取更精确的命令和元数据
 */
function readPackageJson(rootDir: string): Record<string, unknown> | null {
  const pkgPath = path.join(rootDir, 'package.json');
  try {
    const content = fs.readFileSync(pkgPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 检测是否为TypeScript项目
 */
function detectTypeScript(rootDir: string): boolean {
  return fs.existsSync(path.join(rootDir, 'tsconfig.json'))
    || fs.existsSync(path.join(rootDir, 'tsconfig.build.json'));
}

/**
 * 自动识别工程技术栈 (V1.1 README 3.1.4)
 * @param projectRoot 项目根目录
 * @returns 识别到的项目信息
 */
export function detectProject(projectRoot: string): ProjectInfo {
  const rootDir = path.resolve(projectRoot);
  const markerFiles: string[] = [];
  let bestMatch: MarkerConfig | null = null;
  let bestPriority = -1;

  // 优先级：Node.js生态(pnpm>yarn>npm) > Java > Go > Rust > Python > .NET
  // 同类型中，lock文件优先于package.json
  for (let i = 0; i < MARKER_CONFIGS.length; i++) {
    const config = MARKER_CONFIGS[i];
    if (fileExists(rootDir, config.file)) {
      markerFiles.push(config.file);
      // 优先级：索引越小优先级越高（按MARKER_CONFIGS排列顺序）
      if (i > bestPriority) {
        bestPriority = i;
        bestMatch = config;
      }
    }
  }

  if (!bestMatch) {
    logger.info('[ProjectDetector] 未识别到已知工程技术栈');
    return {
      type: 'unknown',
      packageManager: 'unknown',
      rootDir,
      markerFiles: [],
      buildCommand: '',
      testCommand: '',
      lintCommand: '',
      ignoreDirs: ['node_modules', 'dist', 'build', 'target', '.git', '__pycache__'],
      sourceDirs: ['.'],
      isTypeScript: false,
      metadata: {},
    };
  }

  // 基于最佳匹配构建ProjectInfo
  const info: ProjectInfo = {
    type: bestMatch.type,
    packageManager: bestMatch.packageManager,
    rootDir,
    markerFiles,
    buildCommand: bestMatch.buildCommand,
    testCommand: bestMatch.testCommand,
    lintCommand: bestMatch.lintCommand,
    ignoreDirs: [...bestMatch.ignoreDirs, '.git'],
    sourceDirs: bestMatch.sourceDirs,
    isTypeScript: false,
    metadata: {},
  };

  // Node.js项目：从package.json中提取更精确的命令
  if (bestMatch.type === 'node') {
    const pkg = readPackageJson(rootDir);
    if (pkg) {
      const scripts = pkg.scripts as Record<string, string> | undefined;
      if (scripts) {
        // 覆盖构建命令
        if (scripts.build) {
          info.buildCommand = `${bestMatch.packageManager} run build`;
        }
        // 覆盖测试命令
        if (scripts.test) {
          info.testCommand = `${bestMatch.packageManager} test`;
        }
        // 覆盖Lint命令
        if (scripts.lint) {
          info.lintCommand = `${bestMatch.packageManager} run lint`;
        }
      }

      // 检测TypeScript
      info.isTypeScript = detectTypeScript(rootDir);

      // 提取依赖信息
      info.metadata.dependencies = Object.keys((pkg.dependencies as Record<string, string>) || {});
      info.metadata.devDependencies = Object.keys((pkg.devDependencies as Record<string, string>) || {});
    }
  }

  // 其他项目也检测TypeScript（如deno等）
  if (bestMatch.type !== 'node') {
    info.isTypeScript = detectTypeScript(rootDir);
  }

  logger.info(`[ProjectDetector] 识别到 ${info.type} 项目 (包管理: ${info.packageManager}, ` +
    `TypeScript: ${info.isTypeScript}, 标志文件: ${markerFiles.join(', ')})`);

  return info;
}

/**
 * 获取项目类型的友好名称
 */
export function getProjectTypeName(type: ProjectType): string {
  const names: Record<ProjectType, string> = {
    node: 'Node.js',
    java: 'Java',
    go: 'Go',
    rust: 'Rust',
    python: 'Python',
    dotnet: '.NET',
    unknown: '未知',
  };
  return names[type];
}