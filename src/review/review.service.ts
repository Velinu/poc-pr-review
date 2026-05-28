import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { createAgent, tool } from 'langchain';
import * as z from 'zod';
import { CreatePrDto } from './dto/create-pr.dto.js';
import { ReviewPrDto } from './dto/review-pr.dto.js';
import { AGENT_SYSTEM_PROMPT } from './prompts/agent.prompt.js';

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);
  private github: AxiosInstance;
  private owner: string;

  private createModel() {
    return new ChatGoogleGenerativeAI({
      model: 'gemini-2.5-flash-lite',
      apiKey: process.env.GOOGLE_API_KEY,
    });
  }

  constructor() {
    this.owner = process.env.GITHUB_OWNER!;
    this.github = axios.create({
      baseURL: 'https://api.github.com',
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }

  private handleAxiosError(context: string, error: unknown) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    const details = axiosError.response?.data;
    this.logger.error(`[${context}] ${axiosError.message}`, JSON.stringify(details));
    return { error: axiosError.message, status, details };
  }

  async createPullRequest(dto: CreatePrDto) {
    const owner = this.owner;

    let comparison: { commits: any[]; files: any[] };
    try {
      const { data } = await this.github.get(
        `/repos/${owner}/${dto.repo}/compare/${dto.base}...${dto.head}`,
      );
      comparison = {
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
      };
    } catch (error) {
      return this.handleAxiosError('compare_branches', error);
    }

    const createPr = tool(
      async (input: { title: string; body: string }) => {
        try {
          const { data } = await this.github.post(`/repos/${owner}/${dto.repo}/pulls`, {
            title: input.title,
            body: input.body,
            head: dto.head,
            base: dto.base,
          });

          return JSON.stringify({ number: data.number, url: data.html_url, title: data.title });
        } catch (error) {
          const axiosError = error as AxiosError;
          this.logger.error(
            `[create_pull_request] ${axiosError.message}`,
            JSON.stringify(axiosError.response?.data),
          );
          throw error;
        }
      },
      {
        name: 'create_pull_request',
        description: 'Create a pull request on GitHub with the given title and body',
        schema: z.object({
          title: z.string().describe('Pull request title'),
          body: z.string().describe('Pull request description in markdown'),
        }),
      },
    );

    const agent = createAgent({
      model: this.createModel(),
      tools: [createPr],
      systemPrompt: AGENT_SYSTEM_PROMPT,
    });

    return agent.invoke(
      {
        messages: [
          {
            role: 'user',
            content: `Create a pull request for the branch "${dto.head}" → "${dto.base}" in ${owner}/${dto.repo}.

Here is the comparison data between the branches:
${JSON.stringify(comparison, null, 2)}

Based on this data:
1. Generate a concise PR title and a detailed markdown description (summary, what changed and why, modified files, reviewer notes)
2. Call create_pull_request with the generated content

Write the description in the same language as the commit messages.`,
          },
        ],
      },
      { recursionLimit: 5 },
    );
  }

  async reviewPullRequest(dto: ReviewPrDto) {
    const owner = this.owner;

    let prDetails: any;
    let prFiles: any[];
    try {
      const [detailsResponse, filesResponse] = await Promise.all([
        this.github.get(`/repos/${owner}/${dto.repo}/pulls/${dto.pull_number}`),
        this.github.get(`/repos/${owner}/${dto.repo}/pulls/${dto.pull_number}/files`),
      ]);

      const pr = detailsResponse.data;
      prDetails = {
        title: pr.title,
        body: pr.body,
        state: pr.state,
        user: pr.user?.login,
        created_at: pr.created_at,
        base: pr.base?.ref,
        head: pr.head?.ref,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
      };

      prFiles = filesResponse.data.map((file: any) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch?.slice(0, 2000),
      }));
    } catch (error) {
      return this.handleAxiosError('get_pr_data', error);
    }

    const postReviewComment = tool(
      async (input: { body: string }) => {
        try {
          const { data } = await this.github.post(
            `/repos/${owner}/${dto.repo}/issues/${dto.pull_number}/comments`,
            { body: input.body },
          );

          return JSON.stringify({ comment_id: data.id, url: data.html_url });
        } catch (error) {
          const axiosError = error as AxiosError;
          this.logger.error(
            `[post_review_comment] ${axiosError.message}`,
            JSON.stringify(axiosError.response?.data),
          );
          throw error;
        }
      },
      {
        name: 'post_review_comment',
        description: 'Post a review comment on a pull request',
        schema: z.object({
          body: z.string().describe('The review comment content in markdown'),
        }),
      },
    );

    const agent = createAgent({
      model: this.createModel(),
      tools: [postReviewComment],
      systemPrompt: AGENT_SYSTEM_PROMPT,
    });

    return agent.invoke(
      {
        messages: [
          {
            role: 'user',
            content: `Review PR #${dto.pull_number} in ${owner}/${dto.repo}.

PR details:
${JSON.stringify(prDetails, null, 2)}

Changed files:
${JSON.stringify(prFiles, null, 2)}

Write a review covering code quality, bugs, security, performance, and improvements, then call post_review_comment to publish it.`,
          },
        ],
      },
      { recursionLimit: 5 },
    );
  }
}
