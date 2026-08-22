import Stripe from 'stripe';
import { Resend } from 'resend';
import { PublicCredentialService, getCredential, resolveGoogleSearchCredentials } from './credentials';
import { testGroqConnection } from './llm';

export interface CredentialTestResult {
  success: boolean;
  message: string;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
}

export async function testCredential(service: PublicCredentialService): Promise<CredentialTestResult> {
  switch (service) {
    case 'groq':
      return testGroqConnection();
    case 'google-search':
      return testGoogleSearch();
    case 'github':
      return testGitHub();
    case 'stripe':
      return testStripe();
    case 'resend':
      return testResend();
    case 'slack':
      return testSlack();
    case 'tavily':
      return testTavily();
    default:
      return { success: false, message: 'Unsupported credential service.' };
  }
}

async function testGitHub(): Promise<CredentialTestResult> {
  const token = await getCredential('github');
  if (!token) return { success: false, message: 'GitHub token is not configured.' };

  try {
    const response = await fetchWithTimeout('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'SAO-Orchestrator-App',
      },
    });

    if (response.status === 401 || response.status === 403) {
      return { success: false, message: 'GitHub authentication failed.' };
    }

    return response.ok
      ? { success: true, message: 'GitHub connection successful.' }
      : { success: false, message: 'GitHub connection check failed.' };
  } catch {
    return { success: false, message: 'GitHub connection timed out or failed.' };
  }
}

async function testStripe(): Promise<CredentialTestResult> {
  const key = await getCredential('stripe');
  if (!key) return { success: false, message: 'Stripe secret key is not configured.' };

  try {
    const stripe = new Stripe(key, { apiVersion: '2023-10-16' as any });
    await stripe.balance.retrieve();
    return { success: true, message: 'Stripe connection successful.' };
  } catch {
    return { success: false, message: 'Stripe authentication or connectivity check failed.' };
  }
}

async function testResend(): Promise<CredentialTestResult> {
  const key = await getCredential('resend');
  if (!key) return { success: false, message: 'Resend API key is not configured.' };

  try {
    const resend = new Resend(key);
    await resend.domains.list();
    return { success: true, message: 'Resend connection successful.' };
  } catch {
    return { success: false, message: 'Resend authentication or connectivity check failed.' };
  }
}

async function testSlack(): Promise<CredentialTestResult> {
  const token = await getCredential('slack');
  if (!token) return { success: false, message: 'Slack bot token is not configured.' };

  try {
    const response = await fetchWithTimeout('https://slack.com/api/auth.test', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return { success: false, message: 'Slack connection check failed.' };
    }

    const data = await response.json() as { ok?: boolean };
    return data.ok
      ? { success: true, message: 'Slack connection successful.' }
      : { success: false, message: 'Slack authentication failed.' };
  } catch {
    return { success: false, message: 'Slack connection timed out or failed.' };
  }
}

async function testGoogleSearch(): Promise<CredentialTestResult> {
  const { apiKey, cx } = await resolveGoogleSearchCredentials();
  if (!apiKey || !cx) {
    return { success: false, message: 'Google Search API key or CX is not configured.' };
  }

  try {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', 'SAO');
    url.searchParams.set('num', '1');

    const response = await fetchWithTimeout(url.toString());
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { success: false, message: 'Google Search authentication or CX validation failed.' };
    }

    return response.ok
      ? { success: true, message: 'Google Search connection successful.' }
      : { success: false, message: 'Google Search connection check failed.' };
  } catch {
    return { success: false, message: 'Google Search connection timed out or failed.' };
  }
}

async function testTavily(): Promise<CredentialTestResult> {
  const apiKey = await getCredential('tavily');
  if (!apiKey) return { success: false, message: 'Tavily API key is not configured.' };

  try {
    const response = await fetchWithTimeout('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: 'SAO',
        search_depth: 'basic',
        max_results: 1,
        include_answer: false,
        include_raw_content: false,
      }),
    });

    if (response.status === 401 || response.status === 403) {
      return { success: false, message: 'Tavily authentication failed.' };
    }

    return response.ok
      ? { success: true, message: 'Tavily connection successful.' }
      : { success: false, message: 'Tavily connection check failed.' };
  } catch {
    return { success: false, message: 'Tavily connection timed out or failed.' };
  }
}
