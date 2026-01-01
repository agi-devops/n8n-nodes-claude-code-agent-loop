/**
 * Custom error classes for better error handling and debugging.
 */

export class ClaudeAgentError extends Error {
  constructor(message: string, public readonly context?: Record<string, unknown>) {
    super(message);
    this.name = 'ClaudeAgentError';
  }
}

export class WorktreeError extends ClaudeAgentError {
  constructor(
    message: string,
    public readonly repoKey: string,
    context?: Record<string, unknown>
  ) {
    super(message, { repoKey, ...context });
    this.name = 'WorktreeError';
  }
}

export class AgentExecutionError extends ClaudeAgentError {
  constructor(
    message: string,
    public readonly sessionId?: string,
    context?: Record<string, unknown>
  ) {
    super(message, { sessionId, ...context });
    this.name = 'AgentExecutionError';
  }
}

export class PRCreationError extends ClaudeAgentError {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly repo: string,
    context?: Record<string, unknown>
  ) {
    super(message, { provider, repo, ...context });
    this.name = 'PRCreationError';
  }
}

export class ValidationError extends ClaudeAgentError {
  constructor(
    message: string,
    public readonly field: string,
    public readonly value: unknown
  ) {
    super(message, { field, value });
    this.name = 'ValidationError';
  }
}

export class ConfigurationError extends ClaudeAgentError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
    this.name = 'ConfigurationError';
  }
}
