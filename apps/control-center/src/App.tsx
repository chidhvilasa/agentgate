import { Routes, Route, NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from './api';
import Overview from './pages/Overview';
import Timeline from './pages/Timeline';
import Approvals from './pages/Approvals';
import Agents from './pages/Agents';
import Policies from './pages/Policies';
import EventDetail from './pages/EventDetail';

type GatewayStatus = 'connected' | 'disconnected' | 'checking';

export default function App() {
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>('checking');
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const check = async () => {
      try {
        await api.health();
        setGatewayStatus('connected');
      } catch {
        setGatewayStatus('disconnected');
      }
    };
    check();
    const interval = setInterval(check, 10_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const approvals = await api.approvals() as unknown[];
        setPendingCount(approvals.length);
      } catch {}
    };
    load();
    const interval = setInterval(load, 5_000);
    return () => clearInterval(interval);
  }, []);

  const navItems = [
    { to: '/', label: 'Overview', icon: '⬡', exact: true },
    { to: '/timeline', label: 'Timeline', icon: '◈' },
    { to: '/approvals', label: 'Approvals', icon: '◉', badge: pendingCount },
    { to: '/agents', label: 'Agents', icon: '◎' },
    { to: '/policies', label: 'Policies', icon: '⬡' },
  ];

  return (
    <div className="app-shell">
      {/* Topbar */}
      <header className="topbar">
        <div className="topbar-logo">
          <div className="topbar-logo-icon">🛡</div>
          <span>AgentGate</span>
          <span className="topbar-badge">CONTROL CENTER</span>
        </div>
        <div className="topbar-spacer" />
        <div className="topbar-status">
          <span
            className={`status-dot ${
              gatewayStatus === 'connected' ? 'connected' :
              gatewayStatus === 'disconnected' ? 'disconnected' : 'degraded'
            }`}
          />
          {gatewayStatus === 'connected' ? 'Gateway connected' :
           gatewayStatus === 'disconnected' ? 'Gateway offline' : 'Connecting…'}
        </div>
      </header>

      {/* Sidebar */}
      <nav className="sidebar">
        <div className="sidebar-section-label">Navigation</div>
        {navItems.map(({ to, label, icon, badge, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span className="nav-item-icon">{icon}</span>
            {label}
            {badge != null && badge > 0 && (
              <span className={`nav-badge${badge > 5 ? ' danger' : ''}`}>{badge}</span>
            )}
          </NavLink>
        ))}

        <div className="topbar-spacer" style={{ flex: 1, minHeight: 24 }} />
        <div className="sidebar-section-label">System</div>
        <div className="nav-item" style={{ cursor: 'default' }}>
          <span className="nav-item-icon">🗄</span>
          <span className="text-muted" style={{ fontSize: 12 }}>v0.1.0-m1</span>
        </div>
      </nav>

      {/* Main Content */}
      <main className="main-content">
        {gatewayStatus === 'disconnected' && (
          <div className="banner-disconnected">
            ⚠ Gateway offline — run <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 6px', borderRadius: 4, marginLeft: 6 }}>agentgate start</code>
          </div>
        )}
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/timeline" element={<Timeline />} />
          <Route path="/approvals" element={<Approvals onCountChange={setPendingCount} />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/events/:id" element={<EventDetail />} />
        </Routes>
      </main>
    </div>
  );
}
