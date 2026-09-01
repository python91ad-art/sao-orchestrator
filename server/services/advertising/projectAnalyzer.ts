// ============================================================
// PROJECT ANALYZER (Phase 13)
//
// Analyses a deployed SAO project to extract advertising-relevant
// information: what it does, target audience, keywords, value prop.
// Uses existing SAO data — does NOT scrape arbitrary websites.
// ============================================================

import { callLLMJson } from '../llm';

export interface ProjectAnalysis {
  deploymentId: string;
  appName: string;
  category: string;
  description: string;
  functionality: string[];
  targetUsers: string[];
  valueProposition: string;
  keywords: string[];
  advertisingAngles: string[];
  callsToAction: string[];
  completeness: 'complete' | 'partial' | 'insufficient';
  missingFields: string[];
}

export interface AnalysisInput {
  deploymentId: string;
  knows: string;
  needs: string;
  controlsAccess: string;
  underestimatesValue: string;
  businessPlan?: string;
  appDescription?: string;
  files?: { path: string; content?: string }[];
}

/**
 * Analyse a project from available SAO data. Uses the LLM router for
 * projects with sufficient information; falls back to direct data extraction
 * for projects with minimal data.
 */
export async function analyzeProject(input: AnalysisInput): Promise<ProjectAnalysis> {
  const missing: string[] = [];

  // Check data completeness
  const hasGap = input.knows && input.needs;
  const hasPlan = !!(input.businessPlan && input.businessPlan.length > 50);

  if (!hasGap && !hasPlan && !input.appDescription) {
    return {
      deploymentId: input.deploymentId,
      appName: `SAO App ${input.deploymentId.slice(0, 8)}`,
      category: 'unknown',
      description: 'Insufficient project data available for analysis.',
      functionality: [],
      targetUsers: [],
      valueProposition: 'Unknown — insufficient data',
      keywords: [],
      advertisingAngles: [],
      callsToAction: [],
      completeness: 'insufficient',
      missingFields: ['gap data', 'business plan', 'app description', 'files'],
    };
  }

  // Build a prompt from available data
  const dataParts: string[] = [];
  if (input.knows) dataParts.push(`Who has the knowledge: ${input.knows}`);
  if (input.needs) dataParts.push(`Market need: ${input.needs}`);
  if (input.controlsAccess) dataParts.push(`Gatekeepers: ${input.controlsAccess}`);
  if (input.underestimatesValue) dataParts.push(`Value inefficiency: ${input.underestimatesValue}`);
  if (input.businessPlan) dataParts.push(`Business Plan: ${input.businessPlan.slice(0, 2000)}`);
  if (input.appDescription) dataParts.push(`App Description: ${input.appDescription}`);

  const dataText = dataParts.join('\n');

  try {
    const result = await callLLMJson<{
      category: string;
      description: string;
      functionality: string[];
      targetUsers: string[];
      valueProposition: string;
      keywords: string[];
      advertisingAngles: string[];
      callsToAction: string[];
    }>(
      `Analyse this SAO-deployed project for advertising purposes. Return only the JSON object.\n\n${dataText}`,
      {
        task: 'PROJECT_ANALYSIS',
        systemPrompt: `You are a project analyst for the SAO advertising system. Identify what this project does, who its users are, its value proposition, keywords, advertising angles, and calls-to-action. Use ONLY the provided information — do NOT invent facts. If information is insufficient, mark fields as empty or describe uncertainty.`,
        jsonMode: true,
        maxTokens: 1500,
        temperature: 0.3,
      }
    );

    const completeness = determineCompleteness(result, input);

    return {
      deploymentId: input.deploymentId,
      appName: deriveAppName(input),
      category: result.category || 'uncategorized',
      description: result.description || 'No description available',
      functionality: Array.isArray(result.functionality) ? result.functionality : [],
      targetUsers: Array.isArray(result.targetUsers) ? result.targetUsers : [],
      valueProposition: result.valueProposition || 'Unknown',
      keywords: Array.isArray(result.keywords) ? result.keywords : [],
      advertisingAngles: Array.isArray(result.advertisingAngles) ? result.advertisingAngles : [],
      callsToAction: Array.isArray(result.callsToAction) ? result.callsToAction : [],
      completeness,
      missingFields: completeness === 'complete' ? [] : missing,
    };
  } catch (error: any) {
    console.error(`[ProjectAnalyzer] LLM analysis failed for ${input.deploymentId}:`, error?.message || error);
    return {
      deploymentId: input.deploymentId,
      appName: deriveAppName(input),
      category: 'unknown',
      description: 'Analysis failed — LLM unavailable',
      functionality: [],
      targetUsers: [],
      valueProposition: 'Unknown',
      keywords: [],
      advertisingAngles: [],
      callsToAction: [],
      completeness: 'insufficient',
      missingFields: ['analysis failed'],
    };
  }
}

function deriveAppName(input: AnalysisInput): string {
  if (input.appDescription) {
    const firstLine = input.appDescription.split('\n')[0].slice(0, 50);
    if (firstLine) return firstLine;
  }
  if (input.needs) {
    return input.needs.slice(0, 50) + ' App';
  }
  return `SAO App ${input.deploymentId.slice(0, 8)}`;
}

function determineCompleteness(
  result: Record<string, unknown>,
  _input: AnalysisInput
): 'complete' | 'partial' | 'insufficient' {
  const hasKeyFields =
    result.category &&
    result.description &&
    Array.isArray(result.keywords) && result.keywords.length > 0 &&
    Array.isArray(result.targetUsers) && result.targetUsers.length > 0;

  if (hasKeyFields) return 'complete';
  if (result.description || (Array.isArray(result.keywords) && result.keywords.length > 0)) return 'partial';
  return 'insufficient';
}
