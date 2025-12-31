import * as fs from 'fs/promises';
import { query, type SDKMessage, type Options, type SDKAssistantMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

const HOME_CLAUDE_MD = '/home/node/CLAUDE.md';  // Mounted from /home/m5/CLAUDE.md

export interface AgentExecutionResult {
  success: boolean;
  output: string;
  filesModified: string[];
  sessionId: string;  // For resuming later
  error?: string;
}

export interface SessionConfig {
  agentPrompt: string;       // From agent markdown file
  workingDir: string;
  worktrees: Map<string, string>;
  syncWikiDocs: boolean;
  model: string;
  maxTurns: number;
  timeout: number;
  resumeSessionId?: string;  // Optional: resume previous session
  allowedTools?: string[];   // Override default tools
}

/**
 * Loads the home directory CLAUDE.md file.
 * This ALWAYS gets included in the system prompt for context.
 */
async function loadHomeCLAUDEMD(): Promise<string> {
  try {
    const content = await fs.readFile(HOME_CLAUDE_MD, 'utf-8');
    return `\n\n# Server Context (from ~/CLAUDE.md)\n\n${content}`;
  } catch {
    console.warn('Could not load home CLAUDE.md');
    return '';
  }
}

/**
 * Builds the workspace context message for multi-repo setups.
 */
function buildWorkspaceContext(
  worktrees: Map<string, string>,
  syncWikiDocs: boolean
): string {
  const paths = Array.from(worktrees.entries())
    .map(([name, p]) => `- ${name}: ${p}`)
    .join('\n');

  let context = `\n\n# Workspace\n\nYou are working in the following directories:\n${paths}\n`;

  if (syncWikiDocs && worktrees.has('m5') && worktrees.has('wiki')) {
    context += `
## Wiki-Sync Requirement

IMPORTANT: When you make code changes in the m5 repo, also update
the corresponding wiki documentation. The wiki is symlinked at ./wiki/.

Typical documentation updates:
- New features -> /features/{name}.md
- API changes -> /api/{endpoint}.md
- Configuration -> /guides/configuration.md
`;
  }

  return context;
}

/**
 * Default set of allowed tools for the agent.
 */
const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit',
  'Bash', 'Glob', 'Grep',
  'WebFetch', 'WebSearch',
  'Task', 'TodoWrite',
  'NotebookEdit', 'NotebookRead'
];

// Type guard for assistant messages
function isAssistantMessage(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === 'assistant';
}

// Type guard for result messages
function isResultMessage(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === 'result';
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: { file_path?: string };
}

/**
 * Extracts text content from assistant messages.
 */
function extractAssistantText(msg: SDKAssistantMessage): string {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return '';

  return (content as ContentBlock[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('');
}

/**
 * Extracts file paths from tool_use blocks in assistant message.
 */
function extractModifiedFiles(msg: SDKAssistantMessage): string[] {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];

  const filePaths: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type === 'tool_use') {
      const toolName = block.name || '';
      if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
        const filePath = block.input?.file_path;
        if (filePath) {
          filePaths.push(filePath);
        }
      }
    }
  }
  return filePaths;
}

/**
 * Executes an agent task using the Claude Agent SDK.
 * Returns session ID for potential follow-up interactions.
 */
export async function executeAgent(
  config: SessionConfig,
  taskPrompt: string
): Promise<AgentExecutionResult> {
  // ALWAYS load home CLAUDE.md for server context
  const homeCLAUDEMD = await loadHomeCLAUDEMD();

  // Build workspace context for multi-repo awareness
  const workspaceContext = buildWorkspaceContext(config.worktrees, config.syncWikiDocs);

  // Combine: Agent definition + Home CLAUDE.md + Workspace context
  const fullSystemPrompt = config.agentPrompt + homeCLAUDEMD + workspaceContext;

  // Build the full prompt including system instructions
  const fullPrompt = `${fullSystemPrompt}\n\n---\n\n# Task\n\n${taskPrompt}`;

  const options: Options = {
    cwd: config.workingDir,
    allowedTools: config.allowedTools || DEFAULT_ALLOWED_TOOLS,
    tools: { type: 'preset', preset: 'claude_code' },
    // Resume from previous session if specified
    resume: config.resumeSessionId,
    // Additional directories for multi-repo access
    additionalDirectories: Array.from(config.worktrees.values()),
  };

  const output: string[] = [];
  const filesModified: string[] = [];
  let sessionId = '';

  try {
    // Create the query
    const q = query({
      prompt: fullPrompt,
      options
    });

    // Process messages with timeout
    const timeoutMs = config.timeout * 1000;
    const startTime = Date.now();

    for await (const msg of q) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        console.warn('Agent execution timed out');
        break;
      }

      // Capture session ID from any message
      if ('session_id' in msg && typeof msg.session_id === 'string') {
        sessionId = msg.session_id;
      }

      // Process assistant messages
      if (isAssistantMessage(msg)) {
        const text = extractAssistantText(msg);
        if (text) {
          output.push(text);
        }

        // Track file modifications from tool_use blocks
        const files = extractModifiedFiles(msg);
        filesModified.push(...files);
      }

      // Check result message for final status
      if (isResultMessage(msg)) {
        if ('result' in msg && msg.result) {
          output.push(msg.result);
        }
      }
    }

    return {
      success: true,
      output: output.join('\n'),
      filesModified: [...new Set(filesModified)],
      sessionId
    };
  } catch (error) {
    return {
      success: false,
      output: output.join('\n'),
      filesModified: [...new Set(filesModified)],
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Sends a follow-up message to an existing session.
 * Useful for multi-turn interactions like clarifications or iterations.
 */
export async function continueSession(
  sessionId: string,
  followUpPrompt: string,
  config: Omit<SessionConfig, 'agentPrompt' | 'resumeSessionId'>
): Promise<AgentExecutionResult> {
  const options: Options = {
    cwd: config.workingDir,
    allowedTools: config.allowedTools || DEFAULT_ALLOWED_TOOLS,
    tools: { type: 'preset', preset: 'claude_code' },
    resume: sessionId,
    additionalDirectories: Array.from(config.worktrees.values()),
  };

  const output: string[] = [];
  const filesModified: string[] = [];

  try {
    const q = query({
      prompt: followUpPrompt,
      options
    });

    const timeoutMs = config.timeout * 1000;
    const startTime = Date.now();

    for await (const msg of q) {
      if (Date.now() - startTime > timeoutMs) {
        console.warn('Agent execution timed out');
        break;
      }

      if (isAssistantMessage(msg)) {
        const text = extractAssistantText(msg);
        if (text) {
          output.push(text);
        }

        const files = extractModifiedFiles(msg);
        filesModified.push(...files);
      }

      if (isResultMessage(msg)) {
        if ('result' in msg && msg.result) {
          output.push(msg.result);
        }
      }
    }

    return {
      success: true,
      output: output.join('\n'),
      filesModified: [...new Set(filesModified)],
      sessionId
    };
  } catch (error) {
    return {
      success: false,
      output: output.join('\n'),
      filesModified: [...new Set(filesModified)],
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
