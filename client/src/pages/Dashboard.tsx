import React, { useState, useEffect } from 'react';
import DashboardLayout from '../components/DashboardLayout';
import Overview from './dashboard/Overview';
import Gaps from './dashboard/Gaps';
import Queue from './dashboard/Queue';
import Deployments from './dashboard/Deployments';
import AuditLog from './dashboard/AuditLog';
import Policies from './dashboard/Policies';
import Settings from './dashboard/Settings';
import Analytics from './dashboard/Analytics';
import RegistrationAccess from './dashboard/RegistrationAccess';
import Providers from './dashboard/Providers';
import Infrastructure from './dashboard/Infrastructure';
import Operations from './dashboard/Operations';
import Authorizations from './dashboard/Authorizations';
import { useAuth } from '../hooks/useAuth';
import { dashboardPage, requiresAdministrator } from '../lib/dashboardRoutes';

import Advertising from './dashboard/Advertising';

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
      {renderActivePage()}
    </DashboardLayout>
  );
};

export default Dashboard;
