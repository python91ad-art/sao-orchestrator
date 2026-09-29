export type GapClassification = 'safe' | 'unsafe' | 'gray' | 'false';
export type BanRisk = 'low' | 'medium' | 'high';

export interface GapInput {
  knows: string;
  needs: string;
  controlsAccess: string;
  underestimatesValue: string;
  source: string;
}

export interface ClassifierResult {
  classification: GapClassification;
  reasoning: string;
  banRisk: BanRisk;
  explanation: string;
}

export interface GapAnalysisDecision extends ClassifierResult {
  normalized: GapInput;
  score: number;
  qualified: boolean;
  evidenceLevel: 'low' | 'medium' | 'high';
  decisionReason: string;
}

export const QUALIFICATION_THRESHOLD = 60;

export function normalizeGap(input: GapInput): GapInput {
  return {
    knows: input.knows.trim().replace(/\s+/g, ' '),
    needs: input.needs.trim().replace(/\s+/g, ' '),
    controlsAccess: input.controlsAccess.trim().replace(/\s+/g, ' '),
    underestimatesValue: input.underestimatesValue.trim().replace(/\s+/g, ' '),
    source: input.source.trim() || 'unknown',
  };
}

function hasAny(text: string, words: string[]) {
  return words.some((word) => text.includes(word));
}

export function scoreGap(input: GapInput): { score: number; evidenceLevel: 'low' | 'medium' | 'high'; reasons: string[] } {
  const gap = normalizeGap(input);
  const combined = `${gap.knows} ${gap.needs} ${gap.controlsAccess} ${gap.underestimatesValue} ${gap.source}`.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  for (const [field, value] of Object.entries(gap)) {
    if (field === 'source') continue;
    if (value.length >= 20) {
      score += 12;
      reasons.push(`${field}:specific`);
    } else if (value.length >= 8) {
      score += 6;
      reasons.push(`${field}:present`);
    }
  }

  if (hasAny(combined, ['urgent', 'expensive', 'cost', 'revenue', 'replacement', 'compliance', 'manual', 'booking', 'invoice'])) {
    score += 18;
    reasons.push('economic-urgency');
  }
  if (hasAny(combined, ['vetted', 'evidence', 'data', 'forum', 'reviews', 'technicians', 'operators', 'customers'])) {
    score += 14;
    reasons.push('evidence-signal');
  }
  if (hasAny(combined, ['gatekeeper', 'controls', 'restrict', 'dealer', 'manufacturer', 'platform'])) {
    score += 12;
    reasons.push('access-control');
  }
  if (hasAny(combined, ['undervalued', 'underpriced', 'fragmented', 'scattered', 'overlooked'])) {
    score += 10;
    reasons.push('value-mismatch');
  }
  if (hasAny(combined, ['low evidence', 'weak', 'unclear', 'maybe'])) {
    score -= 25;
    reasons.push('weak-evidence');
  }
  if (hasAny(combined, ['conflicting evidence', 'contradictory'])) {
    score -= 15;
    reasons.push('conflicting-evidence');
  }

  score = Math.max(0, Math.min(100, score));
  const evidenceLevel = score >= 75 ? 'high' : score >= QUALIFICATION_THRESHOLD ? 'medium' : 'low';
  return { score, evidenceLevel, reasons };
}

export function decideGapAnalysis(input: GapInput, classifier: ClassifierResult): GapAnalysisDecision {
  const normalized = normalizeGap(input);
  const scored = scoreGap(normalized);
  let classification = classifier.classification || 'gray';
  let qualified = classification === 'safe' && scored.score >= QUALIFICATION_THRESHOLD;
  let decisionReason = `score=${scored.score}; evidence=${scored.evidenceLevel}; signals=${scored.reasons.join(',') || 'none'}`;

  if (classification === 'safe' && !qualified) {
    classification = 'gray';
    decisionReason += '; safe classifier result held for low deterministic evidence';
  }

  if (classification !== 'safe') {
    qualified = false;
  }

  return {
    ...classifier,
    classification,
    normalized,
    score: scored.score,
    qualified,
    evidenceLevel: scored.evidenceLevel,
    reasoning: `${classifier.reasoning} (${decisionReason})`,
    decisionReason,
  };
}
