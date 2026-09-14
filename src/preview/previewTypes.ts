/**
 * NEXUS AI — P7-H: Local Web Project Preview Types
 */

import type { AgentTask } from '../storage/repositories/types.js';

export type PreviewResultStatus =
  | 'LAUNCHED'
  | 'NO_COMPLETED_TASK'
  | 'TASK_FAILED'
  | 'TASK_INCOMPLETE'
  | 'NOT_WEB_PROJECT'
  | 'MISSING_INDEX'
  | 'PLACEHOLDER_ARTIFACT_BLOCKED'
  | 'STOPPED'
  | 'ALREADY_STOPPED'
  | 'ERROR';

export interface PreviewServerInfo {
  port: number;
  url: string;
  projectDir: string;
  entryFile: string;
}

export interface PreviewStatus {
  active: boolean;
  taskId?: string;
  taskTitle?: string;
  serverInfo?: PreviewServerInfo;
}

export interface DiscoveredArtifacts {
  projectDir: string;
  entryFile?: string;
  files: string[];
  hasIndexHtml: boolean;
  isWebProject: boolean;
}

export interface PreviewResult {
  success: boolean;
  status: PreviewResultStatus;
  task?: AgentTask;
  serverInfo?: PreviewServerInfo;
  detectedFiles?: string[];
  artifactsSummary?: string[];
  message?: string;
  error?: string;
}
