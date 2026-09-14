import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Logger, LogLevel } from '../../common/logger.js';

export interface ReadFileResult {
  success: boolean;
  content?: string;
  bytes?: number;
  relativePath?: string;
  errorCategory?: string;
  errorMessage?: string;
}

export interface WorkspaceTreeEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface WorkspaceTreeOptions {
  maxDepth?: number;
  maxEntries?: number;
}

export interface WorkspaceTreeResult {
  success: boolean;
  root: string;
  entries?: WorkspaceTreeEntry[];
  truncated?: boolean;
  totalEntries?: number;
  errorCategory?: string;
  errorMessage?: string;
}

export interface CodeSearchMatch {
  path: string;
  line: number;
  column: number;
  match: string;
  snippet: string;
}

export interface CodeSearchOptions {
  maxResults?: number;
  fileExtensions?: string[];
}

export interface CodeSearchResult {
  success: boolean;
  query: string;
  results?: CodeSearchMatch[];
  totalMatches?: number;
  filesSearched?: number;
  truncated?: boolean;
  errorCategory?: string;
  errorMessage?: string;
}

export interface FileChangeDiff {
  path: string;
  operation: 'create' | 'modify';
  beforeHash: string | null;
  afterHash: string | null;
  beforeSize: number;
  afterSize: number;
  changed: boolean;
  unifiedDiff?: string;
}

export interface WriteFileResult {
  success: boolean;
  path?: string;
  bytesWritten?: number;
  created?: boolean;
  diff?: FileChangeDiff;
  errorCategory?: string;
  errorMessage?: string;
}

export interface EditFileResult {
  success: boolean;
  path?: string;
  bytesWritten?: number;
  diff?: FileChangeDiff;
  errorCategory?: string;
  errorMessage?: string;
}

export function calculateContentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function isSecretFile(relativePath: string): boolean {
  const baseName = path.basename(relativePath).toLowerCase();
  const ext = path.extname(relativePath).toLowerCase();

  if (baseName.startsWith('.env')) {
    return true;
  }
  if (
    baseName.startsWith('id_rsa') ||
    baseName.startsWith('id_dsa') ||
    baseName.startsWith('id_ed25519') ||
    baseName.startsWith('id_ecdsa')
  ) {
    return true;
  }
  if (ext === '.pem' || ext === '.key') {
    return true;
  }
  if (
    baseName === 'credentials.json' ||
    baseName === 'service_account.json' ||
    baseName === 'secrets.json'
  ) {
    return true;
  }

  return false;
}

export function generateUnifiedDiff(
  relativePath: string,
  oldContent: string | null,
  newContent: string
): FileChangeDiff {
  const isCreate = oldContent === null;
  const beforeHash = isCreate ? null : calculateContentHash(oldContent);
  const afterHash = calculateContentHash(newContent);
  const beforeSize = isCreate ? 0 : Buffer.byteLength(oldContent, 'utf8');
  const afterSize = Buffer.byteLength(newContent, 'utf8');

  const normalizedPath = relativePath.replace(/\\/g, '/');

  if (!isCreate && oldContent === newContent) {
    return {
      path: normalizedPath,
      operation: 'modify',
      beforeHash,
      afterHash,
      beforeSize,
      afterSize,
      changed: false,
      unifiedDiff: '',
    };
  }

  const oldLines = isCreate ? [] : oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);

  const diffHeader: string[] = [
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    `@@ -${isCreate ? 0 : 1},${oldLines.length} +1,${newLines.length} @@`,
  ];

  const bodyLines: string[] = [];
  const maxDiffLines = 500;

  if (isCreate) {
    for (let i = 0; i < newLines.length; i++) {
      if (bodyLines.length >= maxDiffLines) {
        bodyLines.push('... [diff truncated]');
        break;
      }
      bodyLines.push(`+${newLines[i]}`);
    }
  } else {
    // Simple, clean unified diff generator
    let i = 0;
    let j = 0;

    // Prefix common lines
    while (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      if (bodyLines.length < maxDiffLines) {
        bodyLines.push(` ${oldLines[i]}`);
      }
      i++;
      j++;
    }

    // Suffix common lines
    let oldEnd = oldLines.length - 1;
    let newEnd = newLines.length - 1;
    while (oldEnd >= i && newEnd >= j && oldLines[oldEnd] === newLines[newEnd]) {
      oldEnd--;
      newEnd--;
    }

    // Changed lines
    for (let k = i; k <= oldEnd; k++) {
      if (bodyLines.length < maxDiffLines) {
        bodyLines.push(`-${oldLines[k]}`);
      }
    }
    for (let k = j; k <= newEnd; k++) {
      if (bodyLines.length < maxDiffLines) {
        bodyLines.push(`+${newLines[k]}`);
      }
    }

    // Suffix context
    for (let k = oldEnd + 1; k < oldLines.length; k++) {
      if (bodyLines.length < maxDiffLines) {
        bodyLines.push(` ${oldLines[k]}`);
      }
    }

    if (bodyLines.length >= maxDiffLines) {
      bodyLines.push('... [diff truncated]');
    }
  }

  return {
    path: normalizedPath,
    operation: isCreate ? 'create' : 'modify',
    beforeHash,
    afterHash,
    beforeSize,
    afterSize,
    changed: true,
    unifiedDiff: diffHeader.concat(bodyLines).join('\n'),
  };
}

export class FilesystemAdapter {
  protected canonicalWorkspaceRoot: string;
  protected logger: Logger;
  protected maxFileSize: number;

  constructor(
    workspaceRoot: string,
    maxFileSizeBytes: number = 2 * 1024 * 1024, // Default 2MB limit
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('FilesystemAdapter', logLevel);
    this.maxFileSize = maxFileSizeBytes;

    if (!workspaceRoot || typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
      throw new Error('FilesystemAdapter initialization failed: workspaceRoot must be a non-empty string.');
    }

    const resolvedRoot = path.resolve(workspaceRoot);
    if (!fs.existsSync(resolvedRoot)) {
      try {
        fs.mkdirSync(resolvedRoot, { recursive: true });
      } catch (err) {
        throw new Error(`FilesystemAdapter initialization failed: workspace directory '${resolvedRoot}' could not be created (${String(err)}).`);
      }
    }

    try {
      this.canonicalWorkspaceRoot = fs.realpathSync(resolvedRoot);
    } catch {
      this.canonicalWorkspaceRoot = resolvedRoot;
    }
  }

  /**
   * Get the canonical workspace root directory.
   */
  getWorkspaceRoot(): string {
    return this.canonicalWorkspaceRoot;
  }

  /**
   * Validate and resolve a workspace-relative path safely within the canonical workspace sandbox.
   */
  validatePath(relativePath: string): { valid: boolean; canonicalPath?: string; errorCategory?: string; errorMessage?: string } {
    if (typeof relativePath !== 'string') {
      return {
        valid: false,
        errorCategory: 'INVALID_INPUT',
        errorMessage: 'Path must be a non-empty string.',
      };
    }

    const trimmed = relativePath.trim();
    const effectivePath = trimmed === '' ? '.' : trimmed;

    // Reject null bytes
    if (effectivePath.includes('\0')) {
      return {
        valid: false,
        errorCategory: 'PATH_TRAVERSAL_DENIED',
        errorMessage: 'Path contains invalid null byte characters.',
      };
    }

    const normalizedRelative = path.normalize(effectivePath);
    let safeRelative = normalizedRelative;
    // On Windows/POSIX, if path has leading slashes but is not an absolute drive-letter path, treat as workspace-relative
    if (!/^[a-zA-Z]:[/\\]/.test(safeRelative) && (safeRelative.startsWith('/') || safeRelative.startsWith('\\'))) {
      safeRelative = safeRelative.replace(/^[/\\]+/, '');
      if (safeRelative === '') safeRelative = '.';
    }

    // Resolve full target path against workspace root
    let resolvedTarget = path.resolve(this.canonicalWorkspaceRoot, safeRelative);

    // Check if relativePath is an alias referring to the workspace root directory itself
    const workspaceBaseName = path.basename(this.canonicalWorkspaceRoot);
    if (!fs.existsSync(resolvedTarget)) {
      const parentResolved = path.resolve(path.dirname(this.canonicalWorkspaceRoot), normalizedRelative);
      const isWin = process.platform === 'win32';
      const p1 = isWin ? parentResolved.toLowerCase() : parentResolved;
      const p2 = isWin ? this.canonicalWorkspaceRoot.toLowerCase() : this.canonicalWorkspaceRoot;
      if (p1 === p2 || normalizedRelative === workspaceBaseName || normalizedRelative === `./${workspaceBaseName}`) {
        resolvedTarget = this.canonicalWorkspaceRoot;
      }
    }

    // Verify canonical path escape check
    let canonicalTarget: string;
    try {
      if (fs.existsSync(resolvedTarget)) {
        canonicalTarget = fs.realpathSync(resolvedTarget);
      } else {
        const parentDir = path.dirname(resolvedTarget);
        if (fs.existsSync(parentDir)) {
          const canonicalParent = fs.realpathSync(parentDir);
          canonicalTarget = path.join(canonicalParent, path.basename(resolvedTarget));
        } else {
          canonicalTarget = resolvedTarget;
        }
      }
    } catch {
      canonicalTarget = resolvedTarget;
    }

    const isWindows = process.platform === 'win32';
    const rootToCheck = isWindows ? this.canonicalWorkspaceRoot.toLowerCase() : this.canonicalWorkspaceRoot;
    const targetToCheck = isWindows ? canonicalTarget.toLowerCase() : canonicalTarget;

    const isInsideWorkspace =
      targetToCheck === rootToCheck ||
      targetToCheck.startsWith(rootToCheck + (isWindows ? '\\' : '/')) ||
      targetToCheck.startsWith(rootToCheck + path.sep);

    if (!isInsideWorkspace) {
      return {
        valid: false,
        errorCategory: 'PATH_TRAVERSAL_DENIED',
        errorMessage: `Access denied: Requested path '${relativePath}' escapes the configured workspace sandbox.`,
      };
    }

    return {
      valid: true,
      canonicalPath: canonicalTarget,
    };
  }

  /**
   * Safely read the content of a file within the workspace sandbox.
   */
  readFile(relativePath: string): ReadFileResult {
    const pathValidation = this.validatePath(relativePath);
    if (!pathValidation.valid || !pathValidation.canonicalPath) {
      this.logger.warn(`File read rejected: path validation failed`, {
        errorCategory: pathValidation.errorCategory,
      });
      return {
        success: false,
        errorCategory: pathValidation.errorCategory || 'PATH_TRAVERSAL_DENIED',
        errorMessage: pathValidation.errorMessage || 'Path validation failed.',
      };
    }

    const targetPath = pathValidation.canonicalPath;

    if (!fs.existsSync(targetPath)) {
      return {
        success: false,
        errorCategory: 'FILE_NOT_FOUND',
        errorMessage: `File not found: '${relativePath}' does not exist in workspace.`,
      };
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(targetPath);
    } catch (err) {
      return {
        success: false,
        errorCategory: 'FILESYSTEM_ERROR',
        errorMessage: `Failed to inspect path '${relativePath}': ${String(err)}`,
      };
    }

    if (stats.isDirectory()) {
      return {
        success: false,
        errorCategory: 'INVALID_FILE_TYPE',
        errorMessage: `Target path '${relativePath}' is a directory, not a file.`,
      };
    }

    if (stats.size > this.maxFileSize) {
      return {
        success: false,
        errorCategory: 'FILE_TOO_LARGE',
        errorMessage: `File size (${stats.size} bytes) exceeds maximum allowable limit (${this.maxFileSize} bytes).`,
      };
    }

    try {
      const content = fs.readFileSync(targetPath, 'utf8');
      this.logger.info(`Successfully read file`, { bytes: stats.size });
      return {
        success: true,
        content,
        bytes: stats.size,
        relativePath,
      };
    } catch (err) {
      return {
        success: false,
        errorCategory: 'READ_FAILED',
        errorMessage: `Failed to read file contents: ${String(err)}`,
      };
    }
  }

  /**
   * Safely return a bounded metadata representation of the directory tree.
   */
  getWorkspaceTree(relativePath: string = '.', options: WorkspaceTreeOptions = {}): WorkspaceTreeResult {
    const maxDepth = options.maxDepth !== undefined ? Math.max(1, Math.min(options.maxDepth, 10)) : 5;
    const maxEntries = options.maxEntries !== undefined ? Math.max(1, Math.min(options.maxEntries, 2000)) : 500;

    const pathValidation = this.validatePath(relativePath);
    if (!pathValidation.valid || !pathValidation.canonicalPath) {
      return {
        success: false,
        root: relativePath,
        errorCategory: pathValidation.errorCategory || 'PATH_TRAVERSAL_DENIED',
        errorMessage: pathValidation.errorMessage || 'Path validation failed.',
      };
    }

    const targetPath = pathValidation.canonicalPath;

    if (!fs.existsSync(targetPath)) {
      // Graceful fallback: if the target path doesn't exist yet (e.g. the planner
      // wants to inspect a directory it is about to CREATE), fall back to the workspace
      // root instead of failing. The path has already been verified as inside the sandbox.
      this.logger.info(`workspace_tree: path '${relativePath}' does not exist yet — falling back to workspace root`, {
        requestedPath: relativePath,
        targetPath,
        fallback: this.canonicalWorkspaceRoot,
      });
      return this.getWorkspaceTree('.', options);
    }

    let targetStats: fs.Stats;
    try {
      targetStats = fs.statSync(targetPath);
    } catch (err) {
      return {
        success: false,
        root: relativePath,
        errorCategory: 'FILESYSTEM_ERROR',
        errorMessage: `Failed to inspect path '${relativePath}': ${String(err)}`,
      };
    }

    const entries: WorkspaceTreeEntry[] = [];
    let truncated = false;

    const defaultExcludedDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

    if (!targetStats.isDirectory()) {
      const relPath = path.relative(this.canonicalWorkspaceRoot, targetPath).replace(/\\/g, '/') || '.';
      entries.push({
        path: relPath,
        type: 'file',
        size: targetStats.size,
      });
      return {
        success: true,
        root: relativePath,
        entries,
        truncated: false,
        totalEntries: 1,
      };
    }

    const isWindows = process.platform === 'win32';
    const canonicalRoot = this.canonicalWorkspaceRoot;

    const traverse = (currentDir: string, currentDepth: number) => {
      if (currentDepth > maxDepth || truncated) {
        return;
      }

      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of dirEntries) {
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }

        const fullPath = path.join(currentDir, entry.name);

        let canonicalEntryPath: string;
        try {
          canonicalEntryPath = fs.realpathSync(fullPath);
        } catch {
          canonicalEntryPath = fullPath;
        }

        const rootCheck = isWindows ? canonicalRoot.toLowerCase() : canonicalRoot;
        const entryCheck = isWindows ? canonicalEntryPath.toLowerCase() : canonicalEntryPath;

        const isInside =
          entryCheck === rootCheck ||
          entryCheck.startsWith(rootCheck + (isWindows ? '\\' : '/')) ||
          entryCheck.startsWith(rootCheck + path.sep);

        if (!isInside) {
          continue;
        }

        const relPath = path.relative(canonicalRoot, canonicalEntryPath).replace(/\\/g, '/') || entry.name;

        if (entry.isDirectory()) {
          entries.push({
            path: relPath,
            type: 'directory',
          });

          if (!defaultExcludedDirs.has(entry.name)) {
            traverse(canonicalEntryPath, currentDepth + 1);
          }
        } else if (entry.isFile()) {
          let fileSize = 0;
          try {
            fileSize = fs.statSync(canonicalEntryPath).size;
          } catch {
            // ignore
          }

          entries.push({
            path: relPath,
            type: 'file',
            size: fileSize,
          });
        }
      }
    };

    traverse(targetPath, 1);

    return {
      success: true,
      root: relativePath,
      entries,
      truncated,
      totalEntries: entries.length,
    };
  }

  /**
   * Safely search source files within the workspace using deterministic text matching.
   */
  searchCode(query: string, relativePath: string = '.', options: CodeSearchOptions = {}): CodeSearchResult {
    if (!query || typeof query !== 'string' || query.trim() === '') {
      return {
        success: false,
        query: query || '',
        errorCategory: 'INVALID_INPUT',
        errorMessage: 'Query parameter must be a non-empty string.',
      };
    }

    const maxResults = options.maxResults !== undefined ? Math.max(1, Math.min(options.maxResults, 200)) : 50;

    const pathValidation = this.validatePath(relativePath);
    if (!pathValidation.valid || !pathValidation.canonicalPath) {
      return {
        success: false,
        query,
        errorCategory: pathValidation.errorCategory || 'PATH_TRAVERSAL_DENIED',
        errorMessage: pathValidation.errorMessage || 'Path validation failed.',
      };
    }

    const targetPath = pathValidation.canonicalPath;

    if (!fs.existsSync(targetPath)) {
      return {
        success: false,
        query,
        errorCategory: 'FILE_NOT_FOUND',
        errorMessage: `Path not found: '${relativePath}' does not exist in workspace.`,
      };
    }

    const defaultAllowedExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.py', '.css', '.html', '.sql', '.yaml', '.yml', '.sh', '.txt']);
    const allowedExts = options.fileExtensions && options.fileExtensions.length > 0
      ? new Set(options.fileExtensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)))
      : defaultAllowedExts;

    const secretFileNames = new Set(['.env', '.env.local', '.env.development', '.env.production', '.env.test', 'id_rsa', 'id_dsa', 'id_ed25519']);
    const defaultExcludedDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

    const isWindows = process.platform === 'win32';
    const canonicalRoot = this.canonicalWorkspaceRoot;

    const filesToSearch: string[] = [];

    const collectFiles = (currentPath: string) => {
      let stats: fs.Stats;
      try {
        stats = fs.statSync(currentPath);
      } catch {
        return;
      }

      if (stats.isFile()) {
        const ext = path.extname(currentPath).toLowerCase();
        const baseName = path.basename(currentPath).toLowerCase();

        if (secretFileNames.has(baseName) || baseName.startsWith('.env')) {
          return;
        }

        if (allowedExts.has(ext) && stats.size <= this.maxFileSize) {
          filesToSearch.push(currentPath);
        }
        return;
      }

      if (stats.isDirectory()) {
        const baseName = path.basename(currentPath);
        if (defaultExcludedDirs.has(baseName)) {
          return;
        }

        let entries: string[];
        try {
          entries = fs.readdirSync(currentPath);
        } catch {
          return;
        }

        for (const entryName of entries) {
          const fullPath = path.join(currentPath, entryName);

          let canonicalEntryPath: string;
          try {
            canonicalEntryPath = fs.realpathSync(fullPath);
          } catch {
            canonicalEntryPath = fullPath;
          }

          const rootCheck = isWindows ? canonicalRoot.toLowerCase() : canonicalRoot;
          const entryCheck = isWindows ? canonicalEntryPath.toLowerCase() : canonicalEntryPath;

          const isInside =
            entryCheck === rootCheck ||
            entryCheck.startsWith(rootCheck + (isWindows ? '\\' : '/')) ||
            entryCheck.startsWith(rootCheck + path.sep);

          if (isInside) {
            collectFiles(canonicalEntryPath);
          }
        }
      }
    };

    collectFiles(targetPath);

    const results: CodeSearchMatch[] = [];
    let truncated = false;
    let filesSearched = 0;
    const lowerQuery = query.toLowerCase();

    for (const filePath of filesToSearch) {
      if (results.length >= maxResults) {
        truncated = true;
        break;
      }

      filesSearched++;

      let content: string;
      try {
        const buf = fs.readFileSync(filePath);
        if (buf.subarray(0, 512).includes(0)) {
          continue;
        }
        content = buf.toString('utf8');
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      const relPath = path.relative(canonicalRoot, filePath).replace(/\\/g, '/');

      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        const lowerLine = lineText.toLowerCase();

        let matchIdx = lowerLine.indexOf(lowerQuery);
        while (matchIdx !== -1) {
          const lineNum = i + 1;
          const colNum = matchIdx + 1;

          const matchedSub = lineText.substring(matchIdx, matchIdx + query.length);
          const snippet = lineText.trim().slice(0, 200);

          results.push({
            path: relPath,
            line: lineNum,
            column: colNum,
            match: matchedSub,
            snippet,
          });

          if (results.length >= maxResults) {
            truncated = true;
            break;
          }

          matchIdx = lowerLine.indexOf(lowerQuery, matchIdx + 1);
        }

        if (truncated) break;
      }
    }

    return {
      success: true,
      query,
      results,
      totalMatches: results.length,
      filesSearched,
      truncated,
    };
  }

  /**
   * Safely create or replace a file strictly inside the workspace sandbox.
   */
  writeFile(relativePath: string, content: string): WriteFileResult {
    if (typeof content !== 'string') {
      return {
        success: false,
        errorCategory: 'INVALID_INPUT',
        errorMessage: 'Content must be a string.',
      };
    }

    const pathValidation = this.validatePath(relativePath);
    if (!pathValidation.valid || !pathValidation.canonicalPath) {
      return {
        success: false,
        errorCategory: pathValidation.errorCategory || 'PATH_TRAVERSAL_DENIED',
        errorMessage: pathValidation.errorMessage || 'Path validation failed.',
      };
    }

    if (isSecretFile(relativePath)) {
      return {
        success: false,
        errorCategory: 'SECRET_FILE_PROTECTED',
        errorMessage: `Security violation: Modification of secret file '${relativePath}' is strictly prohibited.`,
      };
    }

    const targetPath = pathValidation.canonicalPath;

    // Check directory target rejection
    if (fs.existsSync(targetPath)) {
      try {
        const stats = fs.statSync(targetPath);
        if (stats.isDirectory()) {
          return {
            success: false,
            errorCategory: 'INVALID_TARGET',
            errorMessage: `Target path '${relativePath}' is a directory, not a file.`,
          };
        }
      } catch (err) {
        return {
          success: false,
          errorCategory: 'FILESYSTEM_ERROR',
          errorMessage: `Failed to inspect path '${relativePath}': ${String(err)}`,
        };
      }
    }

    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > this.maxFileSize) {
      return {
        success: false,
        errorCategory: 'FILE_TOO_LARGE',
        errorMessage: `File size (${contentBytes} bytes) exceeds maximum allowable limit (${this.maxFileSize} bytes).`,
      };
    }

    let oldContent: string | null = null;
    if (fs.existsSync(targetPath)) {
      try {
        oldContent = fs.readFileSync(targetPath, 'utf8');
      } catch {
        oldContent = null;
      }
    }

    const parentDir = path.dirname(targetPath);
    try {
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
    } catch (err) {
      return {
        success: false,
        errorCategory: 'FILESYSTEM_ERROR',
        errorMessage: `Failed to create parent directory for '${relativePath}': ${String(err)}`,
      };
    }

    const tempFile = path.join(parentDir, `.nexus_tmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`);
    try {
      fs.writeFileSync(tempFile, content, 'utf8');

      const writtenSize = fs.statSync(tempFile).size;
      if (writtenSize !== contentBytes) {
        throw new Error(`Write verification failed: expected ${contentBytes} bytes, wrote ${writtenSize} bytes.`);
      }

      try {
        fs.renameSync(tempFile, targetPath);
      } catch {
        fs.copyFileSync(tempFile, targetPath);
        fs.unlinkSync(tempFile);
      }

      this.logger.info(`Successfully wrote file '${relativePath}' (${contentBytes} bytes)`);

      const relPathPosix = path.relative(this.canonicalWorkspaceRoot, targetPath).replace(/\\/g, '/');
      const diff = generateUnifiedDiff(relPathPosix, oldContent, content);

      return {
        success: true,
        path: relPathPosix,
        bytesWritten: contentBytes,
        created: oldContent === null,
        diff,
      };
    } catch (err) {
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
      }
      return {
        success: false,
        errorCategory: 'WRITE_FAILED',
        errorMessage: `Failed to write file '${relativePath}': ${String(err)}`,
      };
    }
  }

  /**
   * Safely apply a deterministic, hash-verified edit to an existing file in the workspace.
   */
  editFile(
    relativePath: string,
    expectedContentHash: string,
    oldText: string,
    newText: string,
    replaceMode: string = 'single'
  ): EditFileResult {
    if (!relativePath || typeof relativePath !== 'string') {
      return {
        success: false,
        errorCategory: 'INVALID_INPUT',
        errorMessage: 'Path must be a non-empty string.',
      };
    }

    if (!expectedContentHash || typeof expectedContentHash !== 'string') {
      return {
        success: false,
        errorCategory: 'INVALID_INPUT',
        errorMessage: 'expectedContentHash must be a non-empty string.',
      };
    }

    if (typeof oldText !== 'string' || oldText === '') {
      return {
        success: false,
        errorCategory: 'INVALID_INPUT',
        errorMessage: 'oldText must be a non-empty string.',
      };
    }

    if (typeof newText !== 'string') {
      return {
        success: false,
        errorCategory: 'INVALID_INPUT',
        errorMessage: 'newText must be a string.',
      };
    }

    const pathValidation = this.validatePath(relativePath);
    if (!pathValidation.valid || !pathValidation.canonicalPath) {
      return {
        success: false,
        errorCategory: pathValidation.errorCategory || 'PATH_TRAVERSAL_DENIED',
        errorMessage: pathValidation.errorMessage || 'Path validation failed.',
      };
    }

    if (isSecretFile(relativePath)) {
      return {
        success: false,
        errorCategory: 'SECRET_FILE_PROTECTED',
        errorMessage: `Security violation: Editing secret file '${relativePath}' is strictly prohibited.`,
      };
    }

    const targetPath = pathValidation.canonicalPath;

    if (!fs.existsSync(targetPath)) {
      return {
        success: false,
        errorCategory: 'FILE_NOT_FOUND',
        errorMessage: `File not found: '${relativePath}' does not exist in workspace.`,
      };
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(targetPath);
    } catch (err) {
      return {
        success: false,
        errorCategory: 'FILESYSTEM_ERROR',
        errorMessage: `Failed to inspect path '${relativePath}': ${String(err)}`,
      };
    }

    if (stats.isDirectory()) {
      return {
        success: false,
        errorCategory: 'INVALID_TARGET',
        errorMessage: `Target path '${relativePath}' is a directory, not a file.`,
      };
    }

    let currentContent: string;
    try {
      currentContent = fs.readFileSync(targetPath, 'utf8');
    } catch (err) {
      return {
        success: false,
        errorCategory: 'READ_FAILED',
        errorMessage: `Failed to read file '${relativePath}' for edit: ${String(err)}`,
      };
    }

    const currentHash = calculateContentHash(currentContent);
    if (currentHash.toLowerCase() !== expectedContentHash.toLowerCase()) {
      return {
        success: false,
        errorCategory: 'HASH_MISMATCH_CONFLICT',
        errorMessage: `Edit conflict: File content has changed since it was read. Expected hash '${expectedContentHash}', found '${currentHash}'.`,
      };
    }

    const occurrences = currentContent.split(oldText).length - 1;
    if (occurrences === 0) {
      return {
        success: false,
        errorCategory: 'EDIT_TARGET_NOT_FOUND',
        errorMessage: `Edit rejected: oldText not found in file '${relativePath}'.`,
      };
    }

    if (replaceMode === 'single' && occurrences > 1) {
      return {
        success: false,
        errorCategory: 'AMBIGUOUS_EDIT_MATCH',
        errorMessage: `Edit rejected: oldText matched ${occurrences} times in file '${relativePath}'. Disambiguate oldText to match a single instance.`,
      };
    }

    const updatedContent = currentContent.replace(oldText, newText);

    const writeResult = this.writeFile(relativePath, updatedContent);

    if (!writeResult.success) {
      return {
        success: false,
        errorCategory: writeResult.errorCategory,
        errorMessage: writeResult.errorMessage,
      };
    }

    return {
      success: true,
      path: writeResult.path,
      bytesWritten: writeResult.bytesWritten,
      diff: writeResult.diff,
    };
  }
}

export class ReadonlyFilesystemAdapter extends FilesystemAdapter {}
