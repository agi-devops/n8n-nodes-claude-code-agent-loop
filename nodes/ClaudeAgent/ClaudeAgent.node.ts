import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from 'n8n-workflow';

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { loadAgent } from '../../lib/agent-loader.js';
import { MultiRepoWorktreeManager, type RepoConfig } from '../../lib/worktree.js';
import { executeAgent } from '../../lib/sdk-wrapper.js';
import { createMultiRepoPRs, type PRResult } from '../../lib/pr-creator.js';
import {
  validatePrompt,
  validateBranchName,
  validateTimeout,
  validateMaxTurns,
  validateRepoConfig,
} from '../../lib/validation.js';

export class ClaudeAgent implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Claude Agent',
    name: 'claudeAgent',
    icon: 'file:claude-agent.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["agentName"]}}',
    description: 'Run Claude Code Agent with native SDK - multi-repo support, session resume',
    defaults: {
      name: 'Claude Agent',
    },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      // === Agent Selection ===
      {
        displayName: 'Agent Name',
        name: 'agentName',
        type: 'string',
        default: '',
        required: true,
        description: 'Name of the Claude Code agent (from ~/.claude/agents/<name>.md)',
        placeholder: 'e.g., code-reviewer, my-custom-agent',
      },

      // === Repository Configuration ===
      {
        displayName: 'Repositories',
        name: 'repositories',
        type: 'fixedCollection',
        typeOptions: {
          multipleValues: true,
        },
        default: {},
        description: 'Configure repositories for the agent to work with. Leave empty for prompt-only mode (no git operations).',
        options: [
          {
            name: 'repos',
            displayName: 'Repository',
            values: [
              {
                displayName: 'Name',
                name: 'repoName',
                type: 'string',
                default: '',
                required: true,
                description: 'Unique identifier for this repository',
              },
              {
                displayName: 'Local Path',
                name: 'localPath',
                type: 'string',
                default: '',
                required: true,
                description: 'Absolute path to the local git repository',
              },
              {
                displayName: 'Worktrees Directory',
                name: 'worktreesBase',
                type: 'string',
                default: '',
                required: true,
                description: 'Directory where worktrees will be created',
              },
              {
                displayName: 'Git Provider',
                name: 'gitProvider',
                type: 'options',
                options: [
                  { name: 'Gitea', value: 'gitea' },
                  { name: 'GitHub', value: 'github' },
                  { name: 'None (No PRs)', value: 'none' },
                ],
                default: 'gitea',
                description: 'Git provider for PR creation',
              },
              {
                displayName: 'Remote Owner',
                name: 'remoteOwner',
                type: 'string',
                default: '',
                displayOptions: {
                  hide: {
                    gitProvider: ['none'],
                  },
                },
                description: 'Owner/organization on the git provider',
              },
              {
                displayName: 'Remote Repo',
                name: 'remoteRepo',
                type: 'string',
                default: '',
                displayOptions: {
                  hide: {
                    gitProvider: ['none'],
                  },
                },
                description: 'Repository name on the git provider',
              },
            ],
          },
        ],
      },

      // === Task Configuration ===
      {
        displayName: 'Prompt',
        name: 'prompt',
        type: 'string',
        typeOptions: {
          rows: 6,
        },
        default: '',
        required: true,
        description: 'Task prompt for the agent (max 50KB)',
      },
      {
        displayName: 'Branch Name',
        name: 'branchName',
        type: 'string',
        default: '',
        description: 'Git branch name (auto-generated if empty)',
      },
      {
        displayName: 'Base Branch',
        name: 'baseBranch',
        type: 'string',
        default: 'main',
        description: 'Base branch to create worktrees from',
      },
      {
        displayName: 'Create Pull Request',
        name: 'createPR',
        type: 'boolean',
        default: true,
        description: 'Create PR after changes are made',
      },

      // === Model Settings ===
      {
        displayName: 'Model',
        name: 'model',
        type: 'options',
        options: [
          { name: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514' },
          { name: 'Claude Opus 4', value: 'claude-opus-4-20250514' },
          { name: 'Claude Haiku 3.5', value: 'claude-3-5-haiku-20241022' },
        ],
        default: 'claude-sonnet-4-20250514',
        description: 'Model to use (can be overridden by agent definition)',
      },
      {
        displayName: 'Max Turns',
        name: 'maxTurns',
        type: 'number',
        typeOptions: {
          minValue: 1,
          maxValue: 200,
        },
        default: 50,
        description: 'Maximum agent conversation turns (1-200)',
      },
      {
        displayName: 'Timeout (seconds)',
        name: 'timeout',
        type: 'number',
        typeOptions: {
          minValue: 10,
          maxValue: 3600,
        },
        default: 600,
        description: 'Maximum execution time in seconds (10-3600)',
      },

      // === Session Resume ===
      {
        displayName: 'Resume Session',
        name: 'resumeSession',
        type: 'boolean',
        default: false,
        description: 'Continue from a previous session',
      },
      {
        displayName: 'Session ID',
        name: 'sessionId',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            resumeSession: [true],
          },
        },
        description: 'Session ID from previous execution (from output.sessionId)',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const results: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        // Get parameters
        const agentName = this.getNodeParameter('agentName', i) as string;
        const repositoriesParam = this.getNodeParameter('repositories', i, {}) as {
          repos?: Array<{
            repoName: string;
            localPath: string;
            worktreesBase: string;
            gitProvider: 'gitea' | 'github' | 'none';
            remoteOwner?: string;
            remoteRepo?: string;
          }>;
        };
        const prompt = this.getNodeParameter('prompt', i) as string;
        const branchName = this.getNodeParameter('branchName', i, '') as string;
        const baseBranch = this.getNodeParameter('baseBranch', i, 'main') as string;
        const createPR = this.getNodeParameter('createPR', i, true) as boolean;
        const model = this.getNodeParameter('model', i, 'claude-sonnet-4-20250514') as string;
        const maxTurns = this.getNodeParameter('maxTurns', i, 50) as number;
        const timeout = this.getNodeParameter('timeout', i, 600) as number;
        const resumeSession = this.getNodeParameter('resumeSession', i, false) as boolean;
        const sessionId = this.getNodeParameter('sessionId', i, '') as string;

        // Validate inputs
        try {
          validatePrompt(prompt);
          validateBranchName(branchName);
          validateBranchName(baseBranch);
          validateTimeout(timeout);
          validateMaxTurns(maxTurns);
        } catch (validationError) {
          throw new NodeOperationError(
            this.getNode(),
            validationError instanceof Error ? validationError.message : String(validationError),
            { itemIndex: i }
          );
        }

        // Build repo configs
        const repos = repositoriesParam.repos || [];
        const isPromptOnlyMode = repos.length === 0;

        // 1. Load agent definition from ~/.claude/agents/<name>.md
        const agent = await loadAgent(agentName);
        console.log(`Loaded agent: ${agent.name}`);

        let executionResult;
        let prs: PRResult[] = [];
        let taskId = '';
        let finalBranchName = '';

        if (isPromptOnlyMode) {
          // === PROMPT-ONLY MODE ===
          // No git operations, just run the agent in a temp directory
          const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-agent-'));
          taskId = path.basename(tempDir);

          console.log(`Prompt-only mode: working in ${tempDir}`);

          try {
            executionResult = await executeAgent({
              agentPrompt: agent.systemPrompt,
              workingDir: tempDir,
              worktrees: new Map(),
              model: agent.model || model,
              maxTurns,
              timeout,
              resumeSessionId: resumeSession ? sessionId : undefined,
              allowedTools: agent.tools,
            }, prompt);

            console.log(`Agent execution completed: success=${executionResult.success}`);
            console.log(`Session ID: ${executionResult.sessionId}`);
          } finally {
            // Cleanup temp directory
            try {
              await fs.rm(tempDir, { recursive: true, force: true });
              console.log(`Cleaned up temp directory: ${tempDir}`);
            } catch (cleanupError) {
              console.warn(`Failed to cleanup temp directory: ${cleanupError}`);
            }
          }
        } else {
          // === REPOSITORY MODE ===
          // Full git worktree support with optional PR creation
          const repoConfigs: RepoConfig[] = [];
          for (const repo of repos) {
            try {
              validateRepoConfig({
                localPath: repo.localPath,
                worktreesBase: repo.worktreesBase,
                gitProvider: repo.gitProvider,
                remoteOwner: repo.remoteOwner,
                remoteRepo: repo.remoteRepo,
              });
            } catch (validationError) {
              throw new NodeOperationError(
                this.getNode(),
                `Repository "${repo.repoName}": ${validationError instanceof Error ? validationError.message : String(validationError)}`,
                { itemIndex: i }
              );
            }

            repoConfigs.push({
              repoPath: repo.localPath,
              worktreesBase: repo.worktreesBase,
              repoName: repo.repoName,
              gitProvider: repo.gitProvider,
              remoteOwner: repo.remoteOwner || '',
              remoteRepo: repo.remoteRepo || '',
            });
          }

          // Create multi-repo worktrees
          const worktreeManager = new MultiRepoWorktreeManager(
            repoConfigs,
            branchName || undefined
          );
          const workspace = await worktreeManager.create(baseBranch);

          taskId = workspace.taskId;
          finalBranchName = workspace.branchName;

          console.log(`Created workspace: ${workspace.taskId}`);
          console.log(`Working directory: ${workspace.workingDir}`);
          console.log(`Branch: ${workspace.branchName}`);

          try {
            // Execute agent with SDK
            executionResult = await executeAgent({
              agentPrompt: agent.systemPrompt,
              workingDir: workspace.workingDir,
              worktrees: workspace.worktrees,
              model: agent.model || model,
              maxTurns,
              timeout,
              resumeSessionId: resumeSession ? sessionId : undefined,
              allowedTools: agent.tools,
            }, prompt);

            console.log(`Agent execution completed: success=${executionResult.success}`);
            console.log(`Files modified: ${executionResult.filesModified.length}`);
            console.log(`Session ID: ${executionResult.sessionId}`);

            // Commit and push if changes were made and PR requested
            if (createPR && executionResult.filesModified.length > 0) {
              const commitMessage = `Agent: ${agent.name}\n\n${prompt.slice(0, 200)}`;
              await worktreeManager.commitAll(commitMessage);

              const pushResults = await worktreeManager.pushAll();

              if (pushResults.size > 0) {
                const prResult = await createMultiRepoPRs({
                  taskId: workspace.taskId,
                  repos: pushResults,
                  baseBranch,
                  title: `[Agent/${agent.name}] ${prompt.slice(0, 60)}`,
                  body: executionResult.output.slice(0, 2000),
                });
                prs = prResult.prs;

                console.log(`Created ${prs.length} PRs`);
              }
            }
          } finally {
            // Always cleanup worktrees
            await worktreeManager.cleanupAll();
            console.log(`Cleaned up workspace: ${workspace.taskId}`);
          }
        }

        // Return result
        results.push({
          json: {
            success: executionResult.success,
            output: executionResult.output,
            filesModified: executionResult.filesModified,
            sessionId: executionResult.sessionId,
            taskId,
            branchName: finalBranchName,
            agentName: agent.name,
            prs: prs.map(pr => ({
              repo: pr.repoName,
              number: pr.number,
              url: pr.url,
              provider: pr.provider,
            })),
            error: executionResult.error,
          },
        });

      } catch (error) {
        if (this.continueOnFail()) {
          results.push({
            json: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        } else {
          throw error;
        }
      }
    }

    return [results];
  }
}
