import * as fs from 'fs/promises';
import * as path from 'path';

export interface AgentDefinition {
  name: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
}

// User-defined agents directory
const AGENTS_DIR = '/home/node/.claude/agents';

// Built-in agents bundled with the package
const BUILTIN_AGENTS_DIR = path.join(__dirname, '..', 'agents');

/**
 * Loads an agent definition from markdown file.
 * First checks user-defined agents, then falls back to built-in.
 */
export async function loadAgent(agentName: string): Promise<AgentDefinition> {
  // Handle custom path
  if (agentName === 'custom') {
    throw new Error('Custom agent requires customAgentPath parameter');
  }

  // Try user-defined agents first
  const userPath = path.join(AGENTS_DIR, `${agentName}.md`);
  const builtinPath = path.join(BUILTIN_AGENTS_DIR, `${agentName}.md`);

  let content: string;
  let foundPath: string;

  try {
    content = await fs.readFile(userPath, 'utf-8');
    foundPath = userPath;
  } catch {
    try {
      content = await fs.readFile(builtinPath, 'utf-8');
      foundPath = builtinPath;
    } catch {
      throw new Error(
        `Agent "${agentName}" not found.\n` +
        `Searched:\n  - ${userPath}\n  - ${builtinPath}`
      );
    }
  }

  console.log(`Loaded agent "${agentName}" from ${foundPath}`);
  return parseAgentMarkdown(agentName, content);
}

/**
 * Loads an agent from a custom file path.
 */
export async function loadAgentFromPath(filePath: string): Promise<AgentDefinition> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const name = path.basename(filePath, '.md');
    return parseAgentMarkdown(name, content);
  } catch (error) {
    throw new Error(`Failed to load agent from ${filePath}: ${error}`);
  }
}

/**
 * Parses agent markdown content with optional YAML frontmatter.
 *
 * Format:
 * ---
 * tools: [Read, Write, Bash]
 * model: opus
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

    // Parse model: model: opus
    const modelMatch = frontmatter.match(/model:\s*(\w+)/);
    if (modelMatch) {
      agent.model = modelMatch[1];
    }
  }

  return agent;
}

/**
 * Lists all available agents (user-defined + built-in).
 */
export async function listAgents(): Promise<string[]> {
  const agents = new Set<string>();

  // List user-defined agents
  try {
    const userFiles = await fs.readdir(AGENTS_DIR);
    for (const file of userFiles) {
      if (file.endsWith('.md')) {
        agents.add(path.basename(file, '.md'));
      }
    }
  } catch {
    // User agents directory might not exist
  }

  // List built-in agents
  try {
    const builtinFiles = await fs.readdir(BUILTIN_AGENTS_DIR);
    for (const file of builtinFiles) {
      if (file.endsWith('.md')) {
        agents.add(path.basename(file, '.md'));
      }
    }
  } catch {
    // Built-in agents directory might not exist
  }

  return Array.from(agents).sort();
}
