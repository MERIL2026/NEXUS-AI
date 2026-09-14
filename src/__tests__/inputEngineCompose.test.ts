/**
 * NEXUS AI — InputEngine Compose Mode & Multiline Input Unit Tests
 *
 * Direct focused unit tests for InputEngine covering compose mode (/prompt, /send, /cancel),
 * multiline buffer accumulation, clipboard paste handling, initial text capture, and approval bypass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InputEngine } from '../cli/inputEngine.js';

describe('P7-F.1 — InputEngine Compose Mode & Multiline Input', () => {
  let submittedInputs: string[];
  let awaitingApproval: boolean;
  let engine: InputEngine;

  beforeEach(() => {
    submittedInputs = [];
    awaitingApproval = false;

    engine = new InputEngine({
      onInput: async (text: string) => {
        submittedInputs.push(text);
      },
      isAwaitingApproval: () => awaitingApproval,
      debounceMs: 10,
    });
  });

  afterEach(() => {
    engine.close();
  });

  // 1. /prompt enters compose mode
  it('1. /prompt enters compose mode', () => {
    expect(engine.getMode()).toBe('normal');
    engine.processInput('/prompt');
    expect(engine.getMode()).toBe('compose');
  });

  // 2-4. first, second, third lines stored and appended in order
  it('2-4. stores and appends multiple lines in compose buffer', () => {
    engine.processInput('/prompt');
    engine.processInput('First line');
    engine.processInput('Second line');
    engine.processInput('Third line');

    expect(engine.getComposeBuffer()).toEqual(['First line', 'Second line', 'Third line']);
  });

  // 5. multiline buffer preserves order
  it('5. multiline buffer preserves exact sequence order', () => {
    engine.processInput('/prompt');
    engine.processInput('Step 1');
    engine.processInput('Step 2');
    engine.processInput('Step 3');
    engine.processInput('Step 4');

    expect(engine.getComposeBuffer()).toEqual(['Step 1', 'Step 2', 'Step 3', 'Step 4']);
  });

  // 6 & 7. multiline buffer preserves newline characters and /send submits complete buffer
  it('6 & 7. /send submits complete buffer with preserved newline characters', async () => {
    engine.processInput('/prompt');
    engine.processInput('Line 1');
    engine.processInput('Line 2');
    engine.processInput('Line 3');
    engine.processInput('/send');

    // Allow async dispatchInput
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(submittedInputs).toHaveLength(1);
    expect(submittedInputs[0]).toBe('Line 1\nLine 2\nLine 3');
    expect(engine.getMode()).toBe('normal');
  });

  // 8. /send doesn't appear in buffer
  it("8. /send command does not appear in submitted task goal", async () => {
    engine.processInput('/prompt');
    engine.processInput('Build API');
    engine.processInput('/send');

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(submittedInputs[0]).not.toContain('/send');
    expect(submittedInputs[0]).toBe('Build API');
  });

  // 9. /cancel clears buffer without submitting task
  it('9. /cancel discards buffer and exits compose mode without creating a task', async () => {
    engine.processInput('/prompt');
    engine.processInput('Line to discard');
    engine.processInput('/cancel');

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(submittedInputs).toHaveLength(0);
    expect(engine.getMode()).toBe('normal');
    expect(engine.getComposeBuffer()).toEqual([]);
  });

  // 10. /prompt <text> stores initial text
  it('10. /prompt <text> enters compose mode and stores initial text', () => {
    engine.processInput('/prompt Build a calculator webpage');
    expect(engine.getMode()).toBe('compose');
    expect(engine.getComposeBuffer()).toEqual(['Build a calculator webpage']);
  });

  // 11. subsequent lines append to initial text
  it('11. subsequent lines append to initial text from /prompt <text>', async () => {
    engine.processInput('/prompt Build a calculator webpage');
    engine.processInput('Create index.html');
    engine.processInput('Create style.css');
    engine.processInput('/send');

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(submittedInputs[0]).toBe('Build a calculator webpage\nCreate index.html\nCreate style.css');
  });

  // 12. multiline paste produces one buffer
  it('12. multiline paste starting with /prompt produces single complete buffer', async () => {
    const pasteContent = [
      '/prompt Build calculator',
      'Create index.html',
      'Create style.css',
      '/send',
    ].join('\n');

    engine.processInput(pasteContent);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(submittedInputs).toHaveLength(1);
    expect(submittedInputs[0]).toBe('Build calculator\nCreate index.html\nCreate style.css');
  });

  // 13. empty lines don't accidentally terminate compose mode
  it('13. empty lines are preserved and do not terminate compose mode', () => {
    engine.processInput('/prompt Header section');
    engine.processInput('');
    engine.processInput('Footer section');

    expect(engine.getMode()).toBe('compose');
    expect(engine.getComposeBuffer()).toEqual(['Header section', '', 'Footer section']);
  });

  // 14 & 15. final line is not duplicated and not used instead of buffer
  it('14 & 15. final line before /send is not duplicated or used as sole buffer content', async () => {
    engine.processInput('/prompt Initial goal');
    engine.processInput('Middle line');
    engine.processInput('Final line');
    engine.processInput('/send');

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(submittedInputs[0]).toBe('Initial goal\nMiddle line\nFinal line');
    expect(submittedInputs[0]).not.toBe('Final line');
    expect(submittedInputs[0].match(/Final line/g)?.length).toBe(1);
  });

  // 16. normal mode still works
  it('16. single-line input in normal mode dispatches as single task after debounce', async () => {
    engine.processInput('Simple normal task');

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(submittedInputs).toEqual(['Simple normal task']);
    expect(engine.getMode()).toBe('normal');
  });

  // 17. approval Y/N/V behavior still works
  it('17. approval inputs (y/n/v) bypass paste debounce when task is awaiting approval', async () => {
    awaitingApproval = true;
    engine.processInput('y');

    // Immediate dispatch without waiting for debounce timer
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(submittedInputs).toEqual(['y']);
  });

  // CRITICAL REGRESSION TEST — exact bug reported by user
  it('CRITICAL BUG TEST — /prompt + multiline lines + /send submits COMPLETE prompt, NOT last line', async () => {
    engine.processInput('/prompt Build a simple working calculator webpage using HTML, CSS and JavaScript.');
    engine.processInput('Create a folder named final-calculator-test in the NEXUS workspace.');
    engine.processInput('Create:');
    engine.processInput('- index.html');
    engine.processInput('- style.css');
    engine.processInput('- script.js');
    engine.processInput('Make the calculator functional with +, -, ×, ÷, %, clear, delete and equals.');
    engine.processInput('After creating it, verify all three files exist and verify index.html references both CSS and JavaScript.');
    engine.processInput('Do not use any frameworks.');
    engine.processInput('/send');

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(submittedInputs).toHaveLength(1);

    const submittedGoal = submittedInputs[0];

    // MUST NOT be just the last line
    expect(submittedGoal).not.toBe('Do not use any frameworks.');

    // MUST contain all parts of the multiline prompt
    expect(submittedGoal).toContain('Build a simple working calculator webpage using HTML, CSS and JavaScript.');
    expect(submittedGoal).toContain('Create a folder named final-calculator-test in the NEXUS workspace.');
    expect(submittedGoal).toContain('- index.html');
    expect(submittedGoal).toContain('- style.css');
    expect(submittedGoal).toContain('- script.js');
    expect(submittedGoal).toContain('Make the calculator functional with');
    expect(submittedGoal).toContain('After creating it, verify all three files exist');
    expect(submittedGoal).toContain('Do not use any frameworks.');

    const expectedFullText = [
      'Build a simple working calculator webpage using HTML, CSS and JavaScript.',
      'Create a folder named final-calculator-test in the NEXUS workspace.',
      'Create:',
      '- index.html',
      '- style.css',
      '- script.js',
      'Make the calculator functional with +, -, ×, ÷, %, clear, delete and equals.',
      'After creating it, verify all three files exist and verify index.html references both CSS and JavaScript.',
      'Do not use any frameworks.',
    ].join('\n');

    expect(submittedGoal).toBe(expectedFullText);
  });
});
