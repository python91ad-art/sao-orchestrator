import { test, expect } from '@playwright/test';

for (const status of ['ok', 'unavailable', 'partial'] as const) {
  test(`discovery dashboard distinguishes ${status} and shows fallback restrictions`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/trpc/**', route => {
      const url = route.request().url();
      let data: any = [];
      if (url.includes('/auth.me')) data = { id: 'admin-fixture', email: 'admin@sao.test', role: 'admin' };
      if (url.includes('discovery.pipelineDiagnostic')) data = {
        multiSource: { status, ons: { status: status === 'unavailable' ? 'unavailable' : 'ok', signals: 0, errors: [] }, web: { status: status === 'ok' ? 'ok' : 'unavailable' },
          candidatesBySource: { ons: 0, tavily: 0 }, validated: 0, rejected: 0, queued: 0, lastSuccess: null, lastFailure: status === 'ok' ? null : '2026-10-19T12:00:00.000Z' },
        webSearch: { activeProvider: status === 'unavailable' ? null : 'gemini', attempts: [{ provider: 'tavily', status: 'quota_exhausted', reason: 'quota_exhausted' }], providers: { tavily: { status: 'quota_exhausted', retryAt: '2026-10-20T12:00:00.000Z' } } },
      };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { data } }) });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Business discovery', exact: true })).toBeVisible();
    if (status === 'unavailable') {
      await expect(page.getByText('Discovery unavailable', { exact: true })).toBeVisible();
      await expect(page.getByText('No opportunities found', { exact: true })).toHaveCount(0);
    } else await expect(page.getByText(/No opportunities found/)).toBeVisible();
    await expect(page.getByText(/Fallback routing: tavily: quota_exhausted/)).toBeVisible();
    await expect(page.getByText(/restricted until 2026-10-20/)).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('provider editor keeps paid discovery disabled until explicit configuration', async ({ page }) => {
  let saved: any;
  await page.route('**/api/trpc/**', route => {
    const requestUrl = new URL(route.request().url());
    const procedures = requestUrl.pathname.split('/api/trpc/')[1].split(',');
    const results = procedures.map(procedure => {
      let data: any = [];
      if (procedure === 'auth.me') data = { id: 'admin-fixture', email: 'admin@sao.test', role: 'admin' };
      if (procedure === 'providers.serviceTypes') data = [{ id: 'llm', label: 'LLM / AI Models' }];
      if (procedure === 'providers.knownProviders') data = [{ id: 'gemini', name: 'Gemini', serviceType: 'llm', credentialType: 'api_key', envConfigured: true }];
      if (procedure === 'providers.list') data = [{ id: 'provider-fixture', service: 'llm', providerId: 'gemini', name: 'Gemini', credentialType: 'api_key', hasCredential: true, maskedCredential: '••••1234', enabled: true, compatibilityStatus: 'compatible', connectionStatus: 'untested', config: { inferenceSetting: 'preserved' } }];
      if (procedure === 'providers.update') { const body = route.request().postDataJSON(); saved = body['0'] || body; data = {}; }
      return { result: { data } };
    });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(requestUrl.searchParams.has('batch') ? results : results[0]) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Providers/ }).click();
  await page.getByTitle('Edit', { exact: true }).click();
  await expect(page.getByLabel('Enable this provider for discovery')).not.toBeChecked();
  await expect(page.getByLabel('Approve paid web discovery within these limits')).not.toBeChecked();
  await expect(page.getByLabel('I configured a hard spending cap in the provider account')).not.toBeChecked();
  await page.getByLabel('Search model').fill('gemini-2.5-flash');
  await page.getByLabel('Maximum requests per UTC day').fill('10');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await expect.poll(() => saved?.config?.discovery?.model).toBe('gemini-2.5-flash');
  expect(saved.config.inferenceSetting).toBe('preserved');
  expect(saved.config.discovery.billingApproved).toBe(false);
  expect(saved.credential).toBeUndefined();
});
