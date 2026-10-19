import { createHash } from 'node:crypto';
import { mutateDiscoveryRuntime, type MutateRuntime } from './discoveryRuntime';
import { resolveSectionRoutes, discoveryRouteConfig, reserveAssignment, recordAssignmentOutcome, type AssignmentRoute } from './providerAssignments';
import { resolveDiscoveryProvider } from './providerRegistry';

export type SearchProvider = 'tavily' | 'gemini' | 'groq' | 'openrouter';
export type SearchStatus = 'results' | 'zero_results' | 'not_configured' | 'quota_exhausted' | 'rate_limited' | 'auth_failure' | 'timeout' | 'unavailable' | 'invalid_response' | 'billing_blocked' | 'unsupported' | 'stopped';
export interface SearchResult {
  title: string; url: string; snippet: string; displayLink?: string;
  provider?: SearchProvider; retrievedAt?: string; publishedAt?: string;
  citation?: unknown;
}
export interface SearchAttempt { provider: SearchProvider; status: SearchStatus; reason?: string; retryAt?: string }
export interface SearchOutcome {
  status: SearchStatus; results: SearchResult[]; provider: SearchProvider | null; attempts: SearchAttempt[]; reason?: string;
}
export class SearchUnavailableError extends Error {
  readonly code = 'DISCOVERY_UNAVAILABLE';
  constructor(public outcome: SearchOutcome) { super(outcome.reason || 'Web discovery unavailable; inspect discovery provider health.'); }
}
type Config = Awaited<ReturnType<typeof resolveDiscoveryProvider>>;
const order: SearchProvider[] = ['tavily', 'gemini', 'groq', 'openrouter'];
const successful = (s: SearchStatus) => s === 'results' || s === 'zero_results';
export function publicUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}

/** Accept only provider-attributed evidence, never the ordinary completion text. */
export function normalizeSearchResponse(provider: SearchProvider, data: any, limit: number, now: number): SearchResult[] {
  const at = new Date(now).toISOString();
  const result = (url: any, title: any, snippet: any, citation?: unknown, publishedAt?: string): SearchResult | null =>
    publicUrl(url) && typeof snippet === 'string' && snippet.trim() ? {
      url, title: typeof title === 'string' ? title.slice(0, 500) : '', snippet: snippet.slice(0, 8000),
      displayLink: new URL(url).hostname, provider, retrievedAt: at, citation, publishedAt: publishedAt || /(?:published|updated)(?: on| at)?\s*[:–-]?\s*(\d{4}-\d{2}-\d{2})/i.exec(snippet)?.[1],
    } : null;
  let items: (SearchResult | null)[] = [];
  if (provider === 'tavily') {
    if (!Array.isArray(data?.results)) throw new Error('invalid_response');
    items = data.results.map((x: any) => result(x.url, x.title, x.content, undefined, x.published_date));
    if (!data.results.length) return [];
  } else if (provider === 'gemini') {
    const metadata = data?.candidates?.[0]?.groundingMetadata;
    const chunks = metadata?.groundingChunks;
    if (!Array.isArray(chunks) || !Array.isArray(metadata.groundingSupports) || !metadata.webSearchQueries?.length) throw new Error('invalid_response');
    if (!chunks.length && !metadata.groundingSupports.length) return [];
    items = chunks.map((chunk: any, index: number) => {
      const supports = metadata.groundingSupports.filter((s: any) => s.groundingChunkIndices?.includes(index));
      return result(chunk.web?.uri, chunk.web?.title, supports.map((s: any) => s.segment?.text || '').join('\n'),
        { supports: supports.slice(0, 5).map((s: any) => ({ segment: { ...s.segment, text: String(s.segment?.text || '').slice(0, 1600) }, groundingChunkIndices: s.groundingChunkIndices.slice(0, 20) })),
          searchEntryPoint: { renderedContent: String(metadata.searchEntryPoint?.renderedContent || '').slice(0, 16000) } });
    });
  } else if (provider === 'openrouter') {
    const annotations = data?.choices?.[0]?.message?.annotations;
    if (!Array.isArray(annotations)) throw new Error('invalid_response');
    // Exa extractive content is required; a URL attached to uncited completion text is insufficient.
    items = annotations.filter((a: any) => a.type === 'url_citation').map((a: any) =>
      result(a.url_citation?.url, a.url_citation?.title, a.url_citation?.content, { type: a.type, url: a.url_citation?.url, start_index: a.url_citation?.start_index, end_index: a.url_citation?.end_index }));
  } else if (provider === 'groq') {
    // Response fields verified against the official groq-typescript generated OpenAPI types.
    const tools = data?.choices?.[0]?.message?.executed_tools;
    if (!Array.isArray(tools)) throw new Error('invalid_response');
    const browserTools = tools.filter((t: any) => t.type === 'browser_search');
    if (browserTools.length && browserTools.every((t: any) => (Array.isArray(t.browser_results) || Array.isArray(t.search_results?.results)) &&
      !(t.browser_results?.length || t.search_results?.results?.length))) return [];
    items = browserTools.flatMap((t: any) =>
      [...(Array.isArray(t.browser_results) ? t.browser_results : []),
       ...(Array.isArray(t.search_results?.results) ? t.search_results.results : [])]
      .map((r: any) => result(r.url, r.title, r.content, { tool: t.type, index: t.index, url: r.url })));
  } else {
    throw new Error('unsupported');
  }
  const valid = items.filter((x): x is SearchResult => !!x);
  if (!valid.length) throw new Error('invalid_response');
  return Array.from(new Map(valid.map(x => [x.url, x])).values()).slice(0, limit);
}

export class WebSearchRouter {
  private tail: Promise<unknown> = Promise.resolve();
  private inFlight = new Map<string, Promise<SearchOutcome>>();
  private health: Partial<Record<SearchProvider, SearchAttempt & { lastSuccess?: string; lastFailure?: string }>> = {};
  lastOutcome: SearchOutcome | null = null;
  constructor(private deps: { resolve: typeof resolveDiscoveryProvider; mutate: MutateRuntime; fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void>; routes?: () => Promise<AssignmentRoute[]> } = {
    resolve: resolveDiscoveryProvider, mutate: mutateDiscoveryRuntime as MutateRuntime,
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args), now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
    routes: () => resolveSectionRoutes('search', 'live_web_search'),
  }) {}
  getStatus() { return { activeProvider: this.lastOutcome?.provider || null, attempts: this.lastOutcome?.attempts || [], providers: this.health, reason: this.lastOutcome?.reason }; }
  async restoreStatus() {
    const saved = await this.deps.mutate('web-health', state => ({ health: state.health, outcome: state.outcome }));
    if (!this.lastOutcome && saved.health) { this.health = saved.health; this.lastOutcome = saved.outcome || null; }
    return this.getStatus();
  }
  private async finish(outcome: SearchOutcome) {
    this.lastOutcome = outcome;
    await this.deps.mutate('web-health', state => { state.health = this.health; state.outcome = { ...outcome, results: [] }; });
    return outcome;
  }
  search(query: string, options: { maxResults?: number; shouldContinue?: () => Promise<boolean> } = {}): Promise<SearchOutcome> {
    const limit = Math.min(10, Math.max(1, Math.trunc(options.maxResults || 10)));
    const id = `${query}:${limit}`;
    if (this.inFlight.size >= 30 && !this.inFlight.has(id)) return Promise.resolve({ status: 'unavailable', results: [], provider: null, attempts: [] });
    const running = this.inFlight.get(id);
    if (running) return running;
    // One active web request across e-commerce/operations/manual searches; duplicate queries share work.
    const work = this.tail.then(() => this.run(query.slice(0, 1000), limit, options.shouldContinue));
    this.tail = work.catch(() => {});
    this.inFlight.set(id, work);
    void work.finally(() => this.inFlight.delete(id)).catch(() => {});
    return work;
  }
  private async run(query: string, limit: number, shouldContinue: () => Promise<boolean> = async () => true): Promise<SearchOutcome> {
    const attempts: SearchAttempt[] = [];
    let routes: AssignmentRoute[] | undefined;
    try { routes = await this.deps.routes?.(); }
    catch { return this.finish({ status: 'unavailable', results: [], provider: null, attempts: [{ provider: 'tavily', status: 'unavailable', reason: 'Assignment configuration unavailable' }] }); }
    const entries = routes ? routes.map(route => ({ provider: route.providerId as SearchProvider, route })) : order.map(provider => ({ provider, route: undefined }));
    for (const { provider, route } of entries) {
      if (!await shouldContinue()) return { status: 'stopped', results: [], provider: null, attempts };
      let attempt: SearchAttempt;
      let results: SearchResult[] = [];
      try {
        const cfg = route ? await discoveryRouteConfig(route) : await this.deps.resolve(provider);
        const eligible = this.eligible(provider, cfg);
        if (eligible) attempt = { provider, status: eligible, reason: !cfg.enabled ? 'Provider disabled by configuration' : !cfg.key ? 'No discovery credential configured' : eligible === 'billing_blocked' ? 'Paid discovery requires explicit opt-in, approved budget and confirmed provider account spending cap' : eligible === 'unsupported' ? 'Configured model does not support this search adapter' : 'Discovery not enabled for this provider' };
        else {
          const outcome = await this.request(provider, cfg, query, limit, shouldContinue, route);
          attempt = outcome.attempt;
          results = outcome.results;
        }
      } catch { attempt = { provider, status: 'unavailable', reason: 'Configuration or durable request guard unavailable' }; }
      if (route && (successful(attempt.status) || attempt.reason === attempt.status)) await recordAssignmentOutcome(route, successful(attempt.status) ? undefined : attempt.status, this.deps.mutate);
      attempts.push(attempt);
      const old = this.health[provider];
      this.health[provider] = { ...old, ...attempt,
        ...(successful(attempt.status) ? { lastSuccess: new Date(this.deps.now()).toISOString() } : { lastFailure: new Date(this.deps.now()).toISOString() }) };
      if (successful(attempt.status)) {
        return this.finish({ status: attempt.status, results, provider, attempts });
      }
    }
    return this.finish({ status: 'unavailable', results: [], provider: null, attempts, reason: entries.length ? 'No eligible Search & Gap Finder provider succeeded; inspect provider attempts.' : 'No enabled compatible live web search assignments in Search & Gap Finder. Use Manage Assignments in Providers.' });
  }
  private eligible(provider: SearchProvider, cfg: Config): SearchStatus | null {
    if (!cfg.enabled || !cfg.key) return 'not_configured';
    if (provider === 'groq' && !['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'openai/gpt-oss-safeguard-20b'].includes(cfg.config.model)) return 'unsupported';
    if (provider !== 'tavily' && cfg.config.enabled !== true) return 'not_configured';
    if (provider === 'gemini' && !['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.8-flash'].includes(cfg.config.model)) return 'unsupported';
    if (provider === 'openrouter' && !/^[a-z0-9_-]+\/[a-z0-9._:-]+$/i.test(cfg.config.model || '')) return 'unsupported';
    const requiresBilling = provider !== 'tavily' || (cfg.config.maxCreditsPerMonth ?? 900) > 900 || cfg.config.billingApproved === true;
    if (requiresBilling && !(cfg.config.billingApproved === true && cfg.config.accountSpendLimitConfirmed === true &&
      Number.isFinite(cfg.config.dailyBudgetUsd) && cfg.config.dailyBudgetUsd > 0 &&
      Number.isFinite(cfg.config.maxRequestCostUsd) && cfg.config.maxRequestCostUsd > 0 &&
      Number.isInteger(cfg.config.maxRequestsPerDay) && cfg.config.maxRequestsPerDay > 0)) return 'billing_blocked';
    return null;
  }
  private async request(provider: SearchProvider, cfg: Config, query: string, limit: number, shouldContinue: () => Promise<boolean>, route?: AssignmentRoute) {
    const now = this.deps.now;
    const fingerprint = createHash('sha256').update(`${cfg.key}:${cfg.revision.replace(/:\d+$/, '')}:${cfg.config.model || provider}`).digest('hex');
    let status: SearchStatus = 'unavailable';
    for (let retry = 0; retry <= (cfg.config.retries ?? 1); retry++) {
      if (!await shouldContinue()) return { attempt: { provider, status: 'stopped' as SearchStatus, reason: 'Cycle stopped before dispatch' }, results: [] };
      if (route) {
        const cost = provider === 'tavily' && cfg.config.billingApproved !== true ? 0 : cfg.config.maxRequestCostUsd;
        const blocked = await reserveAssignment(route, cost, 0, this.deps.mutate, now());
        if (blocked) return { attempt: { provider, status: 'quota_exhausted' as SearchStatus, reason: blocked }, results: [] };
      }
      const reservation = await this.deps.mutate(`web:${provider}`, state => {
        if (state.fingerprint !== fingerprint) Object.assign(state, { fingerprint, openUntil: 0, failures: 0 });
        const day = new Date(now()).toISOString().slice(0, 10);
        if (state.day !== day) Object.assign(state, { day, requests: 0, reservedUsd: 0 });
        if (state.openUntil > now()) return { status: state.status as SearchStatus, reason: 'Provider circuit open after ' + state.status, retryAt: new Date(state.openUntil).toISOString() };
        const month = day.slice(0, 7);
        if (state.month !== month) { state.month = month; state.credits = 0; }
        if (provider === 'tavily' && state.credits >= (cfg.config.maxCreditsPerMonth ?? 900)) {
          const date = new Date(now());
          return { status: 'quota_exhausted' as SearchStatus, reason: 'Monthly Tavily credit allowance exhausted', retryAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString() };
        }
        const cap = Math.min(500, Math.max(0, cfg.config.maxRequestsPerDay ?? 50));
        const cost = provider === 'tavily' && cfg.config.billingApproved !== true ? 0 : cfg.config.maxRequestCostUsd;
        if (state.requests >= cap || (cost > 0 && state.reservedUsd + cost > cfg.config.dailyBudgetUsd + 1e-9)) return { status: 'quota_exhausted' as SearchStatus, reason: state.requests >= cap ? 'Daily request cap reached' : 'Daily reserved spending limit reached', retryAt: `${new Date(now() + 86400000).toISOString().slice(0, 10)}T00:00:00.000Z` };
        state.requests++; state.reservedUsd += cost;
        if (provider === 'tavily') state.credits++; // Explicit basic depth: one reserved Tavily credit per attempt.
        return null;
      });
      if (reservation) return { attempt: { provider, ...reservation }, results: [] };
      let retryAfter = 0;
      try {
        const prompt = `Search the web for current documented business problems. Cite sources. Query: ${query}`;
        let url = 'https://api.tavily.com/search';
        let headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` };
        let body: any = { query, search_depth: 'basic', topic: 'general', max_results: limit, include_answer: false, include_raw_content: false, auto_parameters: false,
          include_published_date: true, filter_by_published_date: true, start_date: new Date(now() - 180 * 86400000).toISOString().slice(0, 10), end_date: new Date(now()).toISOString().slice(0, 10) };
        if (provider === 'gemini') {
          url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.config.model}:generateContent`;
          delete headers.Authorization;
          headers['x-goog-api-key'] = cfg.key!;
          body = { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: 2048 } };
        } else if (provider === 'groq') {
          url = 'https://api.groq.com/openai/v1/chat/completions';
          headers.Authorization = `Bearer ${cfg.key}`;
          body = { model: cfg.config.model, messages: [{ role: 'user', content: prompt }],
            tools: [{ type: 'browser_search' }], tool_choice: 'required', reasoning_effort: 'low',
            max_completion_tokens: 2048, stream: false };
        } else if (provider === 'openrouter') {
          url = 'https://openrouter.ai/api/v1/chat/completions';
          headers.Authorization = `Bearer ${cfg.key}`;
          body = { model: cfg.config.model, messages: [{ role: 'user', content: prompt }], max_tokens: 2048,
            plugins: [{ id: 'web', engine: 'exa', max_results: limit }] };
        }
        const response = await this.deps.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.config.timeoutMs ?? 15000) });
        if (!response.ok) {
          const ra = response.headers.get('retry-after');
          retryAfter = ra ? (/^\d+(\.\d+)?$/.test(ra) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - now())) : 0;
          if (!Number.isFinite(retryAfter) || retryAfter < 0) retryAfter = 0;
          status = response.status === 432 || response.status === 433 || response.status === 402 ? 'quota_exhausted' : response.status === 429 ? 'rate_limited' :
            response.status === 401 || response.status === 403 ? 'auth_failure' : response.status === 408 || response.status === 504 ? 'timeout' :
            response.status >= 500 ? 'unavailable' : 'invalid_response';
          // Provider error bodies can echo credentials. Never read, log or return them.
        } else {
          let results: SearchResult[];
          try { results = normalizeSearchResponse(provider, await response.json(), limit, now()); } catch { status = 'invalid_response'; throw new Error('invalid_response'); }
          status = results.length ? 'results' : 'zero_results';
          await this.deps.mutate(`web:${provider}`, s => { s.failures = 0; s.openUntil = 0; s.status = status; });
          return { attempt: { provider, status }, results };
        }
      } catch (error: any) {
        if (status !== 'invalid_response') status = /timeout|abort/i.test(String(error?.name)) ? 'timeout' : 'unavailable';
      }
      const transient = status === 'unavailable' || status === 'timeout';
      if (transient && retry < (cfg.config.retries ?? 1)) { await this.deps.sleep(500 * 2 ** retry); continue; }
      const until = await this.deps.mutate(`web:${provider}`, s => {
        s.failures = (s.failures || 0) + 1; s.status = status;
        // Quota recovery is deliberately daily, auth requires rotation or a later health probe.
        const cooldown = status === 'quota_exhausted' ? 86400000 : status === 'auth_failure' ? 3600000 :
          status === 'rate_limited' ? Math.max(60000, retryAfter || 0) : Math.min(3600000, 60000 * 2 ** Math.min(s.failures, 6));
        s.openUntil = now() + cooldown;
        return s.openUntil;
      });
      return { attempt: { provider, status, reason: status, retryAt: new Date(until).toISOString() }, results: [] };
    }
    return { attempt: { provider, status }, results: [] };
  }
}
export const webSearch = new WebSearchRouter();
