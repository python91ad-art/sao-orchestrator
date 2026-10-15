import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { trpc } from '../lib/trpc';
import { LayoutDashboard, Search, List, Rocket, FileText, Shield, Settings, LogOut, User as UserIcon, Megaphone, Menu, X, BarChart3, UserPlus, Key, Network, PanelLeftClose, PanelLeftOpen, ChevronRight, Command } from 'lucide-react';
import { Dialog, StatusBadge } from './ui';
import { requiresAdministrator } from '../lib/dashboardRoutes';

interface DashboardLayoutProps {
  children: React.ReactNode;
  currentPage: string;
  setCurrentPage: (page: string) => void;
}

const DashboardLayout: React.FC<DashboardLayoutProps> = ({ children, currentPage, setCurrentPage }) => {
  const { user, logout } = useAuth();
  const preferences = trpc.operations.preferences.useQuery(undefined, { enabled: Boolean(user) });
  const loop = trpc.coreLoop.status.useQuery(undefined, { enabled: Boolean(user), refetchInterval: 30000 });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sao:sidebar-collapsed') === 'true');
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [commandOpen, setCommandOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const sidebar = useRef<HTMLElement>(null);

  const navItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'Command' },
    { id: 'authorizations', label: 'My Authorizations', icon: Shield, group: 'Command' },
    ...(user?.role === 'admin' ? [{ id: 'operations', label: 'Operations', icon: Network, group: 'Command' }] : []),
    { id: 'gaps', label: 'Gaps', icon: Search, group: 'Business intelligence' },
    { id: 'queue', label: 'Queue', icon: List, group: 'Business intelligence' },
    { id: 'deployments', label: 'Deployments', icon: Rocket, group: 'Business intelligence' },
    { id: 'advertising', label: 'Advertising', icon: Megaphone, group: 'Business intelligence' },
    { id: 'analytics', label: 'Analytics', icon: BarChart3, group: 'Business intelligence' },
    { id: 'audit-log', label: 'Audit Log', icon: FileText, group: 'Governance & systems' },
    ...(user?.role === 'admin' ? [{ id: 'policies', label: 'Policies', icon: Shield, group: 'Governance & systems' }] : []),
    { id: 'providers', label: 'Providers', icon: Key, group: 'Governance & systems' },
    { id: 'infrastructure', label: 'Infrastructure', icon: Network, group: 'Governance & systems' },
    { id: 'settings', label: 'Settings', icon: Settings, group: 'Governance & systems' },
    ...(user?.role === 'admin' ? [{ id: 'registration-access', label: 'Registration Access', icon: UserPlus, group: 'Governance & systems' }] : []),
  ].filter(item => user?.role === 'admin' || !requiresAdministrator(item.id));
  const current = navItems.find(item => item.id === currentPage);
  const groups = [...new Set(navItems.map(item => item.group))];

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => { setMobile(query.matches); setSidebarOpen(false); };
    query.addEventListener('change', update);
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(open => !open); setSearch(''); }
    };
    window.addEventListener('keydown', keyboard);
    return () => { query.removeEventListener('change', update); window.removeEventListener('keydown', keyboard); };
  }, []);

  useEffect(() => {
    if (!sidebarOpen || !mobile) return;
    const previous = document.activeElement as HTMLElement | null;
    sidebar.current?.querySelector<HTMLElement>('[data-mobile-close]')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSidebarOpen(false); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(sidebar.current?.querySelectorAll<HTMLElement>('button, a[href], input') || []).filter(element => element.offsetParent !== null && !element.hasAttribute('disabled'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); previous?.focus(); };
  }, [sidebarOpen, mobile]);

  const handleNavClick = (id: string) => {
    if (!window.dispatchEvent(new Event('sao:before-navigation', { cancelable: true }))) return;
    setCurrentPage(id);
    localStorage.setItem('currentPage', id);
    setSidebarOpen(false);
    setCommandOpen(false);
  };

  return (
    <div className={`sao-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <a href="#workspace" className="skip-link">Skip to workspace</a>
      {sidebarOpen && mobile && <button type="button" aria-label="Close navigation backdrop" className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <aside id="sao-navigation" ref={sidebar} className={`command-sidebar ${sidebarOpen ? 'is-open' : ''}`} role={mobile && sidebarOpen ? 'dialog' : undefined} aria-modal={mobile && sidebarOpen ? true : undefined} aria-label="Main navigation" inert={mobile && !sidebarOpen ? true : undefined}>
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">SAO</span>
          <div className="brand-label"><h1>{preferences.data?.systemName || 'SAO Orchestrator'}</h1><p>Autonomous intelligence</p></div>
          <button type="button" className="icon-button mobile-close" data-mobile-close aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>
        <nav className="sidebar-scroll" aria-label="Workspaces">
          {groups.map(group => <React.Fragment key={group}><p className="nav-group-title">{group}</p>{navItems.filter(item => item.group === group).map(item => {
            const Icon = item.icon;
            return <button type="button" key={item.id} title={collapsed ? item.label : undefined} aria-label={item.label} aria-current={currentPage === item.id ? 'page' : undefined} className={`sidebar-nav-item ${currentPage === item.id ? 'active' : ''}`} onClick={() => handleNavClick(item.id)}><Icon aria-hidden="true" /><span className="nav-label">{item.label}</span></button>;
          })}</React.Fragment>)}
        </nav>
        <footer className="sidebar-footer">
          <div className="operator"><div className="operator-avatar"><UserIcon size={16} aria-hidden="true" /></div><div className="operator-info"><p title={user?.email}>{user?.email}</p><small>{user?.role === 'admin' ? 'Administrator' : 'Business operator'}</small></div></div>
          {logoutError && <p role="alert" className="text-red-300 text-xs">{logoutError}</p>}
          <div className="sidebar-actions">
            <button type="button" aria-label="Sign Out" disabled={loggingOut} className="btn-secondary" title="Sign out" onClick={async () => { if (loggingOut) return; setLoggingOut(true); try { await logout(); } catch { setLogoutError('Sign out failed. Please retry.'); } finally { setLoggingOut(false); } }}><LogOut size={15} aria-hidden="true" /><span className="sign-out-label">{loggingOut ? 'Signing out…' : 'Sign Out'}</span></button>
            <button type="button" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="icon-button desktop-collapse" onClick={() => { localStorage.setItem('sao:sidebar-collapsed', String(!collapsed)); setCollapsed(!collapsed); }}>{collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
          </div>
        </footer>
      </aside>
      <div className="command-workspace" inert={mobile && sidebarOpen ? true : undefined}>
        <header className="command-topbar">
          <button type="button" aria-label="Open navigation" aria-expanded={sidebarOpen} aria-controls="sao-navigation" className="icon-button mobile-toggle" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumb"><span>Command centre</span><ChevronRight size={12} aria-hidden="true" /><strong>{current?.label || 'Workspace'}</strong></div>
          <button type="button" aria-label="Search workspaces" className="workspace-search" onClick={() => { setSearch(''); setCommandOpen(true); }}><Search size={15} aria-hidden="true" /><span>Find workspace</span><kbd>Ctrl K</kbd></button>
          <StatusBadge tone={loop.error ? 'warning' : loop.data?.isRunning ? 'success' : 'neutral'}>{loop.error ? 'Status unavailable' : loop.data ? loop.data.isRunning ? 'Loop running' : 'Loop stopped' : 'Checking loop'}</StatusBadge>
        </header>
        <main id="workspace" tabIndex={-1} className="main-content" aria-label={`${current?.label || 'SAO'} workspace`}><div className="workspace-content">{children}</div></main>
      </div>
      {commandOpen && <Dialog title="Find workspace" onClose={() => setCommandOpen(false)}><label>Search navigation<input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Policies, agents, deployments…" /></label><div className="command-results">{navItems.filter(item => `${item.label} ${item.group}`.toLowerCase().includes(search.toLowerCase())).map(item => <button type="button" key={item.id} onClick={() => handleNavClick(item.id)}><item.icon size={17} aria-hidden="true" /><span>{item.label}</span></button>)}{!navItems.some(item => `${item.label} ${item.group}`.toLowerCase().includes(search.toLowerCase())) && <p role="status">No matching workspace. Try another name.</p>}</div><p className="text-xs text-neutral-400 mt-4"><Command size={12} className="inline" aria-hidden="true" /> Ctrl / ⌘ K to open · Escape to close</p></Dialog>}
    </div>
  );
};

export default DashboardLayout;
