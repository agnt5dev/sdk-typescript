import { describe, it, expect } from 'vitest';
import { ContextImpl } from '../context.js';
import { WaitingForUserInputError, isWaitingForUserInput } from '../errors.js';

describe('Human-in-the-Loop', () => {
  it('should throw WaitingForUserInputError on first waitForUser call', async () => {
    const ctx = new ContextImpl('inv-1', 'run-hitl-1', 0, 'test', { storage: 'memory' });

    try {
      await ctx.waitForUser('What is your name?');
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(isWaitingForUserInput(error)).toBe(true);
      const hitlErr = error as WaitingForUserInputError;
      expect(hitlErr.question).toBe('What is your name?');
      expect(hitlErr.runId).toBe('run-hitl-1');
      expect(hitlErr.inputType).toBe('text');
      expect(hitlErr.pauseIndex).toBe(0);
    }
  });

  it('should return cached response on resume', async () => {
    const ctx = new ContextImpl('inv-2', 'run-hitl-2', 0, 'test', { storage: 'memory' });

    // Simulate platform storing user response
    await ctx.setUserResponse(0, 'Alice');

    // Now waitForUser should return the cached response
    const response = await ctx.waitForUser('What is your name?');
    expect(response).toBe('Alice');
  });

  it('should support approval input type with options', async () => {
    const ctx = new ContextImpl('inv-3', 'run-hitl-3', 0, 'test', { storage: 'memory' });

    try {
      await ctx.waitForUser('Approve deployment?', {
        inputType: 'approval',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      const hitlErr = error as WaitingForUserInputError;
      expect(hitlErr.inputType).toBe('approval');
      expect(hitlErr.options).toHaveLength(2);
      expect(hitlErr.options[0].id).toBe('approve');
    }
  });

  it('should increment pauseIndex for multiple HITL steps', async () => {
    const ctx = new ContextImpl('inv-4', 'run-hitl-4', 0, 'test', { storage: 'memory' });

    // Store responses for first two pauses
    await ctx.setUserResponse(0, 'Alice');
    await ctx.setUserResponse(1, 'Engineering');

    // First wait returns cached response
    const name = await ctx.waitForUser('What is your name?');
    expect(name).toBe('Alice');

    // Second wait also returns cached response
    const dept = await ctx.waitForUser('What department?');
    expect(dept).toBe('Engineering');

    // Third wait should throw (no cached response)
    try {
      await ctx.waitForUser('What is your role?');
      expect.unreachable('Should have thrown');
    } catch (error) {
      const hitlErr = error as WaitingForUserInputError;
      expect(hitlErr.pauseIndex).toBe(2);
      expect(hitlErr.stepName).toBe('wait_for_user_2');
    }
  });

  it('should return null for skipped responses', async () => {
    const ctx = new ContextImpl('inv-5', 'run-hitl-5', 0, 'test', { storage: 'memory' });

    // Simulate user skipping
    await ctx.setUserResponse(0, null);

    const result = await ctx.waitForUser('Optional feedback?', { skippable: true });
    expect(result).toBeNull();
  });

  it('should carry allowCustom and skippable flags', async () => {
    const ctx = new ContextImpl('inv-6', 'run-hitl-6', 0, 'test', { storage: 'memory' });

    try {
      await ctx.waitForUser('Pick a color', {
        inputType: 'select',
        options: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }],
        allowCustom: true,
        skippable: true,
      });
    } catch (error) {
      const hitlErr = error as WaitingForUserInputError;
      expect(hitlErr.allowCustom).toBe(true);
      expect(hitlErr.skippable).toBe(true);
    }
  });

  it('WaitingForUserInputError should have backward-compat prompt/choices getters', () => {
    const err = new WaitingForUserInputError({
      runId: 'run-1',
      question: 'Choose one',
      inputType: 'select',
      options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
    });

    expect(err.prompt).toBe('Choose one');
    expect(err.choices).toEqual(['Option A', 'Option B']);
  });
});
