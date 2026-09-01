// ==========================================
// APPLICATION GENERATOR
// ==========================================
// Converts a SAFE gap + business plan into a
// deployable web application artifact via Groq LLM.
// ==========================================

import { callLLMJsonWithMeta } from './llm';

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
// ============================================================
// APPLICATION SMOKE TESTER — Pre-Deployment Validation
// ============================================================
// Validates generated applications before they are deployed.
// Catches: broken references, empty files, placeholder content,
// missing entry points, and basic structural issues.
// ============================================================

export interface SmokeTestResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  entryPointFound: boolean;
  allReferencesResolved: boolean;
  stats: {
    totalFiles: number;
    totalChars: number;
    htmlFiles: number;
    cssFiles: number;
    jsFiles: number;
    otherFiles: number;
  };
}

const PLACEHOLDER_PATTERNS = [
  /TODO/i,
  /FIXME/i,
  /lorem ipsum/i,
  /placeholder/i,
  /your content here/i,
  /add your/i,
  /insert here/i,
  /coming soon/i,
  /under construction/i,
];

function classifyFilePath(path: string): 'html' | 'css' | 'js' | 'other' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.js')) return 'js';
  return 'other';
}

function extractHtmlReferences(html: string): string[] {
  const refs: string[] = [];
  const linkRegex = /<link\s[^>]*href=["']([^"']+)["']/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    refs.push(match[1]);
  }
  const scriptRegex = /<script\s[^>]*src=["']([^"']+)["']/gi;
  while ((match = scriptRegex.exec(html)) !== null) {
    refs.push(match[1]);
  }
  const imgRegex = /<img\s[^>]*src=["']([^"']+)["']/gi;
  while ((match = imgRegex.exec(html)) !== null) {
    refs.push(match[1]);
  }
  const urlRegex = /url\(["']?([^)"']+)["']?\)/gi;
  while ((match = urlRegex.exec(html)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

/**
 * Run a smoke test on a generated application before deployment.
 * Checks: entry point exists, no placeholders, all HTML references
 * resolve to generated files, minimum file/content requirements,
 * HTML structure, JS syntax, CSS syntax, and more.
 */
export function smokeTestApplication(app: GeneratedApplication): SmokeTestResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const filePaths = new Set(app.files.map((f) => f.path));
  const stats = {
    totalFiles: app.files.length,
    totalChars: app.files.reduce((s, f) => s + f.content.length, 0),
    htmlFiles: 0,
    cssFiles: 0,
    jsFiles: 0,
    otherFiles: 0,
  };

  for (const file of app.files) {
    const type = classifyFilePath(file.path);
    if (type === 'html') stats.htmlFiles++;
    else if (type === 'css') stats.cssFiles++;
    else if (type === 'js') stats.jsFiles++;
    else stats.otherFiles++;
  }

  // --- Entry point check ---
  if (!filePaths.has(app.entryPoint)) {
    errors.push(`Entry point "${app.entryPoint}" not found in generated files.`);
  }

  if (stats.htmlFiles === 0) {
    errors.push('Generated application contains no HTML files.');
  }

  // --- Placeholder content check ---
  for (const file of app.files) {
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(file.content)) {
        warnings.push(`File "${file.path}" contains placeholder content matching "${pattern}".`);
        break;
      }
    }
  }

  // --- HTML structural checks ---
  for (const file of app.files) {
    if (classifyFilePath(file.path) !== 'html') continue;
    const html = file.content;
    // Check for basic HTML skeleton
    if (!/<html/i.test(html) && !/<body/i.test(html) && !/<div/i.test(html) && !/<main/i.test(html) && !/<section/i.test(html)) {
      warnings.push(`HTML file "${file.path}" does not contain recognizable HTML elements.`);
    }
    if (!/<title/i.test(html) && file.path === app.entryPoint) {
      warnings.push(`Entry point "${file.path}" is missing a <title> tag.`);
    }
    // Check for broken/unclosed tags (heuristic)
    const openDivs = (html.match(/<div[ >]/gi) || []).length;
    const closeDivs = (html.match(/<\/div>/gi) || []).length;
    if (Math.abs(openDivs - closeDivs) > 3) {
      warnings.push(`HTML file "${file.path}" may have unbalanced <div> tags (${openDivs} open, ${closeDivs} close).`);
    }
  }

  // --- CSS structural checks ---
  for (const file of app.files) {
    if (classifyFilePath(file.path) !== 'css') continue;
    const css = file.content;
    // Check for broken braces
    const openBraces = (css.match(/\{/g) || []).length;
    const closeBraces = (css.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      errors.push(`CSS file "${file.path}" has unbalanced braces (${openBraces} open, ${closeBraces} close).`);
    }
    // Check for common CSS syntax errors
    if (/:\s*;/.test(css)) {
      warnings.push(`CSS file "${file.path}" contains empty property values (e.g. "color: ;").`);
    }
  }

  // --- JS structural checks ---
  for (const file of app.files) {
    if (classifyFilePath(file.path) !== 'js') continue;
    const js = file.content;
    // Basic brace/paren balance
    const openCurly = (js.match(/\{/g) || []).length;
    const closeCurly = (js.match(/\}/g) || []).length;
    const openParen = (js.match(/\(/g) || []).length;
    const closeParen = (js.match(/\)/g) || []).length;
    if (openCurly !== closeCurly) {
      errors.push(`JS file "${file.path}" has unbalanced curly braces (${openCurly} open, ${closeCurly} close).`);
    }
    if (openParen !== closeParen) {
      errors.push(`JS file "${file.path}" has unbalanced parentheses (${openParen} open, ${closeParen} close).`);
    }
  }

  // --- Reference resolution ---
  let allRefsResolved = true;
  for (const file of app.files) {
    if (classifyFilePath(file.path) !== 'html') continue;
    
    const refs = extractHtmlReferences(file.content);
    for (const ref of refs) {
      if (ref.startsWith('http://') || ref.startsWith('https://') ||
          ref.startsWith('data:') || ref.startsWith('//') ||
          ref.startsWith('#')) {
        continue;
      }
      
      const normalized = ref.replace(/^\.\//, '');
      if (!filePaths.has(normalized)) {
        const baseDir = file.path.split('/').slice(0, -1).join('/');
        const resolved = baseDir ? `${baseDir}/${normalized}` : normalized;
        if (!filePaths.has(resolved)) {
          errors.push(
            `Referenced file "${ref}" in "${file.path}" was not found in generated files.`
          );
          allRefsResolved = false;
        }
      }
    }
  }

  // --- Size and count checks ---
  if (stats.totalChars < 500) {
    warnings.push(`Application is very small (${stats.totalChars} total characters). May be incomplete.`);
  }

  if (stats.totalFiles < 2) {
    warnings.push('Application has very few files (<2). May be incomplete.');
  }

  // --- Self-sufficiency check (critical for static apps) ---
  if (stats.htmlFiles === 0) {
    errors.push('No HTML files — cannot serve as a standalone static application.');
  }
  if (stats.htmlFiles > 0 && (stats.cssFiles === 0 && stats.jsFiles === 0)) {
    warnings.push('Application has no CSS or JS files — all styling/behavior may be inline.');
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    entryPointFound: filePaths.has(app.entryPoint),
    allReferencesResolved: allRefsResolved,
    stats,
  };
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

  let modelUsed = 'router';

  try {
    const { data: raw, model, provider } = await callLLMJsonWithMeta<Record<string, unknown>>(
      buildUserPrompt(input),
      {
        task: 'APPLICATION_GENERATION',
        systemPrompt: buildSystemPrompt(),
        maxTokens: 16384,
        temperature: 0.5,
      }
    );
    modelUsed = `${provider}/${model}`;

    const structError = validateApplicationStructure(raw);
    if (structError) {
      console.error(`[AppGen] Structure validation failed: ${structError}`);
      return {
        success: false,
        error: `Structure error: ${structError}`,
        modelUsed,
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
        modelUsed,
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
      modelUsed,
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
      modelUsed,
    };
  }
}
