# Changelog

All notable changes to n8n-claude-agent-pr will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
