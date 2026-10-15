import React, { lazy, Suspense, useState, useEffect } from 'react';
import DashboardLayout from '../components/DashboardLayout';
import { LoadingState, WorkspaceBoundary } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { dashboardPage, requiresAdministrator } from '../lib/dashboardRoutes';

const Overview = lazy(() => import('./dashboard/Overview'));
const Gaps = lazy(() => import('./dashboard/Gaps'));
const Queue = lazy(() => import('./dashboard/Queue'));
const Deployments = lazy(() => import('./dashboard/Deployments'));
const AuditLog = lazy(() => import('./dashboard/AuditLog'));
const Policies = lazy(() => import('./dashboard/Policies'));
const Settings = lazy(() => import('./dashboard/Settings'));
const Analytics = lazy(() => import('./dashboard/Analytics'));
const RegistrationAccess = lazy(() => import('./dashboard/RegistrationAccess'));
const Providers = lazy(() => import('./dashboard/Providers'));
const Infrastructure = lazy(() => import('./dashboard/Infrastructure'));
const Operations = lazy(() => import('./dashboard/Operations'));
const Authorizations = lazy(() => import('./dashboard/Authorizations'));
const Advertising = lazy(() => import('./dashboard/Advertising'));

const Dashboard: React.FC = () => {
  const { user } = useAuth();
  const [currentPage, setCurrentPage] = useState<string>(() => dashboardPage(window.location, localStorage.getItem('currentPage')));

  useEffect(() => {
    const navigate = () => {
      if (!window.dispatchEvent(new Event('sao:before-navigation', { cancelable: true }))) {
        window.history.pushState(null, '', `/dashboard/${currentPage}`);
        return;
      }
      const page = dashboardPage(window.location, localStorage.getItem('currentPage'));
      localStorage.setItem('currentPage', page);
      setCurrentPage(page);
    };
    window.addEventListener('popstate', navigate);
    return () => window.removeEventListener('popstate', navigate);
  }, [currentPage]);

  const navigate = (page: string) => {
    window.history.pushState(null, '', `/dashboard/${page}`);
    setCurrentPage(page);
  };

  const renderActivePage = () => {
    if (requiresAdministrator(currentPage) && user?.role !== 'admin') return <p role="alert">Administrator access required.</p>;
    switch (currentPage) {
      case 'operations':
        return user?.role === 'admin' ? <Operations /> : <p role="alert">Administrator access required.</p>;
      case 'authorizations':
        return <Authorizations />;
      case 'overview':
        return <Overview />;
      case 'gaps':
        return <Gaps />;
      case 'queue':
        return <Queue />;
      case 'deployments':
        return <Deployments />;
      case 'audit-log':
        return <AuditLog />;
      case 'analytics':
        return <Analytics />;
      case 'advertising':
        return <Advertising />;
      case 'policies':
        return user?.role === 'admin' ? <Policies /> : <p role="alert">Administrator access required.</p>;
      case 'settings':
        return <Settings />;
      case 'registration-access':
        return <RegistrationAccess />;
      case 'providers':
        return <Providers />;
      case 'infrastructure':
        return <Infrastructure />;
      default:
        return <Overview />;
    }
  };

  return (
    <DashboardLayout currentPage={currentPage} setCurrentPage={navigate}>
      <WorkspaceBoundary key={currentPage} page={currentPage}><Suspense fallback={<LoadingState />}><div className="workspace-page">{renderActivePage()}</div></Suspense></WorkspaceBoundary>
    </DashboardLayout>
  );
};

export default Dashboard;
