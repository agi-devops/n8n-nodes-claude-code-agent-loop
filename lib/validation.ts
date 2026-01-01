/**
 * Input validation utilities.
 */

import { ValidationError } from './errors.js';

// Git branch name pattern (RFC compliant)
const GIT_BRANCH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/;

// Maximum lengths
const MAX_PROMPT_LENGTH = 50 * 1024; // 50KB
const MAX_BRANCH_NAME_LENGTH = 255;
const MAX_PATH_LENGTH = 4096;

// Timeout limits
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 3600;

// Max turns limits
const MIN_MAX_TURNS = 1;
const MAX_MAX_TURNS = 200;

/**
 * Validates a git branch name.
 */
export function validateBranchName(name: string): void {
  if (!name) return; // Empty is allowed (auto-generated)

  if (name.length > MAX_BRANCH_NAME_LENGTH) {
    throw new ValidationError(
      `Branch name too long (max ${MAX_BRANCH_NAME_LENGTH} characters)`,
      'branchName',
      name.slice(0, 50) + '...'
    );
  }

  if (!GIT_BRANCH_PATTERN.test(name)) {
    throw new ValidationError(
      'Invalid branch name. Use only alphanumeric characters, dots, underscores, dashes, and forward slashes.',
      'branchName',
      name
    );
  }

  // Check for dangerous patterns
  if (name.includes('..') || name.startsWith('/') || name.endsWith('/')) {
    throw new ValidationError(
      'Branch name cannot contain "..", start with "/", or end with "/"',
      'branchName',
      name
    );
  }
}

/**
 * Validates a prompt string.
 */
export function validatePrompt(prompt: string): void {
  if (!prompt || prompt.trim().length === 0) {
    throw new ValidationError('Prompt cannot be empty', 'prompt', '');
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new ValidationError(
      `Prompt too long (max ${MAX_PROMPT_LENGTH / 1024}KB)`,
      'prompt',
      `${prompt.length} characters`
    );
  }
}

/**
 * Validates timeout value.
 */
export function validateTimeout(timeout: number): void {
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_SECONDS || timeout > MAX_TIMEOUT_SECONDS) {
    throw new ValidationError(
      `Timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds`,
      'timeout',
      timeout
    );
  }
}

/**
 * Validates maxTurns value.
 */
export function validateMaxTurns(maxTurns: number): void {
  if (!Number.isInteger(maxTurns) || maxTurns < MIN_MAX_TURNS || maxTurns > MAX_MAX_TURNS) {
    throw new ValidationError(
      `Max turns must be between ${MIN_MAX_TURNS} and ${MAX_MAX_TURNS}`,
      'maxTurns',
      maxTurns
    );
  }
}

/**
 * Validates a file path.
 */
export function validatePath(filePath: string, fieldName: string): void {
  if (!filePath) {
    throw new ValidationError(`${fieldName} cannot be empty`, fieldName, '');
  }

  if (filePath.length > MAX_PATH_LENGTH) {
    throw new ValidationError(
      `${fieldName} too long (max ${MAX_PATH_LENGTH} characters)`,
      fieldName,
      filePath.slice(0, 50) + '...'
    );
  }

  // Check for path traversal
  if (filePath.includes('..')) {
    throw new ValidationError(
      `${fieldName} cannot contain path traversal (..)`,
      fieldName,
      filePath
    );
  }
}

/**
 * Validates repository configuration.
 */
export function validateRepoConfig(config: {
  localPath: string;
  worktreesBase: string;
  gitProvider: string;
  remoteOwner?: string;
  remoteRepo?: string;
}): void {
  validatePath(config.localPath, 'localPath');
  validatePath(config.worktreesBase, 'worktreesBase');

  const validProviders = ['gitea', 'github', 'none'];
  if (!validProviders.includes(config.gitProvider)) {
    throw new ValidationError(
      `Invalid git provider. Must be one of: ${validProviders.join(', ')}`,
      'gitProvider',
      config.gitProvider
    );
  }

  // If provider is not 'none', require owner and repo
  if (config.gitProvider !== 'none') {
    if (!config.remoteOwner) {
      throw new ValidationError(
        'Remote owner is required when git provider is configured',
        'remoteOwner',
        ''
      );
    }
    if (!config.remoteRepo) {
      throw new ValidationError(
        'Remote repo is required when git provider is configured',
        'remoteRepo',
        ''
      );
    }
  }
}

/**
 * Sanitizes a string for safe shell usage (for display only, not execution).
 */
export function sanitizeForDisplay(str: string, maxLength: number = 100): string {
  return str
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .slice(0, maxLength);
}
