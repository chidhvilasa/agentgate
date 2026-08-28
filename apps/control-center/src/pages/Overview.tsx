import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api';
import type { ContextStatusReport } from '../api';

/**
 * Compact Context Guard summary (ADR-0013) — self-contained: fetches its
 * own bounded snapshot once and silently renders nothing if Context Guard
 * isn't configured (404) or the gateway is unreachable, so Overview stays
 * fully functional either way. Never a second poll loop layered on top of
 * Overview's own — this widget owns its one fetch.
 */
function ContextGuardSummaryCard() {
  const [report, setReport] = useState<ContextStatusReport | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .contexts({ limit: 200 })
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (unavailable || !report) return null;

  const activeWithLabels = report.contexts.filter((c) => c.status === 'active' && c.labels.length > 0).length;
  const pendingApprovals = report.contexts.reduce((sum, c) => sum + c.pending_approval_count, 0);

  if (activeWithLabels === 0 && pendingApprovals === 0) return null;

  return (
    <div className="cg-escalation pending">
      <div className="cg-timeline-title" style={{ marginBottom: 4 }}>Context Guard: accumulated session risk</div>
      <div className="text-muted" style={{ fontSize: 12 }}>
        {activeWithLabels} active context(s) carrying risk labels, {pendingApprovals} pending contextual approval(s).{' '}
        <Link to="/context-guard" style={{ color: 'var(--accent-text)' }}>Review in Context Guard →</Link>
      </div>
    </div>
  );
}

function DecisionBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const cls =
    s.includes('succeed') ? 'allowed' :
    s.includes('allow') && !s.includes('transform') ? 'allowed' :
    // Audit event status is always the literal 'DENIED' (never bare 'DENY'),
    // so matching only the 'deny' substring never fires — check both forms.
    s.includes('deny') || s.includes('deni') ? 'denied' :
    s.includes('pending') || s.includes('approval') ? 'pending' :
    s.includes('transform') ? 'transform' :
    s.includes('execut') ? 'executing' :
    s.includes('fail') || s.includes('cancel') || s.includes('expir') ? 'failed' : 'neutral';
  return <span className={`badge ${cls}`}>{status.replace(/_/g, ' ')}</span>;
}

export default function Overview() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.events({ limit: '20' })
      .then((e) => { setEvents(e as Record<string, unknown>[]); setLoading(false); })
      .catch(() => { setError('Could not load events. Is the gateway running?'); setLoading(false); });
  }, []);

  const allowed24h = events.filter(e => {
    const s = String(e.status ?? '');
    return s === 'ALLOWED' || s === 'SUCCEEDED' || s === 'ALLOWED_WITH_TRANSFORM';
  }).length;

  const denied24h = events.filter(e => {
    const s = String(e.status ?? '');
    return s === 'DENIED' || s === 'EXPIRED' || s === 'FAILED';
  }).length;

  const pending = events.filter(e => String(e.status ?? '') === 'PENDING_APPROVAL').length;

  const riskLevel =
    denied24h > 5 || pending > 3 ? 'high' :
    denied24h > 1 || pending > 0 ? 'medium' : 'low';

  const recentHighRisk = events
    .filter(e => ['DENIED', 'EXPIRED', 'FAILED'].includes(String(e.status ?? '')))
    .slice(0, 5);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-subtitle">Real-time security posture for connected AI agents</p>
        </div>
        <div className={`risk-indicator ${riskLevel}`}>
          {riskLevel === 'low' ? '✔' : riskLevel === 'medium' ? '⚑' : '⚠'} Risk: {riskLevel.toUpperCase()}
        </div>
      </div>

      <ContextGuardSummaryCard />

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Active Agents</div>
          <div className="stat-value neutral">{loading ? '—' : events.length > 0 ? '1' : '0'}</div>
          <div className="stat-trend">sessions with events</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Allowed</div>
          <div className="stat-value allowed">{loading ? '—' : allowed24h}</div>
          <div className="stat-trend">calls this session</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Denied</div>
          <div className="stat-value denied">{loading ? '—' : denied24h}</div>
          <div className="stat-trend">calls blocked</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Pending Approval</div>
          <div className="stat-value pending">{loading ? '—' : pending}</div>
          <div className="stat-trend">awaiting decision</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Recent High-Risk Events</span>
          <DecisionBadge status="DENIED" />
        </div>
        {loading ? (
          <div className="empty-state"><div className="spinner" /></div>
        ) : error ? (
          <div className="empty-state">
            <div className="empty-state-icon">⚡</div>
            <div className="empty-state-title">Gateway Unreachable</div>
            <div className="empty-state-desc">{error}</div>
          </div>
        ) : recentHighRisk.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">✅</div>
            <div className="empty-state-title">No high-risk events</div>
            <div className="empty-state-desc">All recent activity was allowed or is pending approval.</div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Status</th>
                <th>Agent</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {recentHighRisk.map((ev: Record<string, unknown>) => {
                const agent = ev.agent as Record<string, unknown> | undefined;
                const toolCall = ev.tool_call as Record<string, unknown> | undefined;
                return (
                  <tr key={String(ev.id)} onClick={() => navigate(`/events/${ev.id}`)}>
                    <td><span className="tool-name">{String(toolCall?.tool ?? '—')}</span></td>
                    <td><DecisionBadge status={String(ev.status ?? '')} /></td>
                    <td className="text-muted">{String(agent?.declared_name ?? 'unknown')}</td>
                    <td className="text-muted text-mono">
                      {ev.created_at ? new Date(String(ev.created_at)).toLocaleTimeString() : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
