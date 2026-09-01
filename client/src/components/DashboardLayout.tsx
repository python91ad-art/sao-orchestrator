import React, { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import {
  LayoutDashboard,
  Search,
  List,
  Rocket,
  FileText,
  Shield,
  Settings,
  LogOut,
  User as UserIcon,
  Megaphone,
  Menu,
  X,
  BarChart3,
  UserPlus
} from 'lucide-react';

interface DashboardLayoutProps {
  children: React.ReactNode;
  currentPage: string;
  setCurrentPage: (page: string) => void;
}

const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children, currentPage, setCurrentPage }) => {
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'gaps', label: 'Gaps', icon: Search },
    { id: 'queue', label: 'Queue', icon: List },
    { id: 'deployments', label: 'Deployments', icon: Rocket },
    { id: 'advertising', label: 'Advertising', icon: Megaphone },
    { id: 'audit-log', label: 'Audit Log', icon: FileText },
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    { id: 'policies', label: 'Policies', icon: Shield },
    { id: 'settings', label: 'Settings', icon: Settings },
    ...(user?.role === 'admin'
      ? [{ id: 'registration-access', label: 'Registration Access', icon: UserPlus }]
      : []),
  ];

  const handleNavClick = (id: string) => {
    setCurrentPage(id);
    localStorage.setItem('currentPage', id);
    setSidebarOpen(false);
  };

  return (
    <div className="flex h-screen bg-[#100e17] overflow-hidden relative">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div className="sidebar-backdrop md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`w-[240px] bg-[#0c0a12] border-r border-[#221c32] flex flex-col justify-between flex-shrink-0 ${sidebarOpen ? 'sidebar-mobile open' : 'sidebar-mobile'}`}
             style={{ '@media (min-width: 769px)': { position: 'relative', transform: 'none' } } as any}>
        <div className="flex flex-col flex-1 overflow-y-auto">
          {/* Logo / Brand + Close button on mobile */}
          <div className="p-6 flex items-center gap-3 border-b border-[#221c32]">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-[#a855f7] via-[#f43f5e] to-[#eab308] shadow-md shadow-purple-500/10">
              <span className="text-sm font-black text-white">SAO</span>
            </div>
            <div className="flex-1">
              <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-white via-purple-300 to-amber-200 bg-clip-text text-transparent">
                SAO Orchestrator
              </h1>
              <p className="text-[10px] uppercase font-bold tracking-wider text-purple-400">
                Arb Loop Control
              </p>
            </div>
            {/* Close button — mobile only */}
            <button
              onClick={() => setSidebarOpen(false)}
              className="md:hidden text-neutral-400 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Navigation Links */}
          <nav className="flex-1 px-4 py-6 space-y-1.5">
            {navItems.map((item) => {
              const IconComponent = item.icon;
              const isActive = currentPage === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleNavClick(item.id)}
                  className={`w-full sidebar-nav-item ${isActive ? 'active' : ''}`}
                >
                  <IconComponent className="h-4.5 w-4.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* User Info / Bottom Section */}
        <div className="p-4 border-t border-[#221c32] bg-[#09070d]">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-9 w-9 rounded-full bg-purple-900/40 border border-purple-500/30 flex items-center justify-center">
              <UserIcon className="h-4 w-4 text-purple-300" />
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="text-xs font-semibold text-neutral-200 truncate">{user?.email || 'OPERATOR'}</p>
              <p className="text-[10px] text-neutral-500 truncate">{user?.email}</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-neutral-400 hover:text-red-400 hover:bg-red-500/5 border border-transparent hover:border-red-500/10 rounded-lg transition-all"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto bg-[#100e17] px-4 md:px-8 py-4 md:py-8 main-content">
        {/* Mobile header with hamburger */}
        <div className="md:hidden flex items-center justify-between mb-4">
          <button
            onClick={() => setSidebarOpen(true)}
            className="hamburger-btn"
            
          >
            <Menu className="h-5 w-5 text-white" />
          </button>
          <h2 className="text-lg font-bold text-white">SAO Dashboard</h2>
          <div className="w-10" />
        </div>
        <div className="max-w-[1440px] mx-auto space-y-6">
          {children}
        </div>
      </main>
    </div>
  );
};

export default DashboardLayout;
