import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StorageService } from '../storage/index.js';

describe('Repository Layer Persistence', () => {
  let storage: StorageService;

  beforeEach(async () => {
    storage = new StorageService(':memory:', 'error');
    await storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  it('persists and retrieves projects', () => {
    const created = storage.projects.create({
      id: 'proj-1',
      name: 'NEXUS Workspace',
      description: 'Core project workspace',
      workspacePath: 'C:/Workspaces/NEXUS',
    });

    expect(created.id).toBe('proj-1');
    expect(created.name).toBe('NEXUS Workspace');

    const found = storage.projects.findById('proj-1');
    expect(found).not.toBeNull();
    expect(found?.workspacePath).toBe('C:/Workspaces/NEXUS');

    const all = storage.projects.listAll();
    expect(all).toHaveLength(1);

    const deleted = storage.projects.deleteById('proj-1');
    expect(deleted).toBe(true);
    expect(storage.projects.findById('proj-1')).toBeNull();
  });

  it('persists and retrieves conversations and messages', () => {
    storage.projects.create({
      id: 'proj-1',
      name: 'Project 1',
      description: 'Test project description',
      workspacePath: 'C:/Workspaces/1',
    });

    const conversation = storage.conversations.create({
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'Initial Architecture Chat',
      mode: 'chat',
    });

    expect(conversation.id).toBe('conv-1');

    const message1 = storage.messages.create({
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'user',
      content: 'Explain system architecture',
    });

    const message2 = storage.messages.create({
      id: 'msg-2',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'NEXUS AI is structured into 7 distinct layers.',
    });

    expect(message1.id).toBe('msg-1');
    expect(message2.id).toBe('msg-2');

    const messages = storage.messages.listByConversation('conv-1');
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Explain system architecture');
    expect(messages[1].content).toBe('NEXUS AI is structured into 7 distinct layers.');
  });

  it('persists agent tasks and updates task state', () => {
    storage.projects.create({
      id: 'proj-1',
      name: 'Project 1',
      description: 'Test project description',
      workspacePath: 'C:/Workspaces/1',
    });

    const task = storage.agentTasks.create({
      id: 'task-100',
      projectId: 'proj-1',
      title: 'Refactor database module',
    });

    expect(task.state).toBe('created');
    expect(task.stepStatus).toBe('idle');
    expect(task.attemptCount).toBe(0);
    expect(task.errorCategory).toBeNull();

    const updated = storage.agentTasks.updateState('task-100', {
      state: 'planning',
      currentStep: 'Step 1: Analyse schema',
      stepStatus: 'active',
      attemptCount: 1,
    });
    expect(updated).toBe(true);

    const retrieved = storage.agentTasks.findById('task-100');
    expect(retrieved?.state).toBe('planning');
    expect(retrieved?.currentStep).toBe('Step 1: Analyse schema');
    expect(retrieved?.stepStatus).toBe('active');
  });

  it('persists settings configuration metadata', () => {
    storage.settings.set('theme', 'dark');
    storage.settings.set('telemetry', 'false');

    expect(storage.settings.get('theme')).toBe('dark');
    expect(storage.settings.get('telemetry')).toBe('false');

    // Test upsert
    storage.settings.set('theme', 'light');
    expect(storage.settings.get('theme')).toBe('light');

    const all = storage.settings.listAll();
    expect(all).toHaveLength(2);
  });
});
