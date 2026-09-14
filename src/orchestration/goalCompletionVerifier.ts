/**
 * NEXUS AI - P7-F.1: Production-Grade Goal Completion Verifier
 *
 * Prevents false positive task completions.
 *
 * Distinguishes:
 *   1. PLAN EXECUTION SUCCESS (all steps in a plan succeeded)
 *   2. GOAL COMPLETION (the user's requested goal was actually achieved)
 *
 * Security & Sandbox Invariants:
 *  - Enforces workspace root sandbox boundaries on all path checks.
 *  - Performs zero arbitrary shell execution or state mutations.
 *  - Deterministic and pure observation layer over the workspace filesystem.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentPlanStep } from './types.js';
import { isAuthoringGoal } from './planner.js';
import { verifyHtmlContentSubstance } from './placeholderDetector.js';
import { Logger, LogLevel } from '../common/logger.js';

export interface VerifiedArtifactInfo {
  projectRoot: string;
  relativeProjectRoot: string;
  entryPoint: string;
  files: string[];
  artifactType: 'web_project' | 'file' | 'module';
  workspacePath: string;
}

export interface GoalVerificationResult {
  verified: boolean;
  errorCategory?: string;
  errorMessage?: string;
  artifactsChecked?: string[];
  artifactInfo?: VerifiedArtifactInfo;
}

export class GoalCompletionVerifier {
  private logger: Logger;

  constructor(logLevel: LogLevel = 'info') {
    this.logger = new Logger('GoalCompletionVerifier', logLevel);
  }

  /**
   * Verifies whether an executed task has truly satisfied its goal before
   * allowing the task state to transition to COMPLETED.
   *
   * @param taskGoal - The natural language task goal.
   * @param steps - The execution plan steps that were run.
   * @param workspaceRoot - The canonical workspace sandbox root path.
   */
  verifyGoal(
    taskGoal: string,
    steps: AgentPlanStep[],
    workspaceRoot: string
  ): GoalVerificationResult {
    this.logger.info(`Starting goal completion verification`, { taskGoal, workspaceRoot });

    const isAuthoring = isAuthoringGoal(taskGoal);

    // ── READ-ONLY / INSPECTION GOALS ──────────────────────────────────────────
    if (!isAuthoring) {
      this.logger.info(`Goal verified as read-only / inspection task`);
      return { verified: true, artifactsChecked: [] };
    }

    // ── AUTHORING / CREATION GOALS ────────────────────────────────────────────

    // Check 1: Ensure mutation / creation steps actually executed and succeeded
    const mutationSteps = steps.filter(
      (s) =>
        s.status === 'completed' &&
        (s.toolId === 'filesystem_write' ||
          s.toolId === 'filesystem_edit' ||
          s.toolId === 'terminal_execute')
    );

    if (mutationSteps.length === 0) {
      this.logger.warn(`Verification failed: no creation/authoring steps succeeded`, { taskGoal });
      return {
        verified: false,
        errorCategory: 'NO_AUTHORING_STEPS',
        errorMessage:
          'Task goal requested creation/authoring, but no file creation or modification steps were executed.',
      };
    }

    // Check 2: Extract expected target artifact relative paths
    const stepPaths = new Set<string>();

    // 2a. Extract paths from filesystem_write / filesystem_edit step params
    mutationSteps.forEach((s) => {
      if (s.params) {
        const rel =
          typeof s.params.relativePath === 'string'
            ? s.params.relativePath.trim()
            : typeof s.params.path === 'string'
            ? s.params.path.trim()
            : '';
        if (rel) stepPaths.add(rel);
      }
    });

    const expectedPaths = new Set<string>(stepPaths);

    // 2b. Extract explicitly named files from the task goal if no step paths were extracted
    if (stepPaths.size === 0) {
      const explicitFileRegex = /([a-zA-Z0-9_\-\/\\]+\.(html|css|json|jsx|tsx|yaml|yml|txt|py|md|sh|ts|js))\b/gi;
      let match: RegExpExecArray | null;
      while ((match = explicitFileRegex.exec(taskGoal)) !== null) {
        const extracted = match[1].replace(/\\/g, '/');
        // Ignore generic words like "file.html"
        if (!extracted.startsWith('http') && !extracted.includes('*')) {
          expectedPaths.add(extracted);
        }
      }

      // If goal mentions a subdirectory (e.g., "calculator-test"), expand file references
      const folderMatch = taskGoal.match(/(?:folder|directory|called|named)\s+([a-zA-Z0-9_\-]+)/i);
      if (folderMatch && folderMatch[1]) {
        const folderName = folderMatch[1].trim();
        ['index.html', 'style.css', 'script.js'].forEach((fileName) => {
          if (taskGoal.toLowerCase().includes(fileName)) {
            expectedPaths.add(`${folderName}/${fileName}`);
          }
        });
      }
    }

    if (expectedPaths.size === 0) {
      // Fallback: if no specific paths extracted, ensure at least one written step exists
      this.logger.info(`Authoring steps completed (no explicit filename pattern extracted)`);
      return { verified: true, artifactsChecked: [] };
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync(workspaceRoot);
    } catch {
      canonicalRoot = path.resolve(workspaceRoot);
    }
    const checked: string[] = [];

    // Check 3: Verify each expected artifact exists & is non-empty
    for (let relPath of expectedPaths) {
      let absPath = path.resolve(canonicalRoot, relPath);

      // If bare filename is requested but missing at root, check if stepPaths wrote it inside a subdirectory
      if (!fs.existsSync(absPath) && !relPath.includes('/') && !relPath.includes('\\')) {
        const matchingStepPath = Array.from(stepPaths).find(
          (sp) => sp.endsWith('/' + relPath) || sp.endsWith('\\' + relPath)
        );
        if (matchingStepPath) {
          relPath = matchingStepPath;
          absPath = path.resolve(canonicalRoot, relPath);
        }
      }

      // Sandbox safety check
      if (!absPath.startsWith(canonicalRoot)) {
        this.logger.warn(`Path traversal attempt blocked in verification: ${relPath}`);
        return {
          verified: false,
          errorCategory: 'PERMISSION_DENIED',
          errorMessage: `Verification path '${relPath}' is outside workspace root sandbox.`,
        };
      }

      if (!fs.existsSync(absPath)) {
        this.logger.warn(`Verification failed: missing expected artifact '${relPath}'`);
        return {
          verified: false,
          errorCategory: 'MISSING_ARTIFACT',
          errorMessage: `Expected artifact file '${relPath}' does not exist in workspace.`,
          artifactsChecked: checked,
        };
      }

      const stat = fs.statSync(absPath);
      if (stat.isFile() && stat.size === 0) {
        this.logger.warn(`Verification failed: empty artifact '${relPath}' (0 bytes)`);
        return {
          verified: false,
          errorCategory: 'EMPTY_ARTIFACT',
          errorMessage: `Expected artifact file '${relPath}' exists but is 0 bytes (empty).`,
          artifactsChecked: checked,
        };
      }

      checked.push(relPath);
    }

    // Check 4: Deep Content & Intent verification for web authoring
    const lowerGoal = taskGoal.toLowerCase();
    const isWebGoal =
      lowerGoal.includes('html') ||
      lowerGoal.includes('calculator') ||
      lowerGoal.includes('webpage') ||
      lowerGoal.includes('website') ||
      lowerGoal.includes('landing') ||
      lowerGoal.includes('saas') ||
      lowerGoal.includes('portfolio') ||
      lowerGoal.includes('app');

    if (isWebGoal) {
      // Prioritize standard entry point index.html, then goal-matched HTML, then first html artifact
      let htmlPathRel = Array.from(checked).find(
        (p) => p.toLowerCase() === 'index.html' || p.toLowerCase().endsWith('/index.html') || p.toLowerCase().endsWith('\\index.html')
      );
      if (!htmlPathRel) {
        htmlPathRel = Array.from(checked).find(
          (p) => p.endsWith('.html') && lowerGoal.includes(path.basename(p).toLowerCase())
        );
      }
      if (!htmlPathRel) {
        htmlPathRel = Array.from(checked).find((p) => p.endsWith('.html'));
      }

      if (htmlPathRel) {
        const htmlAbs = path.resolve(canonicalRoot, htmlPathRel);
        if (fs.existsSync(htmlAbs)) {
          const htmlContent = fs.readFileSync(htmlAbs, 'utf8');
          const lowerHtml = htmlContent.toLowerCase();

          // 4a. Comprehensive Content Substance & Placeholder Verification
          const contentRes = verifyHtmlContentSubstance(htmlContent, taskGoal);
          if (!contentRes.valid) {
            this.logger.warn(`Verification failed: HTML content substance check rejected '${htmlPathRel}'`, {
              category: contentRes.errorCategory,
              reason: contentRes.reason,
            });
            return {
              verified: false,
              errorCategory: contentRes.errorCategory || 'CONTENT_VERIFICATION_FAILED',
              errorMessage: `Verification rejected: HTML artifact '${htmlPathRel}' failed content substance check. ${contentRes.reason}`,
              artifactsChecked: checked,
            };
          }

          // 4b. Verify CSS and JS file references in HTML
          const cssPathRel = Array.from(checked).find((p) => p.endsWith('.css'));
          const jsPathRel = Array.from(checked).find((p) => p.endsWith('.js'));

          const hasCssRef = cssPathRel
            ? lowerHtml.includes('.css') || lowerHtml.includes('<style')
            : true;

          const hasJsRef = jsPathRel
            ? lowerHtml.includes('.js') || lowerHtml.includes('<script')
            : true;

          if (!hasCssRef || !hasJsRef) {
            this.logger.warn(`Verification failed: HTML artifact '${htmlPathRel}' missing CSS or JS references`);
            return {
              verified: false,
              errorCategory: 'CONTENT_VERIFICATION_FAILED',
              errorMessage: `HTML artifact '${htmlPathRel}' does not reference expected CSS/JS files.`,
              artifactsChecked: checked,
            };
          }

          // 4c. Verify CSS Styling Substance
          if (cssPathRel) {
            const cssAbs = path.resolve(canonicalRoot, cssPathRel);
            if (fs.existsSync(cssAbs)) {
              const cssStat = fs.statSync(cssAbs);
              const minCssSize = lowerGoal.includes('calculator') ? 50 : 80;
              if (cssStat.size < minCssSize) {
                this.logger.warn(`Verification failed: CSS artifact '${cssPathRel}' is too small/trivial (${cssStat.size} bytes)`);
                return {
                  verified: false,
                  errorCategory: 'INSUFFICIENT_STYLE_CONTENT',
                  errorMessage: `CSS artifact '${cssPathRel}' is insufficient (${cssStat.size} bytes; minimum ${minCssSize} bytes required).`,
                  artifactsChecked: checked,
                };
              }

              const cssText = fs.readFileSync(cssAbs, 'utf8');
              const hasCssRules = /\{[^}]*:[^}]*\}/.test(cssText);
              if (!hasCssRules) {
                this.logger.warn(`Verification failed: CSS artifact '${cssPathRel}' contains no valid property declarations`);
                return {
                  verified: false,
                  errorCategory: 'INSUFFICIENT_STYLE_CONTENT',
                  errorMessage: `CSS artifact '${cssPathRel}' does not contain valid CSS style rules or declarations.`,
                  artifactsChecked: checked,
                };
              }
            }
          }

          // 4d. Verify JS Logic Substance
          if (jsPathRel) {
            const jsAbs = path.resolve(canonicalRoot, jsPathRel);
            if (fs.existsSync(jsAbs)) {
              const jsStat = fs.statSync(jsAbs);
              if (jsStat.size === 0) {
                this.logger.warn(`Verification failed: JS artifact '${jsPathRel}' is empty (0 bytes)`);
                return {
                  verified: false,
                  errorCategory: 'EMPTY_ARTIFACT',
                  errorMessage: `JS artifact '${jsPathRel}' is empty (0 bytes).`,
                  artifactsChecked: checked,
                };
              }

              if (lowerGoal.includes('calculator')) {
                const jsText = fs.readFileSync(jsAbs, 'utf8');
                const hasCalcLogic = /(?:function|=>|display|clear|append|eval|calculate|\+|-|\*|\/)/i.test(jsText);
                if (!hasCalcLogic) {
                  this.logger.warn(`Verification failed: JS artifact '${jsPathRel}' lacks calculator functional logic`);
                  return {
                    verified: false,
                    errorCategory: 'INSUFFICIENT_LOGIC_CONTENT',
                    errorMessage: `JS artifact '${jsPathRel}' does not contain functional calculator evaluation logic.`,
                    artifactsChecked: checked,
                  };
                }
              }
            }
          }
        }
      }
    }

    this.logger.info(`Goal completion verification succeeded`, { checkedCount: checked.length });

    // Determine artifact project root and entry point
    let projectRoot = canonicalRoot;
    let relativeProjectRoot = '.';
    let entryPoint = 'index.html';
    let artifactType: 'web_project' | 'file' | 'module' = 'file';

    const htmlRel = checked.find((p) => p.endsWith('.html'));
    if (htmlRel) {
      artifactType = 'web_project';
      entryPoint = path.basename(htmlRel);
      const dirName = path.dirname(htmlRel);
      if (dirName && dirName !== '.') {
        relativeProjectRoot = dirName.replace(/\\/g, '/');
        projectRoot = path.resolve(canonicalRoot, dirName);
      }
    } else if (checked.length > 0) {
      const firstRel = checked[0];
      entryPoint = path.basename(firstRel);
      const dirName = path.dirname(firstRel);
      if (dirName && dirName !== '.') {
        relativeProjectRoot = dirName.replace(/\\/g, '/');
        projectRoot = path.resolve(canonicalRoot, dirName);
      }
    }

    const artifactInfo: VerifiedArtifactInfo = {
      projectRoot,
      relativeProjectRoot,
      entryPoint,
      files: checked.map((p) => path.relative(projectRoot, path.resolve(canonicalRoot, p)).replace(/\\/g, '/')),
      artifactType,
      workspacePath: canonicalRoot,
    };

    return { verified: true, artifactsChecked: checked, artifactInfo };
  }
}
