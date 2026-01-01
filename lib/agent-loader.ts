import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface AgentDefinition {
  name: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
}

/**
 * Gets the Claude Code agents directory.
 * Checks multiple locations for container/host compatibility.
 */
function getAgentsDirectories(): string[] {
  return [
    // Container path (mounted from host)
    '/home/node/.claude/agents',
    // Host home directory
    path.join(os.homedir(), '.claude', 'agents'),
  ];
}

/**
 * Loads an agent definition from the native Claude Code agents directory.
 * Agents are markdown files at ~/.claude/agents/<name>.md
 */
export async function loadAgent(agentName: string): Promise<AgentDefinition> {
  if (!agentName || agentName.trim().length === 0) {
    throw new Error('Agent name is required');
  }

  // Validate agent name (prevent path traversal)
  if (agentName.includes('/') || agentName.includes('\\') || agentName.includes('..')) {
    throw new Error(`Invalid agent name: "${agentName}". Use only the agent name without path.`);
  }

  const searchPaths: string[] = [];

  for (const dir of getAgentsDirectories()) {
    const agentPath = path.join(dir, `${agentName}.md`);
    searchPaths.push(agentPath);

    try {
      const content = await fs.readFile(agentPath, 'utf-8');
      console.log(`Loaded agent "${agentName}" from ${agentPath}`);
      return parseAgentMarkdown(agentName, content);
    } catch {
      // Try next path
    }
  }

  throw new Error(
    `Agent "${agentName}" not found.\n` +
    `Create your agent at ~/.claude/agents/${agentName}.md\n` +
    `Searched:\n${searchPaths.map(p => `  - ${p}`).join('\n')}`
  );
}

/**
 * Parses agent markdown content with optional YAML frontmatter.
 *
 * Format:
 * ---
 * tools: [Read, Write, Bash]
 * model: claude-sonnet-4-20250514
 * ---
 * # Agent Name
 *
 * System prompt content...
 */
function parseAgentMarkdown(name: string, content: string): AgentDefinition {
  const agent: AgentDefinition = { name, systemPrompt: content };

  // Parse frontmatter if present (YAML between ---)
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    // Remove frontmatter from system prompt
    agent.systemPrompt = content.slice(frontmatterMatch[0].length).trim();

    // Parse tools array: tools: [Read, Write, Bash]
    const toolsMatch = frontmatter.match(/tools:\s*\[(.*?)\]/);
    if (toolsMatch) {
      agent.tools = toolsMatch[1]
        .split(',')
        .map(t => t.trim().replace(/['"]/g, ''))
        .filter(t => t.length > 0);
    }

    // Parse model (full model ID or shorthand)
    const modelMatch = frontmatter.match(/model:\s*([^\n]+)/);
    if (modelMatch) {
      agent.model = modelMatch[1].trim();
    }
  }

  return agent;
}

/**
 * Lists all available agents from the Claude Code agents directory.
 */
export async function listAgents(): Promise<string[]> {
  const agents = new Set<string>();

  for (const dir of getAgentsDirectories()) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith('.md')) {
          agents.add(path.basename(file, '.md'));
        }
      }
    } catch {
      // Directory might not exist
    }
  }

  return Array.from(agents).sort();
}
