# Agent Component

## What is an Agent?

An **Agent** in AGNT5 is an autonomous LLM-driven system that can reason, plan, and execute tasks using tools. Agents orchestrate complex multi-step workflows by breaking down problems, selecting appropriate tools, and iterating until tasks are complete. Agents combine language models, tools, memory, and sessions to deliver intelligent, context-aware interactions.

**Key Characteristics:**
- **LLM-Powered**: Driven by language models for reasoning and decision-making
- **Tool Orchestration**: Automatically selects and executes appropriate tools
- **Memory Integration**: Maintains long-term knowledge across conversations
- **Session Aware**: Uses sessions for conversation context and multi-agent coordination
- **Streaming Support**: Real-time event streaming for responsive UX
- **Durable by Default**: Built on AGNT5 primitives for automatic fault tolerance

## Why are Agents Needed?

### 1. Autonomous Task Execution

Agents break down complex tasks and execute them autonomously:

```typescript
import { Agent, LanguageModel, tool } from 'agnt5';

interface Paper {
  title: string;
  url: string;
  authors: string[];
}

const searchPapers = tool({
  name: 'search_papers',
  description: 'Search academic papers.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' }
    },
    required: ['query']
  },
  execute: async ({ query }: { query: string }): Promise<Paper[]> => {
    // Implementation
    return [];
  }
});

const analyzePaper = tool({
  name: 'analyze_paper',
  description: 'Analyze paper content.',
  parameters: {
    type: 'object',
    properties: {
      paperUrl: { type: 'string' }
    },
    required: ['paperUrl']
  },
  execute: async ({ paperUrl }: { paperUrl: string }): Promise<object> => {
    // Implementation
    return {};
  }
});

const lm = new LanguageModel();
const agent = new Agent({
  name: 'researcher',
  model: lm,
  instructions: 'You are a research assistant. Break down complex research tasks.',
  tools: {
    searchPapers,
    analyzePaper
  }
});

// Agent autonomously:
// 1. Searches for relevant papers
// 2. Analyzes each paper
// 3. Synthesizes findings
const result = await agent.run('Summarize recent work on transformer architectures');
```

### 2. Multi-Step Reasoning with Tools

Agents chain tool calls based on reasoning:

```typescript
// Agent decides tool execution order based on context
const agent = new Agent({
  name: 'analyst',
  model: lm,
  tools: {
    searchWeb,
    fetchStockData,
    calculateMetrics,
    generateChart
  },
  instructions: 'Analyze companies thoroughly before making recommendations.'
});

const result = await agent.run('Should I invest in Tesla?');

// Agent's reasoning chain:
// 1. searchWeb("Tesla recent news")
// 2. fetchStockData("TSLA")
// 3. calculateMetrics(stock_data)
// 4. generateChart(metrics)
// 5. Synthesize analysis and recommendation
```

### 3. Multi-Agent Collaboration

Multiple specialized agents work together on complex tasks:

```typescript
import { Session } from 'agnt5';

// Shared session for agent coordination
const session = new Session({
  id: 'code-review-123',
  userId: 'developer-456'
});

// Specialized agents
const codeAnalyzer = new Agent({
  name: 'analyzer',
  model: lm,
  tools: {
    lintTool,
    complexityTool
  },
  session
});

const securityChecker = new Agent({
  name: 'security',
  model: lm,
  tools: {
    vulnScanTool,
    dependencyCheckTool
  },
  session
});

// Agents share context through session
const analysis = await codeAnalyzer.run('Analyze code quality');
const security = await securityChecker.run('Check for security issues');
// Both agents see shared context and each other's findings
```

## How to Use Agents

### Basic Agent Creation

```typescript
import { Agent, LanguageModel } from 'agnt5';

const lm = new LanguageModel();

const agent = new Agent({
  name: 'assistant',
  model: lm,
  instructions: 'You are a helpful coding assistant.'
});

// Simple agent without tools
const result = await agent.run('Explain recursion');
console.log(result.output);
```

### Agent with Tools

```typescript
import { Agent, tool } from 'agnt5';

interface DocResult {
  title: string;
  url: string;
  snippet: string;
}

const searchDocs = tool({
  name: 'search_docs',
  description: 'Search programming language documentation.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      language: { type: 'string', default: 'python' }
    },
    required: ['query']
  },
  execute: async ({ query, language = 'python' }: {
    query: string;
    language?: string
  }): Promise<DocResult[]> => {
    // Implementation
    return [];
  }
});

const runCode = tool({
  name: 'run_code',
  description: 'Execute code and return output.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      language: { type: 'string', default: 'python' }
    },
    required: ['code']
  },
  execute: async ({ code, language = 'python' }: {
    code: string;
    language?: string
  }): Promise<{ output: string; error?: string }> => {
    // Implementation
    return { output: '' };
  }
});

const agent = new Agent({
  name: 'coding_assistant',
  model: lm,
  instructions: `You are a coding assistant. Help users write and test code.
    Use search_docs to find API references.
    Use run_code to test code examples.`,
  tools: {
    searchDocs,
    runCode
  }
});

const result = await agent.run('How do I read a file in Python? Show me an example.');
// Agent searches docs, generates example, tests it with run_code
```

### Agent with Session and Memory

```typescript
import { Agent, Session, Memory, LanguageModel } from 'agnt5';

// Create session for conversation
const session = new Session({
  id: 'tutoring-session-789',
  userId: 'student-123',
  metadata: { subject: 'mathematics' }
});

// Create memory for long-term knowledge
const memory = new Memory({ service: new VectorMemoryService() });
await memory.store('student_level', 'Advanced calculus, struggles with proofs');

// Create agent with context
const lm = new LanguageModel();
const agent = new Agent({
  name: 'math_tutor',
  model: lm,
  instructions: 'You are a patient math tutor. Adapt to student\'s level.',
  tools: {
    solveEquationTool,
    plotFunctionTool
  },
  session,
  memory
});

// Agent uses memory and session for personalized tutoring
const result = await agent.run('Help me understand the epsilon-delta definition');
// Agent recalls student level from memory
// Agent maintains conversation in session
```

### Streaming Agent Responses

```typescript
for await (const event of agent.stream('Analyze this large dataset', { session })) {
  switch (event.type) {
    case 'thinking':
      console.log(`🤔 ${event.content}`);
      break;
    case 'tool_call':
      console.log(`🔧 Calling ${event.toolName}(${JSON.stringify(event.arguments)})`);
      break;
    case 'tool_result':
      console.log(`✓ Result: ${JSON.stringify(event.result)}`);
      break;
    case 'response':
      console.log(`💬 ${event.content}`);
      break;
    case 'error':
      console.log(`❌ Error: ${event.error}`);
      break;
  }
}
```

### Agent Planning

Preview what an agent will do before execution:

```typescript
// Get execution plan without running
const plan = await agent.plan('Analyze competitor pricing strategies');

console.log(`Estimated steps: ${plan.steps.length}`);
for (const step of plan.steps) {
  console.log(`- ${step.type}: ${step.description}`);
  if (step.tool) {
    console.log(`  Tool: ${step.tool.name}`);
  }
}

// Review plan, then execute if approved
if (userApproves(plan)) {
  const result = await agent.run('Analyze competitor pricing strategies');
}
```

## Common Patterns

### Research Agent Pattern

```typescript
import { Agent, Session, Memory, tool } from 'agnt5';

interface AcademicPaper {
  title: string;
  authors: string[];
  year: number;
  abstract: string;
}

const searchAcademic = tool({
  name: 'search_academic',
  description: 'Search academic papers.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      yearFrom: { type: 'number', default: 2020 }
    },
    required: ['query']
  },
  execute: async ({ query, yearFrom = 2020 }: {
    query: string;
    yearFrom?: number
  }): Promise<AcademicPaper[]> => {
    // Implementation
    return [];
  }
});

const extractInsights = tool({
  name: 'extract_insights',
  description: 'Extract key insights from paper.',
  parameters: {
    type: 'object',
    properties: {
      paperText: { type: 'string' }
    },
    required: ['paperText']
  },
  execute: async ({ paperText }: { paperText: string }): Promise<{
    keyFindings: string[];
    methodology: string[];
    limitations: string[];
  }> => {
    // Implementation
    return { keyFindings: [], methodology: [], limitations: [] };
  }
});

// Research session
const session = new Session({
  id: 'research-ai-safety-001',
  userId: 'researcher-123'
});
const memory = new Memory({ service: new VectorMemoryService() });

const researchAgent = new Agent({
  name: 'research_agent',
  model: lm,
  instructions: `You are a research assistant specializing in AI safety.

    Research process:
    1. Search for relevant recent papers
    2. Extract key insights from each paper
    3. Identify common themes and gaps
    4. Synthesize findings into comprehensive summary

    Focus on papers from 2020 onwards.`,
  tools: {
    searchAcademic,
    extractInsights
  },
  session,
  memory
});

const result = await researchAgent.run(
  'Survey the current state of AI alignment research'
);

// Store findings in long-term memory
await memory.ingestFromSession(session, { strategy: 'smart' });
```

### Multi-Agent Workflow

```typescript
// Coordinator pattern for complex workflows
const session = new Session({
  id: 'product-launch-001',
  userId: 'pm-456'
});

// Specialized agents
const marketResearcher = new Agent({
  name: 'market_analyst',
  model: lm,
  tools: {
    marketDataTool,
    competitorAnalysisTool
  },
  session,
  instructions: 'Analyze market opportunities and competitive landscape.'
});

const productDesigner = new Agent({
  name: 'designer',
  model: lm,
  tools: {
    designTool,
    userResearchTool
  },
  session,
  instructions: 'Design products based on market research and user needs.'
});

const technicalLead = new Agent({
  name: 'tech_lead',
  model: lm,
  tools: {
    architectureTool,
    feasibilityTool
  },
  session,
  instructions: 'Assess technical feasibility and propose architecture.'
});

// Sequential execution with shared context
const marketAnalysis = await marketResearcher.run(
  'Analyze market for AI-powered code review tools'
);

const productSpecs = await productDesigner.run(
  'Design product based on market analysis'
);

const techAssessment = await technicalLead.run(
  'Evaluate technical feasibility of proposed product'
);

// All agents see shared context and previous outputs
```

### Agent Handoff Pattern

```typescript
import { AgentTool } from 'agnt5/tools';

// Create specialized agents
const billingAgent = new Agent({
  name: 'billing_specialist',
  model: lm,
  tools: {
    paymentTool,
    invoiceTool,
    refundTool
  },
  instructions: 'Handle billing, payments, and refunds.'
});

const technicalAgent = new Agent({
  name: 'tech_support',
  model: lm,
  tools: {
    diagnosticTool,
    fixTool,
    escalationTool
  },
  instructions: 'Diagnose and fix technical issues.'
});

// Coordinator with agent handoff capability
const coordinator = new Agent({
  name: 'coordinator',
  model: lm,
  tools: {
    classifyRequestTool,
    billing_specialist: new AgentTool({ targetAgent: billingAgent }),
    tech_support: new AgentTool({ targetAgent: technicalAgent })
  },
  instructions: `You are a support coordinator.
    Classify requests and hand off to appropriate specialist.

    Hand off to:
    - billing_specialist: payment, invoice, refund questions
    - tech_support: technical issues, bugs, troubleshooting`
});

const session = new Session({
  id: 'support-ticket-789',
  userId: 'customer-123'
});

const result = await coordinator.run(
  'I was charged twice for my subscription',
  { session }
);
// Coordinator automatically hands off to billing_agent
```

### Agent with Human-in-the-Loop

```typescript
const deployToProduction = tool({
  name: 'deploy_to_production',
  description: 'Deploy application to production. Warning: Requires human approval.',
  parameters: {
    type: 'object',
    properties: {
      version: { type: 'string' }
    },
    required: ['version']
  },
  confirmation: true,
  execute: async ({ version }: { version: string }): Promise<{
    status: string;
    deploymentUrl: string;
  }> => {
    // Implementation
    return { status: 'deployed', deploymentUrl: '' };
  }
});

const deploymentAgent = new Agent({
  name: 'deployer',
  model: lm,
  tools: {
    runTestsTool,
    deployToProduction
  },
  instructions: `Run all tests before deploying.
    Always request human approval for production deployments.`
});

const result = await deploymentAgent.run('Deploy version 2.0 to production');
// Agent runs tests automatically
// Requests human approval before deploy_to_production
// Waits for approval signal before proceeding
```

### Iterative Problem Solving

```typescript
const debuggingAgent = new Agent({
  name: 'debugger',
  model: lm,
  tools: {
    analyzeLogsTool,
    runDiagnosticTool,
    applyFixTool,
    verifyFixTool
  },
  instructions: `You are a debugging assistant.

    Process:
    1. Analyze error logs to identify root cause
    2. Run diagnostics to confirm hypothesis
    3. Apply potential fix
    4. Verify fix works
    5. If not fixed, iterate (max 3 attempts)

    Always verify fixes before considering issue resolved.`
});

const result = await debuggingAgent.run(
  'Users are experiencing 500 errors on the checkout page'
);
// Agent iteratively debugs until issue is resolved or max attempts reached
```

## Best Practices

### 1. Write Clear Instructions

Good instructions help agents make better decisions:

```typescript
// Good - Specific, actionable instructions
const agent = new Agent({
  name: 'code_reviewer',
  model: lm,
  tools: {
    analyzeCodeTool,
    suggestImprovementsTool
  },
  instructions: `You are an expert code reviewer specializing in TypeScript.

    Review process:
    1. Analyze code for common issues (complexity, duplication, style)
    2. Check for security vulnerabilities and edge cases
    3. Suggest specific improvements with code examples
    4. Prioritize: security > correctness > performance > style

    Be constructive and explain your reasoning.`
});

// Avoid - Vague instructions
const agent = new Agent({
  name: 'helper',
  model: lm,
  tools: {
    tool1,
    tool2
  },
  instructions: 'Help the user with stuff.'  // Too vague
});
```

### 2. Use Sessions for Multi-Agent Coordination

Share context across agents:

```typescript
// Create shared session
const session = new Session({
  id: 'project-workflow-123',
  userId: 'user-456'
});

// Set shared context
session.setState('project_name', 'ai-safety-research');
session.setState('deadline', '2024-12-31');

// All agents access shared context
const agent1 = new Agent({ name: 'agent1', session, /* ... */ });
const agent2 = new Agent({ name: 'agent2', session, /* ... */ });

// Context automatically shared
```

### 3. Leverage Memory for Long-Term Context

Use Memory for knowledge that persists across sessions:

```typescript
// Store user expertise in long-term memory
await memory.store('user_expertise', 'Expert in React and TypeScript');
await memory.store('coding_style', 'Prefers functional programming');

// Agent recalls context automatically
const agent = new Agent({
  name: 'assistant',
  model: lm,
  tools: {
    codeGenTool
  },
  memory
});

// Memory influences agent's responses
const result = await agent.run('Help me build a component');
// Agent generates React/TypeScript with functional style
```

## Architecture

Agents orchestrate AGNT5 primitives:

1. **LLM Core**: Language model for reasoning and planning
2. **Tool Execution**: Tools built on Function primitive with durability
3. **State Management**: Sessions use Entity for conversation state
4. **Long-Term Storage**: Memory uses Entity for knowledge persistence
5. **Orchestration**: Agent decision loop uses Workflow patterns internally
6. **Streaming**: Real-time event emission for responsive UX

```
Agent
├── LanguageModel (reasoning)
├── Tools (actions via Function)
├── Session (context via Entity)
├── Memory (knowledge via Entity)
└── Planner (orchestration via Workflow patterns)
```

## Comparison with Other Components

| Aspect          | Function         | Workflow           | Agent              |
| --------------- | ---------------- | ------------------ | ------------------ |
| Autonomy        | None             | Scripted           | Autonomous         |
| Decision Making | Pre-programmed   | Control flow       | LLM-driven         |
| Tool Use        | N/A              | Explicit calls     | Dynamic selection  |
| Adaptability    | Fixed            | Fixed steps        | Adaptive reasoning |
| Use Case        | Single operation | Multi-step process | Complex tasks      |

**When to use Function:**
- Single, deterministic operation
- No decision-making needed

**When to use Workflow:**
- Pre-defined multi-step process
- Explicit control flow

**When to use Agent:**
- Complex, open-ended tasks
- Requires reasoning and adaptation
- Dynamic tool selection needed

## See Also

- [Session Component](session.md) - Agent conversation context
- [Tool Component](tool.md) - Agent capabilities
- [Memory Component](memory.md) - Agent long-term knowledge
- [Workflow Component](workflow.md) - Orchestration patterns
- [Context API](context.md) - Agent execution context
