# n8n-nodes-claude-agent

n8n community node for running Claude Code agents with native SDK integration.

**Features:**
- Run predefined or custom Claude agents
- Multi-repository support with git worktrees
- Automatic PR creation (Gitea & GitHub)
- Session resume for multi-turn interactions
- Configurable timeouts and turn limits

## Installation

Install via n8n Community Nodes:

1. Go to **Settings > Community Nodes**
2. Select **Install**
3. Enter `n8n-nodes-claude-agent`
4. Click **Install**

Or install manually:
```bash
npm install n8n-nodes-claude-agent
```

## Prerequisites

- **Claude Code CLI** authenticated (`claude` command available)
- **Git** for worktree operations
- Optional: `gitea` or `github` CLI for PR creation

## Node Configuration

### Agent Selection

| Field | Description |
|-------|-------------|
| Agent Name | Select a predefined agent or "Custom" |
| Custom Agent Path | Path to custom agent markdown file (when "Custom" selected) |

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

## Custom Agents

Create custom agents using markdown files with optional YAML frontmatter:

```markdown
---
tools: [Read, Write, Edit, Bash, Grep, Glob]
model: claude-sonnet-4-20250514
---
# My Custom Agent

You are a specialized agent for...

## Guidelines
- Follow coding standards
- Write tests for new code
- Document changes
```

Place custom agents in `~/.claude/agents/` or specify the full path.

## Built-in Agents

| Agent | Description |
|-------|-------------|
| `code-reviewer` | Reviews code and suggests improvements |
| `wiki-editor` | Edits wiki documentation |
| `auto-fixer` | Automatically fixes issues |

## Security

- Uses `execFile` instead of `exec` to prevent shell injection
- Validates all inputs (branch names, paths, prompts)
- Supports configurable CLAUDE.md context
- Cleans up worktrees after execution

## License

MIT
