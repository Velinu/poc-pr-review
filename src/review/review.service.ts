import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { createAgent, tool } from 'langchain';
import * as z from 'zod';
import { CreatePrDto } from './dto/create-pr.dto.js';
import { ReviewPrDto } from './dto/review-pr.dto.js';
import { AGENT_SYSTEM_PROMPT } from './prompts/agent.prompt.js';

@Injectable()
export class ReviewService {
  private github: AxiosInstance;
  private owner: string;

  constructor() {
    this.owner = process.env.USER!;
    this.github = axios.create({
      baseURL: 'https://api.github.com',
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }

  async createPullRequest(dto: CreatePrDto) {
    const github = this.github;
    const owner = this.owner;

    const compareBranches = tool(
      async (input: { repo: string; head: string; base: string }) => {
        const { data } = await github.get(
          `/repos/${owner}/${input.repo}/compare/${input.base}...${input.head}`,
        );

        return JSON.stringify({
          commits: data.commits.map((commit: any) => ({
            message: commit.commit.message,
            author: commit.commit.author.name,
          })),
          files: data.files.map((file: any) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch: file.patch?.slice(0, 2000),
          })),
        });
      },
      {
        name: 'compare_branches',
        description: 'Compare two branches and get commits and file diffs',
        schema: z.object({
          repo: z.string().describe('Repository name'),
          head: z.string().describe('Source branch'),
          base: z.string().describe('Target branch'),
        }),
      },
    );

    const createPr = tool(
      async (input: {
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
      }) => {
        const { data } = await github.post(`/repos/${owner}/${input.repo}/pulls`, {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
        });

        return JSON.stringify({
          number: data.number,
          url: data.html_url,
          title: data.title,
        });
      },
      {
        name: 'create_pull_request',
        description: 'Create a pull request on GitHub with the given title and body',
        schema: z.object({
          repo: z.string().describe('Repository name'),
          title: z.string().describe('Pull request title'),
          body: z.string().describe('Pull request description in markdown'),
          head: z.string().describe('Source branch'),
          base: z.string().describe('Target branch'),
        }),
      },
    );

    const agent = createAgent({
      model: 'google-genai:gemini-2.5-flash-lite',
      tools: [compareBranches, createPr],
      systemPrompt: AGENT_SYSTEM_PROMPT,
    });

    return agent.invoke({
      messages: [
        {
          role: 'user',
          content: `Analyze branch "${dto.head}" against "${dto.base}" in ${owner}/${dto.repo}.

1. Call compare_branches to get commits and file diffs
2. Generate a concise PR title and a detailed markdown description (summary, what changed and why, modified files, reviewer notes)
3. Call create_pull_request with the generated content

Write the description in the same language as the commit messages.`,
        },
      ],
    });
  }

  async reviewPullRequest(dto: ReviewPrDto) {
    const github = this.github;
    const owner = this.owner;

    const getPrDetails = tool(
      async (input: { repo: string; pull_number: number }) => {
        const { data } = await github.get(
          `/repos/${owner}/${input.repo}/pulls/${input.pull_number}`,
        );

        return JSON.stringify({
          title: data.title,
          body: data.body,
          state: data.state,
          user: data.user?.login,
          created_at: data.created_at,
          base: data.base?.ref,
          head: data.head?.ref,
          additions: data.additions,
          deletions: data.deletions,
          changed_files: data.changed_files,
        });
      },
      {
        name: 'get_pr_details',
        description: 'Get details of a GitHub pull request',
        schema: z.object({
          repo: z.string().describe('Repository name'),
          pull_number: z.number().describe('Pull request number'),
        }),
      },
    );

    const getPrFiles = tool(
      async (input: { repo: string; pull_number: number }) => {
        const { data: files } = await github.get(
          `/repos/${owner}/${input.repo}/pulls/${input.pull_number}/files`,
        );

        return JSON.stringify(
          files.map((file: any) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch: file.patch?.slice(0, 2000),
          })),
        );
      },
      {
        name: 'get_pr_files',
        description: 'Get list of files changed in a pull request with their diffs',
        schema: z.object({
          repo: z.string().describe('Repository name'),
          pull_number: z.number().describe('Pull request number'),
        }),
      },
    );

    const postReviewComment = tool(
      async (input: { repo: string; pull_number: number; body: string }) => {
        const { data } = await github.post(
          `/repos/${owner}/${input.repo}/issues/${input.pull_number}/comments`,
          { body: input.body },
        );

        return JSON.stringify({ comment_id: data.id, url: data.html_url });
      },
      {
        name: 'post_review_comment',
        description: 'Post a review comment on a pull request',
        schema: z.object({
          repo: z.string().describe('Repository name'),
          pull_number: z.number().describe('Pull request number'),
          body: z.string().describe('The review comment content in markdown'),
        }),
      },
    );

    const agent = createAgent({
      model: 'google-genai:gemini-2.5-flash-lite',
      tools: [getPrDetails, getPrFiles, postReviewComment],
      systemPrompt: AGENT_SYSTEM_PROMPT,
    });

    return agent.invoke({
      messages: [
        {
          role: 'user',
          content: `Review PR #${dto.pull_number} in ${owner}/${dto.repo}.

1. Call get_pr_details to get the PR context
2. Call get_pr_files to analyze changed files and diffs
3. Write a review covering code quality, bugs, security, performance, and improvements
4. Call post_review_comment to publish the review as a comment on the PR`,
        },
      ],
    });
  }
}
