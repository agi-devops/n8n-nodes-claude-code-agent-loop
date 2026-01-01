import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  scriptPath: string;
  allowedTools?: string[];
  model?: string;
}

/**
 * Gets the Claude Code skills directories.
 * Checks multiple locations for container/host compatibility.
 */
function getSkillsDirectories(): string[] {
  return [
    // Container path (mounted from host)
    '/home/node/.claude/skills',
    // Host home directory
    path.join(os.homedir(), '.claude', 'skills'),
  ];
}

/**
 * Loads all skill definitions from the native Claude Code skills directories.
 * Skills are directories with SKILL.md files at ~/.claude/skills/<name>/SKILL.md
 */
export async function loadAllSkills(): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];
  const seenNames = new Set<string>();

  for (const dir of getSkillsDirectories()) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillName = entry.name;

        // Skip if already loaded from higher-priority directory
        if (seenNames.has(skillName)) continue;

        const skillPath = path.join(dir, skillName, 'SKILL.md');

        try {
          const content = await fs.readFile(skillPath, 'utf-8');
          const skill = parseSkillMarkdown(skillName, content, dir);

          if (skill) {
            skills.push(skill);
            seenNames.add(skillName);
            console.log(`Loaded skill "${skillName}" from ${skillPath}`);
          }
        } catch {
          // SKILL.md doesn't exist in this directory
        }
      }
    } catch {
      // Directory might not exist
    }
  }

  return skills;
}

/**
 * Loads a specific skill by name.
 */
export async function loadSkill(skillName: string): Promise<SkillDefinition | null> {
  if (!skillName || skillName.trim().length === 0) {
    throw new Error('Skill name is required');
  }

  // Validate skill name (prevent path traversal)
  if (skillName.includes('/') || skillName.includes('\\') || skillName.includes('..')) {
    throw new Error(`Invalid skill name: "${skillName}". Use only the skill name without path.`);
  }

  for (const dir of getSkillsDirectories()) {
    const skillPath = path.join(dir, skillName, 'SKILL.md');

    try {
      const content = await fs.readFile(skillPath, 'utf-8');
      const skill = parseSkillMarkdown(skillName, content, dir);

      if (skill) {
        console.log(`Loaded skill "${skillName}" from ${skillPath}`);
        return skill;
      }
    } catch {
      // Try next path
    }
  }

  return null;
}

/**
 * Parses skill markdown content with YAML frontmatter.
 *
 * Format:
 * ---
 * name: skill-name
 * description: What this skill does and when to use it
 * allowed-tools: Bash
 * model: claude-sonnet-4-20250514
 * ---
 * # Skill Content
 *
 * Instructions...
 */
function parseSkillMarkdown(name: string, content: string, baseDir: string): SkillDefinition | null {
  // Parse frontmatter (required for skills)
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) {
    console.warn(`Skill "${name}" has no frontmatter, skipping`);
    return null;
  }

  const frontmatter = frontmatterMatch[1];
  const body = content.slice(frontmatterMatch[0].length).trim();

  // Parse description (required)
  const descMatch = frontmatter.match(/description:\s*(.+?)(?:\n|$)/);
  if (!descMatch) {
    console.warn(`Skill "${name}" has no description, skipping`);
    return null;
  }

  const skill: SkillDefinition = {
    name,
    description: descMatch[1].trim(),
    content: body,
    scriptPath: path.join(baseDir, name, 'scripts'),
  };

  // Parse allowed-tools (comma-separated or array)
  const toolsMatch = frontmatter.match(/allowed-tools:\s*(.+?)(?:\n|$)/);
  if (toolsMatch) {
    const toolsStr = toolsMatch[1].trim();
    // Handle both "Bash" and "[Bash, Read]" formats
    if (toolsStr.startsWith('[')) {
      skill.allowedTools = toolsStr
        .slice(1, -1)
        .split(',')
        .map(t => t.trim().replace(/['"]/g, ''))
        .filter(t => t.length > 0);
    } else {
      skill.allowedTools = toolsStr.split(',').map(t => t.trim()).filter(t => t.length > 0);
    }
  }

  // Parse model
  const modelMatch = frontmatter.match(/model:\s*([^\n]+)/);
  if (modelMatch) {
    skill.model = modelMatch[1].trim();
  }

  return skill;
}

/**
 * Finds skills relevant to a given prompt using keyword matching.
 * Returns skills sorted by relevance.
 */
export function findRelevantSkills(
  prompt: string,
  skills: SkillDefinition[],
  maxSkills: number = 3
): SkillDefinition[] {
  const promptLower = prompt.toLowerCase();

  // Score each skill by keyword matches in description
  const scored = skills.map(skill => {
    const descLower = skill.description.toLowerCase();
    let score = 0;

    // Split description into words and check for matches
    const keywords = descLower.split(/\s+/).filter(w => w.length > 3);
    for (const keyword of keywords) {
      if (promptLower.includes(keyword)) {
        score += 1;
      }
    }

    // Boost for service name mentions
    const nameLower = skill.name.toLowerCase();
    if (promptLower.includes(nameLower)) {
      score += 5;
    }

    // Check for common trigger words in description
    const triggers = descLower.match(/use when ([^.]+)/i);
    if (triggers) {
      const triggerWords = triggers[1].toLowerCase().split(/\s+/);
      for (const word of triggerWords) {
        if (promptLower.includes(word) && word.length > 3) {
          score += 2;
        }
      }
    }

    return { skill, score };
  });

  // Filter skills with score > 0 and sort by score descending
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSkills)
    .map(s => s.skill);
}

/**
 * Builds a context string from skills to inject into agent prompts.
 */
export function buildSkillContext(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return '';
  }

  const skillSections = skills.map(skill => {
    return `## ${skill.name}\n\n${skill.content}`;
  });

  return `\n\n# Available Skills\n\nThe following tools are available for this task:\n\n${skillSections.join('\n\n---\n\n')}`;
}

/**
 * Lists all available skill names.
 */
export async function listSkills(): Promise<string[]> {
  const skills = await loadAllSkills();
  return skills.map(s => s.name).sort();
}
