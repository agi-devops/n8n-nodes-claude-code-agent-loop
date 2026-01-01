import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AgentExecutionError } from './errors.js';
import { loadAllSkills, buildSkillContext } from './skill-loader.js';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface AgentExecutionResult {
  success: boolean;
  output: string;
  filesModified: string[];
  sessionId: string;          // For resuming later
  turnCount: number;          // Number of turns in this execution
  sessionCreated: string;     // ISO timestamp when session started
  lastActivity: string;       // ISO timestamp of last activity
  conversationSummary: string; // Summary of recent exchanges
  hasAction: boolean;         // Whether any write/create action was taken
  error?: string;
}

export interface SessionConfig {
  agentPrompt: string;       // From agent markdown file
  workingDir: string;
  worktrees: Map<string, string>;
  model: string;
  maxTurns: number;
  timeout: number;
  sessionTimeout: number;    // Session timeout in minutes (for output metadata)
  resumeSessionId?: string;  // Optional: resume previous session
  allowedTools?: string[];   // Override default tools
  claudeMdPath?: string;     // Optional: custom CLAUDE.md path
  conversationContext?: ConversationMessage[];  // Previous messages for context
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

/**
 * Builds conversation context from previous messages for multi-turn interactions.
 */
function buildConversationContext(messages?: ConversationMessage[]): string {
  if (!messages || messages.length === 0) {
    return '';
  }

  const formattedMessages = messages.map(msg => {
    const timestamp = msg.timestamp ? ` [${msg.timestamp}]` : '';
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    return `[${role}${timestamp}]: ${msg.content}`;
  }).join('\n\n');

  return `\n\n# Previous Conversation\n\n${formattedMessages}\n\n---\n`;
}

/**
 * Generates a summary of the last few conversation exchanges.
 */
function summarizeConversation(messages: ConversationMessage[], output: string): string {
  const recentMessages = messages.slice(-4); // Last 4 messages
  const parts: string[] = [];

  for (const msg of recentMessages) {
    const role = msg.role === 'user' ? 'User' : 'Bot';
    const preview = msg.content.slice(0, 100) + (msg.content.length > 100 ? '...' : '');
    parts.push(`${role}: ${preview}`);
  }

  // Add current output as last assistant message
  if (output) {
    const preview = output.slice(0, 100) + (output.length > 100 ? '...' : '');
    parts.push(`Bot: ${preview}`);
  }

  return parts.join(' | ');
}

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
  const sessionCreated = new Date().toISOString();

  // Dynamic import for ESM-only SDK
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { query } = sdk;

  // Load CLAUDE.md for context (searches multiple locations)
  const claudeMdContent = await loadCLAUDEMD(config.claudeMdPath, config.workingDir);

  // Build workspace context for multi-repo awareness
  const workspaceContext = buildWorkspaceContext(config.worktrees);

  // Build conversation context from previous messages
  const conversationContext = buildConversationContext(config.conversationContext);

  // Load and inject all available skills
  let skillContext = '';
  try {
    const allSkills = await loadAllSkills();
    if (allSkills.length > 0) {
      skillContext = buildSkillContext(allSkills);
      console.log(`Loaded ${allSkills.length} skills: ${allSkills.map(s => s.name).join(', ')}`);
    }
  } catch (error) {
    console.warn('Failed to load skills:', error);
  }

  // Combine: Agent definition + CLAUDE.md context + Workspace context + Skills context
  const fullSystemPrompt = config.agentPrompt + claudeMdContent + workspaceContext + skillContext;

  // Build the full prompt including system instructions and conversation context
  let fullPrompt: string;
  if (conversationContext) {
    // Multi-turn mode: include previous conversation
    fullPrompt = `${fullSystemPrompt}${conversationContext}\n# Current Message\n\n${taskPrompt}`;
  } else {
    // New conversation: standard format
    fullPrompt = `${fullSystemPrompt}\n\n---\n\n# Task\n\n${taskPrompt}`;
  }

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
  let turnCount = 0;

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
        turnCount++;
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

    const lastActivity = new Date().toISOString();
    const outputText = output.join('\n');
    const uniqueFiles = [...new Set(filesModified)];

    // Determine if any action was taken (file writes or specific keywords)
    const hasAction = uniqueFiles.length > 0 ||
      outputText.toLowerCase().includes('created issue') ||
      outputText.toLowerCase().includes('issue erstellt') ||
      outputText.toLowerCase().includes('committed') ||
      outputText.toLowerCase().includes('pushed');

    return {
      success: true,
      output: outputText,
      filesModified: uniqueFiles,
      sessionId,
      turnCount,
      sessionCreated,
      lastActivity,
      conversationSummary: summarizeConversation(config.conversationContext || [], outputText),
      hasAction
    };
  } catch (error) {
    const lastActivity = new Date().toISOString();
    const outputText = output.join('\n');

    return {
      success: false,
      output: outputText,
      filesModified: [...new Set(filesModified)],
      sessionId,
      turnCount,
      sessionCreated,
      lastActivity,
      conversationSummary: summarizeConversation(config.conversationContext || [], outputText),
      hasAction: false,
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
  const sessionCreated = new Date().toISOString(); // Timestamp for this continuation

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
  let turnCount = 0;

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
        turnCount++;
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

    const lastActivity = new Date().toISOString();
    const outputText = output.join('\n');
    const uniqueFiles = [...new Set(filesModified)];

    const hasAction = uniqueFiles.length > 0 ||
      outputText.toLowerCase().includes('created issue') ||
      outputText.toLowerCase().includes('issue erstellt') ||
      outputText.toLowerCase().includes('committed') ||
      outputText.toLowerCase().includes('pushed');

    return {
      success: true,
      output: outputText,
      filesModified: uniqueFiles,
      sessionId,
      turnCount,
      sessionCreated,
      lastActivity,
      conversationSummary: summarizeConversation(config.conversationContext || [], outputText),
      hasAction
    };
  } catch (error) {
    const lastActivity = new Date().toISOString();
    const outputText = output.join('\n');

    return {
      success: false,
      output: outputText,
      filesModified: [...new Set(filesModified)],
      sessionId,
      turnCount,
      sessionCreated,
      lastActivity,
      conversationSummary: summarizeConversation(config.conversationContext || [], outputText),
      hasAction: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
