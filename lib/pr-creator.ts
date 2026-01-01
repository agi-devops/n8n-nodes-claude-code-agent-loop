/**
 * Multi-provider PR creation with secure command execution.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { PRCreationError } from './errors.js';
import { validateBranchName } from './validation.js';

const execFileAsync = promisify(execFile);

export interface RepoConfig {
  repoPath: string;
  worktreesBase: string;
  repoName: string;
  gitProvider: 'gitea' | 'github' | 'none';
  remoteOwner: string;
  remoteRepo: string;
  // Optional: custom CLI paths
  giteaCliPath?: string;
  githubCliPath?: string;
}

export interface PRResult {
  repoName: string;
  url: string;
  number: number;
  provider: string;
}

export interface MultiPRResult {
  taskId: string;
  prs: PRResult[];
  linkedDescription: string;
}

/**
 * Git provider interface for PR creation abstraction.
 */
interface GitProvider {
  name: string;
  createPR(options: CreatePROptions): Promise<PRResult>;
  updatePRBody?(config: RepoConfig, prNumber: number, body: string): Promise<void>;
}

interface CreatePROptions {
  config: RepoConfig;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

/**
 * Gitea provider implementation using the gitea CLI.
 */
class GiteaProvider implements GitProvider {
  name = 'gitea';
  private cliPath: string;

  constructor(cliPath: string = 'gitea') {
    this.cliPath = cliPath;
  }

  async createPR(options: CreatePROptions): Promise<PRResult> {
    const { config, branch, baseBranch, title, body } = options;

    // Validate inputs
    validateBranchName(branch);
    validateBranchName(baseBranch);

    const repoPath = `${config.remoteOwner}/${config.remoteRepo}`;

    try {
      // Use execFile with array arguments - no shell injection possible
      const { stdout } = await execFileAsync(
        this.cliPath,
        [
          'pr:create',
          repoPath,
          branch,
          baseBranch,
          title,
          `--body=${body}`
        ],
        { timeout: 30000 }
      );

      // Parse PR number from output
      const prMatch = stdout.match(/PR #(\d+)/i) || stdout.match(/#(\d+)/);
      const prNumber = prMatch ? parseInt(prMatch[1], 10) : 0;

      return {
        repoName: config.repoName,
        url: `https://gitea.devops.methode5.at/${repoPath}/pulls/${prNumber}`,
        number: prNumber,
        provider: this.name
      };
    } catch (error) {
      throw new PRCreationError(
        `Failed to create Gitea PR: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        repoPath,
        { branch, baseBranch }
      );
    }
  }

  async updatePRBody(config: RepoConfig, prNumber: number, body: string): Promise<void> {
    const repoPath = `${config.remoteOwner}/${config.remoteRepo}`;
    const jsonBody = JSON.stringify({ body });

    try {
      await execFileAsync(
        this.cliPath,
        ['raw:patch', `repos/${repoPath}/pulls/${prNumber}`, jsonBody],
        { timeout: 30000 }
      );
    } catch (error) {
      // Non-fatal - PR was created, just couldn't update body
      console.warn(`Failed to update Gitea PR body for ${repoPath}#${prNumber}:`, error);
    }
  }
}

/**
 * GitHub provider implementation using the github CLI.
 */
class GitHubProvider implements GitProvider {
  name = 'github';
  private cliPath: string;

  constructor(cliPath: string = 'github') {
    this.cliPath = cliPath;
  }

  async createPR(options: CreatePROptions): Promise<PRResult> {
    const { config, branch, baseBranch, title, body } = options;

    // Validate inputs
    validateBranchName(branch);
    validateBranchName(baseBranch);

    const repoPath = `${config.remoteOwner}/${config.remoteRepo}`;

    try {
      // Use execFile with array arguments
      const { stdout } = await execFileAsync(
        this.cliPath,
        [
          'pr:create',
          repoPath,
          branch,
          baseBranch,
          title,
          `--body=${body}`
        ],
        { timeout: 30000 }
      );

      // Parse PR number from output
      const prMatch = stdout.match(/PR #(\d+)/i) || stdout.match(/#(\d+)/);
      const prNumber = prMatch ? parseInt(prMatch[1], 10) : 0;

      return {
        repoName: config.repoName,
        url: `https://github.com/${repoPath}/pull/${prNumber}`,
        number: prNumber,
        provider: this.name
      };
    } catch (error) {
      throw new PRCreationError(
        `Failed to create GitHub PR: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        repoPath,
        { branch, baseBranch }
      );
    }
  }

  async updatePRBody(config: RepoConfig, prNumber: number, body: string): Promise<void> {
    const repoPath = `${config.remoteOwner}/${config.remoteRepo}`;
    const jsonBody = JSON.stringify({ body });

    try {
      await execFileAsync(
        this.cliPath,
        ['raw:patch', `repos/${repoPath}/pulls/${prNumber}`, jsonBody],
        { timeout: 30000 }
      );
    } catch (error) {
      console.warn(`Failed to update GitHub PR body for ${repoPath}#${prNumber}:`, error);
    }
  }
}

/**
 * No-op provider when PR creation is disabled.
 */
class NoOpProvider implements GitProvider {
  name = 'none';

  async createPR(): Promise<PRResult> {
    throw new PRCreationError('PR creation is disabled for this repository', 'none', '');
  }
}

/**
 * Factory function to get the appropriate provider.
 */
function getProvider(config: RepoConfig): GitProvider {
  switch (config.gitProvider) {
    case 'gitea':
      return new GiteaProvider(config.giteaCliPath);
    case 'github':
      return new GitHubProvider(config.githubCliPath);
    case 'none':
    default:
      return new NoOpProvider();
  }
}

/**
 * Creates PRs for all repos that have changes.
 * PRs are cross-linked so reviewers can see related changes.
 */
export async function createMultiRepoPRs(options: {
  taskId: string;
  repos: Map<string, { branch: string; config: RepoConfig }>;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<MultiPRResult> {
  const prs: PRResult[] = [];
  const repoList = Array.from(options.repos.entries());

  if (repoList.length === 0) {
    return {
      taskId: options.taskId,
      prs: [],
      linkedDescription: options.body
    };
  }

  // First pass: create all PRs with placeholder body
  for (const [, { branch, config }] of repoList) {
    // Skip repos with no provider configured
    if (config.gitProvider === 'none') {
      console.log(`Skipping PR creation for ${config.repoName} (no provider configured)`);
      continue;
    }

    try {
      const provider = getProvider(config);
      const pr = await provider.createPR({
        config,
        branch,
        baseBranch: options.baseBranch,
        title: options.title,
        body: 'Creating PR... (will update with links)'
      });
      prs.push(pr);
    } catch (error) {
      console.error(`Failed to create PR for ${config.repoName}:`, error);
      // Continue with other repos
    }
  }

  // Build cross-linked description
  let linkedDescription = options.body + '\n\n---\n\n## Related PRs\n\n';
  linkedDescription += `Task ID: \`${options.taskId}\`\n\n`;
  for (const pr of prs) {
    linkedDescription += `- [${pr.repoName}: PR #${pr.number}](${pr.url}) (${pr.provider})\n`;
  }
  linkedDescription += '\n\n---\n*Generated by Claude Agent*';

  // Second pass: update PRs with cross-links
  for (const pr of prs) {
    const repoData = options.repos.get(pr.repoName);
    if (repoData) {
      const provider = getProvider(repoData.config);
      if (provider instanceof GiteaProvider || provider instanceof GitHubProvider) {
        await provider.updatePRBody(repoData.config, pr.number, linkedDescription);
      }
    }
  }

  return {
    taskId: options.taskId,
    prs,
    linkedDescription
  };
}

/**
 * Creates a single PR for a single repo (simpler case).
 */
export async function createPR(options: {
  config: RepoConfig;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<PRResult> {
  if (options.config.gitProvider === 'none') {
    throw new PRCreationError(
      'PR creation is disabled for this repository',
      'none',
      options.config.repoName
    );
  }

  const provider = getProvider(options.config);
  return provider.createPR(options);
}
