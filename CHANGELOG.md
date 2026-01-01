# Changelog

All notable changes to n8n-claude-agent-pr will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-01-01

### Added
- **Conversation Mode** - New dropdown to choose between "New Conversation" and "Continue Conversation"
- **Session Timeout** - Configurable timeout (1-120 minutes, default 30) for session expiration
- **Conversation Context** - JSON input for providing previous message history to agents
- **Enhanced Output Metadata**:
  - `turnCount` - Number of conversation turns in this execution
  - `sessionCreated` - ISO timestamp when session started
  - `lastActivity` - ISO timestamp of last activity
  - `conversationSummary` - Brief summary of recent exchanges
  - `hasAction` - Boolean indicating if files were modified or issues created
  - `conversationMode` - Which mode was used for this execution

### Changed
- Agent name is now only required for new conversations (hidden in continue mode)
- Session ID input is now required and prominent in continue mode
- SDK wrapper includes conversation context in prompts for multi-turn awareness
- Output structure includes full session metadata for workflow state management

## [1.2.0] - 2026-01-01

### Added
- **Claude Code Skills integration** - Automatically loads and injects all skills from `~/.claude/skills/`
- New `skill-loader.ts` module for discovering and parsing SKILL.md files
- Skills are injected into agent system prompt with full command references

### Changed
- Agent system prompts now include skills context with all available CLI tools
- Skills use YAML frontmatter format: `name`, `description`, `allowed-tools`

## [1.1.0] - 2025-01-01

### Changed
- Agent names are now freely choosable text input instead of dropdown
- Uses native Claude Code agents from `~/.claude/agents/` directory
- Removed bundled predefined agents - users define their own

### Fixed
- Agent loader now properly searches both container and host paths

## [1.0.0] - 2025-01-01

### Added
- Initial public release
- Claude Agent node with native SDK integration
- Multi-repository support with git worktrees
- PR creation for Gitea and GitHub
- Session resume for multi-turn interactions
- Predefined agents: code-reviewer, wiki-editor, auto-fixer
- Custom agent support via markdown files
- Input validation and security hardening
- Configurable timeouts and turn limits
- Claude sunglasses icon

### Security
- Uses `execFile` instead of `exec` to prevent shell injection
- Validates git branch names against RFC patterns
- Validates file paths to prevent traversal attacks
- Limits prompt size to 50KB
