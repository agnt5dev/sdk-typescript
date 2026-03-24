/**
 * Example: Human-in-the-Loop (HITL) workflows
 *
 * Demonstrates pausing workflows for user input using different input types.
 */

import { fn, workflow, ContextImpl, WaitingForUserInputError } from '../src/index.js';

// ─── 1. Text input ──────────────────────────────────────────────────

const askName = fn('ask-name', {
  description: 'Ask user for their name',
  handler: async (ctx) => {
    const name = await ctx.waitForUser('What is your name?', {
      inputType: 'text',
    });
    return `Hello, ${name}!`;
  },
});

// ─── 2. Approval flow ──────────────────────────────────────────────

const approveDeployment = fn('approve-deployment', {
  description: 'Request deployment approval',
  handler: async (ctx) => {
    const approved = await ctx.waitForUser(
      'Deploy v2.1.0 to production?',
      {
        inputType: 'approval',
        skippable: false,
      },
    );
    return approved === 'approved' ? 'Deploying...' : 'Deployment cancelled.';
  },
});

// ─── 3. Select from options ─────────────────────────────────────────

const chooseRegion = fn('choose-region', {
  description: 'Let user choose deployment region',
  handler: async (ctx) => {
    const region = await ctx.waitForUser('Select deployment region:', {
      inputType: 'select',
      options: [
        { id: 'us-east-1', label: 'US East (Virginia)' },
        { id: 'eu-west-1', label: 'EU West (Ireland)' },
        { id: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
      ],
    });
    return `Deploying to ${region}`;
  },
});

// ─── 4. Multi-step HITL workflow ────────────────────────────────────

const onboardingWorkflow = workflow('onboarding', {
  description: 'Multi-step user onboarding with HITL',
  handler: async (ctx, input) => {
    // Step 1: Get user info
    const name = await ctx.waitForUser('What is your name?', {
      inputType: 'text',
    });

    // Step 2: Choose plan
    const plan = await ctx.waitForUser(`Welcome ${name}! Choose your plan:`, {
      inputType: 'select',
      options: [
        { id: 'free', label: 'Free - Basic features' },
        { id: 'pro', label: 'Pro - $29/mo' },
        { id: 'enterprise', label: 'Enterprise - Contact us' },
      ],
    });

    // Step 3: Confirm
    const confirmed = await ctx.waitForUser(
      `Confirm: ${name} on ${plan} plan?`,
      { inputType: 'approval' },
    );

    return {
      name,
      plan,
      confirmed: confirmed === 'approved',
      status: confirmed === 'approved' ? 'active' : 'cancelled',
    };
  },
});

// ─── Running locally (simulation) ───────────────────────────────────

async function simulateHITL() {
  const ctx = new ContextImpl('sim-1', 'run-1', 0, 'hitl-demo', {
    storage: 'memory',
    checkpointData: {},
  });

  // First call: will throw WaitingForUserInputError
  try {
    await askName.handler(ctx);
  } catch (error) {
    if (error instanceof WaitingForUserInputError) {
      console.log(`HITL pause: "${error.question}" (type: ${error.inputType})`);

      // Simulate user response
      ctx.setUserResponse(error.pauseIndex, 'Alice');

      // Resume: will get the cached response
      const result = await askName.handler(ctx);
      console.log('Result:', result);
    }
  }
}

simulateHITL().catch(console.error);
