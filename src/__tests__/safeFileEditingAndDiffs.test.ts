import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ToolGateway,
  FilesystemAdapter,
  calculateContentHash,
  generateUnifiedDiff,
  isSecretFile,
  FILESYSTEM_WRITE_TOOL_DEFINITION,
  FILESYSTEM_EDIT_TOOL_DEFINITION,
  ApprovalPolicyEngine,
} from '../tools/index.js';

describe('P6-B — Safe Workspace File Editing & Diffs (filesystem_write & filesystem_edit)', () => {
  let tempDir: string;
  let adapter: FilesystemAdapter;
  let gateway: ToolGateway;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-p6b-test-'));

    // Populate mock workspace
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'example.ts'),
      'export const message = "Hello World";\nfunction run() {\n  console.log(message);\n}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'duplicate.ts'),
      'const value = 1;\nconst value = 1;\n'
    );

    adapter = new FilesystemAdapter(tempDir, 2 * 1024 * 1024, 'error');
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
  // filesystem_write Tests (15 required tests)
  // ---------------------------------------------------------------------------

  describe('filesystem_write tool', () => {
    it('1. creates a new file in the workspace', () => {
      const res = adapter.writeFile('src/new_file.ts', 'export const newVar = 42;\n');
      expect(res.success).toBe(true);
      expect(res.created).toBe(true);
      expect(res.bytesWritten).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(tempDir, 'src', 'new_file.ts'))).toBe(true);
      expect(res.diff?.operation).toBe('create');
    });

    it('2. replaces an existing file in the workspace', () => {
      const res = adapter.writeFile('src/example.ts', 'export const message = "Updated";\n');
      expect(res.success).toBe(true);
      expect(res.created).toBe(false);
      expect(res.diff?.operation).toBe('modify');
      const updatedContent = fs.readFileSync(path.join(tempDir, 'src', 'example.ts'), 'utf8');
      expect(updatedContent).toContain('Updated');
    });

    it('3. supports workspace-relative paths in subdirectories', () => {
      const res = adapter.writeFile('src/sub/deep/file.ts', 'console.log("Deep");');
      expect(res.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'src', 'sub', 'deep', 'file.ts'))).toBe(true);
    });

    it('4. rejects path traversal attempts (../outside.txt)', () => {
      const res = adapter.writeFile('../outside.txt', 'evil content');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
    });

    it('5. rejects absolute paths escaping workspace', () => {
      const outsidePath = process.platform === 'win32' ? 'C:\\Windows\\evil.txt' : '/etc/evil';
      const res = adapter.writeFile(outsidePath, 'evil content');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
    });

    it('6. rejects null-byte characters in path', () => {
      const res = adapter.writeFile('src\0/file.ts', 'content');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
    });

    it('7. rejects symlink target escaping workspace', () => {
      if (process.platform !== 'win32') {
        const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-target-'));
        const symlinkPath = path.join(tempDir, 'symlink_out.ts');
        try {
          fs.symlinkSync(path.join(outsideTarget, 'file.txt'), symlinkPath);
          const res = adapter.writeFile('symlink_out.ts', 'content');
          expect(res.success).toBe(false);
          expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
        } finally {
          fs.rmSync(outsideTarget, { recursive: true, force: true });
        }
      }
    });

    it('8. rejects directory target as file destination', () => {
      const res = adapter.writeFile('src', 'content targeting directory');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('INVALID_TARGET');
    });

    it('9. enforces file size limit', () => {
      const smallAdapter = new FilesystemAdapter(tempDir, 100, 'error'); // 100 bytes limit
      const largeContent = 'A'.repeat(200);
      const res = smallAdapter.writeFile('src/large.txt', largeContent);
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('FILE_TOO_LARGE');
    });

    it('10. rejects write targeting secret files (.env, id_rsa, *.key)', () => {
      const resEnv = adapter.writeFile('.env', 'API_KEY=secret');
      expect(resEnv.success).toBe(false);
      expect(resEnv.errorCategory).toBe('SECRET_FILE_PROTECTED');

      const resKey = adapter.writeFile('private.key', 'PRIVATE KEY DATA');
      expect(resKey.success).toBe(false);
      expect(resKey.errorCategory).toBe('SECRET_FILE_PROTECTED');
    });

    it('11. blocks execution via ToolGateway when permission policy excludes filesystem.write', async () => {
      const readOnlyPolicy = {
        id: 'readonly_policy',
        name: 'Read-Only Policy',
        allowedCapabilities: ['filesystem.read' as const],
        maxRiskLevel: 'high' as const,
        allowDisabledTools: false,
      };
      const readOnlyGateway = new ToolGateway(readOnlyPolicy, 'error');
      readOnlyGateway.initialize(undefined, tempDir);

      const execRes = await readOnlyGateway.executeTool({
        requestId: 'req-write-denied',
        taskId: 'task-1',
        toolId: 'filesystem_write',
        requestedCapabilities: ['filesystem.write'],
        params: { path: 'src/test.ts', content: 'test' },
      });

      expect(execRes.authorized).toBe(false);
      expect(execRes.executed).toBe(false);
      expect(execRes.errorCategory).toBe('PERMISSION_DENIED');
    });

    it('12. requires human approval for medium-risk write tool via ApprovalPolicyEngine', () => {
      const policyEngine = new ApprovalPolicyEngine(undefined, 'error');
      const decision = policyEngine.evaluate(FILESYSTEM_WRITE_TOOL_DEFINITION, 'filesystem.write');
      expect(decision.requiresApproval).toBe(true);
      expect(decision.decision).toBe('REQUIRES_APPROVAL');
      expect(decision.riskLevel).toBe('medium');
    });

    it('13. verifies read-after-write content consistency', () => {
      const content = 'const x = 123;\nexport default x;\n';
      const writeRes = adapter.writeFile('src/readback.ts', content);
      expect(writeRes.success).toBe(true);

      const readRes = adapter.readFile('src/readback.ts');
      expect(readRes.success).toBe(true);
      expect(readRes.content).toBe(content);
    });

    it('14. guarantees no files are written outside workspace sandbox', () => {
      const outsideFile = path.join(os.tmpdir(), 'outside_nexus_test.txt');
      const res = adapter.writeFile(outsideFile, 'data');
      expect(res.success).toBe(false);
      expect(fs.existsSync(outsideFile)).toBe(false);
    });

    it('15. ensures failure during write validation leaves target file untouched', () => {
      const originalContent = fs.readFileSync(path.join(tempDir, 'src', 'example.ts'), 'utf8');
      const smallAdapter = new FilesystemAdapter(tempDir, 10, 'error'); // 10 byte limit
      const res = smallAdapter.writeFile('src/example.ts', 'A'.repeat(500));
      expect(res.success).toBe(false);

      const contentAfterFail = fs.readFileSync(path.join(tempDir, 'src', 'example.ts'), 'utf8');
      expect(contentAfterFail).toBe(originalContent);
    });
  });

  // ---------------------------------------------------------------------------
  // filesystem_edit Tests (11 required tests)
  // ---------------------------------------------------------------------------

  describe('filesystem_edit tool', () => {
    it('16. applies exact single replacement when hash matches', () => {
      const initialContent = fs.readFileSync(path.join(tempDir, 'src', 'example.ts'), 'utf8');
      const hash = calculateContentHash(initialContent);

      const res = adapter.editFile(
        'src/example.ts',
        hash,
        'Hello World',
        'Hello NEXUS AI'
      );

      expect(res.success).toBe(true);
      const updated = fs.readFileSync(path.join(tempDir, 'src', 'example.ts'), 'utf8');
      expect(updated).toContain('Hello NEXUS AI');
      expect(updated).not.toContain('Hello World');
    });

    it('17. rejects edit when oldText is not found in file', () => {
      const initialContent = fs.readFileSync(path.join(tempDir, 'src', 'example.ts'), 'utf8');
      const hash = calculateContentHash(initialContent);

      const res = adapter.editFile(
        'src/example.ts',
        hash,
        'NON_EXISTENT_TEXT',
        'replacement'
      );

      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('EDIT_TARGET_NOT_FOUND');
    });

    it('18. rejects edit when oldText matches multiple times in replaceMode "single"', () => {
      const content = fs.readFileSync(path.join(tempDir, 'src', 'duplicate.ts'), 'utf8');
      const hash = calculateContentHash(content);

      const res = adapter.editFile(
        'src/duplicate.ts',
        hash,
        'const value = 1;',
        'const value = 2;'
      );

      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('AMBIGUOUS_EDIT_MATCH');
    });

    it('19. rejects edit when expectedContentHash does not match current file content (conflict)', () => {
      const staleHash = '0000000000000000000000000000000000000000000000000000000000000000';

      const res = adapter.editFile(
        'src/example.ts',
        staleHash,
        'Hello World',
        'New Text'
      );

      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('HASH_MISMATCH_CONFLICT');
    });

    it('20. succeeds when exact SHA-256 hash is provided', () => {
      const content = fs.readFileSync(path.join(tempDir, 'src', 'example.ts'), 'utf8');
      const exactHash = calculateContentHash(content);

      const res = adapter.editFile('src/example.ts', exactHash, 'Hello World', 'NEXUS');
      expect(res.success).toBe(true);
    });

    it('20b. succeeds when wildcard expectedContentHash "*" or "auto" is provided', () => {
      const resWildcard = adapter.editFile('src/example.ts', '*', 'Hello World', 'NEXUS-WILDCARD');
      expect(resWildcard.success).toBe(true);

      const resAuto = adapter.editFile('src/example.ts', 'auto', 'NEXUS-WILDCARD', 'Hello Universe');
      expect(resAuto.success).toBe(true);
      const content = fs.readFileSync(path.join(tempDir, 'src', 'example.ts'), 'utf8');
      expect(content).toContain('Hello Universe');
    });

    it('21. rejects edits targeting secret files', () => {
      fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET=123');
      const hash = calculateContentHash('SECRET=123');

      const res = adapter.editFile('.env', hash, '123', '456');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('SECRET_FILE_PROTECTED');
    });

    it('22. rejects path traversal in edit target path', () => {
      const res = adapter.editFile('../outside.ts', 'hash', 'old', 'new');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
    });

    it('23. rejects symlink escape target for edit', () => {
      if (process.platform !== 'win32') {
        const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-edit-'));
        fs.writeFileSync(path.join(outsideTarget, 'target.txt'), 'content');
        const symlinkPath = path.join(tempDir, 'symlink_edit.ts');
        try {
          fs.symlinkSync(path.join(outsideTarget, 'target.txt'), symlinkPath);
          const res = adapter.editFile('symlink_edit.ts', 'hash', 'content', 'new');
          expect(res.success).toBe(false);
          expect(res.errorCategory).toBe('PATH_TRAVERSAL_DENIED');
        } finally {
          fs.rmSync(outsideTarget, { recursive: true, force: true });
        }
      }
    });

    it('24. blocks edit execution when PermissionEngine denies capability', async () => {
      const readOnlyPolicy = {
        id: 'readonly_policy',
        name: 'Read-Only Policy',
        allowedCapabilities: ['filesystem.read' as const],
        maxRiskLevel: 'high' as const,
        allowDisabledTools: false,
      };
      const readOnlyGateway = new ToolGateway(readOnlyPolicy, 'error');
      readOnlyGateway.initialize(undefined, tempDir);

      const execRes = await readOnlyGateway.executeTool({
        requestId: 'req-edit-denied',
        taskId: 'task-1',
        toolId: 'filesystem_edit',
        requestedCapabilities: ['filesystem.write'],
        params: { path: 'src/example.ts', expectedContentHash: 'hash', oldText: 'a', newText: 'b' },
      });

      expect(execRes.authorized).toBe(false);
      expect(execRes.executed).toBe(false);
      expect(execRes.errorCategory).toBe('PERMISSION_DENIED');
    });

    it('25. requires human approval for medium-risk edit tool via ApprovalPolicyEngine', () => {
      const policyEngine = new ApprovalPolicyEngine(undefined, 'error');
      const decision = policyEngine.evaluate(FILESYSTEM_EDIT_TOOL_DEFINITION, 'filesystem.write');
      expect(decision.requiresApproval).toBe(true);
      expect(decision.decision).toBe('REQUIRES_APPROVAL');
      expect(decision.riskLevel).toBe('medium');
    });

    it('26. protects against concurrent/stale edit overwrites', () => {
      const initialContent = fs.readFileSync(path.join(tempDir, 'src', 'example.ts'), 'utf8');
      const originalHash = calculateContentHash(initialContent);

      // Concurrent modification occurs
      fs.writeFileSync(path.join(tempDir, 'src', 'example.ts'), 'CONCURRENT_USER_CHANGE');

      // Stale agent edit attempt
      const res = adapter.editFile('src/example.ts', originalHash, 'Hello World', 'Agent Edit');
      expect(res.success).toBe(false);
      expect(res.errorCategory).toBe('HASH_MISMATCH_CONFLICT');

      const content = fs.readFileSync(path.join(tempDir, 'src', 'example.ts'), 'utf8');
      expect(content).toBe('CONCURRENT_USER_CHANGE'); // User change preserved!
    });
  });

  // ---------------------------------------------------------------------------
  // Diff Generation Tests (7 required tests)
  // ---------------------------------------------------------------------------

  describe('diff generation system', () => {
    it('27. generates structured diff for new file creation', () => {
      const diff = generateUnifiedDiff('src/new.ts', null, 'line1\nline2\n');
      expect(diff.operation).toBe('create');
      expect(diff.beforeHash).toBeNull();
      expect(diff.afterHash).toBe(calculateContentHash('line1\nline2\n'));
      expect(diff.changed).toBe(true);
      expect(diff.unifiedDiff).toContain('+++ b/src/new.ts');
      expect(diff.unifiedDiff).toContain('+line1');
    });

    it('28. generates structured diff for modified file', () => {
      const oldText = 'line1\noldText\nline3';
      const newText = 'line1\nnewText\nline3';
      const diff = generateUnifiedDiff('src/mod.ts', oldText, newText);
      expect(diff.operation).toBe('modify');
      expect(diff.beforeHash).toBe(calculateContentHash(oldText));
      expect(diff.afterHash).toBe(calculateContentHash(newText));
      expect(diff.changed).toBe(true);
      expect(diff.unifiedDiff).toContain('-oldText');
      expect(diff.unifiedDiff).toContain('+newText');
    });

    it('29. returns changed: false for identical content', () => {
      const text = 'same content\n';
      const diff = generateUnifiedDiff('src/same.ts', text, text);
      expect(diff.changed).toBe(false);
      expect(diff.beforeHash).toBe(diff.afterHash);
      expect(diff.unifiedDiff).toBe('');
    });

    it('30. bounds diff size for large file modifications', () => {
      const oldLarge = Array.from({ length: 600 }, (_, i) => `old line ${i}`).join('\n');
      const newLarge = Array.from({ length: 600 }, (_, i) => `new line ${i}`).join('\n');
      const diff = generateUnifiedDiff('src/large.ts', oldLarge, newLarge);
      expect(diff.unifiedDiff).toContain('... [diff truncated]');
    });

    it('31. reports accurate beforeHash before edit', () => {
      const oldContent = 'initial data';
      const diff = generateUnifiedDiff('test.txt', oldContent, 'updated data');
      expect(diff.beforeHash).toBe(calculateContentHash(oldContent));
    });

    it('32. reports accurate afterHash after edit', () => {
      const newContent = 'updated data';
      const diff = generateUnifiedDiff('test.txt', 'initial data', newContent);
      expect(diff.afterHash).toBe(calculateContentHash(newContent));
    });

    it('33. protects sensitive content by denying write/edit before diff stage', () => {
      expect(isSecretFile('.env')).toBe(true);
      expect(isSecretFile('id_rsa')).toBe(true);
      expect(isSecretFile('server.key')).toBe(true);
      expect(isSecretFile('cert.pem')).toBe(true);
      expect(isSecretFile('src/normal.ts')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-End ToolGateway Integration Tests for P6-B
  // ---------------------------------------------------------------------------

  describe('ToolGateway end-to-end integration for P6-B tools', () => {
    it('executes filesystem_write through ToolGateway pipeline', async () => {
      const execRes = await gateway.executeTool({
        requestId: 'req-write-e2e',
        taskId: 'task-e2e-1',
        toolId: 'filesystem_write',
        requestedCapabilities: ['filesystem.write'],
        params: { path: 'src/gateway_write.ts', content: 'export const g = 1;\n' },
      });

      expect(execRes.authorized).toBe(true);
      expect(execRes.executed).toBe(true);
      expect(execRes.success).toBe(true);
      expect(execRes.output?.path).toBe('src/gateway_write.ts');
      expect(execRes.output?.diff).toBeDefined();
    });

    it('executes filesystem_edit through ToolGateway pipeline', async () => {
      const initialContent = fs.readFileSync(path.join(tempDir, 'src', 'example.ts'), 'utf8');
      const hash = calculateContentHash(initialContent);

      const execRes = await gateway.executeTool({
        requestId: 'req-edit-e2e',
        taskId: 'task-e2e-2',
        toolId: 'filesystem_edit',
        requestedCapabilities: ['filesystem.write'],
        params: {
          path: 'src/example.ts',
          expectedContentHash: hash,
          oldText: 'Hello World',
          newText: 'Gateway Edit',
        },
      });

      expect(execRes.authorized).toBe(true);
      expect(execRes.executed).toBe(true);
      expect(execRes.success).toBe(true);
      expect(execRes.output?.diff).toBeDefined();
    });
  });
});
