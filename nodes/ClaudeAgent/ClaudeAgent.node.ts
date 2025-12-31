import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from 'n8n-workflow';

import { loadAgent, loadAgentFromPath } from '../../lib/agent-loader.js';
import { MultiRepoWorktreeManager } from '../../lib/worktree.js';
import { executeAgent } from '../../lib/sdk-wrapper.js';
import { createMultiRepoPRs, type PRResult } from '../../lib/pr-creator.js';

export class ClaudeAgent implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Claude Agent',
    name: 'claudeAgent',
    icon: 'file:claude-agent.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["agentName"]}}',
    description: 'Run Claude Code Agent with native SDK - multi-repo support, session resume, wiki sync',
    defaults: {
      name: 'Claude Agent',
    },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      // Agent Selection
      {
        displayName: 'Agent Name',
        name: 'agentName',
        type: 'options',
        options: [
          { name: 'Code Reviewer', value: 'code-reviewer' },
          { name: 'Wiki Editor', value: 'wiki-editor' },
          { name: 'Auto Fixer', value: 'auto-fixer' },
          { name: 'Custom', value: 'custom' },
        ],
        default: 'code-reviewer',
        description: 'Select a predefined agent or use custom',
      },
      {
        displayName: 'Custom Agent Path',
        name: 'customAgentPath',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            agentName: ['custom'],
          },
        },
        description: 'Absolute path to custom agent markdown file',
      },

      // Repository Selection
      {
        displayName: 'Repositories',
        name: 'repositories',
        type: 'multiOptions',
        options: [
          { name: 'M5 Project', value: 'm5' },
          { name: 'Wiki', value: 'wiki' },
        ],
        default: ['m5'],
        description: 'Select repos to work with. Multiple repos = synced worktrees.',
      },
      {
        displayName: 'Sync Wiki Docs',
        name: 'syncWikiDocs',
        type: 'boolean',
        default: true,
        description: 'Automatically update wiki when code changes are made (requires both m5 and wiki selected)',
      },

      // Task Configuration
      {
        displayName: 'Prompt',
        name: 'prompt',
        type: 'string',
        typeOptions: {
          rows: 6,
        },
        default: '',
        required: true,
        description: 'Task prompt for the agent',
      },
      {
        displayName: 'Branch Name',
        name: 'branchName',
        type: 'string',
        default: '',
        description: 'Git branch name (auto-generated if empty)',
      },
      {
        displayName: 'Create Pull Request',
        name: 'createPR',
        type: 'boolean',
        default: true,
        description: 'Create PR after changes are made',
      },

      // Model Settings
      {
        displayName: 'Model',
        name: 'model',
        type: 'options',
        options: [
          { name: 'Claude Sonnet 4', value: 'claude-sonnet-4-5-20250929' },
          { name: 'Claude Opus 4', value: 'claude-opus-4-5-20250929' },
          { name: 'Claude Haiku 3.5', value: 'claude-3-5-haiku-20241022' },
        ],
        default: 'claude-sonnet-4-5-20250929',
        description: 'Model to use (can be overridden by agent definition)',
      },
      {
        displayName: 'Max Turns',
        name: 'maxTurns',
        type: 'number',
        default: 50,
        description: 'Maximum agent conversation turns',
      },
      {
        displayName: 'Timeout (seconds)',
        name: 'timeout',
        type: 'number',
        default: 600,
        description: 'Maximum execution time in seconds',
      },

      // Session Resume
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
        const customAgentPath = this.getNodeParameter('customAgentPath', i, '') as string;
        const repositories = this.getNodeParameter('repositories', i) as string[];
        const syncWikiDocs = this.getNodeParameter('syncWikiDocs', i, true) as boolean;
        const prompt = this.getNodeParameter('prompt', i) as string;
        const branchName = this.getNodeParameter('branchName', i, '') as string;
        const createPR = this.getNodeParameter('createPR', i, true) as boolean;
        const model = this.getNodeParameter('model', i, 'claude-sonnet-4-5-20250929') as string;
        const maxTurns = this.getNodeParameter('maxTurns', i, 50) as number;
        const timeout = this.getNodeParameter('timeout', i, 600) as number;
        const resumeSession = this.getNodeParameter('resumeSession', i, false) as boolean;
        const sessionId = this.getNodeParameter('sessionId', i, '') as string;

        if (!prompt) {
          throw new NodeOperationError(this.getNode(), 'Prompt is required', { itemIndex: i });
        }

        if (repositories.length === 0) {
          throw new NodeOperationError(this.getNode(), 'At least one repository must be selected', { itemIndex: i });
        }

        // 1. Load agent definition
        const agent = agentName === 'custom' && customAgentPath
          ? await loadAgentFromPath(customAgentPath)
          : await loadAgent(agentName);

        console.log(`Loaded agent: ${agent.name}`);

        // 2. Create multi-repo worktrees
        const worktreeManager = new MultiRepoWorktreeManager(
          repositories,
          branchName || undefined
        );
        const workspace = await worktreeManager.create();

        console.log(`Created workspace: ${workspace.taskId}`);
        console.log(`Working directory: ${workspace.workingDir}`);

        let executionResult;
        let prs: PRResult[] = [];

        try {
          // 3. Execute agent with V2 SDK
          executionResult = await executeAgent({
            agentPrompt: agent.systemPrompt,
            workingDir: workspace.workingDir,
            worktrees: workspace.worktrees,
            syncWikiDocs: syncWikiDocs && repositories.includes('m5') && repositories.includes('wiki'),
            model: agent.model || model,
            maxTurns,
            timeout,
            resumeSessionId: resumeSession ? sessionId : undefined,
            allowedTools: agent.tools,
          }, prompt);

          console.log(`Agent execution completed: success=${executionResult.success}`);
          console.log(`Files modified: ${executionResult.filesModified.length}`);
          console.log(`Session ID: ${executionResult.sessionId}`);

          // 4. Commit and push if changes were made and PR requested
          if (createPR && executionResult.filesModified.length > 0) {
            const commitMessage = `Agent: ${agent.name}\n\n${prompt.slice(0, 200)}`;
            await worktreeManager.commitAll(commitMessage);

            const pushResults = await worktreeManager.pushAll();

            if (pushResults.size > 0) {
              const prResult = await createMultiRepoPRs({
                taskId: workspace.taskId,
                repos: pushResults,
                baseBranch: 'main',
                title: `[Agent/${agent.name}] ${prompt.slice(0, 60)}`,
                body: executionResult.output.slice(0, 2000),
              });
              prs = prResult.prs;

              console.log(`Created ${prs.length} PRs`);
            }
          }
        } finally {
          // 5. Always cleanup worktrees
          await worktreeManager.cleanupAll();
          console.log(`Cleaned up workspace: ${workspace.taskId}`);
        }

        // Return result
        results.push({
          json: {
            success: executionResult.success,
            output: executionResult.output,
            filesModified: executionResult.filesModified,
            sessionId: executionResult.sessionId,
            taskId: workspace.taskId,
            agentName: agent.name,
            prs: prs.map(pr => ({
              repo: pr.repoName,
              number: pr.number,
              url: pr.url,
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
