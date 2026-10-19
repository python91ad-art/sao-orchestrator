import { test, expect } from '@playwright/test';

test('manage assignments saves multiple sections, settings, disable and removal while preserving connection', async ({ page }) => {
  let assignments: any[] = [{ section: 'llm', operation: 'inference', enabled: true, priority: 100, fallbackOrder: 0, model: null, settings: {} }];
  test.setTimeout(60000);
  const saves: any[] = [];
  const provider = { id: 'groq-fixture', service: 'llm', providerId: 'groq', name: 'Groq', enabled: true, hasCredential: true, maskedCredential: '••••1234', connectionStatus: 'connected', compatibilityStatus: 'compatible', credentialType: 'api_key', createdAt: '2026-10-19', config: {} };
  await page.route('**/api/trpc/**', route => {
    const url = new URL(route.request().url());
    const procedures = url.pathname.split('/api/trpc/')[1].split(',');
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    const results = procedures.map((procedure, index) => {
      let data: any = [];
      if (procedure === 'auth.me') data = { id: 'admin', email: 'admin@sao.test', role: 'admin' };
      if (procedure === 'providers.list') data = [provider];
      if (procedure === 'providers.serviceTypes') data = [{ id: 'llm', label: 'LLM / AI Models' }, { id: 'search', label: 'Search / Gap Finder' }, { id: 'payments', label: 'Payments' }];
      if (procedure === 'providers.knownProviders') data = [{ id: 'groq', name: 'Groq', serviceType: 'llm', credentialType: 'api_key' }];
      if (procedure === 'providers.saveAssignments') {
        const input = body[String(index)] || body;
        saves.push(input); assignments = input.assignments;
      }
      if (['providers.assignments', 'providers.saveAssignments'].includes(procedure)) data = { connectionId: provider.id, name: provider.name, providerId: 'groq', enabled: true, connectionStatus: 'connected', revision: 'fixture', health: {}, billingApproved: false, assignments,
        offerings: [{ section: 'llm', operation: 'inference', models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'], defaultModel: null, capabilities: ['llm_inference'] },
          { section: 'search', operation: 'live_web_search', models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'], defaultModel: 'openai/gpt-oss-20b', capabilities: ['live_web_search', 'source_evidence'] }] };
      return { result: { data } };
    });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.searchParams.has('batch') ? results : results[0]) });
  });
  await page.goto('/dashboard/providers');
  await page.getByRole('button', { name: 'Manage Assignments', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Manage Assignments — Groq' })).toBeVisible();
  await expect(page.getByText('Connection:', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Assign to LLM / AI Models', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Assign to Payments', { exact: true })).toBeDisabled();
  await expect(page.getByText('Unavailable: this adapter lacks the required capability for Payments.')).toBeVisible();
  await page.getByLabel('Assign to Search / Gap Finder', { exact: true }).check();
  await page.getByLabel('Priority for Search / Gap Finder', { exact: true }).fill('120');
  await expect(page.getByText(/Paid search is blocked/)).toBeVisible();
  await page.getByText('Advanced settings for Search / Gap Finder', { exact: true }).click();
  await page.getByLabel('Model for Search / Gap Finder', { exact: true }).selectOption('openai/gpt-oss-120b');
  await page.getByLabel('Fallback order for Search / Gap Finder', { exact: true }).fill('2');
  await page.getByLabel('Daily request cap for Search / Gap Finder', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Save Assignments', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  await expect(page.getByRole('heading', { name: 'Manage Assignments — Groq' })).toHaveCount(0);
  expect(assignments).toHaveLength(2);
  expect(assignments.find(a => a.section === 'search')).toMatchObject({ priority: 120, fallbackOrder: 2, model: 'openai/gpt-oss-120b', settings: { maxRequestsPerDay: 5 } });
  expect(JSON.stringify(saves)).not.toContain('credential'); expect(JSON.stringify(saves)).not.toContain('billingApproved');
  await page.reload(); await page.getByRole('button', { name: 'Manage Assignments', exact: true }).click();
  await expect(page.getByLabel('Assign to Search / Gap Finder', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Priority for Search / Gap Finder', { exact: true })).toHaveValue('120');
  await page.getByText('Advanced settings for Search / Gap Finder', { exact: true }).click();
  await page.getByLabel('Copy applicable settings to Search / Gap Finder', { exact: true }).selectOption('llm');
  await expect(page.getByLabel('Priority for Search / Gap Finder', { exact: true })).toHaveValue('100');
  await page.getByRole('button', { name: 'Restore defaults for Search / Gap Finder' }).click();
  await expect(page.getByLabel('Daily request cap for Search / Gap Finder', { exact: true })).toHaveValue('');
  await page.getByLabel('Enabled for Search / Gap Finder', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save Assignments', exact: true }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(assignments.find(a => a.section === 'search').enabled).toBe(false);
  await expect(page.getByRole('heading', { name: 'Manage Assignments — Groq' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage Assignments', exact: true }).click();
  await page.getByLabel('Assign to Search / Gap Finder', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save Assignments', exact: true }).click();
  await expect.poll(() => saves.length).toBe(3);
  expect(assignments.map(a => a.section)).toEqual(['llm']);
  expect(provider.hasCredential).toBe(true); expect(provider.enabled).toBe(true);
  await expect(page.getByText('••••1234')).toBeVisible();
});
