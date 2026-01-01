# n8n-nodes-claude-agent-loop

n8n community node for running Claude Code agents with native SDK integration.

**Features:**
- Use your native Claude Code agents (from `~/.claude/agents/`)
- Multi-repository support with git worktrees
- Automatic PR creation (Gitea & GitHub)
- Session resume for multi-turn interactions
- Configurable timeouts and turn limits

## Installation

```bash
npm install n8n-nodes-claude-agent-loop
```

Or clone and build locally:

```bash
git clone https://github.com/Niach/n8n-nodes-claude-agent-loop.git
cd n8n-nodes-claude-agent-loop
npm install
npm run build
```

## Prerequisites

- **Claude Code CLI** authenticated (`claude` command available)
- **Agents** defined in `~/.claude/agents/` (see below)
- **Skills** (optional) in `~/.claude/skills/` for CLI tool access
- **Git** for worktree operations
- Optional: `gitea` or `github` CLI for PR creation

## Creating Agents

This node uses your native Claude Code agents. Create agents as markdown files in `~/.claude/agents/`:

```bash
mkdir -p ~/.claude/agents
```

### Example Agent: `~/.claude/agents/code-reviewer.md`

```markdown
---
tools: [Read, Write, Edit, Bash, Grep, Glob]
model: claude-sonnet-4-20250514
---
# Code Reviewer

You are a code review agent. Your task is to review code changes and suggest improvements.

## Guidelines
- Check for bugs and potential issues
- Suggest performance improvements
- Ensure code follows best practices
- Look for security vulnerabilities
```

### Frontmatter Options

| Field | Description |
|-------|-------------|
| `tools` | Array of allowed tools: `[Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch]` |
| `model` | Claude model ID (e.g., `claude-sonnet-4-20250514`, `claude-opus-4-20250514`) |

## Skills (CLI Tools)

Skills provide CLI tools that agents can use. They are automatically loaded from `~/.claude/skills/` and injected into the agent's context.

### Skill Structure

```
~/.claude/skills/
  gitea/
    SKILL.md          # Skill definition
    scripts/
      gitea           # Executable CLI script
  youtrack/
    SKILL.md
    scripts/
      youtrack
```

### Example Skill: `~/.claude/skills/gitea/SKILL.md`

```markdown
---
name: gitea
description: Interacts with Gitea git server. Manages repositories, branches, issues, pull requests, releases, and webhooks. Use when working with Gitea repos.
allowed-tools: Bash
---
# Gitea CLI

Execute: `~/.claude/skills/gitea/scripts/gitea <command> [args]`

## Commands
- `repos` - List repositories
- `repo:create <name>` - Create repository
- `issues <owner/repo>` - List issues
- `pr:create <owner/repo> --title "..." --body "..."` - Create PR
```

### Skill Frontmatter

| Field | Description |
|-------|-------------|
| `name` | Skill identifier |
| `description` | When to use this skill (used for context injection) |
| `allowed-tools` | Tools the skill needs (e.g., `Bash`) |
| `model` | Optional model override |

All skills are automatically available to every agent execution.

## Node Configuration

### Agent Selection

| Field | Description |
|-------|-------------|
| Agent Name | Name of your agent (matches `~/.claude/agents/<name>.md`) |

### Repository Configuration

Add one or more repositories for the agent to work with:

| Field | Description |
|-------|-------------|
| Name | Unique identifier for this repository |
| Local Path | Absolute path to the local git repository |
| Worktrees Directory | Directory where isolated worktrees will be created |
| Git Provider | `gitea`, `github`, or `none` (for PR creation) |
| Remote Owner | Organization/user on the git provider |
| Remote Repo | Repository name on the git provider |

### Task Configuration

| Field | Description |
|-------|-------------|
| Prompt | Task description for the agent (max 50KB) |
| Branch Name | Git branch name (auto-generated if empty) |
| Base Branch | Branch to create worktrees from (default: `main`) |
| Create Pull Request | Whether to create PR after changes |

### Model Settings

| Field | Description |
|-------|-------------|
| Model | Claude model to use (can be overridden by agent) |
| Max Turns | Maximum conversation turns (1-200, default: 50) |
| Timeout | Maximum execution time in seconds (10-3600, default: 600) |

### Session Resume

| Field | Description |
|-------|-------------|
| Resume Session | Continue from a previous session |
| Session ID | Session ID from previous execution output |

## Output

```json
{
  "success": true,
  "output": "Agent's response text...",
  "filesModified": ["/path/to/file1.ts", "/path/to/file2.ts"],
  "sessionId": "abc123",
  "taskId": "f7e8d9c0",
  "branchName": "agent/f7e8d9c0",
  "agentName": "code-reviewer",
  "prs": [
    {
      "repo": "my-app",
      "number": 42,
      "url": "https://github.com/org/my-app/pull/42",
      "provider": "github"
    }
  ],
  "error": null
}
```

## n8n Container Setup

When running n8n in Docker, mount your Claude configuration and skills:

```yaml
volumes:
  - ~/.claude:/home/node/.claude     # Agents, skills, and auth
  - ~/CLAUDE.md:/home/node/CLAUDE.md:ro  # Optional context file
```

The node will automatically find:
- Agents at `/home/node/.claude/agents/`
- Skills at `/home/node/.claude/skills/`

## Security

- Uses `execFile` instead of `exec` to prevent shell injection
- Validates all inputs (branch names, paths, prompts)
- Supports configurable CLAUDE.md context
- Cleans up worktrees after execution

## License

MIT
