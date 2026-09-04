import { callLLMJson } from './llm';
import { ExtractedGap } from './crawler';
import { retryWithExponentialBackoff } from '../retryEngine';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  displayLink?: string;
}

// ==========================================
// Discovery configuration — used by dashboard diagnostics
// ==========================================
let _lastSearchStatus: 'not_configured' | 'configured_no_results' | 'configured_results_ok' | 'api_error' | null = null;
let _lastSearchStatusTime: number = 0;

export function getDiscoveryStatus() {
  return {
    tavilyConfigured: !!process.env.TAVILY_API_KEY,
    lastSearchStatus: _lastSearchStatus,
    lastSearchStatusTime: _lastSearchStatusTime ? new Date(_lastSearchStatusTime).toISOString() : null,
  };
}

// ==========================================
// EXTRACTION HEALTH METRICS — Observable failure categorization
// ==========================================

export type ExtractionFailureReason =
  | 'llm_unavailable'
  | 'llm_timeout'
  | 'malformed_json'
  | 'schema_validation_failure'
  | 'provider_failure'
  | 'rate_limit'
  | 'auth_failure'
  | 'network_error'
  | 'unknown';

export interface ExtractionMetrics {
  totalAttempts: number;
  /** LLM was reached and returned parseable structured output (even if 0 gaps). */
  llmSuccesses: number;
  /** LLM returned valid JSON gaps array but all entries were filtered out. */
  llmNoValidGaps: number;
  /** LLM returned output but it failed structural validation. */
  llmSchemaFailures: number;
  /** LLM call itself failed (network, auth, timeout, rate limit, etc). */
  failures: Record<Exclude<ExtractionFailureReason, 'schema_validation_failure'>, number>;
  lastFailureReason: ExtractionFailureReason | null;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  /** Total valid gaps successfully extracted across all calls. */
  totalGapsExtracted: number;
}

const extractionMetrics: ExtractionMetrics = {
  totalAttempts: 0,
  llmSuccesses: 0,
  llmNoValidGaps: 0,
  llmSchemaFailures: 0,
  failures: {
    llm_unavailable: 0,
    llm_timeout: 0,
    malformed_json: 0,
    provider_failure: 0,
    rate_limit: 0,
    auth_failure: 0,
    network_error: 0,
    unknown: 0,
  },
  lastFailureReason: null,
  lastFailureTime: null,
  lastSuccessTime: null,
  totalGapsExtracted: 0,
};

export function getExtractionMetrics(): ExtractionMetrics {
  return { ...extractionMetrics, failures: { ...extractionMetrics.failures } };
}

function recordExtractionFailure(reason: ExtractionFailureReason): void {
  extractionMetrics.totalAttempts++;
  extractionMetrics.lastFailureReason = reason;
  extractionMetrics.lastFailureTime = Date.now();
  if (reason === 'schema_validation_failure') {
    extractionMetrics.llmSchemaFailures++;
  } else {
    extractionMetrics.failures[reason]++;
  }
}

function recordExtractionSuccess(gapCount: number = 0): void {
  extractionMetrics.totalAttempts++;
  extractionMetrics.llmSuccesses++;
  extractionMetrics.lastSuccessTime = Date.now();
  extractionMetrics.lastFailureReason = null;
  extractionMetrics.totalGapsExtracted += gapCount;
  if (gapCount === 0) {
    extractionMetrics.llmNoValidGaps++;
  }
}

function categorizeLLMError(error: any): ExtractionFailureReason {
  const msg = String(error?.message || error || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  const name = String(error?.name || '').toLowerCase();

  if (/rate.?limit|too many requests|quota|429|tpm|rpm/.test(msg)) return 'rate_limit';
  if (/unauthorized|forbidden|invalid api key|authentication|401|403/.test(msg)) return 'auth_failure';
  if (/timed? ?out|abort|etimedout|408/.test(msg + code)) return 'llm_timeout';
  if (/network|fetch failed|econnrefused|econnreset|enotfound|socket/.test(msg)) return 'network_error';
  if (/json|parse|unexpected token|syntax error|cannot parse/i.test(msg)) return 'malformed_json';
  if (name === 'llmrouterexhaustederror' || code === 'llm_all_providers_exhausted') return 'llm_unavailable';
  return 'unknown';
}

/**
 * Tavily web search API.
 * Uses an AI-oriented web search provider while preserving SAO's
 * existing SearchResult interface and all downstream gap detection.
 */
export async function search(query: string, options: { maxResults?: number } = {}): Promise<SearchResult[]> {
  // Credential precedence: dashboard registry → environment variable.
  const { resolveCredential } = await import('./providerRegistry');
  const resolved = await resolveCredential('tavily', ['TAVILY_API_KEY']);
  const apiKey = resolved.value;

  if (!apiKey) {
    console.warn('[Search] Tavily API key not configured (TAVILY_API_KEY missing from environment). Returning empty results.');
    _lastSearchStatus = 'not_configured';
    _lastSearchStatusTime = Date.now();
    return [];
  }

  const maxResults = Math.min(options.maxResults || 10, 10);

  console.log(`[Search] 🔍 Tavily request → query: "${query.slice(0, 80)}" maxResults: ${maxResults}`);

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

    console.log(`[Search] 📡 Tavily HTTP ${response.status} for query: "${query.slice(0, 60)}"`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Search] ❌ Tavily returned ${response.status}: ${errorText}`);
      _lastSearchStatus = 'api_error';
      _lastSearchStatusTime = Date.now();
      return [];
    }

    const data = await response.json();
    const results = data.results || [];

    _lastSearchStatus = results.length > 0 ? 'configured_results_ok' : 'configured_no_results';
    _lastSearchStatusTime = Date.now();

    if (results.length === 0) {
      console.log(`[Search] ⚠️ Tavily returned 0 results for query: ${query.slice(0, 60)}`);
    } else {
      console.log(`[Search] ✅ Tavily returned ${results.length} results for query: "${query.slice(0, 60)}"`);
    }

    return results.map((item: any) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.content || '',
      displayLink: item.url ? new URL(item.url).hostname : '',
    }));
  } catch (error: any) {
    console.error('[Search] ❌ Tavily search failed:', error?.message || error);
    _lastSearchStatus = 'api_error';
    _lastSearchStatusTime = Date.now();
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

  try {
    return await extractGapsFromSearchContent(concatenatedContent, `tavily_search:${topic}`);
  } catch (error: any) {
    console.error(
      `[Search] ❌ Gap extraction failed for topic "${topic}" ` +
      `(category: ${error?.category || 'unknown'}): ${error?.message || error}`
    );
    return [];
  }
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
    const result = await retryWithExponentialBackoff(
      async () => {
        const parsed = await callLLMJson<{ gaps: any[] }>(prompt, {
          systemPrompt: 'You are a market intelligence analyst specializing in situational arbitrage.',
        });

        if (!parsed.gaps || !Array.isArray(parsed.gaps)) {
          recordExtractionFailure('schema_validation_failure');
          return [] as ExtractedGap[];
        }

        const extracted = parsed.gaps.map((g: any) => ({
          knows: g.knows || '',
          needs: g.needs || '',
          controlsAccess: g.controlsAccess || '',
          underestimatesValue: g.underestimatesValue || '',
          source: sourceUrl,
        }));

        recordExtractionSuccess(extracted.length);
        return extracted;
      },
      3,
      1000,
      2
    );

    return result;
  } catch (error: any) {
    const category = categorizeLLMError(error);
    recordExtractionFailure(category);

    console.error(
      `[Search] Failed to extract gaps from search results ` +
      `(category: ${category}): ${error?.message || error}`
    );

    throw Object.assign(
      new Error(`LLM gap extraction failed [${category}]: ${error?.message || 'Unknown error'}`),
      { code: 'EXTRACTION_FAILED', category, sourceUrl }
    );
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

  console.log(`[Ecommerce Gap Detection] 🔍 Starting detection with ${queries.length} queries`);

const allGaps: DetectedGap[] = [];
  let extractionFailures = 0;

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    console.log(`[Ecommerce Gap Detection] Query ${i+1}/${queries.length}: "${query}"`);
    const results = await search(query, { maxResults: 5 });
    console.log(`[Ecommerce Gap Detection] Query ${i+1}: ${results.length} Tavily results`);
    if (results.length === 0) continue;

    // Concatenate snippets and extract gaps via LLM
    const content = results
      .map(r => `Source: ${r.url}\nTitle: ${r.title}\nSnippet: ${r.snippet}`)
      .join('\n\n---\n\n');

    try {
      const gaps = await extractGapFromText(content, 'tavily_search:ecommerce');
      for (const g of gaps) {
        allGaps.push({
          ...g,
          source: 'tavily_search',
          priority: g.priority || 5,
        });
      }
    } catch (error: any) {
      extractionFailures++;
      console.error(
        `[Ecommerce Gap Detection] ❌ Extraction failed for query ${i+1} ` +
        `(category: ${error?.category || 'unknown'}): ${error?.message || error}`
      );
      continue;
    }
  }

  console.log(
    `[Ecommerce Gap Detection] ✅ Total: ${allGaps.length} e-commerce gaps discovered from ${queries.length} queries.` +
    `${extractionFailures > 0 ? ` ${extractionFailures} extraction failure(s).` : ''}`
  );
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

  console.log(`[Operational Gap Detection] 🔍 Starting detection with ${queries.length} queries`);

  const allGaps: DetectedGap[] = [];
  let extractionFailures = 0;

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    console.log(`[Operational Gap Detection] Query ${i+1}/${queries.length}: "${query}"`);
    const results = await search(query, { maxResults: 5 });
    console.log(`[Operational Gap Detection] Query ${i+1}: ${results.length} Tavily results`);
    if (results.length === 0) continue;

    const content = results
      .map(r => `Source: ${r.url}\nTitle: ${r.title}\nSnippet: ${r.snippet}`)
      .join('\n\n---\n\n');

    try {
      const gaps = await extractGapFromText(content, 'tavily_search:operational');
      for (const g of gaps) {
        allGaps.push({
          ...g,
          source: 'tavily_search',
          priority: g.priority || 5,
        });
      }
    } catch (error: any) {
      extractionFailures++;
      console.error(
        `[Operational Gap Detection] ❌ Extraction failed for query ${i+1} ` +
        `(category: ${error?.category || 'unknown'}): ${error?.message || error}`
      );
      continue;
    }
  }

  console.log(
    `[Operational Gap Detection] ✅ Total: ${allGaps.length} operational gaps discovered from ${queries.length} queries.` +
    `${extractionFailures > 0 ? ` ${extractionFailures} extraction failure(s).` : ''}`
  );
  return allGaps;
}

/**
 * Extract a gap object from a text snippet using LLM (with retry & fallback).
 * 
 * Failure modes are tracked separately via extractionMetrics.
 * Retries transient failures (rate_limit, timeout, network) up to 2 times with
 * exponential backoff. Returns empty array only when no valid gaps exist —
 * LLM crashes are propagated so callers can distinguish "no gaps" from "failed".
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
    console.log(`[extractGapFromText] 🤖 Calling LLM to extract gaps from ${sourceTag} (text length: ${text.length} chars)`);
    
    const result = await retryWithExponentialBackoff(
      async () => {
        const parsed = await callLLMJson<{ gaps: any[] }>(prompt, {
          systemPrompt: 'You are a market intelligence analyst specializing in situational arbitrage gap detection.',
          maxTokens: 2000,
          temperature: 0.0,
        });

        if (!parsed.gaps || !Array.isArray(parsed.gaps)) {
          recordExtractionFailure('schema_validation_failure');
          console.log(`[extractGapFromText] ⚠️ LLM returned no valid gaps array for ${sourceTag}`);
          // LLM was reached but output was structurally wrong — NOT "success with 0 gaps"
          return [] as DetectedGap[];
        }

        const filtered = parsed.gaps.filter((g: any) => g.knows && g.needs);
        console.log(`[extractGapFromText] ✅ LLM extracted ${filtered.length} candidate gaps from ${sourceTag} (${parsed.gaps.length} raw, ${parsed.gaps.length - filtered.length} rejected missing knows/needs)`);

        // LLM succeeded and gave us parseable output. Track success, gap count may be 0.
        recordExtractionSuccess(filtered.length);

        return filtered
          .map((g: any) => ({
            knows: g.knows || '',
            needs: g.needs || '',
            controlsAccess: g.controlsAccess || '',
            underestimatesValue: g.underestimatesValue || '',
            source: sourceTag,
            priority: typeof g.priority === 'number' ? Math.max(1, Math.min(10, g.priority)) : 5,
          }));
      },
      3,      // maxAttempts
      1000,   // baseDelay
      2       // backoffMultiplier
    );

    return result;
  } catch (error: any) {
    const category = categorizeLLMError(error);
    recordExtractionFailure(category);

    console.error(
      `[extractGapFromText] ❌ LLM extraction FAILED for ${sourceTag} ` +
      `(category: ${category}): ${error?.message || error}`
    );

    // Do NOT silently swallow — throw a structured error so callers know
    // this was an extraction failure, not an empty result.
    throw Object.assign(
      new Error(`LLM gap extraction failed [${category}]: ${error?.message || 'Unknown error'}`),
      { 
        code: 'EXTRACTION_FAILED',
        category,
        sourceTag,
        textLength: text.length,
      }
    );
  }
}
