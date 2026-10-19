export type BusinessProviderId = 'ons';

export interface EvidenceRecord {
  provider: BusinessProviderId;
  source: string;
  title: string;
  url: string;
  retrievedAt: string;
  reportingPeriod?: string;
  geography?: string;
  summary: string;
  caveats: string[];
  raw?: unknown;
}

export interface BusinessResearchBundle {
  query: string;
  industryTerms: string[];
  evidence: EvidenceRecord[];
  unavailable: { provider: BusinessProviderId; reason: string }[];
}

export class BusinessDataError extends Error {
  provider: BusinessProviderId;
  status?: number;
  retryAfterMs?: number;
  category: 'auth' | 'rate_limit' | 'timeout' | 'network' | 'invalid_request' | 'server' | 'unknown';

  constructor(params: {
    provider: BusinessProviderId;
    message: string;
    status?: number;
    retryAfterMs?: number;
    category?: BusinessDataError['category'];
  }) {
    super(params.message);
    this.name = 'BusinessDataError';
    this.provider = params.provider;
    this.status = params.status;
    this.retryAfterMs = params.retryAfterMs;
    this.category = params.category || 'unknown';
  }
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRIES = 2;
const cache = new Map<string, { expires: number; value: unknown; retrievedAt: string }>();
const circuit = { until: 0, failures: 0 };
export function clearDiscoveryEvidenceCache() { cache.clear(); circuit.until = 0; circuit.failures = 0; }

function nowIso() {
  return new Date().toISOString();
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function classifyStatus(provider: BusinessProviderId, status: number, body: string, headers: Headers): BusinessDataError {
  if (status === 401 || status === 403) {
    return new BusinessDataError({ provider, status, category: 'auth', message: 'Authentication failed for business data provider.' });
  }
  if (status === 429) {
    return new BusinessDataError({
      provider,
      status,
      category: 'rate_limit',
      retryAfterMs: retryAfterMs(headers),
      message: 'Business data provider rate limit reached.',
    });
  }
  if (status >= 500) {
    return new BusinessDataError({ provider, status, category: 'server', message: `Provider server error (HTTP ${status}).` });
  }
  return new BusinessDataError({
    provider,
    status,
    category: 'invalid_request',
    message: `Provider request failed (HTTP ${status}): ${body.slice(0, 180)}`,
  });
}

async function fetchJson<T>(
  provider: BusinessProviderId,
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; retries?: number; cacheTtlMs?: number } = {}
): Promise<T> {
  const cacheKey = `${provider}:${url}:${JSON.stringify(opts.headers || {})}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value as T;

  if (circuit.until > Date.now()) throw new BusinessDataError({ provider, category: 'rate_limit', retryAfterMs: circuit.until - Date.now(), message: 'ONS circuit is open; requests are temporarily restricted.' });
  const attempts = Math.max(1, (opts.retries ?? DEFAULT_RETRIES) + 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', ...(opts.headers || {}) },
        signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw classifyStatus(provider, response.status, body, response.headers);
      }
      const json = (await response.json()) as T;
      circuit.failures = 0;
      if (opts.cacheTtlMs && opts.cacheTtlMs > 0) {
        if (cache.size >= 500) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, { expires: Date.now() + opts.cacheTtlMs, value: json, retrievedAt: nowIso() });
      }
      return json;
    } catch (error: any) {
      lastError = error;
      const category = error instanceof BusinessDataError
        ? error.category
        : /abort|timeout/i.test(String(error?.message || error))
          ? 'timeout'
          : /fetch failed|network|econnreset|enotfound/i.test(String(error?.message || error))
            ? 'network'
            : 'unknown';
      if (category === 'rate_limit') {
        circuit.until = Date.now() + Math.max(60000, error instanceof BusinessDataError ? error.retryAfterMs || 0 : 0);
        break;
      }
      const retryable = category === 'timeout' || category === 'network' || category === 'server';
      if (retryable && ++circuit.failures >= 3) { circuit.until = Date.now() + 60000; break; }
      if (!retryable || attempt >= attempts) break;
      const wait = error instanceof BusinessDataError && error.retryAfterMs
        ? Math.min(error.retryAfterMs, 8_000)
        : Math.min(500 * Math.pow(2, attempt - 1), 4_000);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  if (lastError instanceof BusinessDataError) throw lastError;
  const msg = String((lastError as any)?.message || lastError || 'unknown error');
  throw new BusinessDataError({
    provider,
    category: /abort|timeout/i.test(msg) ? 'timeout' : 'network',
    message: msg.slice(0, 180),
  });
}

function cleanTerms(input: string): string[] {
  return Array.from(new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 4)
      .filter((word) => !['with', 'from', 'that', 'this', 'their', 'what', 'have', 'need', 'needs', 'business'].includes(word))
  )).slice(0, 8);
}

function buildQuery(parts: string[]): string {
  const terms = cleanTerms(parts.join(' '));
  return terms.slice(0, 5).join(' ') || 'small business';
}

export class OnsAdapter {
  readonly provider: BusinessProviderId = 'ons';
  constructor(private requestBudget = 60, private shouldContinue: () => Promise<boolean> = async () => true) {}
  private async read(path: string): Promise<any> {
    if (!await this.shouldContinue()) throw new BusinessDataError({ provider: 'ons', category: 'invalid_request', message: 'Discovery stopped before ONS dispatch.' });
    if (--this.requestBudget < 0) throw new BusinessDataError({ provider: 'ons', category: 'rate_limit', message: 'ONS discovery request budget reached.' });
    return fetchJson(this.provider, `${this.baseUrl}${path}`, { cacheTtlMs: 3600000, retries: 1 });
  }
  async listDatasets(limit = 100, offset = 0): Promise<any> { return this.read(`/datasets?limit=${Math.min(limit, 100)}&offset=${offset}`); }
  async getVersion(datasetId: string, edition: string, version: string): Promise<any> {
    return this.read(`/datasets/${encodeURIComponent(datasetId)}/editions/${encodeURIComponent(edition)}/versions/${encodeURIComponent(version)}`);
  }
  async getDimensionOptions(datasetId: string, edition: string, version: string, dimension: string, offset = 0): Promise<any> {
    return this.read(`/datasets/${encodeURIComponent(datasetId)}/editions/${encodeURIComponent(edition)}/versions/${encodeURIComponent(version)}/dimensions/${encodeURIComponent(dimension)}/options?limit=1000&offset=${offset}`);
  }
  readonly baseUrl = 'https://api.beta.ons.gov.uk/v1';

  async searchDatasets(query: string, limit = 5): Promise<EvidenceRecord[]> {
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&limit=${Math.min(limit, 10)}`;
    const data: any = await this.read(`/search?q=${encodeURIComponent(query)}&limit=${Math.min(limit, 10)}`);
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data?.results) ? data.results : [];
    return items.slice(0, limit).map((item: any) => {
      const href = item?.links?.self?.href || item?.uri || item?.url || url;
      return {
        provider: this.provider,
        source: 'Office for National Statistics API',
        title: item?.description?.title || item?.title || item?.description || 'ONS dataset',
        url: String(href).startsWith('http') ? String(href) : `https://www.ons.gov.uk${href}`,
        retrievedAt: nowIso(),
        geography: item?.description?.national_statistic ? 'UK' : undefined,
        summary: item?.description?.summary || item?.summary || item?.description?.keywords?.join(', ') || 'ONS dataset discovered for market context.',
        caveats: [
          'ONS statistics are supporting macro evidence, not proof of customer demand or profitability.',
          'Dataset dimensions vary by dataset; observations must be requested with the dataset-specific dimensions.',
        ],
        raw: item,
      };
    });
  }

  async getDataset(datasetId: string): Promise<any> {
    const safeId = datasetId.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(safeId)) throw new BusinessDataError({ provider: this.provider, category: 'invalid_request', message: 'Invalid ONS dataset id.' });
    return this.read(`/datasets/${encodeURIComponent(safeId)}`);
  }

  async getObservation(params: {
    datasetId: string;
    edition: string;
    version: string | number;
    dimensions: Record<string, string>;
  }): Promise<EvidenceRecord> {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params.dimensions)) {
      qs.set(key, value);
    }
    const path = `/datasets/${encodeURIComponent(params.datasetId)}/editions/${encodeURIComponent(params.edition)}/versions/${encodeURIComponent(String(params.version))}/observations`;
    const url = `${this.baseUrl}${path}?${qs.toString()}`;
    const data: any = await this.read(`${path}?${qs.toString()}`);
    return {
      provider: this.provider,
      source: 'Office for National Statistics API',
      title: `ONS observation: ${params.datasetId}`,
      url,
      retrievedAt: cache.get(`${this.provider}:${url}:{}`)?.retrievedAt || nowIso(),
      reportingPeriod: params.dimensions.time,
      geography: params.dimensions.geography,
      summary: `Retrieved ${Array.isArray(data?.observations) ? data.observations.length : 0} observation(s), unit: ${data?.unit_of_measure || 'not specified'}.`,
      caveats: [
        'Observation filters are dataset-specific; one dimension may be wildcarded where supported by ONS.',
        'Statistics should be combined with other evidence before business validation.',
      ],
      raw: data,
    };
  }
}

export function formatEvidenceForPrompt(bundle: BusinessResearchBundle): string {
  if (bundle.evidence.length === 0 && bundle.unavailable.length === 0) {
    return 'No UK business-data API evidence was available for this item.';
  }
  const evidence = bundle.evidence.slice(0, 12).map((item, index) => [
    `${index + 1}. ${item.title}`,
    `Provider: ${item.source}`,
    `URL: ${item.url}`,
    `Retrieved: ${item.retrievedAt}`,
    item.reportingPeriod ? `Reporting period/publication date: ${item.reportingPeriod}` : '',
    item.geography ? `Geography: ${item.geography}` : '',
    `Summary: ${item.summary}`,
    `Caveats: ${item.caveats.join(' ')}`,
  ].filter(Boolean).join('\n')).join('\n\n');
  const unavailable = bundle.unavailable.length
    ? `\n\nUnavailable providers: ${bundle.unavailable.map((u) => `${u.provider} (${u.reason})`).join('; ')}`
    : '';
  return `${evidence}${unavailable}`;
}

export async function collectBusinessEvidenceForGap(gap: {
  knows?: string;
  needs?: string;
  controlsAccess?: string;
  underestimatesValue?: string;
  source?: string;
}): Promise<BusinessResearchBundle> {
  const query = buildQuery([
    gap.knows || '',
    gap.needs || '',
    gap.controlsAccess || '',
    gap.underestimatesValue || '',
    gap.source || '',
  ]);
  const industryTerms = cleanTerms(query);
  const unavailable: BusinessResearchBundle['unavailable'] = [];
  const evidence: EvidenceRecord[] = [];

  const ons = new OnsAdapter();

  const tasks: Promise<EvidenceRecord[]>[] = [
    ons.searchDatasets(`${query} industry business economy`, 4).catch((error) => {
      unavailable.push({ provider: 'ons', reason: (error as Error).message });
      return [];
    }),
  ];

  const settled = await Promise.all(tasks);
  for (const records of settled) evidence.push(...records);

  return { query, industryTerms, evidence, unavailable };
}

export async function testBusinessDataSmoke(): Promise<BusinessResearchBundle> {
  return collectBusinessEvidenceForGap({
    knows: 'UK small business operators',
    needs: 'market conditions and industry statistics',
    controlsAccess: 'official statistics publishers',
    underestimatesValue: 'fragmented public statistics',
    source: 'business_data_smoke',
  });
}
