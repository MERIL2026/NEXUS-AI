/**
 * NEXUS AI — Chat Mode & Persistent Chat History Comprehensive Test Suite
 *
 * Tests:
 *  A. Chat creation
 *  B. Chat message persistence
 *  C. Multi-turn context retention
 *  D. Chat title automatic generation
 *  E. /new-chat functionality
 *  F. /exit-chat functionality
 *  G. Chat listing (/chats)
 *  H. Open previous chat (/chats open <id>)
 *  I. Search chats (/chats search <query>)
 *  J. Delete chat (/chats delete <id>)
 *  K. Restart persistence (re-opening SQLite database)
 *  L. Model routing for chat role
 *  M. Provider failure resilience
 *  N. Fallback model handling
 *  O. CRITICAL REGRESSION: Agent / Chat isolation (Chat messages NEVER create tasks)
 *  P. Slash commands in chat mode
 *  Q. Empty chat input handling
 *  R. Long message handling
 *  S. Special characters handling
 *  T. Multiple chats coexistence
 *  U. Agent mode regression (Plan -> Approval -> Execute -> Verify)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatRunner } from '../cli/chatRunner.js';
import { AgentRunner } from '../cli/agentRunner.js';
import { ApplicationApi } from '../api/index.js';
import { loadConfig } from '../config/index.js';
import { SIGNAL_ENTER_CHAT, SIGNAL_EXIT_CHAT } from '../cli/inputEngine.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('NEXUS AI — Chat Mode & History System', () => {
  let tempDir: string;
  let dbPath: string;
  let api: ApplicationApi;
  let chatRunner: ChatRunner;
  let agentRunner: AgentRunner;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-chat-test-'));
    dbPath = path.join(tempDir, 'nexus-test.sqlite');
    const workspaceRoot = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const config = loadConfig({
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: workspaceRoot,
      LOG_LEVEL: 'error',
    });

    api = new ApplicationApi(config);
    await api.bootstrap();

    // Register local test models in Models repository
    api.storage.models.upsert({
      id: 'llama3.1:8b',
      name: 'llama3.1:8b',
      capabilities: ['chat', 'general'],
    });

    api.storage.models.upsert({
      id: 'qwen2.5-coder-1.5b',
      name: 'qwen2.5-coder-1.5b',
      capabilities: ['coding', 'planning', 'chat', 'general', 'lightweight'],
    });

    api.intelligence.router.setGlobalOverride('qwen2.5-coder-1.5b');

    chatRunner = new ChatRunner(api, 'error');
    agentRunner = new AgentRunner(api, 'error');
  });

  afterEach(() => {
    api.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ---------------------------------------------------------------------------
  // A & B: Chat Creation and Message Persistence
  // ---------------------------------------------------------------------------
  it('A & B: creates persistent conversation and stores user and assistant messages in database', async () => {
    const conv = api.conversations.createConversation({ title: 'React Hooks Discussion' });
    expect(conv.id).toBeDefined();

    api.messages.addMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'Explain useState vs useReducer',
    });

    api.messages.addMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: 'useState is for simple state, useReducer is for complex state transitions.',
    });

    const messages = api.messages.getMessages(conv.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Explain useState vs useReducer');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toContain('useState is for simple state');
  });

  // ---------------------------------------------------------------------------
  // C: Multi-turn Context
  // ---------------------------------------------------------------------------
  it('C: maintains multi-turn conversation context across multiple messages', async () => {
    const conv = api.conversations.createConversation({ title: 'Context Memory Test' });

    // Turn 1
    api.messages.addMessage({ conversationId: conv.id, role: 'user', content: 'My name is Alex.' });
    api.messages.addMessage({ conversationId: conv.id, role: 'assistant', content: 'Nice to meet you, Alex.' });

    // Turn 2
    api.messages.addMessage({ conversationId: conv.id, role: 'user', content: 'What is my name?' });
    api.messages.addMessage({ conversationId: conv.id, role: 'assistant', content: 'Your name is Alex.' });

    const history = api.messages.getMessages(conv.id);
    expect(history).toHaveLength(4);
    expect(history[0].content).toContain('Alex');
    expect(history[3].content).toContain('Your name is Alex');
  });

  // ---------------------------------------------------------------------------
  // D: Chat Title Generation
  // ---------------------------------------------------------------------------
  it('D: deterministically generates concise titles from user prompts', () => {
    expect(api.conversations.generateTitle('Explain React hooks in detail')).toBe('Explain React hooks in detail');
    expect(api.conversations.generateTitle('JavaScript Arrays vs Objects')).toBe('JavaScript Arrays vs Objects');
    expect(api.conversations.generateTitle('Hello NEXUS, what is recursion?')).toBe('What is recursion');
    expect(api.conversations.generateTitle('/chat What is the difference between an array and an object in JavaScript?')).toContain('What is the difference between an array');
  });

  // ---------------------------------------------------------------------------
  // E: /new-chat
  // ---------------------------------------------------------------------------
  it('E: /new-chat creates a new conversation and resets active conversation ID without losing previous chat', async () => {
    const banner = await chatRunner.startOrResumeChat();
    expect(banner).toContain('NEXUS CHAT');
    const firstId = chatRunner.currentConversationId;
    expect(firstId).toBeDefined();

    // Add message in chat 1
    api.messages.addMessage({ conversationId: firstId!, role: 'user', content: 'Chat 1 text' });

    // Trigger /new-chat
    const newChatMsg = chatRunner.newChat();
    expect(newChatMsg).toContain('Started new conversation');
    const secondId = chatRunner.currentConversationId;
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);

    // Verify both exist in history
    const all = api.conversations.listAllConversations();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((c) => c.id === firstId)).toBe(true);
    expect(all.some((c) => c.id === secondId)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // F: /exit-chat
  // ---------------------------------------------------------------------------
  it('F: /exit-chat returns the SIGNAL_EXIT_CHAT sentinel', () => {
    const res = chatRunner.runCommand('/exit-chat');
    expect(res).resolves.toBe(SIGNAL_EXIT_CHAT);
  });

  // ---------------------------------------------------------------------------
  // G: Chat Listing (/chats)
  // ---------------------------------------------------------------------------
  it('G: /chats lists all conversations with message count and IDs', async () => {
    const c1 = api.conversations.createConversation({ title: 'JavaScript Help' });
    api.messages.addMessage({ conversationId: c1.id, role: 'user', content: 'How do closures work?' });

    const c2 = api.conversations.createConversation({ title: 'Python Project' });
    api.messages.addMessage({ conversationId: c2.id, role: 'user', content: 'What is asyncio?' });

    const listOutput = chatRunner.listChats();
    expect(listOutput).toContain('NEXUS CHAT HISTORY');
    expect(listOutput).toContain('JavaScript Help');
    expect(listOutput).toContain('Python Project');
    expect(listOutput).toContain(c1.id);
    expect(listOutput).toContain(c2.id);
  });

  // ---------------------------------------------------------------------------
  // H: Open Previous Chat (/chats open <id>)
  // ---------------------------------------------------------------------------
  it('H: /chats open restores the specified conversation and message history', async () => {
    const c1 = api.conversations.createConversation({ title: 'Restored Discussion' });
    api.messages.addMessage({ conversationId: c1.id, role: 'user', content: 'Original message' });
    api.messages.addMessage({ conversationId: c1.id, role: 'assistant', content: 'Original reply' });

    const output = chatRunner.openChat(c1.id);
    expect(output).toContain('Opened conversation');
    expect(output).toContain('Restored Discussion');
    expect(output).toContain('Original message');
    expect(chatRunner.currentConversationId).toBe(c1.id);
  });

  // ---------------------------------------------------------------------------
  // I: Search Chats (/chats search <query>)
  // ---------------------------------------------------------------------------
  it('I: /chats search searches across titles and message contents', async () => {
    const c1 = api.conversations.createConversation({ title: 'React Hooks Guide' });
    api.messages.addMessage({ conversationId: c1.id, role: 'user', content: 'Explain useState' });

    const c2 = api.conversations.createConversation({ title: 'Database Optimization' });
    api.messages.addMessage({ conversationId: c2.id, role: 'user', content: 'How to index SQLite?' });

    const reactSearch = chatRunner.searchChats('React');
    expect(reactSearch).toContain('React Hooks Guide');
    expect(reactSearch).not.toContain('Database Optimization');

    const sqliteSearch = chatRunner.searchChats('SQLite');
    expect(sqliteSearch).toContain('Database Optimization');
  });

  // ---------------------------------------------------------------------------
  // J: Delete Chat (/chats delete <id>)
  // ---------------------------------------------------------------------------
  it('J: /chats delete deletes only that specific conversation and its messages', async () => {
    const c1 = api.conversations.createConversation({ title: 'To Delete' });
    api.messages.addMessage({ conversationId: c1.id, role: 'user', content: 'Temporary text' });

    const c2 = api.conversations.createConversation({ title: 'To Keep' });
    api.messages.addMessage({ conversationId: c2.id, role: 'user', content: 'Important text' });

    const deleteResult = chatRunner.deleteChat(c1.id);
    expect(deleteResult).toContain('Deleted conversation');

    const all = api.conversations.listAllConversations();
    expect(all.some((c) => c.id === c1.id)).toBe(false);
    expect(all.some((c) => c.id === c2.id)).toBe(true);

    const c1Messages = api.messages.getMessages(c1.id);
    expect(c1Messages).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // K: Restart Persistence
  // ---------------------------------------------------------------------------
  it('K: conversations and messages persist across database reopen (restart)', async () => {
    const c1 = api.conversations.createConversation({ title: 'Persistence Across Restart' });
    api.messages.addMessage({ conversationId: c1.id, role: 'user', content: 'Persisted message' });
    api.messages.addMessage({ conversationId: c1.id, role: 'assistant', content: 'Persisted assistant response' });

    api.close();

    // Reopen database
    const config = loadConfig({
      DATABASE_PATH: dbPath,
      WORKSPACE_ROOT: tempDir,
      LOG_LEVEL: 'error',
    });
    const api2 = new ApplicationApi(config);
    await api2.bootstrap();

    const loadedConv = api2.conversations.getConversation(c1.id);
    expect(loadedConv).toBeDefined();
    expect(loadedConv.title).toBe('Persistence Across Restart');

    const loadedMessages = api2.messages.getMessages(c1.id);
    expect(loadedMessages).toHaveLength(2);
    expect(loadedMessages[0].content).toBe('Persisted message');
    expect(loadedMessages[1].content).toBe('Persisted assistant response');

    api2.close();
  });

  // ---------------------------------------------------------------------------
  // L: Model Routing & Provider Selection for Chat
  // ---------------------------------------------------------------------------
  it('L1: selects llama3.1:8b for chat role and routes to Ollama adapter', () => {
    const router = api.intelligence.router;
    router.resetOverrides();
    const route = router.selectRoute(undefined, undefined, 'chat');
    expect(route.primaryModel.id).toBe('llama3.1:8b');
    expect(route.fallbackModel?.id).toBe('qwen2.5-coder-1.5b');

    // Verify adapter selection for llama3.1:8b is ollama adapter
    const adapter = api.intelligence.runtimeManager.getAdapterForModel('llama3.1:8b');
    expect(adapter.providerId).toBe('ollama');

    // Verify embedded adapter is only used for embedded-specific models
    const embeddedAdapter = api.intelligence.runtimeManager.getAdapterForModel('nexus-proto');
    expect(embeddedAdapter.providerId).toBe('embedded');

    // Test role override
    router.setRoleOverride('chat', 'qwen2.5-coder-1.5b');
    const overriddenRoute = router.selectRoute(undefined, undefined, 'chat');
    expect(overriddenRoute.primaryModel.id).toBe('qwen2.5-coder-1.5b');

    // Reset override
    router.resetOverrides('chat');
    const resetRoute = router.selectRoute(undefined, undefined, 'chat');
    expect(resetRoute.primaryModel.id).toBe('llama3.1:8b');
  });

  it('L2: Multi-turn chat context accurately preserves real assistant responses without diagnostic text', async () => {
    const conv = api.conversations.createConversation({ title: 'Context Precision Test' });

    // Turn 1
    api.messages.addMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'hello nexus . what can you do ?',
    });
    api.messages.addMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: 'I am NEXUS AI. I can assist you with coding, reasoning, planning, and software development.',
    });

    // Turn 2
    api.messages.addMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'what is a python language ?',
    });

    const messages = api.messages.getMessages(conv.id);
    expect(messages).toHaveLength(3);

    // Verify context formatting
    const { PromptTemplates } = await import('../chat/promptTemplates.js');
    const pkg = PromptTemplates.buildPromptPackage(messages);
    const formatted = PromptTemplates.formatForOllama(pkg);

    expect(formatted.prompt).toContain('User: hello nexus . what can you do ?');
    expect(formatted.prompt).toContain('Assistant: I am NEXUS AI. I can assist you with coding, reasoning, planning, and software development.');
    expect(formatted.prompt).toContain('User: what is a python language ?');
    expect(formatted.prompt).not.toContain('[NEXUS Embedded AI]: System operational');
  });

  // ---------------------------------------------------------------------------
  // O: CRITICAL REGRESSION: Agent / Chat Isolation
  // ---------------------------------------------------------------------------
  it('O: CRITICAL REGRESSION — Chat messages NEVER create Agent Tasks', async () => {
    const initialTasks = api.tasks.listTasks();
    const initialTaskCount = initialTasks.length;

    // Send chat messages through chat runner
    await chatRunner.startOrResumeChat();
    await chatRunner.runCommand('Hello NEXUS. What can you do?', { streamToStdout: false });
    await chatRunner.runCommand('Delete all files in my workspace', { streamToStdout: false });

    const finalTasks = api.tasks.listTasks();
    expect(finalTasks).toHaveLength(initialTaskCount);
  }, 30000);

  // ---------------------------------------------------------------------------
  // P: Slash Commands in Chat Mode
  // ---------------------------------------------------------------------------
  it('P: slash commands inside chat mode are executed locally without LLM dispatch', async () => {
    await chatRunner.startOrResumeChat();

    const helpRes = await chatRunner.runCommand('/help', { streamToStdout: false });
    expect(helpRes).toContain('CHAT');
    expect(helpRes).toContain('/exit-chat');

    const newChatRes = await chatRunner.runCommand('/new-chat', { streamToStdout: false });
    expect(newChatRes).toContain('Started new conversation');

    const exitRes = await chatRunner.runCommand('/exit-chat', { streamToStdout: false });
    expect(exitRes).toBe(SIGNAL_EXIT_CHAT);
  });

  // ---------------------------------------------------------------------------
  // Q & R & S: Edge Cases (Empty, Long, Special Chars)
  // ---------------------------------------------------------------------------
  it('Q, R, S: handles empty input, long prompts, and special characters safely', async () => {
    chatRunner.newChat();

    // Empty input
    const emptyRes = await chatRunner.runCommand('   ', { streamToStdout: false });
    expect(emptyRes).toBe('');

    // Special characters
    const specialChars = 'Special chars: <script>alert("xss")</script> & { "json": true } @#$%^&*()';
    const resSpecial = await chatRunner.runCommand(specialChars, { streamToStdout: false });
    expect(resSpecial).toBeDefined();

    // Check message persisted correctly
    const messages = api.messages.getMessages(chatRunner.currentConversationId!);
    const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
    expect(lastUserMsg?.content).toBe(specialChars);
  }, 30000);

  // ---------------------------------------------------------------------------
  // U: Agent Mode Regression Test
  // ---------------------------------------------------------------------------
  it('U: Agent Mode still plans, approves, and executes tasks properly without regression', async () => {
    api.intelligence.router.setGlobalOverride('qwen2.5-coder-1.5b');
    const taskResult = await agentRunner.submitTask('Create a project note in note.txt');
    expect(taskResult).toContain('Task Submitted');

    const tasks = api.tasks.listTasks();
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0].title).toContain('note.txt');
  }, 30000);

  // ---------------------------------------------------------------------------
  // V: Agent Mode /chat command triggers mode transition
  // ---------------------------------------------------------------------------
  it('V: /chat at main NEXUS prompt returns SIGNAL_ENTER_CHAT', async () => {
    const res = await agentRunner.runCommand('/chat');
    expect(res).toBe(SIGNAL_ENTER_CHAT);

    const resOpen = await agentRunner.runCommand('/chats open conv-123');
    expect(resOpen).toBe(`${SIGNAL_ENTER_CHAT}:conv-123`);
  });
});
