import * as cheerio from 'cheerio';
import { callLLMJson } from './llm';

export interface CrawlResult {
  success: boolean;
  content?: string;
  title?: string;
  error?: string;
}

export interface ExtractedGap {
  knows: string;
  needs: string;
  controlsAccess: string;
  underestimatesValue: string;
  source: string;
}

/**
 * Fetch HTML from a URL and extract visible text using cheerio.
 * No external API needed — just node-fetch + cheerio.
 */
export async function crawlUrl(url: string): Promise<CrawlResult> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SAO-Crawler/1.0; +https://github.com/sao)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status} for ${url}` };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove non-content elements
    $('script, style, nav, footer, header, aside, noscript, iframe, svg').remove();

    const title = $('title').text().trim() || $('h1').first().text().trim() || url;
    
    // Extract visible text — prefer article/main body, fall back to full body
    const bodyText = $('article, main, .content, .post, .entry, body')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    // Truncate to ~8000 chars to stay within LLM context limits
    const content = bodyText.slice(0, 8000);

    if (!content || content.length < 50) {
      return { success: false, error: 'Page content too sparse to analyze' };
    }

    return { success: true, content, title };
  } catch (error: any) {
    console.error('[Crawler] crawlUrl failed:', error);
    return { success: false, error: error.message || String(error) };
  }
}

/**
 * Send extracted text to Groq LLM to identify potential market gaps.
 */
export async function extractGapsFromContent(content: string, sourceUrl: string): Promise<ExtractedGap[]> {
  const prompt = `Analyze the following web content and extract concrete, hidden "Situational Arbitrage" market gaps.
Situational arbitrage occurs when there is an inefficiency, knowledge barrier, or friction between a provider and consumers that can be bypassed or served by a nimble startup.

For each gap, identify:
1. knows: Who possesses the special knowledge/data or capabilities?
2. needs: Who urgently demands this value, and what is their problem?
3. controlsAccess: Who is the gatekeeper/platform controlling the transaction?
4. underestimatesValue: Why is the price, resource, or effort undervalued or inefficiently deployed?

Content to analyze:
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

    if (!parsed.gaps || !Array.isArray(parsed.gaps)) {
      console.warn('[Crawler] ⚠️ LLM returned no valid gaps array — no gaps extracted.');
      return [];
    }

    return parsed.gaps.map((g: any) => ({
      knows: g.knows || '',
      needs: g.needs || '',
      controlsAccess: g.controlsAccess || '',
      underestimatesValue: g.underestimatesValue || '',
      source: sourceUrl,
    }));
  } catch (error: any) {
    const msg = String(error?.message || error || 'unknown error').toLowerCase();
    let category = 'unknown';
    if (/rate.?limit|too many requests|quota|429/i.test(msg)) category = 'rate_limit';
    else if (/unauthorized|forbidden|auth|401|403/i.test(msg)) category = 'auth_failure';
    else if (/timed? ?out|abort|etimedout/i.test(msg)) category = 'llm_timeout';
    else if (/network|fetch failed|econn/i.test(msg)) category = 'network_error';
    else if (/json|parse|unexpected token/i.test(msg)) category = 'malformed_json';

    console.error(`[Crawler] ❌ LLM extraction FAILED (category: ${category}): ${error?.message || error}`);
    
    throw Object.assign(
      new Error(`LLM gap extraction failed [${category}]: ${error?.message || 'Unknown error'}`),
      { code: 'EXTRACTION_FAILED', category, sourceUrl }
    );
  }
}

/**
 * Crawl a URL and extract gaps in one step.
 */
export async function crawlAndExtract(url: string): Promise<ExtractedGap[]> {
  const crawlResult = await crawlUrl(url);
  if (!crawlResult.success || !crawlResult.content) {
    console.error(`[Crawler] Crawl failed for ${url}:`, crawlResult.error);
    return [];
  }
  try {
    return await extractGapsFromContent(crawlResult.content, url);
  } catch (error: any) {
    console.error(
      `[Crawler] ❌ Extraction failed for ${url} ` +
      `(category: ${error?.category || 'unknown'}): ${error?.message || error}`
    );
    return [];
  }
}
