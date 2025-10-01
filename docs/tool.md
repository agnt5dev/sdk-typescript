# Tool Component

## What is a Tool?

A **Tool** in AGNT5 is a callable capability that extends what agents can do. Tools provide structured interfaces to functions, APIs, services, and other agents, with automatic schema extraction from TypeScript code. Tools are the hands and eyes of agents - enabling them to search, analyze, compute, and interact with external systems.

**Key Characteristics:**
- **Automatic Schema**: Extract input/output schemas from Zod definitions and TypeScript types
- **Multiple Types**: Function, Hosted, MCP, OpenAPI, and Agent tools
- **Built on Function**: Inherits durability and retry logic from Function primitive
- **Confirmation Policies**: Optional user approval for dangerous operations
- **Rich Metadata**: Descriptions, examples, and parameter constraints

## Why are Tools Needed?

### 1. Extend Agent Capabilities

Agents alone can only generate text - tools give them real-world abilities:

```typescript
import { Agent, tool } from 'agnt5';
import { z } from 'zod';

const searchWeb = tool({
  name: 'search_web',
  description: 'Search the web for information',
  parameters: z.object({
    query: z.string().describe('The search query string'),
    maxResults: z.number().default(10).describe('Maximum number of results to return'),
  }),
  execute: async ({ query, maxResults }) => {
    // Implementation
    const results = await performWebSearch(query, maxResults);
    return results; // List of search results with title, url, and snippet
  },
});

const agent = new Agent({
  name: 'researcher',
  model: lm,
  tools: [searchWeb], // Agent can now search the web
});

const result = await agent.run('What are the latest developments in quantum computing?');
// Agent automatically calls search_web tool with appropriate query
```

### 2. Reusable Function Libraries

Define tools once, use across multiple agents:

```typescript
import { tool } from 'agnt5';
import { z } from 'zod';

// Define domain-specific tools
const analyzeCode = tool({
  name: 'analyze_code',
  description: 'Analyze code for quality issues',
  parameters: z.object({
    code: z.string(),
    language: z.string().default('typescript'),
  }),
  execute: async ({ code, language }) => {
    // Implementation
    return analysisResults;
  },
});

const runTests = tool({
  name: 'run_tests',
  description: 'Execute test suite and return results',
  parameters: z.object({
    testFile: z.string(),
  }),
  execute: async ({ testFile }) => {
    // Implementation
    return testResults;
  },
});

const formatCode = tool({
  name: 'format_code',
  description: 'Format code according to style guide',
  parameters: z.object({
    code: z.string(),
    style: z.string().default('prettier'),
  }),
  execute: async ({ code, style }) => {
    // Implementation
    return formattedCode;
  },
});

// Multiple agents share the same toolset
const codeReviewer = new Agent({ name: 'reviewer', tools: [analyzeCode, runTests] });
const codeFixer = new Agent({ name: 'fixer', tools: [analyzeCode, formatCode] });
```

### 3. Safe Execution with Confirmation

Require approval for dangerous operations:

```typescript
import { tool } from 'agnt5';
import { z } from 'zod';

const deleteDatabase = tool({
  name: 'delete_database',
  description: 'Delete a database permanently. WARNING: This operation is irreversible and will delete all data.',
  parameters: z.object({
    databaseName: z.string().describe('Name of the database to delete'),
  }),
  confirmation: true, // Requires human approval before execution
  execute: async ({ databaseName }) => {
    // Requires human approval before execution
    await performDeletion(databaseName);
    return { status: 'deleted', database: databaseName };
  },
});

// Agent proposes deletion but waits for approval
const agent = new Agent({ name: 'admin', tools: [deleteDatabase] });
const result = await agent.run('Clean up the test database');
// User receives confirmation prompt before tool executes
```

## How to Use Tools

### Function Tools with Auto-Schema

The simplest way to create tools is with the `tool()` builder:

```typescript
import { tool } from 'agnt5';
import { z } from 'zod';

const calculateArea = tool({
  name: 'calculate_area',
  description: 'Calculate the area of a rectangle',
  parameters: z.object({
    length: z.number().describe('Length of the rectangle in meters'),
    width: z.number().describe('Width of the rectangle in meters'),
  }),
  execute: async ({ length, width }) => {
    return length * width; // Area in square meters
  },
});

// Schema automatically extracted:
// {
//   "name": "calculate_area",
//   "description": "Calculate the area of a rectangle",
//   "input_schema": {
//     "type": "object",
//     "properties": {
//       "length": {"type": "number", "description": "Length of the rectangle in meters"},
//       "width": {"type": "number", "description": "Width of the rectangle in meters"}
//     },
//     "required": ["length", "width"]
//   }
// }
```

### Manual Schema Definition

For more control, define schemas explicitly:

```typescript
import { Tool } from 'agnt5';

const searchTool = new Tool({
  name: 'search',
  description: 'Search for information',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      filters: { type: 'object' },
    },
    required: ['query'],
  },
  handler: searchFunction,
});
```

### Hosted Tools (AGNT5 Workers)

Tools can be deployed as durable AGNT5 workers:

```typescript
import { worker } from 'agnt5';
import { HostedTool } from 'agnt5/tools';

// Define worker function
worker.handler('analyze_data', async (data: Record<string, any>) => {
  // Heavy computation here
  return analysisResults;
});

// Create hosted tool pointing to worker
const analysisTool = new HostedTool({
  name: 'analyze_data',
  description: 'Perform complex data analysis',
  endpoint: 'agnt5://data-analysis-service/analyze_data',
});

// Agent uses hosted tool with automatic retries and durability
const agent = new Agent({ name: 'analyst', tools: [analysisTool] });
```

### MCP Tools (Model Context Protocol)

Integrate with MCP servers:

```typescript
import { MCPTool } from 'agnt5/tools';

// Connect to MCP server
const filesystemTool = new MCPTool({
  name: 'filesystem',
  mcpServerUrl: 'http://localhost:3000/mcp',
  capabilities: ['read_file', 'write_file', 'list_directory'],
});

const agent = new Agent({ name: 'file_assistant', tools: [filesystemTool] });
```

### OpenAPI Tools

Automatically generate tools from OpenAPI specs:

```typescript
import { OpenAPITool } from 'agnt5/tools';

// Create tools from OpenAPI specification
const githubTools = await OpenAPITool.fromSpec({
  specUrl: 'https://api.github.com/openapi.json',
  operations: ['get_repo', 'list_issues', 'create_issue'],
});

const agent = new Agent({ name: 'github_bot', tools: githubTools });
```

## Common Patterns

### Tool Composition

Combine multiple tools for complex capabilities:

```typescript
import { tool, Agent } from 'agnt5';
import { z } from 'zod';

const searchPapers = tool({
  name: 'search_papers',
  description: 'Search academic papers',
  parameters: z.object({
    query: z.string(),
    yearFrom: z.number().default(2020),
  }),
  execute: async ({ query, yearFrom }) => {
    // Implementation
    return papers;
  },
});

const downloadPdf = tool({
  name: 'download_pdf',
  description: 'Download PDF document',
  parameters: z.object({
    url: z.string().url(),
  }),
  execute: async ({ url }) => {
    // Implementation
    return pdfData;
  },
});

const extractText = tool({
  name: 'extract_text',
  description: 'Extract text from PDF',
  parameters: z.object({
    pdfData: z.instanceof(Buffer),
  }),
  execute: async ({ pdfData }) => {
    // Implementation
    return extractedText;
  },
});

// Agent orchestrates multiple tools
const researchAgent = new Agent({
  name: 'researcher',
  tools: [searchPapers, downloadPdf, extractText],
  instructions: 'Search papers, download them, and extract key findings.',
});

const result = await researchAgent.run('Survey recent work on transformer architectures');
// Agent chains: search_papers → download_pdf → extract_text
```

### Conditional Tool Execution

Tools with prerequisite checks:

```typescript
import { tool } from 'agnt5';
import { z } from 'zod';

const checkBalance = tool({
  name: 'check_balance',
  description: 'Check account balance',
  parameters: z.object({
    accountId: z.string(),
  }),
  execute: async ({ accountId }) => {
    return { accountId, balance: 1000.0 };
  },
});

const transferFunds = tool({
  name: 'transfer_funds',
  description: 'Transfer funds between accounts',
  parameters: z.object({
    fromAccount: z.string().describe('Source account ID'),
    toAccount: z.string().describe('Destination account ID'),
    amount: z.number().positive().describe('Amount to transfer'),
  }),
  confirmation: true,
  execute: async ({ fromAccount, toAccount, amount }) => {
    // Check balance first (agent learns to do this)
    const balance = await checkBalance.execute({ accountId: fromAccount });
    if (balance.balance < amount) {
      throw new Error('Insufficient funds');
    }

    // Perform transfer
    return { transactionId: 'txn_123', status: 'completed' };
  },
});

const agent = new Agent({
  name: 'banking_assistant',
  tools: [checkBalance, transferFunds],
  instructions: 'Always check balance before transfers.',
});
```

### Tool Error Handling

Tools with robust error handling:

```typescript
import { tool } from 'agnt5';
import { z } from 'zod';

class InvalidSymbolError extends Error {}
class MarketAPIError extends Error {}

const fetchStockPrice = tool({
  name: 'fetch_stock_price',
  description: 'Fetch current stock price. Returns stock price data with current price, change, and volume.',
  parameters: z.object({
    symbol: z.string().describe("Stock ticker symbol (e.g., 'AAPL', 'GOOGL')"),
  }),
  execute: async ({ symbol }) => {
    try {
      // Fetch from market data API
      const priceData = await marketApi.getPrice(symbol);
      return {
        symbol,
        price: priceData.current,
        change: priceData.change,
        volume: priceData.volume,
      };
    } catch (error) {
      if (error instanceof InvalidSymbolError) {
        throw new Error(`Invalid stock symbol: ${symbol}`);
      }
      if (error instanceof MarketAPIError) {
        throw new Error(`Market data unavailable: ${error.message}`);
      }
      throw error;
    }
  },
});

// Agent handles tool errors gracefully
const agent = new Agent({ name: 'stock_advisor', tools: [fetchStockPrice] });
const result = await agent.run("What's the price of AAPL?");
// If tool fails, agent can retry or inform user
```

### Dynamic Tool Registration

Register tools at runtime based on context:

```typescript
import { Agent } from 'agnt5';

interface User {
  role: 'admin' | 'user';
}

// Base toolset
const baseTools = [searchTool, calculateTool];

// Add specialized tools based on user role
function getToolsForUser(user: User) {
  if (user.role === 'admin') {
    const adminTools = [deleteUserTool, modifyPermissionsTool];
    return [...baseTools, ...adminTools];
  }
  return baseTools;
}

const agent = new Agent({
  name: 'assistant',
  tools: getToolsForUser(user),
  instructions: `You are assisting a ${user.role}.`,
});
```

### Tool with Context Access

Tools can access execution context for advanced operations:

```typescript
import { tool, Context } from 'agnt5';
import { z } from 'zod';

const storeMemory = tool({
  name: 'store_memory',
  description: 'Store information in long-term memory',
  parameters: z.object({
    key: z.string().describe('Memory key'),
    value: z.string().describe('Content to store'),
  }),
  execute: async ({ key, value }, ctx: Context) => {
    // Access context for durable storage
    await ctx.memory.set(key, value);

    return {
      status: 'stored',
      key,
      timestamp: ctx.now(),
    };
  },
});

// Context is automatically injected when tool is called
const agent = new Agent({ name: 'memory_agent', tools: [storeMemory] });
```

## Best Practices

### 1. Write Clear Tool Descriptions

Good descriptions help agents use tools correctly:

```typescript
import { tool } from 'agnt5';
import { z } from 'zod';

// Good - Clear, specific description
const searchDocumentation = tool({
  name: 'search_documentation',
  description: `Search official language documentation for code examples and API references.

    Use this tool when you need to find specific functions, classes, or usage
    examples from official documentation. Returns relevant documentation sections
    with code examples.`,
  parameters: z.object({
    query: z.string().describe('Specific function name, class, or concept to search for'),
    language: z.enum(['typescript', 'javascript', 'go', 'rust', 'python']).default('typescript'),
  }),
  execute: async ({ query, language }) => {
    // Returns list of documentation sections with title, url, and code examples
    return documentationResults;
  },
});

// Avoid - Vague description
const search = tool({
  name: 'search',
  description: 'Search for stuff', // Too vague - agent won't know when to use this
  parameters: z.object({
    q: z.string(),
  }),
  execute: async ({ q }) => {
    return results;
  },
});
```

### 2. Use Zod Schemas and TypeScript Types

Enable automatic schema extraction:

```typescript
import { tool } from 'agnt5';
import { z } from 'zod';

interface SentimentResult {
  label: 'positive' | 'negative' | 'neutral';
  scores?: Record<string, number>;
}

const analyzeSentiment = tool({
  name: 'analyze_sentiment',
  description: 'Analyze sentiment of text',
  parameters: z.object({
    text: z.string().min(10).describe('Text to analyze (minimum 10 characters)'),
    language: z.enum(['en', 'es', 'fr', 'de']).default('en').describe('ISO language code'),
    returnScores: z.boolean().default(false).describe('Include detailed confidence scores'),
  }),
  execute: async ({ text, language, returnScores }): Promise<SentimentResult> => {
    // Zod schema + TypeScript types = complete schema
    const result = await performSentimentAnalysis(text, language);
    return {
      label: result.label,
      ...(returnScores && { scores: result.scores }),
    };
  },
});
```

### 3. Implement Confirmation for Dangerous Operations

Protect users from destructive actions:

```typescript
import { tool } from 'agnt5';
import { z } from 'zod';

// Dangerous operations should require confirmation
const executeCode = tool({
  name: 'execute_code',
  description: `Execute arbitrary code in a sandboxed environment.

    WARNING: Code execution can be dangerous. This tool requires explicit user approval.`,
  parameters: z.object({
    code: z.string(),
    language: z.string().default('typescript'),
  }),
  confirmation: true,
  execute: async ({ code, language }) => {
    // Execute in sandboxed environment
    return executionResult;
  },
});

const sendEmailBlast = tool({
  name: 'send_email_blast',
  description: `Send email to multiple recipients.

    WARNING: Bulk email requires confirmation to prevent spam.`,
  parameters: z.object({
    recipients: z.array(z.string().email()),
    subject: z.string(),
    body: z.string(),
  }),
  confirmation: true,
  execute: async ({ recipients, subject, body }) => {
    // Send emails
    return emailResults;
  },
});
```

## Architecture

Tools are built on AGNT5's Function primitive:

1. **Function Foundation**: Each tool wraps a durable function with retry policies
2. **Schema Layer**: Automatic extraction from Zod schemas and TypeScript types
3. **Agent Integration**: Tools registered with agents for LLM-driven invocation
4. **Execution Modes**:
   - **FunctionTool**: Direct TypeScript function execution
   - **HostedTool**: Remote execution via AGNT5 workers
   - **MCPTool**: Proxy to MCP servers
   - **OpenAPITool**: Generated from OpenAPI specs
5. **Durability**: All tool executions benefit from function-level durability and checkpointing

## Comparison with Function

| Aspect | Function | Tool |
|--------|----------|------|
| Purpose | General computation | Agent capability |
| Schema | Optional | Required (auto-generated) |
| Discovery | Manual invocation | Agent-driven selection |
| Metadata | Basic | Rich (description, examples, confirmation) |
| Use Case | Backend logic | Agent actions |

**When to use Function:**
- Backend processing
- Internal system operations
- Not exposed to agents

**When to use Tool:**
- Agent capabilities
- External system integration
- User-facing operations

## See Also

- [Function Component](function.md) - Underlying primitive for tools
- [Agent Component](agent.md) - Agents use tools for actions
- [Context API](context.md) - Tool context operations
- [Worker](../sdk/typescript/workers.md) - Hosted tool deployment
