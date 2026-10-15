export const dashboardPages = ['overview', 'authorizations', 'operations', 'gaps', 'queue', 'deployments', 'advertising', 'audit-log', 'analytics', 'policies', 'providers', 'infrastructure', 'settings', 'registration-access'] as const;

export function dashboardPage(location: Pick<Location, 'pathname' | 'search'>, savedPage: string | null) {
  const pathPage = location.pathname.startsWith('/dashboard/') ? location.pathname.slice('/dashboard/'.length) : null;
  const requested = pathPage || new URLSearchParams(location.search).get('page') || savedPage;
  return dashboardPages.find(page => page === requested) || 'overview';
}

export function requiresAdministrator(page: string) {
  return ['operations', 'policies', 'registration-access', 'gaps', 'queue', 'deployments', 'audit-log', 'settings'].includes(page);
}
