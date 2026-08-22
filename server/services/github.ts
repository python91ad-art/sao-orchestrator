import { ExtractedGap, extractGapsFromContent } from './crawler';
import { getCredential } from './credentials';

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  user: {
    login: string;
  } | null;
}

export async function listIssues(owner: string, repo: string): Promise<GitHubIssue[]> {
  const token = await getCredential('github');
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'SAO-Orchestrator-App',
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=30`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned status ${response.status}.`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Failed to list GitHub issues for ${owner}/${repo}:`, error instanceof Error ? error.message : error);
    return [];
  }
}

export async function searchIssues(query: string): Promise<GitHubIssue[]> {
  const token = await getCredential('github');
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'SAO-Orchestrator-App',
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const encodedQuery = encodeURIComponent(`${query} state:open type:issue`);
  try {
    const response = await fetch(`https://api.github.com/search/issues?q=${encodedQuery}&per_page=30`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`GitHub Search API returned status ${response.status}.`);
    }

    const data = await response.json();
    return data.items || [];
  } catch (error) {
    console.error(`Failed to search GitHub issues for query "${query}":`, error instanceof Error ? error.message : error);
    return [];
  }
}

export async function extractGapsFromIssues(issues: GitHubIssue[]): Promise<ExtractedGap[]> {
  if (issues.length === 0) return [];

  const issueText = issues
    .map(i => `Issue #${rNum(i.number)}: ${i.title}\nUrl: ${i.html_url}\nDescription: ${i.body || 'No description provided'}`)
    .join('\n\n---\n\n');

  return extractGapsFromContent(issueText, 'github-issues-feed');
}

function rNum(num: any): string {
  return String(num);
}
