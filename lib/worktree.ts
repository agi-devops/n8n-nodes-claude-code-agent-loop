import { simpleGit, type SimpleGit } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface RepoConfig {
  repoPath: string;      // Source repo path
  worktreesBase: string; // Base for worktrees
  repoName: string;      // Repo identifier
  giteaOwner: string;    // Gitea owner for PR creation
  giteaRepo: string;     // Gitea repo name
}

const REPO_CONFIGS: Record<string, RepoConfig> = {
  m5: {
    repoPath: '/home/node/m5',
    worktreesBase: '/home/node/agent-worktrees',
    repoName: 'm5',
    giteaOwner: 'm5',
    giteaRepo: 'm5'
  },
  wiki: {
    repoPath: '/home/node/wiki',
    worktreesBase: '/home/node/agent-worktrees',
    repoName: 'wiki',
    giteaOwner: 'm5',
    giteaRepo: 'wiki'
  }
};

export interface MultiRepoWorkspace {
  taskId: string;
  worktrees: Map<string, string>;  // repoName -> worktreePath
  workingDir: string;              // Primary working directory for agent
}

/**
 * Manages multiple git worktrees for a single agent task.
 * Enables synchronized work across m5 code and wiki documentation.
 */
export class MultiRepoWorktreeManager {
  private taskId: string;
  private repos: string[];
  private worktrees: Map<string, { path: string; git: SimpleGit; config: RepoConfig }>;

  constructor(repos: string[], taskId?: string) {
    this.taskId = taskId || randomUUID().slice(0, 8);
    this.repos = repos;
    this.worktrees = new Map();
  }

  /**
   * Gets the repo config for a given repo key.
   */
  static getRepoConfig(repoKey: string): RepoConfig | undefined {
    return REPO_CONFIGS[repoKey];
  }

  /**
   * Creates worktrees for all specified repos.
   * Returns a workspace object with paths the agent can use.
   */
  async create(baseBranch: string = 'main'): Promise<MultiRepoWorkspace> {
    const branchName = `agent/${this.taskId}`;

    for (const repoKey of this.repos) {
      const config = REPO_CONFIGS[repoKey];
      if (!config) {
        console.warn(`Unknown repo: ${repoKey}`);
        continue;
      }

      const git = simpleGit(config.repoPath);
      const worktreePath = path.join(config.worktreesBase, config.repoName, this.taskId);

      // Ensure directory exists
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });

      // Fetch latest from origin
      await git.fetch('origin');

      // Create worktree with new branch
      try {
        await git.raw([
          'worktree', 'add',
          '-b', branchName,
          worktreePath,
          `origin/${baseBranch}`
        ]);
      } catch (error) {
        // Branch might already exist from a previous failed attempt
        // Try to remove it and retry
        try {
          await git.raw(['branch', '-D', branchName]);
          await git.raw([
            'worktree', 'add',
            '-b', branchName,
            worktreePath,
            `origin/${baseBranch}`
          ]);
        } catch {
          throw new Error(`Failed to create worktree for ${repoKey}: ${error}`);
        }
      }

      this.worktrees.set(repoKey, { path: worktreePath, git, config });
    }

    // Create symlinks in primary worktree for easy cross-repo access
    // e.g., /agent-worktrees/m5/{taskId}/wiki -> /agent-worktrees/wiki/{taskId}
    const primaryRepo = this.repos[0];
    const primaryPath = this.worktrees.get(primaryRepo)?.path;

    if (primaryPath && this.repos.length > 1) {
      for (const repoKey of this.repos.slice(1)) {
        const otherPath = this.worktrees.get(repoKey)?.path;
        if (otherPath) {
          const linkPath = path.join(primaryPath, repoKey);
          try {
            await fs.symlink(otherPath, linkPath, 'dir');
          } catch {
            // Symlink might already exist or fail, not critical
          }
        }
      }
    }

    const worktreePaths = new Map<string, string>();
    for (const [key, data] of this.worktrees) {
      worktreePaths.set(key, data.path);
    }

    return {
      taskId: this.taskId,
      worktrees: worktreePaths,
      workingDir: primaryPath || '/home/node'
    };
  }

  /**
   * Commits changes in all worktrees with the same message.
   */
  async commitAll(message: string): Promise<void> {
    for (const [repoKey, data] of this.worktrees) {
      const wtGit = simpleGit(data.path);
      const status = await wtGit.status();

      if (status.files.length > 0) {
        await wtGit.add('-A');
        await wtGit.commit(message);
        console.log(`Committed changes in ${repoKey}: ${status.files.length} files`);
      }
    }
  }

  /**
   * Pushes all worktrees and returns branch info for PR creation.
   */
  async pushAll(): Promise<Map<string, { branch: string; config: RepoConfig }>> {
    const results = new Map<string, { branch: string; config: RepoConfig }>();
    const branchName = `agent/${this.taskId}`;

    for (const [repoKey, data] of this.worktrees) {
      const wtGit = simpleGit(data.path);
      const status = await wtGit.status();

      // Only push if there are commits ahead of origin
      if (status.ahead > 0) {
        await wtGit.push('origin', branchName, ['--set-upstream']);
        results.set(repoKey, { branch: branchName, config: data.config });
        console.log(`Pushed ${repoKey} branch: ${branchName}`);
      }
    }

    return results;
  }

  /**
   * Cleans up all worktrees.
   */
  async cleanupAll(): Promise<void> {
    for (const [repoKey, data] of this.worktrees) {
      try {
        await data.git.raw(['worktree', 'remove', data.path, '--force']);
        console.log(`Cleaned up worktree for ${repoKey}`);
      } catch {
        // Fallback: remove directory manually
        try {
          await fs.rm(data.path, { recursive: true, force: true });
          await data.git.raw(['worktree', 'prune']);
        } catch {
          console.warn(`Failed to cleanup worktree for ${repoKey}`);
        }
      }
    }
  }

  /**
   * Gets the task ID for this workspace.
   */
  getTaskId(): string {
    return this.taskId;
  }

  /**
   * Gets worktree data for a specific repo.
   */
  getWorktree(repoKey: string): { path: string; config: RepoConfig } | undefined {
    const data = this.worktrees.get(repoKey);
    if (data) {
      return { path: data.path, config: data.config };
    }
    return undefined;
  }
}
