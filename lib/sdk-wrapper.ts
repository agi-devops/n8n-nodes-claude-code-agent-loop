import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AgentExecutionError } from './errors.js';

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
  model: string;
  maxTurns: number;
  timeout: number;
  resumeSessionId?: string;  // Optional: resume previous session
  allowedTools?: string[];   // Override default tools
  claudeMdPath?: string;     // Optional: custom CLAUDE.md path
}

/**
 * Attempts to load CLAUDE.md from common locations.
 * Order: custom path > working directory > home directory
 */
async function loadCLAUDEMD(customPath?: string, workingDir?: string): Promise<string> {
  const searchPaths: string[] = [];

  // Custom path takes priority
  if (customPath) {
    searchPaths.push(customPath);
  }

  // Check working directory
  if (workingDir) {
    searchPaths.push(path.join(workingDir, 'CLAUDE.md'));
  }

  // Check home directory (both container and host paths)
  searchPaths.push(path.join(os.homedir(), 'CLAUDE.md'));
  searchPaths.push('/home/node/CLAUDE.md');

  for (const searchPath of searchPaths) {
    try {
      const content = await fs.readFile(searchPath, 'utf-8');
      console.log(`Loaded CLAUDE.md from ${searchPath}`);
      return `\n\n# Context (from ${searchPath})\n\n${content}`;
    } catch {
      // Try next path
    }
  }

  console.warn('No CLAUDE.md found in any search path');
  return '';
}

/**
 * Builds the workspace context message for multi-repo setups.
 */
function buildWorkspaceContext(worktrees: Map<string, string>): string {
  if (worktrees.size === 0) {
    return '';
  }

  const paths = Array.from(worktrees.entries())
    .map(([name, p]) => `- ${name}: ${p}`)
    .join('\n');

  return `\n\n# Workspace\n\nYou are working in the following directories:\n${paths}\n`;
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

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: { file_path?: string };
}

interface SDKMessage {
  type: string;
  session_id?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
}

/**
 * Extracts text content from assistant messages.
 */
function extractAssistantText(msg: SDKMessage): string {
  if (msg.type !== 'assistant') return '';
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
function extractModifiedFiles(msg: SDKMessage): string[] {
  if (msg.type !== 'assistant') return [];
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
 * Uses dynamic import for ESM-only SDK.
 * Returns session ID for potential follow-up interactions.
 */
export async function executeAgent(
  config: SessionConfig,
  taskPrompt: string
): Promise<AgentExecutionResult> {
  // Dynamic import for ESM-only SDK
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { query } = sdk;

  // Load CLAUDE.md for context (searches multiple locations)
  const claudeMdContent = await loadCLAUDEMD(config.claudeMdPath, config.workingDir);

  // Build workspace context for multi-repo awareness
  const workspaceContext = buildWorkspaceContext(config.worktrees);

  // Combine: Agent definition + CLAUDE.md context + Workspace context
  const fullSystemPrompt = config.agentPrompt + claudeMdContent + workspaceContext;

  // Build the full prompt including system instructions
  const fullPrompt = `${fullSystemPrompt}\n\n---\n\n# Task\n\n${taskPrompt}`;

  const options = {
    cwd: config.workingDir,
    allowedTools: config.allowedTools || DEFAULT_ALLOWED_TOOLS,
    tools: { type: 'preset' as const, preset: 'claude_code' as const },
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
      const sdkMsg = msg as SDKMessage;

      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        console.warn('Agent execution timed out');
        break;
      }

      // Capture session ID from any message
      if (sdkMsg.session_id) {
        sessionId = sdkMsg.session_id;
      }

      // Process assistant messages
      if (sdkMsg.type === 'assistant') {
        const text = extractAssistantText(sdkMsg);
        if (text) {
          output.push(text);
        }

        // Track file modifications from tool_use blocks
        const files = extractModifiedFiles(sdkMsg);
        filesModified.push(...files);
      }

      // Check result message for final status
      if (sdkMsg.type === 'result') {
        if (sdkMsg.result) {
          output.push(sdkMsg.result);
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
  config: Omit<SessionConfig, 'agentPrompt' | 'resumeSessionId' | 'claudeMdPath'>
): Promise<AgentExecutionResult> {
  // Dynamic import for ESM-only SDK
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { query } = sdk;

  const options = {
    cwd: config.workingDir,
    allowedTools: config.allowedTools || DEFAULT_ALLOWED_TOOLS,
    tools: { type: 'preset' as const, preset: 'claude_code' as const },
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
      const sdkMsg = msg as SDKMessage;

      if (Date.now() - startTime > timeoutMs) {
        console.warn('Agent execution timed out');
        break;
      }

      if (sdkMsg.type === 'assistant') {
        const text = extractAssistantText(sdkMsg);
        if (text) {
          output.push(text);
        }

        const files = extractModifiedFiles(sdkMsg);
        filesModified.push(...files);
      }

      if (sdkMsg.type === 'result') {
        if (sdkMsg.result) {
          output.push(sdkMsg.result);
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
