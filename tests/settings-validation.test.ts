// ============================================================
// SETTINGS DASHBOARD PAYLOAD & SCHEMA VALIDATION TESTS
// Tests the exact request contracts for settings operations:
// retryConfig, queueLimits, setConcurrency, operational limits, etc.
// ============================================================

import { z } from 'zod';

const results: { name: string; pass: boolean; detail?: string }[] = [];

function record(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// Schemas mirrored from server/routers.ts settingsRouter
const retryConfigSchema = z.object({
  maxAttempts: z.number().min(1).max(10),
  backoffMultiplier: z.number().min(1).max(3),
  baseDelayMs: z.number().min(1000).max(60000),
});

const queueLimitsSchema = z.object({
  maxSize: z.number().min(100).max(10000),
  expirationHours: z.number().min(1).max(168),
});

const setConcurrencySchema = z.object({
  level: z.number().min(1).max(10),
});

const operationalLimitsSchema = z.object({
  maxCostPerDay: z.number().min(0),
  maxDeployments: z.number().min(0),
  autoPauseOnHighBanRisk: z.boolean(),
});

const notificationSettingsSchema = z.object({
  emailNotifications: z.boolean(),
  slackNotifications: z.boolean(),
});

const setIntervalSchema = z.object({
  intervalMs: z.number().min(5000).max(86400000),
});

async function main() {
  console.log('\n=== Settings Dashboard Payload & Validation Tests ===\n');

  // --- 1. Retry Config Payload Contract ---
  console.log('--- 1. Retry Configuration ---');
  {
    const validPayload = {
      maxAttempts: 3,
      backoffMultiplier: 1.5,
      baseDelayMs: 5000,
    };
    const parsed = retryConfigSchema.safeParse(validPayload);
    record('Valid retry payload passes validation', parsed.success);

    // Faulty { json: ... } payload (the bug identified in audit)
    const buggyPayload = {
      json: {
        maxAttempts: 3,
        backoffMultiplier: 1.5,
        baseDelayMs: 5000,
      },
    };
    const buggyParsed = retryConfigSchema.safeParse(buggyPayload);
    record('Nested { json: ... } payload is correctly rejected by schema', !buggyParsed.success);

    // Boundary validations
    record('Rejects maxAttempts < 1', !retryConfigSchema.safeParse({ ...validPayload, maxAttempts: 0 }).success);
    record('Rejects maxAttempts > 10', !retryConfigSchema.safeParse({ ...validPayload, maxAttempts: 11 }).success);
    record('Rejects backoffMultiplier > 3', !retryConfigSchema.safeParse({ ...validPayload, backoffMultiplier: 3.5 }).success);
    record('Rejects baseDelayMs < 1000', !retryConfigSchema.safeParse({ ...validPayload, baseDelayMs: 500 }).success);
  }

  // --- 2. Queue Limits Payload Contract ---
  console.log('\n--- 2. Queue Limits ---');
  {
    const validQueue = {
      maxSize: 1000,
      expirationHours: 72,
    };
    record('Valid queue limits payload passes', queueLimitsSchema.safeParse(validQueue).success);

    // Buggy payload
    const buggyQueue = {
      json: { maxSize: 1000, expirationHours: 72 },
    };
    record('Nested { json: ... } queue payload is correctly rejected', !queueLimitsSchema.safeParse(buggyQueue).success);

    // Boundaries
    record('Rejects queue size < 100', !queueLimitsSchema.safeParse({ maxSize: 50, expirationHours: 72 }).success);
    record('Rejects expiration > 168h', !queueLimitsSchema.safeParse({ maxSize: 1000, expirationHours: 200 }).success);
  }

  // --- 3. Concurrency Payload Contract ---
  console.log('\n--- 3. Concurrency Level ---');
  {
    const validConcurrency = { level: 2 };
    record('Valid concurrency payload passes', setConcurrencySchema.safeParse(validConcurrency).success);

    const buggyConcurrency = { json: { level: 2 } };
    record('Nested { json: ... } concurrency payload is correctly rejected', !setConcurrencySchema.safeParse(buggyConcurrency).success);

    record('Rejects concurrency level < 1', !setConcurrencySchema.safeParse({ level: 0 }).success);
    record('Rejects concurrency level > 10', !setConcurrencySchema.safeParse({ level: 15 }).success);
  }

  // --- 4. Operational & Notification Limits ---
  console.log('\n--- 4. Operational & Notification Settings ---');
  {
    record('Valid operational limits pass', operationalLimitsSchema.safeParse({
      maxCostPerDay: 50.0,
      maxDeployments: 10,
      autoPauseOnHighBanRisk: true,
    }).success);

    record('Valid notifications pass', notificationSettingsSchema.safeParse({
      emailNotifications: true,
      slackNotifications: false,
    }).success);

    record('Valid interval passes', setIntervalSchema.safeParse({ intervalMs: 10800000 }).success);
    record('Rejects interval < 5000ms', !setIntervalSchema.safeParse({ intervalMs: 1000 }).success);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
