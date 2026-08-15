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

const Dashboard: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<string>('overview');

  useEffect(() => {
    const savedPage = localStorage.getItem('currentPage');
    if (savedPage) {
      setCurrentPage(savedPage);
    }
  }, []);

  const renderActivePage = () => {
    switch (currentPage) {
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
      case 'policies':
        return <Policies />;
      case 'settings':
        return <Settings />;
      default:
        return <Overview />;
    }
  };

  return (
    <DashboardLayout currentPage={currentPage} setCurrentPage={setCurrentPage}>
      {renderActivePage()}
    </DashboardLayout>
  );
};

export default Dashboard;
