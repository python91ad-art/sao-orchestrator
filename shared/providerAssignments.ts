/** Stable function and operation identifiers shared by the API and assignment editor. */
import { z } from 'zod';
export const sectionSchema = z.enum(['llm', 'search', 'business_data', 'deployment', 'payments', 'advertising']);
export type ProviderSection = z.infer<typeof sectionSchema>;
export const assignmentSettingsSchema = z.object({
  maxRequestsPerDay: z.number().int().min(0).max(100000).optional(),
  maxRequestsPerMinute: z.number().int().min(0).max(10000).optional(),
  maxTokensPerDay: z.number().int().min(0).max(100000000).optional(),
  dailyBudgetUsd: z.number().finite().min(0).max(1000).optional(),
  maxRequestCostUsd: z.number().finite().min(0).max(100).optional(),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
  retries: z.number().int().min(0).max(1).optional(),
}).strict();
export const assignmentSchema = z.object({
  section: sectionSchema, enabled: z.boolean().default(true),
  priority: z.number().int().min(-10000).max(10000).default(100),
  fallbackOrder: z.number().int().min(0).max(10000).default(0),
  operation: z.enum(['inference', 'live_web_search', 'statistical_data', 'deploy', 'payment']),
  model: z.string().max(150).regex(/^[a-zA-Z0-9/._:-]*$/).nullable().optional(),
  settings: assignmentSettingsSchema.default({}),
}).strict();
export type Assignment = z.infer<typeof assignmentSchema>;
export const assignmentListSchema = z.array(assignmentSchema).max(6).superRefine((items, ctx) => {
  if (new Set(items.map(a => a.section)).size !== items.length) ctx.addIssue({ code: 'custom', message: 'A connection may have only one assignment per section.' });
});
