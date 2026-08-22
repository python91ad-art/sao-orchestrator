import { callLLMJson } from './llm';
import { ExtractedGap } from './crawler';
import { getCredential } from './credentials';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  displayLink?: string;
}

/**
 * Tavily web search API.
 * Uses an AI-oriented web search provider while preserving SAO's
 * existing SearchResult interface and all downstream gap detection.
 */
export async function search(query: string, options: { maxResults?: number } = {}): Promise<SearchResult[]> {
  const apiKey = await getCredential('tavily');

  if (!apiKey) {
    console.warn('[Search] Tavily API key not configured. Returning empty results.');
    return [];
  }

  const maxResults = Math.min(options.maxResults || 10, 10);

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        topic: 'general',
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.error(`[Search] Tavily returned ${response.status}.`);
      return [];
    }

    const data = await response.json();
    const results = data.results || [];

    return results.map((item: any) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.content || '',
      displayLink: item.url ? new URL(item.url).hostname : '',
    }));
  } catch (error: any) {
    console.error('[Search] Tavily search failed:', error?.message || error);
    return [];
  }
}

/**
 * Search for market gaps on a given topic.
 * Uses Tavily to find results, then LLM to extract gaps from snippets.
 */
export async function searchForGaps(topic: string): Promise<ExtractedGap[]> {
  const searchQuery = `"${topic}" problems pain points workflow frustration limitations`;
  const results = await search(searchQuery, { maxResults: 10 });

  if (results.length === 0) return [];

  const concatenatedContent = results
    .map(r => `Source: ${r.url}\nTitle: ${r.title}\nSnippet: ${r.snippet}`)
    .join('\n\n---\n\n');

  return extractGapsFromSearchContent(concatenatedContent, `tavily_search:${topic}`);
}

/**
 * LLM-based gap extraction from search snippets.
 */
async function extractGapsFromSearchContent(content: string, sourceUrl: string): Promise<ExtractedGap[]> {
  const prompt = `Analyze the following search results and extract concrete "Situational Arbitrage" market gaps.

For each gap, identify:
1. knows: Who possesses the special knowledge/data or capabilities?
2. needs: Who urgently demands this value, and what is their problem?
3. controlsAccess: Who is the gatekeeper/platform controlling the transaction?
4. underestimatesValue: Why is the price, resource, or effort undervalued or inefficiently deployed?

Search results to analyze:
---
${content}
---

Respond with valid JSON containing a list of gaps under a "gaps" property, matching this schema:
{
  "gaps": [
    {
      "knows": "...",
      "needs": "...",
      "controlsAccess": "...",
      "underestimatesValue": "..."
    }
  ]
}`;

  try {
    const parsed = await callLLMJson<{ gaps: any[] }>(prompt, {
      systemPrompt: 'You are a market intelligence analyst specializing in situational arbitrage.',
    });

    if (!parsed.gaps || !Array.isArray(parsed.gaps)) return [];

    return parsed.gaps.map((g: any) => ({
      knows: g.knows || '',
      needs: g.needs || '',
      controlsAccess: g.controlsAccess || '',
      underestimatesValue: g.underestimatesValue || '',
      source: sourceUrl,
    }));
  } catch (error) {
    console.error('[Search] Failed to extract gaps from search results:', error);
    return [];
  }
}

/**
 * Search for trending problems across multiple categories.
 */
export async function trendingProblems(): Promise<SearchResult[]> {
  const categories = [
    'developer platform API limitations workflows',
    'SaaS billing subscription frustrations',
    'AI automation tool pipelines bottlenecks',
  ];

  const query = categories.join(' OR ');
  return search(query, { maxResults: 10 });
}

// ==========================================
// E-COMMERCE GAP DETECTION (replaces WooCommerce adapter)
// Uses Tavily Search + Groq LLM — no extra API keys needed.
// ==========================================

export interface DetectedGap {
  knows: string;
  needs: string;
  controlsAccess: string;
  underestimatesValue: string;
  source: string;
  priority?: number;
}

/**
 * Detect e-commerce supply/demand gaps using Tavily Search.
 * Searches for "out of stock", "low inventory", "sold out", "price mismatch"
 * and extracts situational arbitrage gaps from the results.
 */
export async function detectEcommerceGaps(): Promise<DetectedGap[]> {
  const queries = [
    '"out of stock" problems frustrated buyers',
    '"low inventory" supply chain shortages 2025 2026',
    '"sold out" where to buy alternative',
    '"price mismatch" arbitrage opportunity reselling',
    'ecommerce inventory sync oversell stockout pain points',
  ];

  const allGaps: DetectedGap[] = [];

  for (const query of queries) {
    const results = await search(query, { maxResults: 5 });
    if (results.length === 0) continue;

    // Concatenate snippets and extract gaps via LLM
    const content = results
      .map(r => `Source: ${r.url}\nTitle: ${r.title}\nSnippet: ${r.snippet}`)
      .join('\n\n---\n\n');

    const gaps = await extractGapFromText(content, 'tavily_search:ecommerce');
    for (const g of gaps) {
      allGaps.push({
        ...g,
        source: 'tavily_search',
        priority: g.priority || 5,
      });
    }
  }

  console.log(`[Ecommerce Gap Detection] Found ${allGaps.length} e-commerce gaps.`);
  return allGaps;
}

/**
 * Detect operational/business gaps using Tavily Search.
 * Searches for "struggling with leads", "hiring for", "customer churn", etc.
 * and extracts situational arbitrage gaps from the results.
 */
export async function detectOperationalGaps(): Promise<DetectedGap[]> {
  const queries = [
    '"struggling with leads" small business frustration',
    '"hiring for" hard to fill skills gap shortage',
    '"customer churn" retention problem SaaS',
    '"workflow bottleneck" manual process inefficient',
    '"no solution for" underserved market opportunity',
  ];

  const allGaps: DetectedGap[] = [];

  for (const query of queries) {
    const results = await search(query, { maxResults: 5 });
    if (results.length === 0) continue;

    const content = results
      .map(r => `Source: ${r.url}\nTitle: ${r.title}\nSnippet: ${r.snippet}`)
      .join('\n\n---\n\n');

    const gaps = await extractGapFromText(content, 'tavily_search:operational');
    for (const g of gaps) {
      allGaps.push({
        ...g,
        source: 'tavily_search',
        priority: g.priority || 5,
      });
    }
  }

  console.log(`[Operational Gap Detection] Found ${allGaps.length} operational gaps.`);
  return allGaps;
}

/**
 * Extract a gap object from a text snippet using Groq LLM.
 * Handles failures gracefully — returns empty array on parse error.
 */
async function extractGapFromText(text: string, sourceTag: string): Promise<DetectedGap[]> {
  const prompt = `Analyze the following content and extract concrete "Situational Arbitrage" market gaps.

A situational arbitrage gap occurs when:
- Someone KNOWS something valuable that others don't
- Someone NEEDS a solution that isn't being provided
- A gatekeeper CONTROLS ACCESS to the solution inefficiently
- The VALUE of the solution is underestimated or mispriced

Content to analyze:
---
${text}
---

Respond with valid JSON containing a list of gaps under a "gaps" property:
{
  "gaps": [
    {
      "knows": "Who has the knowledge/advantage",
      "needs": "Who needs it and what's their problem",
      "controlsAccess": "Who is the gatekeeper",
      "underestimatesValue": "Why is it undervalued",
      "priority": 5
    }
  ]
}

If no real gaps are found, return { "gaps": [] }`;

  try {
    const parsed = await callLLMJson<{ gaps: any[] }>(prompt, {
      systemPrompt: 'You are a market intelligence analyst specializing in situational arbitrage gap detection.',
      maxTokens: 2000,
      temperature: 0.4,
    });

    if (!parsed.gaps || !Array.isArray(parsed.gaps)) return [];

    return parsed.gaps
      .filter((g: any) => g.knows && g.needs) // Must have at least knows + needs
      .map((g: any) => ({
        knows: g.knows || '',
        needs: g.needs || '',
        controlsAccess: g.controlsAccess || '',
        underestimatesValue: g.underestimatesValue || '',
        source: sourceTag,
        priority: typeof g.priority === 'number' ? Math.max(1, Math.min(10, g.priority)) : 5,
      }));
  } catch (error) {
    console.error(`[extractGapFromText] Failed to parse gaps from ${sourceTag}:`, error);
    return [];
  }
}
