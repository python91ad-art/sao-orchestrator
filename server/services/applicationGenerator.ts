// ==========================================
// APPLICATION GENERATOR
// ==========================================
// Converts a SAFE gap + business plan into a
// deployable web application artifact via Groq LLM.
// ==========================================

import { callLLMJson, MODEL_BUSINESS_PLAN } from './llm';

// ==========================================
// TYPES
// ==========================================

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GeneratedApplication {
  files: GeneratedFile[];
  entryPoint: string;
  framework: 'static' | 'react' | 'other';
  description: string;
}

export interface GenerationInput {
  gapId: string;
  deploymentId: string;
  knows: string;
  needs: string;
  controlsAccess: string;
  underestimatesValue: string;
  businessPlan: string;
}

export interface GenerationResult {
  success: boolean;
  application?: GeneratedApplication;
  error?: string;
  modelUsed?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ==========================================
// SAFETY LIMITS
// ==========================================

const MAX_FILES = 30;
const MAX_FILE_SIZE = 200_000;
const MAX_TOTAL_SIZE = 1_000_000;

const FORBIDDEN_PATTERNS: RegExp[] = [
  /process\.env/i,
  /api[_-]?key\s*[:=]\s*['"`][A-Za-z0-9_-]{8,}/i,
  /fetch\s*\(\s*['"`]https?:\/\/[^'"`]+['"`]\s*,\s*\{[^}]*['"`](?:token|key|secret|auth)/i,
  /child_process/i,
  /require\s*\(\s*['"`](?:child_process|fs|os|net|cluster)/i,
  /exec\s*\(/i,
  /eval\s*\(/i,
  /new\s+Function\s*\(/i,
  /rm\s+-rf/i,
  /\/etc\/passwd/i,
];

// ==========================================
// LLM PROMPT TEMPLATES
// ==========================================

function buildSystemPrompt(): string {
  return `You are an expert front-end web application generator for the SAO platform.

Your task is to generate a COMPLETE, deployable, self-contained web application.

CRITICAL RULES:
1. Generate a STATIC web app (HTML + CSS + JavaScript). No backend, no server.
2. ALL files must be COMPLETE — no placeholders or "TODO" or lorem ipsum.
3. The app must be functional for the described market gap.
4. Use semantic HTML5, modern CSS (flex/grid), vanilla JavaScript.
5. Responsive design (mobile + desktop).
6. NO external APIs unless free/public and require NO authentication.
7. NO secrets, API keys, tokens, credentials, environment variables.
8. NO server-side code, no Node.js require(), no process.env.
9. File paths relative: "index.html", "css/style.css", "js/main.js".
10. Every file must have real COMPLETE code.

Output valid JSON exactly matching:
{
  "description": "Brief description of the application",
  "entryPoint": "index.html",
  "framework": "static",
  "files": [
    { "path": "index.html", "content": "complete HTML here" }
  ]
}`;
}

function buildUserPrompt(input: GenerationInput): string {
  return `Generate a complete web application for this market gap.

MARKET GAP:
- Knows: ${input.knows}
- Needs: ${input.needs}
- Controls Access: ${input.controlsAccess}
- Underestimates Value: ${input.underestimatesValue}

BUSINESS PLAN:
${input.businessPlan}

Generate a web app that solves the gap. Include a clear value proposition.
Minimum files: index.html, css/style.css, js/main.js
Every file must have COMPLETE working code (no placeholders).
The app must work when opened directly in a browser.

Output ONLY valid JSON.`;
}

// ==========================================
// VALIDATION
// ==========================================

export function validateGeneratedApplication(
  app: GeneratedApplication
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!app.files || !Array.isArray(app.files)) {
    return { valid: false, errors: ['No files array.'], warnings: [] };
  }
  if (app.files.length === 0) {
    return { valid: false, errors: ['No files generated.'], warnings: [] };
  }
  if (app.files.length > MAX_FILES) {
    errors.push(`Too many files: ${app.files.length} (max ${MAX_FILES}).`);
  }
  if (!app.entryPoint) {
    errors.push('Missing entryPoint.');
  }

  const paths = new Set<string>();
  let totalSize = 0;

  for (const file of app.files) {
    if (!file.path || typeof file.path !== 'string') {
      errors.push('A file is missing its path.');
      continue;
    }
    if (file.path.startsWith('/')) {
      errors.push(`Absolute path rejected: "${file.path}".`);
    }
    if (file.path.includes('..')) {
      errors.push(`Path traversal rejected: "${file.path}".`);
    }
    if (paths.has(file.path)) {
      errors.push(`Duplicate path: "${file.path}".`);
    }
    paths.add(file.path);

    if (!file.content || typeof file.content !== 'string') {
      errors.push(`File "${file.path}" has missing/invalid content.`);
      continue;
    }
    if (file.content.length > MAX_FILE_SIZE) {
      errors.push(`File "${file.path}" too large: ${file.content.length} chars.`);
    }
    totalSize += file.content.length;

    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(file.content)) {
        errors.push(`File "${file.path}" contains forbidden pattern.`);
        break;
      }
    }
  }

  if (totalSize > MAX_TOTAL_SIZE) {
    errors.push(`Total size too large: ${totalSize} chars.`);
  }
  if (app.entryPoint && !paths.has(app.entryPoint)) {
    errors.push(`Entry point "${app.entryPoint}" not found.`);
  }
  if (!app.files.some((f) => f.path.endsWith('.html'))) {
    errors.push('No HTML file found.');
  }
  if (app.files.length === 1) {
    warnings.push('Only a single file generated.');
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateApplicationStructure(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') {
    return 'LLM did not return a valid JSON object.';
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.files)) {
    return 'Missing or invalid "files" array.';
  }
  if (obj.files.length === 0) {
    return 'Generated application contains no files.';
  }
  for (let i = 0; i < obj.files.length; i++) {
    const f = (obj.files as any[])[i];
    if (!f || typeof f.path !== 'string') {
      return `File at index ${i} is missing a "path" field.`;
    }
    if (typeof f.content !== 'string' || f.content.length === 0) {
      return `File "${f.path || `index ${i}`}" has empty/missing content.`;
    }
  }
  return null;
}

// ==========================================
// GENERATION
// ==========================================

export async function generateApplication(
  input: GenerationInput
): Promise<GenerationResult> {
  const startTime = Date.now();
  console.log(
    `[AppGen] Generating for gap ${input.gapId}, deployment ${input.deploymentId}.`
  );

  try {
    const raw = await callLLMJson<Record<string, unknown>>(
      buildUserPrompt(input),
      {
        model: MODEL_BUSINESS_PLAN,
        systemPrompt: buildSystemPrompt(),
        maxTokens: 16384,
        temperature: 0.5,
      }
    );

    const structError = validateApplicationStructure(raw);
    if (structError) {
      console.error(`[AppGen] Structure validation failed: ${structError}`);
      return {
        success: false,
        error: `Structure error: ${structError}`,
        modelUsed: MODEL_BUSINESS_PLAN,
      };
    }

    const app: GeneratedApplication = {
      files: (raw.files as any[]).map((f: any) => ({
        path: f.path,
        content: f.content,
      })),
      entryPoint:
        typeof raw.entryPoint === 'string'
          ? raw.entryPoint
          : ((raw.files as any[])?.[0]?.path || 'index.html'),
      framework:
        typeof raw.framework === 'string'
          ? (raw.framework as GeneratedApplication['framework'])
          : 'static',
      description:
        typeof raw.description === 'string' ? raw.description : '',
    };

    const validation = validateGeneratedApplication(app);
    if (!validation.valid) {
      console.error(
        `[AppGen] Validation failed: ${validation.errors.join('; ')}`
      );
      return {
        success: false,
        error: `Validation failed: ${validation.errors.join('; ')}`,
        modelUsed: MODEL_BUSINESS_PLAN,
      };
    }

    if (validation.warnings.length > 0) {
      console.warn(
        `[AppGen] Warnings: ${validation.warnings.join('; ')}`
      );
    }

    const duration = Date.now() - startTime;
    const totalChars = app.files.reduce((s, f) => s + f.content.length, 0);
    console.log(
      `[AppGen] Generated ${app.files.length} files (${totalChars} chars) in ${duration}ms.`
    );

    return {
      success: true,
      application: app,
      modelUsed: MODEL_BUSINESS_PLAN,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(
      `[AppGen] Failed after ${duration}ms:`,
      error?.message || String(error)
    );
    return {
      success: false,
      error: `Generation failed: ${error?.message || 'Unknown error'}`,
      modelUsed: MODEL_BUSINESS_PLAN,
    };
  }
}
