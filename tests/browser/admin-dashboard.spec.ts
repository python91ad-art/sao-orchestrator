import { test, expect } from '@playwright/test';

test.describe('SAO Admin Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log('[BROWSER CONSOLE ERROR]', msg.text());
      }
    });

    page.on('pageerror', error => {
      console.log('[BROWSER PAGE ERROR]', error.message);
    });

    await page.route('**/api/trpc/**', async route => {
      const url = route.request().url();

      if (url.includes('/auth.me')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            result: {
              data: {
                id: 'browser-admin',
                email: 'admin-e2e@sao.test',
                role: 'admin'
              }
            }
          })
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: { data: [] }
        })
      });
    });
  });

  test('admin can navigate the dashboard in Firefox', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('SAO Orchestrator')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();

    await page.getByRole('button', { name: 'Advertising' }).click();
    await expect(
      page.getByRole('heading', { name: 'Advertising' })
    ).toBeVisible();

    await expect(
      page.getByRole('heading', { name: 'Channel Configuration' })
    ).toBeVisible();

    await expect(
      page.getByRole('heading', { name: 'Create Campaign' })
    ).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).click();

    await expect(
      page.getByRole('heading', { name: 'System Settings' })
    ).toBeVisible();

    await expect(
      page.getByRole('button', { name: 'Save Configuration' })
    ).toBeVisible();

    await expect(
      page.getByRole('button', { name: 'Save Retry Config' })
    ).toBeVisible();

    await expect(
      page.getByRole('button', { name: 'Save Queue Limits' })
    ).toBeVisible();
  });

  test('dashboard page selection survives reload', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Advertising' }).click();
    await expect(
      page.getByRole('heading', { name: 'Advertising' })
    ).toBeVisible();

    await page.reload();

    await expect(
      page.getByRole('heading', { name: 'Advertising' })
    ).toBeVisible();

    await expect.poll(async () =>
      page.evaluate(() => localStorage.getItem('currentPage'))
    ).toBe('advertising');
  });
});
