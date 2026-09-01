// ============================================================
// ADVERTISING CREATIVE GENERATOR (Phase 13)
//
// Uses the existing multi-provider LLM router to generate
// structured advertising content for a specific campaign.
// Never sends secrets to the LLM. Validates output.
// ============================================================

import { callLLMJson } from '../llm';
import { AdvertisingStrategy } from './strategyEngine';
import { ProjectAnalysis } from './projectAnalyzer';

export interface GeneratedCreative {
  format: 'headline' | 'primary_text' | 'description' | 'cta' | 'social_post';
  content: string;
  headline?: string;
  callToAction?: string;
  targetAudience?: string;
  variation: number;
}

export interface CreativeGenerationInput {
  projectAnalysis: ProjectAnalysis;
  strategy: AdvertisingStrategy;
  campaignId: string;
  deploymentId: string;
}

export interface CreativeGenerationResult {
  success: boolean;
  creatives: GeneratedCreative[];
  error?: string;
  modelUsed?: string;
}

// Forbidden patterns — prevent LLM from inserting secrets
const FORBIDDEN_AD_PATTERNS: RegExp[] = [
  /api[_-]?key\s*[:=]\s*['"`][A-Za-z0-9_-]{8,}/i,
  /process\.env/i,
  /GROQ_API_KEY|RESEND_API_KEY|JWT_SECRET|DATABASE_URL/i,
  /gsk_[A-Za-z0-9]+/i,
  /re_[A-Za-z0-9]+/i,
  /AIza[A-Za-z0-9_-]+/i,
  /sk-[A-Za-z0-9]+/i,
  /ghp_[A-Za-z0-9]+/i,
  /BEGIN RSA PRIVATE KEY/i,
];

function validateCreative(creative: GeneratedCreative): string | null {
  if (!creative.content || creative.content.trim().length === 0) {
    return 'Empty content';
  }

  for (const pattern of FORBIDDEN_AD_PATTERNS) {
    if (pattern.test(creative.content)) return 'Content contains forbidden patterns';
    if (creative.headline && pattern.test(creative.headline)) return 'Headline contains forbidden patterns';
    if (creative.callToAction && pattern.test(creative.callToAction)) return 'CTA contains forbidden patterns';
  }

  // Content length limits
  if (creative.format === 'headline' && creative.content.length > 150) return 'Headline too long';
  if (creative.format === 'description' && creative.content.length > 500) return 'Description too long';
  if (creative.format === 'cta' && creative.content.length > 50) return 'CTA too long';
  if (creative.format === 'social_post' && creative.content.length > 2000) return 'Social post too long';

  return null;
}

function buildCreativePrompt(input: CreativeGenerationInput): string {
  return `Generate advertising creatives for this SAO-deployed project.

PROJECT:
- Name: ${input.projectAnalysis.appName}
- Category: ${input.projectAnalysis.category}
- Description: ${input.projectAnalysis.description}
- Value Proposition: ${input.projectAnalysis.valueProposition}
- Keywords: ${input.projectAnalysis.keywords.join(', ')}
- Target Users: ${input.projectAnalysis.targetUsers.join(', ')}

STRATEGY:
- What to promote: ${input.strategy.whatToPromote}
- Key Messages: ${input.strategy.keyMessages.join(' | ')}
- Objectives: ${input.strategy.campaignObjectives.join(', ')}

Generate advertising creatives for each format. Follow standard advertising best practices.
Use ONLY the provided project information — do NOT invent or fabricate facts.
Never include API keys, secrets, URLs to internal systems, or technical infrastructure details.

Output valid JSON:
{
  "creatives": [
    { "format": "headline", "content": "...", "headline": "...", "callToAction": null, "targetAudience": "...", "variation": 1 },
    { "format": "primary_text", "content": "...", "headline": null, "callToAction": "...", "targetAudience": "...", "variation": 1 },
    { "format": "description", "content": "...", "headline": null, "callToAction": null, "targetAudience": null, "variation": 1 },
    { "format": "cta", "content": "...", "headline": null, "callToAction": "...", "targetAudience": null, "variation": 1 },
    { "format": "social_post", "content": "...", "headline": null, "callToAction": "...", "targetAudience": null, "variation": 1 }
  ]
}`;
}

/**
 * Generate advertising creatives using the existing LLM router.
 */
export async function generateCreatives(
  input: CreativeGenerationInput
): Promise<CreativeGenerationResult> {
  try {
    const result = await callLLMJson<{ creatives: GeneratedCreative[] }>(buildCreativePrompt(input), {
      task: 'ADVERTISING_CREATIVE',
      systemPrompt: `You are an expert advertising copywriter for the SAO platform. Create compelling, conversion-focused advertising content. Use ONLY provided project information. Never include API keys, secrets, or internal infrastructure details.`,
      jsonMode: true,
      maxTokens: 2500,
      temperature: 0.8,
    });

    if (!Array.isArray(result.creatives) || result.creatives.length === 0) {
      return {
        success: false,
        creatives: [],
        error: 'LLM did not return valid creatives array',
      };
    }

    const validated: GeneratedCreative[] = [];
    for (const creative of result.creatives) {
      const error = validateCreative(creative);
      if (error) {
        console.warn(`[CreativeGen] Skipping invalid creative (${creative.format}): ${error}`);
        continue;
      }
      validated.push({
        format: creative.format || 'primary_text',
        content: creative.content,
        headline: creative.headline || undefined,
        callToAction: creative.callToAction || undefined,
        targetAudience: creative.targetAudience || undefined,
        variation: creative.variation || 1,
      });
    }

    if (validated.length === 0) {
      return { success: false, creatives: [], error: 'All generated creatives failed validation' };
    }

    return { success: true, creatives: validated };
  } catch (error: any) {
    console.error('[CreativeGen] Generate failed:', error?.message || error);
    return {
      success: false,
      creatives: [],
      error: `Creative generation failed: ${error?.message || 'Unknown error'}`,
    };
  }
}

/**
 * Generate a quick set of basic creatives WITHOUT calling the LLM.
 * Used when LLM is unavailable or as a fallback for simple projects.
 */
export function generateBasicCreatives(input: CreativeGenerationInput): GeneratedCreative[] {
  const { projectAnalysis, strategy } = input;
  const name = projectAnalysis.appName || 'Our App';
  const desc = projectAnalysis.description || 'A useful solution';

  return [
    {
      format: 'headline',
      content: `${name} — ${strategy.valueProposition.slice(0, 100) || desc.slice(0, 100)}`,
      headline: name,
      callToAction: undefined,
      targetAudience: projectAnalysis.targetUsers.join(', ') || undefined,
      variation: 1,
    },
    {
      format: 'primary_text',
      content: desc,
      headline: undefined,
      callToAction: projectAnalysis.callsToAction[0] || 'Learn More',
      targetAudience: undefined,
      variation: 1,
    },
    {
      format: 'cta',
      content: projectAnalysis.callsToAction[0] || 'Get Started',
      headline: undefined,
      callToAction: projectAnalysis.callsToAction[0] || 'Get Started',
      targetAudience: undefined,
      variation: 1,
    },
  ];
}
