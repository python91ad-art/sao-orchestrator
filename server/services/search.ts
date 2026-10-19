import type { ExtractedGap } from './crawler';
import { webSearch, SearchUnavailableError, type SearchResult, type SearchAttempt } from './webSearch';
import { extractQualifiedGaps, type QualifiedGap, type DiscoveryEvidence } from './discoveryEvidence';
export type { SearchResult } from './webSearch';

export interface DetectedGap {
  knows: string; needs: string; controlsAccess: string; underestimatesValue: string; source: string; priority?: number;
}
let _lastSearchStatus: 'not_configured' | 'configured_no_results' | 'configured_results_ok' | 'api_error' | null = null;
let _lastSearchStatusTime = 0;
export function getDiscoveryStatus() {
  const routing = webSearch.getStatus();
  return { tavilyConfigured: routing.providers.tavily ? routing.providers.tavily.status !== 'not_configured' : !!process.env.TAVILY_API_KEY,
    lastSearchStatus: _lastSearchStatus, lastSearchStatusTime: _lastSearchStatusTime ? new Date(_lastSearchStatusTime).toISOString() : null, ...routing };
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


/** Existing array interface retained; failures now throw a typed error instead of becoming empty successes. */
export async function search(query: string, options: { maxResults?: number; shouldContinue?: () => Promise<boolean> } = {}, metrics?: WebDiscoveryMetrics): Promise<SearchResult[]> {
  const outcome = await webSearch.search(query, options);
  if (metrics) { metrics.attempts.push(...outcome.attempts); metrics.activeProvider = outcome.provider; }
  _lastSearchStatusTime = Date.now();
  if (outcome.status === 'results' || outcome.status === 'zero_results') {
    _lastSearchStatus = outcome.results.length ? 'configured_results_ok' : 'configured_no_results';
    return outcome.results;
  }
  _lastSearchStatus = outcome.attempts.every(a => a.status === 'not_configured') ? 'not_configured' : 'api_error';
  throw new SearchUnavailableError(outcome);
}
export interface WebDiscoveryMetrics { attempts: SearchAttempt[]; activeProvider: string | null; searches: number; successes: number; failures: number; extractionFailures: number; candidates: number; rejected: number; candidatesByProvider: Record<string, number> }
export const newWebMetrics = (): WebDiscoveryMetrics => ({ attempts: [], activeProvider: null, searches: 0, successes: 0, failures: 0, extractionFailures: 0, candidates: 0, rejected: 0, candidatesByProvider: {} });
async function findGaps(queries: string[], category: string, metrics = newWebMetrics(), shouldContinue: () => Promise<boolean> = async () => true): Promise<QualifiedGap[]> {
  const gaps: QualifiedGap[] = [];
  for (const query of queries) {
    if (!await shouldContinue()) break;
    metrics.searches++;
    let results: SearchResult[];
    try { results = await search(query, { maxResults: 5, shouldContinue }, metrics); metrics.successes++; }
    catch { metrics.failures++; continue; }
    if (!await shouldContinue()) break;
    if (!results.length) continue;
    const evidence: DiscoveryEvidence[] = results.map((r, i) => ({ id: `web:${i}`, provider: r.provider || 'tavily', url: r.url,
      title: r.title, text: r.snippet, retrievedAt: r.retrievedAt || new Date().toISOString(), publishedAt: r.publishedAt, citation: r.citation }));
    try {
      const batch = await extractQualifiedGaps(evidence, `${results[0].provider || 'tavily'}_search:${category}`);
      const provider = results[0].provider || 'tavily';
      metrics.candidatesByProvider[provider] = (metrics.candidatesByProvider[provider] || 0) + batch.candidates;
      metrics.candidates += batch.candidates; metrics.rejected += batch.rejected;
      recordExtractionSuccess(batch.gaps.length);
      gaps.push(...batch.gaps);
    } catch (error) { metrics.extractionFailures++; recordExtractionFailure(categorizeLLMError(error)); }
  }
  return gaps;
}
export async function searchForGaps(topic: string): Promise<ExtractedGap[]> {
  const metrics = newWebMetrics();
  const gaps = await findGaps([`"${topic}" problems pain points workflow frustration limitations`], topic, metrics);
  if (metrics.failures || metrics.extractionFailures) throw new Error('Discovery unavailable: search or evidence extraction failed.');
  return gaps;
}
export async function trendingProblems(): Promise<SearchResult[]> {
  return search('developer platform API limitations workflows OR SaaS billing subscription frustrations OR AI automation tool pipelines bottlenecks');
}
export async function detectEcommerceGaps(metrics?: WebDiscoveryMetrics, shouldContinue?: () => Promise<boolean>): Promise<QualifiedGap[]> {
  return findGaps([
    '"out of stock" problems frustrated buyers',
    '"low inventory" supply chain shortages',
    '"sold out" where to buy alternative',
    '"price mismatch" arbitrage opportunity reselling',
    'ecommerce inventory sync oversell stockout pain points',
  ], 'ecommerce', metrics, shouldContinue);
}
export async function detectOperationalGaps(metrics?: WebDiscoveryMetrics, shouldContinue?: () => Promise<boolean>): Promise<QualifiedGap[]> {
  return findGaps([
    '"struggling with leads" small business frustration',
    '"hiring for" hard to fill skills gap shortage',
    '"customer churn" retention problem SaaS',
    '"workflow bottleneck" manual process inefficient',
    '"no solution for" underserved market opportunity',
  ], 'operational', metrics, shouldContinue);
}
