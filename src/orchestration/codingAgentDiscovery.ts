/**
 * NEXUS AI — P6-D: Coding Agent Codebase Discovery
 *
 * Gathers bounded, secret-safe codebase evidence using registered discovery tools:
 *  - workspace_tree
 *  - code_search
 *  - filesystem_read
 *
 * SECURITY INVARIANTS:
 *  - Workspace sandboxed — paths outside workspace are rejected.
 *  - Secret-safe — secret files (.env, *.key, *.pem, id_rsa, credentials.json) are excluded.
 *  - Bounded — snippet lengths and file counts are capped to prevent context overflow.
 *  - Read-only — zero filesystem modifications.
 */

import type { ToolGateway } from '../tools/index.js';
import { isSecretFile } from '../tools/index.js';
import type { CodebaseEvidence, WorkspaceFileEvidence, SearchMatchEvidence } from './codingAgentTypes.js';
import { Logger, LogLevel } from '../common/logger.js';

export class CodingAgentDiscovery {
  private logger: Logger;

  constructor(
    private toolGateway: ToolGateway,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('CodingAgentDiscovery', logLevel);
  }

  /**
   * Discover evidence for a user task goal within the configured workspace.
   *
   * @param taskId Unique task ID.
   * @param goal User task goal string.
   * @param searchKeywords Keywords extracted or inferred for code search.
   * @returns Bounded, secret-safe CodebaseEvidence object.
   */
  async discoverCodebase(
    taskId: string,
    goal: string,
    searchKeywords: string[] = []
  ): Promise<CodebaseEvidence> {
    this.logger.info(`Starting codebase discovery for task`, { taskId, goal });

    const secretFilesExcluded: string[] = [];
    const discoveredFiles: WorkspaceFileEvidence[] = [];
    const searchResults: SearchMatchEvidence[] = [];
    let treeEntriesCount = 0;
    let packageInfo: CodebaseEvidence['packageInfo'] = undefined;

    // 1. Explore workspace directory tree (bounded)
    const treeReqId = `req-tree-${taskId}`;
    const treeResult = this.toolGateway.executeTool({
      requestId: treeReqId,
      taskId,
      toolId: 'workspace_tree',
      requestedCapabilities: ['filesystem.read'],
      params: { path: '.', maxDepth: 4, maxEntries: 200 },
    });

    const resolvedTreeResult = treeResult instanceof Promise ? await treeResult : treeResult;

    if (resolvedTreeResult.success && resolvedTreeResult.output?.entries) {
      const rawEntries = resolvedTreeResult.output.entries as Array<{ path: string; type: string; size?: number }>;
      treeEntriesCount = rawEntries.length;

      for (const entry of rawEntries) {
        if (isSecretFile(entry.path)) {
          secretFilesExcluded.push(entry.path);
          continue;
        }

        if (entry.type === 'file') {
          discoveredFiles.push({
            relativePath: entry.path,
            size: entry.size,
            isSecret: false,
          });
        }
      }
    }

    // 2. Read package.json if present for project context
    const hasPackageJson = discoveredFiles.some((f) => f.relativePath === 'package.json');
    if (hasPackageJson) {
      const readPkgResult = this.toolGateway.executeTool({
        requestId: `req-pkg-${taskId}`,
        taskId,
        toolId: 'filesystem_read',
        requestedCapabilities: ['filesystem.read'],
        params: { relativePath: 'package.json' },
      });

      const resolvedPkg = readPkgResult instanceof Promise ? await readPkgResult : readPkgResult;

      if (resolvedPkg.success && typeof resolvedPkg.output?.content === 'string') {
        try {
          const parsed = JSON.parse(resolvedPkg.output.content);
          packageInfo = {
            name: parsed.name,
            version: parsed.version,
            scripts: parsed.scripts,
          };
        } catch {
          /* ignore parse error */
        }
      }
    }

    // 3. Search code for relevant terms in task goal & keywords
    const keywordsToSearch = new Set<string>();
    for (const kw of searchKeywords) {
      if (kw && kw.trim().length >= 3) {
        keywordsToSearch.add(kw.trim());
      }
    }

    // Extract identifiers from task goal
    const goalTokens = goal.match(/\b[a-zA-Z_][a-zA-Z0-9_\-\.]*\b/g) || [];
    for (const token of goalTokens) {
      if (token.length >= 4 && !['task', 'fix', 'code', 'file', 'test', 'run', 'make', 'with', 'from', 'that', 'this'].includes(token.toLowerCase())) {
        keywordsToSearch.add(token);
      }
    }

    for (const kw of Array.from(keywordsToSearch).slice(0, 3)) {
      const searchRes = this.toolGateway.executeTool({
        requestId: `req-search-${taskId}-${kw}`,
        taskId,
        toolId: 'code_search',
        requestedCapabilities: ['filesystem.read'],
        params: { query: kw, path: '.', maxResults: 10 },
      });

      const resolvedSearch = searchRes instanceof Promise ? await searchRes : searchRes;

      if (resolvedSearch.success && Array.isArray(resolvedSearch.output?.results)) {
        const matches = resolvedSearch.output.results as Array<{
          path: string;
          line: number;
          match: string;
          snippet: string;
        }>;

        for (const m of matches) {
          if (isSecretFile(m.path)) {
            if (!secretFilesExcluded.includes(m.path)) {
              secretFilesExcluded.push(m.path);
            }
            continue;
          }

          searchResults.push({
            relativePath: m.path,
            line: m.line,
            match: m.match,
            snippet: m.snippet.slice(0, 200), // bounded snippet length
          });
        }
      }
    }

    this.logger.info(`Codebase discovery completed`, {
      taskId,
      filesDiscoveredCount: discoveredFiles.length,
      searchResultsCount: searchResults.length,
      secretsExcludedCount: secretFilesExcluded.length,
    });

    return {
      workspaceRoot: '.',
      discoveredFiles: discoveredFiles.slice(0, 50), // bounded file count
      searchResults: searchResults.slice(0, 20),      // bounded search results
      treeEntriesCount,
      packageInfo,
      secretFilesExcluded,
    };
  }
}
