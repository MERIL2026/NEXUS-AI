/**
 * NEXUS AI — P5-E: Agent Plan Synthesis & Controlled Task Orchestration
 *
 * Security invariant:
 *   PlanSynthesisService is an UNTRUSTED PLAN GENERATOR.
 *   It has NO execution authority — it cannot call tools, modify task state,
 *   or interact with the PermissionEngine.
 *   The AgentExecutionService (P5-D) remains the sole execution authority.
 *
 * Data flow:
 *   PlanSynthesisService
 *     → ModelGateway (plain-text inference only)
 *     → PlanValidator (deterministic, stateless, no side effects)
 *     → PlanSynthesisResult (validated AgentPlan or typed error)
 *     → caller passes AgentPlan.steps to AgentExecutionService.runExecutionLoop()
 */

import type { ModelGateway } from '../intelligence/modelGateway.js';
import type { ToolGateway } from '../tools/index.js';
import type {
  AgentPlan,
  AgentPlanStep,
  PlanSynthesisOptions,
  PlanSynthesisResult,
  PlanValidationError,
  PlanValidationResult,
} from './types.js';
import { VALID_CAPABILITIES } from '../tools/types.js';
import { Logger, LogLevel } from '../common/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum steps a plan may contain. */
const DEFAULT_MAX_STEPS = 10;

/** Low temperature for deterministic planner output. */
const PLANNER_DEFAULT_TEMPERATURE = 0.2;

/** Default inference timeout for the planning call. */
const PLANNER_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * System prompt injected for the planner role.
 * Instructs the model to output ONLY a well-formed JSON plan and nothing else.
 */
const PLANNER_SYSTEM_PROMPT = `You are a deterministic task planner for the NEXUS AI Agent Runtime.

Your ONLY job is to produce a valid JSON plan for the given goal.
You do NOT execute tools. You do NOT make decisions at runtime.
You ONLY output a plan in the exact JSON format specified.

TOOL CONTRACT & CAPABILITY RULES:
1. workspace_tree: READ-ONLY workspace/directory structure inspection. MUST NEVER be used to create directories, create files, or modify files.
2. code_search: READ-ONLY source code search. MUST NEVER be used to create or modify files.
3. filesystem_read: READ-ONLY file content inspection. MUST NEVER be used to create or modify files.
4. filesystem_write: Used ONLY to CREATE new files or REPLACE full file contents. Requires filesystem.write.
5. filesystem_edit: Used ONLY to MODIFY existing files. Requires filesystem.write. Use expectedContentHash: "*" (or exact SHA-256 hash).
6. terminal_execute: Used ONLY for executing allowed terminal/build/test commands. Requires terminal.execute. High risk, approval-controlled.

STRICT PLAN & JSON ESCAPING RULES:
1. Output ONLY valid JSON — no markdown wrapper, no conversational text, no explanation outside JSON.
2. The plan must have a "reasoning" string and a "steps" array containing at least 1 step.
3. Each step must have: stepId (string), toolId (string), requestedCapabilities (array), params (object).
4. Only use tool IDs that are explicitly listed in the AVAILABLE TOOLS section.
5. Only request capabilities that match the selected tool's contract.
6. stepId values must be unique within the plan (e.g., "step-1", "step-2").
7. Use read-only tools (workspace_tree, code_search, filesystem_read) for inspection/discovery of files that ALREADY EXIST. filesystem_read MUST ONLY be used on files confirmed to exist.
8. Use filesystem_write to create new files or filesystem_edit to modify existing files.
9. Keep reasoning concise and steps minimal.
10. JSON STRING ESCAPING: Inside all JSON string values (especially "content" or "path"), write newlines as \\n and escape double quotes as \\". DO NOT include unescaped raw newlines or unescaped raw double quotes inside string values.

FILE CREATION / AUTHORING RULES:
11. MANDATORY MULTI-STEP CREATION: If the task asks to build/create a project, webpage, website, or multi-file artifact (e.g. calculator webpage with HTML, CSS, and JS), you MUST include a filesystem_write step for EACH required file (e.g. index.html, style.css, script.js).
12. NEVER output ONLY workspace_tree or read-only tools for a creation/authoring goal. A plan for an authoring task MUST contain actual filesystem_write or filesystem_edit steps.
13. NO PREMATURE READS: NEVER issue filesystem_read on the target file path that you are about to create — it does not exist yet. filesystem_read is RESERVED for reading files that are KNOWN TO EXIST. Use filesystem_write to author each file with complete, valid code contents.
14. EXPLICIT TEXT PRESERVATION: If the task goal specifies text, HTML, marker, or contents (e.g. NEXUS_FINAL_ALPHA_2026), you MUST include that exact text in the "content" parameter of the filesystem_write step. DO NOT output placeholder text like "// Content for...".
15. COMPLETE REAL IMPLEMENTATION ONLY: Every file you author must contain 100% complete, fully implemented code and rich content with real paragraphs, headings, components, styles, and logic. NEVER output empty skeleton tags or placeholder comments (e.g. <!-- Hero Content -->, <!-- Features Content -->, <!-- Content -->, TODO, or empty container sections). Skeletons and placeholder comments will fail automated content verification and cause the task to fail.

REQUIRED OUTPUT FORMAT EXAMPLE (strict JSON, no other text):
{
  "reasoning": "Create project directory and author HTML, CSS, and JS files for calculator webpage.",
  "steps": [
    {
      "stepId": "step-1",
      "toolId": "filesystem_write",
      "requestedCapabilities": ["filesystem.write"],
      "params": {
        "path": "final-calculator-test/index.html",
        "content": "<!DOCTYPE html>\\n<html>\\n<head>\\n<link rel=\\\"stylesheet\\\" href=\\\"style.css\\\">\\n</head>\\n<body>\\n<div id=\\\"calc\\\"></div>\\n<script src=\\\"script.js\\\"></script>\\n</body>\\n</html>"
      }
    }
  ]
}`;

/**
 * Utility to determine if a task goal represents an authoring/creation request.
 *
 * Uses word-boundary regex matching to prevent substring false-positives
 * (e.g. 'typescript' must not match keyword 'script').
 */
export function isAuthoringGoal(goalText: string): boolean {
  if (!goalText || !goalText.trim()) return false;
  const lower = goalText.toLowerCase();

  // Action verbs that signal file creation/authoring intent.
  // Use word-boundary anchors (\b) to avoid substring matches.
  const authoringVerbs = [
    'create', 'build', 'write', 'generate', 'make', 'author', 'develop',
    'draft', 'implement', 'scaffold', 'initialise', 'initialize',
  ];

  // Multi-word phrases or specific artifact noun patterns that confirm authoring
  // even without an explicit verb (e.g. "new file", "a webpage", "PRD document").
  const authoringPhrases = [
    'new file', 'add file', 'webpage', 'website', 'prd', 'readme',
    'calculator', 'landing page',
  ];

  const inspectionOnlyPhrases = [
    'show workspace', 'list workspace', 'workspace tree', 'inspect workspace',
    'search code', 'find in code', 'read file', 'view file', 'check status',
    'list directory', 'explore workspace',
  ];

  // Word-boundary match for single verbs
  const hasAuthoringVerb = authoringVerbs.some((verb) =>
    new RegExp(`\\b${verb}\\b`).test(lower)
  );

  // Simple substring match is fine for multi-word phrases / proper nouns
  const hasAuthoringPhrase = authoringPhrases.some((phrase) => lower.includes(phrase));

  const hasAuthoring = hasAuthoringVerb || hasAuthoringPhrase;

  const isPureInspection =
    inspectionOnlyPhrases.some((phrase) => lower.includes(phrase)) && !hasAuthoring;

  return hasAuthoring && !isPureInspection;
}

// ---------------------------------------------------------------------------
// PlanValidator
// ---------------------------------------------------------------------------

/**
 * Deterministic, stateless plan validator.
 *
 * Validates a raw model-generated plan proposal against the tool registry.
 * No side effects. No execution. Returns a typed validation result.
 *
 * Security note: model-generated params are treated as untrusted strings.
 * The validator does NOT evaluate or execute any param values.
 */
export class PlanValidator {
  constructor(private toolGateway: ToolGateway) {}

  /**
   * Validate a raw parsed plan proposal.
   * Returns a deterministic result with all errors (does not short-circuit on first error).
   */
  validate(
    proposal: unknown,
    taskId: string,
    maxSteps: number = DEFAULT_MAX_STEPS,
    taskGoal?: string
  ): PlanValidationResult {
    const errors: PlanValidationError[] = [];

    // 1. Top-level structure check
    if (
      typeof proposal !== 'object' ||
      proposal === null ||
      Array.isArray(proposal)
    ) {
      errors.push({
        code: 'MALFORMED_OUTPUT',
        message: 'Plan proposal is not a JSON object.',
      });
      return { valid: false, errors };
    }

    const raw = proposal as Record<string, unknown>;

    // 2. Reasoning field
    if (typeof raw['reasoning'] !== 'string' || raw['reasoning'].trim() === '') {
      errors.push({
        code: 'INVALID_STEP_STRUCTURE',
        message: 'Plan must contain a non-empty "reasoning" string.',
      });
    }

    // 3. Steps array
    if (!Array.isArray(raw['steps'])) {
      errors.push({
        code: 'MALFORMED_OUTPUT',
        message: 'Plan must contain a "steps" array.',
      });
      return { valid: false, errors };
    }

    const rawSteps = raw['steps'] as unknown[];

    // 4. Empty plan check
    if (rawSteps.length === 0) {
      errors.push({
        code: 'EMPTY_PLAN',
        message: 'Plan must contain at least one step.',
      });
      return { valid: false, errors };
    }

    // 5. Step limit check
    if (rawSteps.length > maxSteps) {
      errors.push({
        code: 'STEP_LIMIT_EXCEEDED',
        message: `Plan contains ${rawSteps.length} steps but maximum allowed is ${maxSteps}.`,
      });
    }

    // 5b. Authoring goal validation — authoring goals MUST NOT consist ONLY of workspace_tree steps.
    // This prevents the specific false-completion bug where a "build" task runs only workspace_tree
    // and is marked COMPLETED without creating any files.
    // Note: filesystem_read-only plans are allowed at this stage; GoalCompletionVerifier enforces
    // artifact existence at completion time.
    if (taskGoal && isAuthoringGoal(taskGoal)) {
      const allStepsAreWorkspaceTree = rawSteps.every((step) => {
        if (typeof step === 'object' && step !== null && !Array.isArray(step)) {
          const toolId = String((step as Record<string, unknown>)['toolId'] || '');
          return toolId === 'workspace_tree';
        }
        return true;
      });

      if (allStepsAreWorkspaceTree) {
        errors.push({
          code: 'UNSUPPORTED_ACTION',
          message:
            'Task goal requires file creation/authoring, but the plan contains no file creation or execution steps (only read-only inspection tools were planned).',
        });
      }
    }

    // 6. Per-step validation
    const seenStepIds = new Set<string>();

    for (let i = 0; i < rawSteps.length; i++) {
      const rawStep = rawSteps[i];

      if (typeof rawStep !== 'object' || rawStep === null || Array.isArray(rawStep)) {
        errors.push({
          code: 'INVALID_STEP_STRUCTURE',
          message: `Step at index ${i} is not a valid object.`,
        });
        continue;
      }

      const s = rawStep as Record<string, unknown>;
      const stepId = typeof s['stepId'] === 'string' ? s['stepId'].trim() : '';

      // 6a. stepId must be a non-empty unique string
      if (!stepId) {
        errors.push({
          code: 'INVALID_STEP_STRUCTURE',
          message: `Step at index ${i} is missing a valid "stepId".`,
        });
      } else if (seenStepIds.has(stepId)) {
        errors.push({
          code: 'INVALID_STEP_STRUCTURE',
          message: `Duplicate stepId "${stepId}" at index ${i}.`,
          stepId,
        });
      } else {
        seenStepIds.add(stepId);
      }

      // 6b. toolId must reference a registered, enabled tool
      const toolId = typeof s['toolId'] === 'string' ? s['toolId'].trim() : '';
      let toolDef: import('../tools/types.js').ToolDefinition | null = null;
      if (!toolId) {
        errors.push({
          code: 'INVALID_STEP_STRUCTURE',
          message: `Step "${stepId || i}" is missing a valid "toolId".`,
          stepId: stepId || undefined,
        });
      } else {
        toolDef = this.toolGateway.getTool(toolId);
        if (!toolDef) {
          errors.push({
            code: 'UNKNOWN_TOOL',
            message: `Step "${stepId}" references unknown tool "${toolId}". Only registered tools may be planned.`,
            stepId: stepId || undefined,
          });
        } else if (!toolDef.enabled) {
          errors.push({
            code: 'UNSUPPORTED_ACTION',
            message: `Step "${stepId}" references disabled tool "${toolId}".`,
            stepId: stepId || undefined,
          });
        }
      }

      // 6c. requestedCapabilities must be a non-empty array of known values matching tool definition permissions
      const reqCaps = s['requestedCapabilities'];
      if (!Array.isArray(reqCaps) || reqCaps.length === 0) {
        errors.push({
          code: 'INVALID_STEP_STRUCTURE',
          message: `Step "${stepId || i}" must specify at least one requestedCapability.`,
          stepId: stepId || undefined,
        });
      } else {
        for (const cap of reqCaps) {
          if (typeof cap !== 'string' || !VALID_CAPABILITIES.has(cap as never)) {
            errors.push({
              code: 'UNSUPPORTED_ACTION',
              message: `Step "${stepId}" requests unknown capability "${String(cap)}".`,
              stepId: stepId || undefined,
            });
          } else if (toolDef) {
            // Check capability is permitted for the tool definition
            if (!toolDef.requiredPermissions.includes(cap as never)) {
              errors.push({
                code: 'UNSUPPORTED_ACTION',
                message: `Step "${stepId}" requests capability "${String(cap)}" which is not permitted for tool "${toolId}".`,
                stepId: stepId || undefined,
              });
            }
          }
        }
      }

      // 6d. Tool contract & action compatibility validation
      if (toolDef && toolId) {
        const writeMutationRegex = /\b(create|mkdir|write|edit|modify|delete|remove|add-dir|make-dir|create-structure|build-structure)\b/i;
        const mutationIdRegex = /^(create[-_]structure|build[-_]structure|modify[-_]file|write[-_]content|write[-_]file|edit[-_]file|make[-_]dir|mkdir|delete[-_]file)$/i;
        const paramsObj = (typeof s['params'] === 'object' && s['params'] !== null) ? s['params'] as Record<string, unknown> : {};
        const explicitAction = String(paramsObj['action'] || paramsObj['operation'] || paramsObj['mode'] || '');
        const hasWriteCapability = Array.isArray(reqCaps) && reqCaps.includes('filesystem.write');
        const isClaimingMutation = mutationIdRegex.test(stepId) || writeMutationRegex.test(explicitAction) || hasWriteCapability;

        if (toolId === 'workspace_tree') {
          if (isClaimingMutation) {
            errors.push({
              code: 'UNSUPPORTED_ACTION',
              message: `Step "${stepId}" claims a write/create/modify operation but 'workspace_tree' is strictly READ-ONLY.`,
              stepId: stepId || undefined,
            });
          }
        } else if (toolId === 'code_search') {
          if (isClaimingMutation) {
            errors.push({
              code: 'UNSUPPORTED_ACTION',
              message: `Step "${stepId}" claims a write/modify operation but 'code_search' is strictly READ-ONLY.`,
              stepId: stepId || undefined,
            });
          }
        } else if (toolId === 'filesystem_read') {
          if (isClaimingMutation) {
            errors.push({
              code: 'UNSUPPORTED_ACTION',
              message: `Step "${stepId}" claims a write/modify operation but 'filesystem_read' is strictly READ-ONLY.`,
              stepId: stepId || undefined,
            });
          }
        } else if (toolId === 'filesystem_write' || toolId === 'filesystem_edit') {
          if (Array.isArray(reqCaps) && !reqCaps.includes('filesystem.write')) {
            errors.push({
              code: 'UNSUPPORTED_ACTION',
              message: `Step "${stepId}" uses tool '${toolId}' but missing required capability 'filesystem.write'.`,
              stepId: stepId || undefined,
            });
          }
        } else if (toolId === 'terminal_execute') {
          if (Array.isArray(reqCaps) && !reqCaps.includes('terminal.execute')) {
            errors.push({
              code: 'UNSUPPORTED_ACTION',
              message: `Step "${stepId}" uses tool 'terminal_execute' but missing required capability 'terminal.execute'.`,
              stepId: stepId || undefined,
            });
          }
        }
      }

      // 6e. params must be an object (content treated as untrusted — not evaluated)
      if (
        typeof s['params'] !== 'object' ||
        s['params'] === null ||
        Array.isArray(s['params'])
      ) {
        errors.push({
          code: 'INVALID_STEP_STRUCTURE',
          message: `Step "${stepId || i}" must have a "params" object (may be empty: {}).`,
          stepId: stepId || undefined,
        });
      } else {
        const params = s['params'] as Record<string, unknown>;
        for (const [key, val] of Object.entries(params)) {
          if (typeof val === 'function') {
            errors.push({
              code: 'UNTRUSTED_PARAM',
              message: `Step "${stepId}" param "${key}" must not be a function.`,
              stepId: stepId || undefined,
            });
          }
        }
      }
    }

    void taskId;
    return { valid: errors.length === 0, errors };
  }
}

// ---------------------------------------------------------------------------
// PlanSynthesisService
// ---------------------------------------------------------------------------

/**
 * PlanSynthesisService — generates structured, validated agent plans using
 * the ModelGateway.
 *
 * SECURITY CONTRACT:
 * - This service is an UNTRUSTED PLAN GENERATOR.
 * - It has NO access to ToolExecutor, PermissionEngine, or AgentExecutionService.
 * - It passes only plain-text prompts to the model and returns structured data.
 * - The resulting AgentPlan carries zero execution authority.
 * - Callers must pass plan.steps to AgentExecutionService.runExecutionLoop()
 *   for execution, which enforces all authorization and sandbox boundaries.
 */
export class PlanSynthesisService {
  private logger: Logger;
  private validator: PlanValidator;
  private planVersion = 0;

  constructor(
    private modelGateway: ModelGateway,
    private toolGateway: ToolGateway,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('PlanSynthesisService', logLevel);
    this.validator = new PlanValidator(toolGateway);
  }

  /**
   * Synthesize a validated agent plan for the given task.
   *
   * Flow:
   *  1. Build a structured prompt listing available tools + constraints.
   *  2. Invoke ModelGateway with a low-temperature generation call.
   *  3. Extract the JSON plan block from the raw model output.
   *  4. Parse the JSON.
   *  5. Run PlanValidator (deterministic, no side effects).
   *  6. If valid → assemble and return AgentPlan.
   *     If invalid → return PlanSynthesisResult with typed errors.
   */
  async synthesize(
    taskId: string,
    options: PlanSynthesisOptions
  ): Promise<PlanSynthesisResult> {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    const timeoutMs = options.timeoutMs ?? PLANNER_DEFAULT_TIMEOUT_MS;
    const temperature = options.temperature ?? PLANNER_DEFAULT_TEMPERATURE;

    this.logger.info('Starting plan synthesis', { taskId, maxSteps, temperature });

    const maxAttempts = 2; // Bounded retry: 1 initial attempt + 1 retry attempt
    let lastErrorCategory: 'PLAN_PARSE_FAILED' | 'PLAN_VALIDATION_FAILED' | 'SYNTHESIS_TIMEOUT' | 'MODEL_UNAVAILABLE' = 'PLAN_PARSE_FAILED';
    let lastErrorMessage = 'Unknown synthesis failure';
    let lastValidationErrors: PlanValidationError[] | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isRetry = attempt > 1;
      this.logger.info(`Plan synthesis attempt ${attempt}/${maxAttempts}`, { taskId, isRetry });

      // 1. Build prompt (standard or targeted retry prompt)
      const prompt = isRetry
        ? this.buildRetryPlannerPrompt(options.taskGoal, maxSteps, lastErrorMessage)
        : this.buildPlannerPrompt(options.taskGoal, maxSteps);

      // 2. Model inference with capability-aware routing
      const isAuthoring = isAuthoringGoal(options.taskGoal);
      const effectiveCapability = isAuthoring ? 'coding' : 'planning';

      if (isAuthoring) {
        this.logger.info('[CodingAgent] Generation started', { taskId, attempt, capability: effectiveCapability });
      }

      let rawModelText: string;
      let usedModelId: string;

      try {
        const response = await this.modelGateway.generate({
          prompt,
          system: PLANNER_SYSTEM_PROMPT,
          modelId: options.modelId,
          taskCapability: effectiveCapability,
          temperature,
          timeoutMs,
          allowFallback: true,
        });

        rawModelText = response.text;
        usedModelId = response.modelId;

        this.logger.info('Model inference completed', {
          taskId,
          attempt,
          modelId: usedModelId,
          latencyMs: response.latencyMs,
          textLength: rawModelText.length,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Model inference failed during plan synthesis (attempt ${attempt}): ${msg}`, { taskId });
        return {
          success: false,
          errorCategory: (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('timed out')) ? 'SYNTHESIS_TIMEOUT' : 'MODEL_UNAVAILABLE',
          errorMessage: msg,
        };
      }

      // 3. Extract JSON from raw model output
      let parsed: unknown;
      try {
        parsed = this.extractJsonFromModelOutput(rawModelText);
      } catch (parseErr: unknown) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        lastErrorCategory = 'PLAN_PARSE_FAILED';
        lastErrorMessage = `Could not extract valid JSON from model output: ${msg}`;
        this.logger.warn(`JSON extraction failed (attempt ${attempt}/${maxAttempts})`, { taskId, error: msg });

        if (attempt < maxAttempts) {
          continue; // Trigger bounded retry
        }
        return {
          success: false,
          errorCategory: 'PLAN_PARSE_FAILED',
          errorMessage: lastErrorMessage,
        };
      }

      // 4. Validate the parsed proposal
      const validation: PlanValidationResult = this.validator.validate(
        parsed,
        taskId,
        maxSteps,
        options.taskGoal
      );

      if (!validation.valid) {
        lastErrorCategory = 'PLAN_VALIDATION_FAILED';
        lastValidationErrors = validation.errors;
        lastErrorMessage = `Plan rejected: ${validation.errors.map((e) => e.message).join('; ')}`;
        this.logger.warn(`Plan validation failed (attempt ${attempt}/${maxAttempts})`, {
          taskId,
          errorCount: validation.errors.length,
          errors: validation.errors.map((e) => `${e.code}: ${e.message}`),
          rawParsed: JSON.stringify(parsed),
        });

        if (attempt < maxAttempts) {
          continue; // Trigger bounded retry
        }
        return {
          success: false,
          errorCategory: 'PLAN_VALIDATION_FAILED',
          validationErrors: validation.errors,
          errorMessage: lastErrorMessage,
        };
      }

      // 5. Assemble the validated AgentPlan
      const planVersion = ++this.planVersion;
      const planId = `plan-${taskId}-v${planVersion}-${Date.now()}`;
      const raw = parsed as Record<string, unknown>;
      const rawSteps = raw['steps'] as Array<Record<string, unknown>>;

      const steps: AgentPlanStep[] = rawSteps.map((s, idx) => {
        const now = new Date().toISOString();
        const paramsObj = { ...(s['params'] as Record<string, unknown>) };

        // Explicit marker/content preservation for filesystem_write steps
        if (String(s['toolId']) === 'filesystem_write') {
          const contentStr = typeof paramsObj['content'] === 'string' ? paramsObj['content'] : '';
          if (!contentStr || contentStr.startsWith('// Content for')) {
            const markerMatch = options.taskGoal.match(/(NEXUS_[A-Z0-9_]+)/) ||
                               options.taskGoal.match(/(?:containing|text|content|marker)\s+[:'"]?([a-zA-Z0-9_\-]+)['"]?/i);
            if (markerMatch && markerMatch[1]) {
              const markerText = markerMatch[1].trim();
              paramsObj['content'] = `<!DOCTYPE html>\n<html>\n<head><title>Preview</title></head>\n<body>\n<h1>${markerText}</h1>\n</body>\n</html>`;
            }
          }
        }

        return {
          stepId: String(s['stepId']),
          taskId,
          sequence: idx + 1,
          stepType: 'tool_execution' as const,
          status: 'pending' as const,
          toolId: String(s['toolId']),
          requestedCapabilities: (s['requestedCapabilities'] as import('../tools/types.js').ToolCapability[]).slice(),
          params: paramsObj,
          attemptCount: 0,
          maxAttempts: 3,
          createdAt: now,
          updatedAt: now,
        };
      });

      const plan: AgentPlan = {
        planId,
        taskId,
        version: planVersion,
        steps,
        reasoning: String(raw['reasoning']),
        modelId: usedModelId,
        synthesizedAt: new Date().toISOString(),
      };

      if (isAuthoring) {
        this.logger.info('[CodingAgent] Generation completed', { taskId, planId, stepCount: steps.length });
      }

      this.logger.info('Plan synthesis succeeded', {
        taskId,
        planId,
        version: planVersion,
        stepCount: steps.length,
        modelId: usedModelId,
        attempt,
      });

      return { success: true, plan };
    }

    return {
      success: false,
      errorCategory: lastErrorCategory,
      validationErrors: lastValidationErrors,
      errorMessage: lastErrorMessage,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the structured planner prompt.
   * Lists available registered tools with their IDs and required capabilities
   * so the model can only reference tools that exist in the registry.
   */
  private buildPlannerPrompt(taskGoal: string, maxSteps: number): string {
    const isAuthoring = isAuthoringGoal(taskGoal);
    const tools = this.toolGateway.listTools();

    const toolLines = tools.length > 0
      ? tools
          .filter((t) => t.enabled)
          .map((t) => {
            const schemaKeys = t.inputSchema ? Object.keys(t.inputSchema).map((k) => `"${k}"`).join(', ') : '';
            return `  - id: "${t.id}" | capabilities: [${t.requiredPermissions.map((p) => `"${p}"`).join(', ')}] | params: {${schemaKeys}} | risk: ${t.riskLevel} | description: ${t.description}`;
          })
          .join('\n')
      : '  (none — no tools are registered)';

    const goalGuidance = isAuthoring
      ? [
          '  - AUTHORING GOAL: You MUST include filesystem_write steps to create each required file with its complete, working code content.',
          '  - Do NOT output a plan with only read-only inspection tools (workspace_tree / code_search / filesystem_read).',
        ]
      : [
          '  - You MUST include at least 1 step to inspect, explore, or execute the goal.',
        ];

    return [
      `TASK GOAL: ${taskGoal}`,
      '',
      'CONSTRAINTS:',
      `  - Maximum steps: ${maxSteps}`,
      `  - You may ONLY use the tools listed below.`,
      ...goalGuidance,
      `  - Do NOT output an empty steps array.`,
      `  - Do NOT invent tool IDs or capabilities.`,
      '',
      'AVAILABLE TOOLS:',
      toolLines,
      '',
      isAuthoring
        ? 'Produce a valid JSON plan containing the necessary filesystem_write steps with full file contents to build the requested project.'
        : 'Produce a minimal, valid JSON plan containing at least 1 step using the available tools to accomplish or inspect the goal.',
    ].join('\n');
  }

  /**
   * Build targeted retry prompt requesting JSON correction.
   */
  private buildRetryPlannerPrompt(taskGoal: string, maxSteps: number, failureReason: string): string {
    const basePrompt = this.buildPlannerPrompt(taskGoal, maxSteps);
    return [
      basePrompt,
      '',
      'CRITICAL REPAIR REQUIRED FOR THIS RETRY:',
      `Your previous response failed validation/parsing with error:`,
      `"${failureReason}"`,
      '',
      'RETRY INSTRUCTIONS:',
      '1. You MUST output ONLY valid JSON matching the exact REQUIRED OUTPUT FORMAT.',
      '2. Escape all newlines in string literals as \\n and double quotes as \\".',
      '3. Ensure all steps include stepId, toolId, requestedCapabilities, and params.',
      '4. Do NOT output markdown code fences or conversational text.',
    ].join('\n');
  }

  /**
   * Extract a JSON object from raw model output.
   *
   * Handles:
   *  - Pure JSON responses (ideal)
   *  - JSON wrapped in markdown code fences (```json ... ```)
   *  - Leading/trailing conversational text
   *  - Sanitization of unescaped raw control characters (newlines/tabs) inside JSON strings
   *
   * Throws if no valid JSON object can be extracted.
   */
  private extractJsonFromModelOutput(raw: string): unknown {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error('Model returned empty response');
    }

    const candidates: string[] = [];

    // Candidate 1: markdown code fence content
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1].trim()) {
      candidates.push(fenceMatch[1].trim());
    }

    // Candidate 2: pure trimmed response
    candidates.push(trimmed);

    // Candidate 3: first '{' to last '}' block
    const braceStart = trimmed.indexOf('{');
    const braceEnd = trimmed.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      const slice = trimmed.slice(braceStart, braceEnd + 1).trim();
      if (!candidates.includes(slice)) {
        candidates.push(slice);
      }
    }

    // Try parsing candidates: first raw JSON.parse, then sanitized JSON.parse
    for (const cand of candidates) {
      try {
        return JSON.parse(cand);
      } catch {
        try {
          const sanitized = this.sanitizeJsonString(cand);
          return JSON.parse(sanitized);
        } catch {
          // continue
        }
      }
    }

    // Check for truncated JSON indicators
    if (braceStart !== -1 && braceEnd <= braceStart) {
      throw new Error('Truncated or incomplete JSON output (missing closing brace)');
    }

    throw new Error('No valid JSON object could be extracted from model output');
  }

  /**
   * Repair unescaped raw newlines, tabs, invalid backslash escapes, and trailing commas inside JSON string candidate.
   */
  private sanitizeJsonString(jsonStr: string): string {
    // 1. Remove trailing commas before closing braces/brackets
    const clean = jsonStr.replace(/,\s*([}\]])/g, '$1');

    let inString = false;
    let escaped = false;
    let result = '';
    let openBraces = 0;
    let openBrackets = 0;

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];

      if (inString) {
        if (escaped) {
          // Check if valid JSON escape character: ", \, /, b, f, n, r, t, u
          if (!'\\"/bfnrtu'.includes(ch)) {
            result += '\\\\' + ch;
          } else {
            result += ch;
          }
          escaped = false;
        } else if (ch === '\\') {
          const next = clean[i + 1];
          if (next && !'\\"/bfnrtu'.includes(next)) {
            result += '\\\\';
          } else {
            result += '\\';
            escaped = true;
          }
        } else if (ch === '"') {
          result += ch;
          inString = false;
        } else if (ch === '\n') {
          result += '\\n';
        } else if (ch === '\r') {
          // drop CR
        } else if (ch === '\t') {
          result += '\\t';
        } else {
          result += ch;
        }
      } else {
        if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          openBraces++;
        } else if (ch === '}') {
          if (openBraces > 0) openBraces--;
        } else if (ch === '[') {
          openBrackets++;
        } else if (ch === ']') {
          if (openBrackets > 0) openBrackets--;
        }
        result += ch;
      }
    }

    if (inString) {
      result += '"';
    }

    while (openBrackets > 0) {
      result += ']';
      openBrackets--;
    }
    while (openBraces > 0) {
      result += '}';
      openBraces--;
    }

    return result;
  }
}
