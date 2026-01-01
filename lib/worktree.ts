/**
 * Multi-repo worktree management for isolated agent workspaces.
 */

import { simpleGit, type SimpleGit } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { WorktreeError } from './errors.js';
import type { RepoConfig } from './pr-creator.js';

export type { RepoConfig };

export interface MultiRepoWorkspace {
  taskId: string;
  branchName: string;
  worktrees: Map<string, string>;  // repoName -> worktreePath
  workingDir: string;              // Primary working directory for agent
  configs: Map<string, RepoConfig>; // repoName -> config for PR creation
}

interface WorktreeData {
  path: string;
  git: SimpleGit;
  config: RepoConfig;
}

/**
 * Manages multiple git worktrees for a single agent task.
 * Enables synchronized work across multiple repositories.
 */
export class MultiRepoWorktreeManager {
  private taskId: string;
  private branchName: string;
  private configs: RepoConfig[];
  private worktrees: Map<string, WorktreeData>;

  /**
   * Creates a new worktree manager.
   * @param configs - Array of repository configurations
   * @param branchName - Optional branch name (auto-generated if empty)
   */
  constructor(configs: RepoConfig[], branchName?: string) {
    this.taskId = randomUUID().slice(0, 8);
    this.branchName = branchName || `agent/${this.taskId}`;
    this.configs = configs;
    this.worktrees = new Map();
  }

  /**
   * Creates worktrees for all configured repos.
   * Returns a workspace object with paths the agent can use.
   */
  async create(baseBranch: string = 'main'): Promise<MultiRepoWorkspace> {
    for (const config of this.configs) {
      try {
        await this.createSingleWorktree(config, baseBranch);
      } catch (error) {
        // Cleanup any worktrees we already created
        await this.cleanupAll();
        throw error;
      }
    }

    // Create symlinks in primary worktree for easy cross-repo access
    await this.createCrossRepoSymlinks();

    const worktreePaths = new Map<string, string>();
    const repoConfigs = new Map<string, RepoConfig>();

    for (const [key, data] of this.worktrees) {
      worktreePaths.set(key, data.path);
      repoConfigs.set(key, data.config);
    }

    const primaryPath = this.configs.length > 0
      ? this.worktrees.get(this.configs[0].repoName)?.path
      : undefined;

    return {
      taskId: this.taskId,
      branchName: this.branchName,
      worktrees: worktreePaths,
      workingDir: primaryPath || process.cwd(),
      configs: repoConfigs
    };
  }

  /**
   * Creates a single worktree for a repository.
   */
  private async createSingleWorktree(config: RepoConfig, baseBranch: string): Promise<void> {
    // Verify source repo exists
    try {
      await fs.access(config.repoPath);
    } catch {
      throw new WorktreeError(
        `Source repository not found: ${config.repoPath}`,
        config.repoName,
        { repoPath: config.repoPath }
      );
    }

    const git = simpleGit(config.repoPath);
    const worktreePath = path.join(config.worktreesBase, config.repoName, this.taskId);

    // Ensure worktrees directory exists
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });

    // Fetch latest from origin
    try {
      await git.fetch('origin');
    } catch (error) {
      throw new WorktreeError(
        `Failed to fetch from origin: ${error instanceof Error ? error.message : String(error)}`,
        config.repoName
      );
    }

    // Create worktree with new branch
    try {
      await git.raw([
        'worktree', 'add',
        '-b', this.branchName,
        worktreePath,
        `origin/${baseBranch}`
      ]);
    } catch (error) {
      // Branch might already exist from a previous failed attempt
      try {
        await git.raw(['branch', '-D', this.branchName]);
        await git.raw([
          'worktree', 'add',
          '-b', this.branchName,
          worktreePath,
          `origin/${baseBranch}`
        ]);
      } catch (retryError) {
        throw new WorktreeError(
          `Failed to create worktree: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          config.repoName,
          { branchName: this.branchName, worktreePath }
        );
      }
    }

    this.worktrees.set(config.repoName, { path: worktreePath, git, config });
    console.log(`Created worktree for ${config.repoName} at ${worktreePath}`);
  }

  /**
   * Creates symlinks between worktrees for easy cross-repo access.
   */
  private async createCrossRepoSymlinks(): Promise<void> {
    if (this.configs.length <= 1) return;

    const primaryRepo = this.configs[0].repoName;
    const primaryPath = this.worktrees.get(primaryRepo)?.path;
    if (!primaryPath) return;

    for (const config of this.configs.slice(1)) {
      const otherPath = this.worktrees.get(config.repoName)?.path;
      if (otherPath) {
        const linkPath = path.join(primaryPath, config.repoName);
        try {
          await fs.symlink(otherPath, linkPath, 'dir');
        } catch {
          // Symlink might already exist or fail - not critical
        }
      }
    }
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

    for (const [repoKey, data] of this.worktrees) {
      const wtGit = simpleGit(data.path);
      const status = await wtGit.status();

      // Only push if there are commits ahead of origin
      if (status.ahead > 0) {
        try {
          await wtGit.push('origin', this.branchName, ['--set-upstream']);
          results.set(repoKey, { branch: this.branchName, config: data.config });
          console.log(`Pushed ${repoKey} branch: ${this.branchName}`);
        } catch (error) {
          throw new WorktreeError(
            `Failed to push: ${error instanceof Error ? error.message : String(error)}`,
            repoKey
          );
        }
      }
    }

    return results;
  }

  /**
   * Cleans up all worktrees with verification.
   */
  async cleanupAll(): Promise<void> {
    const errors: Error[] = [];

    for (const [repoKey, data] of this.worktrees) {
      try {
        await this.cleanupSingleWorktree(repoKey, data);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    // Prune any orphaned worktrees
    for (const [, data] of this.worktrees) {
      try {
        await data.git.raw(['worktree', 'prune']);
      } catch {
        // Ignore prune errors
      }
    }

    this.worktrees.clear();

    if (errors.length > 0) {
      console.warn(`Cleanup completed with ${errors.length} error(s):`, errors.map(e => e.message));
    }
  }

  /**
   * Cleans up a single worktree.
   */
  private async cleanupSingleWorktree(repoKey: string, data: WorktreeData): Promise<void> {
    try {
      await data.git.raw(['worktree', 'remove', data.path, '--force']);
      console.log(`Cleaned up worktree for ${repoKey}`);
    } catch {
      // Fallback: remove directory manually
      try {
        await fs.rm(data.path, { recursive: true, force: true });

        // Verify cleanup succeeded
        try {
          await fs.access(data.path);
          // Directory still exists - this is an error
          throw new WorktreeError(
            'Worktree directory still exists after cleanup',
            repoKey,
            { path: data.path }
          );
        } catch {
          // Directory doesn't exist - cleanup succeeded
          console.log(`Manually cleaned up worktree for ${repoKey}`);
        }
      } catch (rmError) {
        throw new WorktreeError(
          `Failed to cleanup worktree: ${rmError instanceof Error ? rmError.message : String(rmError)}`,
          repoKey,
          { path: data.path }
        );
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
   * Gets the branch name for this workspace.
   */
  getBranchName(): string {
    return this.branchName;
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
