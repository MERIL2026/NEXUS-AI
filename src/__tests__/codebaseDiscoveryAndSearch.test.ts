import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ToolGateway,
  ReadonlyFilesystemAdapter,
  WORKSPACE_TREE_TOOL_DEFINITION,
  CODE_SEARCH_TOOL_DEFINITION,
} from '../tools/index.js';
import { PermissionEngine } from '../tools/permissionEngine.js';
import { ToolRegistry } from '../tools/toolRegistry.js';

describe('P6-A — Codebase Discovery & Search Tools (workspace_tree & code_search)', () => {
  let tempDir: string;
  let adapter: ReadonlyFilesystemAdapter;
  let gateway: ToolGateway;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p6a-test-'));

    // Create a mock project structure
    fs.mkdirSync(path.join(tempDir, 'src', 'common'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src', 'utils'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'node_modules', 'some-pkg'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });

    // Populate source files
    fs.writeFileSync(
      path.join(tempDir, 'src', 'main.ts'),
      'import { logger } from "./common/logger.js";\nconsole.log("NEXUS AI Main");\nfunction startApp() {\n  logger("Starting NEXUS AI");\n}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'common', 'logger.ts'),
      'export function logger(msg: string) {\n  console.log(`[LOG] ${msg}`);\n}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'utils', 'helper.ts'),
      'export const APP_NAME = "NEXUS AI";\nexport function getAppVersion() { return "1.0.0"; }\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'docs', 'README.md'),
      '# NEXUS AI Workstation Documentation\nNEXUS AI provides offline AI tools.\n'
    );

    // Secret file
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET_API_KEY=supersecret12345\n');
    fs.writeFileSync(path.join(tempDir, 'secret.key'), 'PRIVATE_KEY_DATA\n');

    // Binary file
    const binaryBuf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
    fs.writeFileSync(path.join(tempDir, 'image.png'), binaryBuf);

    adapter = new ReadonlyFilesystemAdapter(tempDir, 2 * 1024 * 1024, 'error');
    gateway = new ToolGateway(undefined, 'error');
    await gateway.initialize(undefined, tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ---------------------------------------------------------------------------
  // workspace_tree Tests (12 required tests)
  // ---------------------------------------------------------------------------

  describe('workspace_tree tool', () => {
    it('1. lists root tree directory entries safely', () => {
      const res = adapter.getWorkspaceTree('.', { maxDepth: 2, maxEntries: 50 });
      expect(res.success).toBe(true);
      expect(res.entries).toBeDefined();
      const paths = res.entries!.map((e) => e.path);
      expect(paths).toContain('src');
      expect(paths).toContain('docs');
    });

    it('2. lists entries inside nested directory', () => {
      const res = adapter.getWorkspaceTree('src', { maxDepth: 3 });
      expect(res.success).toBe(true);
      const paths = res.entries!.map((e) => e.path);
      expect(paths.some((p) => p.includes('main.ts'))).toBe(true);
      expect(paths.some((p) => p.includes('logger.ts'))).toBe(true);
    });

    it('3. respects maxDepth traversal limit', () => {
      const resDepth1 = adapter.getWorkspaceTree('.', { maxDepth: 1 });
      expect(resDepth1.success).toBe(true);
      const deepEntries = resDepth1.entries!.filter((e) => e.path.includes('logger.ts'));
      expect(deepEntries.length).toBe(0);
    });

    it('4. respects maxEntries limit and sets truncated flag', () => {
      const res = adapter.getWorkspaceTree('.', { maxDepth: 5, maxEntries: 3 });
      expect(res.success).toBe(true);
      expect(res.entries!.length).toBeLessThanOrEqual(3);
      expect(res.truncated).toBe(true);
    });

    it('5. falls back to workspace root when non-existent path is requested (authoring support)', () => {
      // When the planner inspects a directory before creating it (authoring tasks),
      // workspace_tree must not fail — it falls back to workspace root.
      const res = adapter.getWorkspaceTree('non_existent_folder');
      expect(res.success).toBe(true);
      // Fallback result is the workspace root
      expect(res.entries).toBeDefined();
    });

    it('6. rejects path traversal attempts (../)', () => {
      const res = adapter.getWorkspaceTree('../outside');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
    });

    it('7. rejects absolute outside-workspace path', () => {
      const outsidePath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/passwd';
      const res = adapter.getWorkspaceTree(outsidePath);
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
    });

    it('8. skips symlink escape outside workspace', () => {
      if (process.platform !== 'win32') {
        const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-target-'));
        const symlinkPath = path.join(tempDir, 'outside_symlink');
        try {
          fs.symlinkSync(outsideTarget, symlinkPath);
          const res = adapter.getWorkspaceTree('.');
          expect(res.success).toBe(true);
          const containsEscape = res.entries!.some((e) => e.path.includes('outside_symlink/file'));
          expect(containsEscape).toBe(false);
        } finally {
          fs.rmSync(outsideTarget, { recursive: true, force: true });
        }
      }
    });

    it('9. rejects null-byte characters in path', () => {
      const res = adapter.getWorkspaceTree('src\0/secret');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
    });

    it('10. guarantees read-only behavior (workspace unmodified)', () => {
      const beforeFiles = fs.readdirSync(tempDir);
      adapter.getWorkspaceTree('.');
      const afterFiles = fs.readdirSync(tempDir);
      expect(afterFiles).toEqual(beforeFiles);
    });

    it('11. returns authorization denial when PermissionEngine blocks request', () => {
      const disabledRegistry = new ToolRegistry('error');
      disabledRegistry.registerTool({
        ...WORKSPACE_TREE_TOOL_DEFINITION,
        enabled: false,
      });
      const engine = new PermissionEngine(disabledRegistry, undefined, 'error');

      const auth = engine.authorize({
        requestId: 'req-tree-disabled',
        taskId: 'task-1',
        toolId: 'workspace_tree',
        requestedCapabilities: ['filesystem.read'],
      });

      expect(auth.allowed).toBe(false);
      expect(auth.decision).toBe('DENIED');
    });

    it('12. bounds large workspace directories safely', () => {
      const largeFolder = path.join(tempDir, 'large_dir');
      fs.mkdirSync(largeFolder);
      for (let i = 0; i < 20; i++) {
        fs.writeFileSync(path.join(largeFolder, `file_${i}.txt`), `Content ${i}`);
      }

      const res = adapter.getWorkspaceTree('large_dir', { maxEntries: 5 });
      expect(res.success).toBe(true);
      expect(res.entries!.length).toBe(5);
      expect(res.truncated).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // code_search Tests (12 required tests)
  // ---------------------------------------------------------------------------

  describe('code_search tool', () => {
    it('1. performs basic text matching across workspace files', () => {
      const res = adapter.searchCode('NEXUS AI');
      expect(res.success).toBe(true);
      expect(res.results).toBeDefined();
      expect(res.results!.length).toBeGreaterThan(0);
      expect(res.results!.some((m) => m.path.includes('main.ts'))).toBe(true);
    });

    it('2. finds multiple matches across multiple files', () => {
      const res = adapter.searchCode('logger');
      expect(res.success).toBe(true);
      expect(res.results!.length).toBeGreaterThanOrEqual(2);
    });

    it('3. reports accurate line and column numbers for matches', () => {
      const res = adapter.searchCode('console.log');
      expect(res.success).toBe(true);
      const match = res.results!.find((m) => m.path.includes('main.ts'));
      expect(match).toBeDefined();
      expect(match!.line).toBeGreaterThan(0);
      expect(match!.column).toBeGreaterThan(0);
      expect(match!.snippet).toContain('console.log');
    });

    it('4. filters by explicit fileExtensions', () => {
      const res = adapter.searchCode('NEXUS', '.', { fileExtensions: ['.md'] });
      expect(res.success).toBe(true);
      expect(res.results!.every((m) => m.path.endsWith('.md'))).toBe(true);
    });

    it('5. respects maxResults limit and sets truncated flag', () => {
      const res = adapter.searchCode('NEXUS', '.', { maxResults: 1 });
      expect(res.success).toBe(true);
      expect(res.results!.length).toBe(1);
      expect(res.truncated).toBe(true);
    });

    it('6. returns FILE_NOT_FOUND when non-existent path is searched', () => {
      const res = adapter.searchCode('test', 'invalid_dir');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('FILE_NOT_FOUND');
    });

    it('7. rejects path traversal in search path', () => {
      const res = adapter.searchCode('test', '../../etc');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
    });

    it('8. skips binary files during code search', () => {
      const res = adapter.searchCode('PNG');
      expect(res.success).toBe(true);
      expect(res.results!.some((m) => m.path.includes('image.png'))).toBe(false);
    });

    it('9. excludes secret files (.env, .key) from search results', () => {
      const res = adapter.searchCode('supersecret12345');
      expect(res.success).toBe(true);
      expect(res.results!.length).toBe(0);
    });

    it('10. excludes node_modules and .git folders by default', () => {
      fs.writeFileSync(path.join(tempDir, 'node_modules', 'some-pkg', 'index.js'), 'const NEXUS_MODULE = true;\n');
      const res = adapter.searchCode('NEXUS_MODULE');
      expect(res.success).toBe(true);
      expect(res.results!.length).toBe(0);
    });

    it('11. returns authorization denial via ToolGateway when blocked', () => {
      const disabledRegistry = new ToolRegistry('error');
      disabledRegistry.registerTool({
        ...CODE_SEARCH_TOOL_DEFINITION,
        enabled: false,
      });
      const disabledGateway = new ToolGateway(undefined, 'error');
      disabledGateway.registry = disabledRegistry;

      const auth = disabledGateway.authorizeInvocation({
        requestId: 'req-search-disabled',
        taskId: 'task-1',
        toolId: 'code_search',
        requestedCapabilities: ['filesystem.read'],
      });

      expect(auth.authorized).toBe(false);
      expect(auth.decision).toBe('DENIED');
    });

    it('12. enforces workspace boundary for absolute target paths', () => {
      const outsidePath = process.platform === 'win32' ? 'C:\\Windows' : '/var/log';
      const res = adapter.searchCode('query', outsidePath);
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-End ToolGateway Integration Tests for P6-A
  // ---------------------------------------------------------------------------

  describe('ToolGateway end-to-end integration for P6-A tools', () => {
    it('executes workspace_tree tool through ToolGateway pipeline', async () => {
      const execRes = await gateway.executeTool({
        requestId: 'req-tree-e2e',
        taskId: 'task-e2e-1',
        toolId: 'workspace_tree',
        requestedCapabilities: ['filesystem.read'],
        params: { path: '.', maxDepth: 2 },
      });

      expect(execRes.authorized).toBe(true);
      expect(execRes.executed).toBe(true);
      expect(execRes.success).toBe(true);
      expect(execRes.output).toBeDefined();
      expect(execRes.output!.entries).toBeDefined();
    });

    it('executes code_search tool through ToolGateway pipeline', async () => {
      const execRes = await gateway.executeTool({
        requestId: 'req-search-e2e',
        taskId: 'task-e2e-2',
        toolId: 'code_search',
        requestedCapabilities: ['filesystem.read'],
        params: { query: 'NEXUS AI', path: '.' },
      });

      expect(execRes.authorized).toBe(true);
      expect(execRes.executed).toBe(true);
      expect(execRes.success).toBe(true);
      expect(execRes.output).toBeDefined();
      expect(execRes.output!.results).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Regression tests: workspace_tree authoring pre-creation scenarios
  // ---------------------------------------------------------------------------

  describe('workspace_tree authoring regression tests', () => {
    it('13. workspace_tree can inspect the existing workspace root path "."', () => {
      const res = adapter.getWorkspaceTree('.');
      expect(res.success).toBe(true);
      expect(res.entries).toBeDefined();
    });

    it('14. workspace_tree can inspect an existing subdirectory', () => {
      fs.mkdirSync(path.join(tempDir, 'existing_sub'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'existing_sub', 'hello.txt'), 'hello');
      const res = adapter.getWorkspaceTree('existing_sub');
      expect(res.success).toBe(true);
      expect(res.entries!.some((e) => e.path.includes('hello.txt'))).toBe(true);
    });

    it('15. workspace_tree does NOT require future target directory to exist — returns workspace root', () => {
      const res = adapter.getWorkspaceTree('final-calculator-test');
      // Should succeed with fallback to root, NOT fail
      expect(res.success).toBe(true);
      expect(res.entries).toBeDefined();
    });

    it('16. filesystem_write can create a new nested directory and file under workspace root', () => {
      const writeResult = adapter.writeFile('new_calc_dir/index.html', '<html></html>');
      expect(writeResult.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'new_calc_dir', 'index.html'))).toBe(true);
    });

    it('17. path traversal remains denied even after workspace_tree fallback change', () => {
      const res = adapter.getWorkspaceTree('../outside');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
    });

    it('18. absolute paths outside workspace remain denied', () => {
      const outsidePath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/passwd';
      const res = adapter.getWorkspaceTree(outsidePath);
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
    });

    it('19. authoring plan: workspace_tree on root succeeds before creating new files', () => {
      // Simulates planner step 1: inspect workspace root
      const treeRes = adapter.getWorkspaceTree('.');
      expect(treeRes.success).toBe(true);

      // Simulates planner step 2: create new file
      const writeRes = adapter.writeFile('authoring-test/style.css', 'body { margin: 0; }');
      expect(writeRes.success).toBe(true);

      expect(fs.existsSync(path.join(tempDir, 'authoring-test', 'style.css'))).toBe(true);
    });

    it('20. workspace_tree with non-existent calculator target path resolves to workspace root with entries', () => {
      // This is the exact scenario: planner generates params: { path: "final-calculator-test" }
      // before the directory is created. Should fall back and return workspace root entries.
      const res = adapter.getWorkspaceTree('final-calculator-test');
      expect(res.success).toBe(true);
      expect(Array.isArray(res.entries)).toBe(true);
    });
  });
});
