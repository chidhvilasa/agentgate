import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Agents() {
  const [agents, setAgents] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Derive agents from recent events
    api.events({ limit: '200' }).then((evs) => {
      const events = evs as Record<string, unknown>[];
      const seen = new Map<string, Record<string, unknown>>();
      for (const ev of events) {
        const agent = ev.agent as Record<string, unknown> | undefined;
        const sid = String(agent?.session_id ?? '');
        if (sid && !seen.has(sid)) seen.set(sid, agent!);
      }
      setAgents(Array.from(seen.values()));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Agents</h1>
          <p className="page-subtitle">Connected and recently active MCP agents</p>
        </div>
      </div>

      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : agents.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">◎</div>
          <div className="empty-state-title">No agents yet</div>
          <div className="empty-state-desc">Connect Claude Code or another MCP client through the AgentGate stdio proxy to see agents here.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-12">
          {agents.map((agent) => (
            <div key={String(agent.session_id)} className="agent-card">
              <div className="agent-avatar">🤖</div>
              <div className="agent-info">
                <div className="agent-name">{String(agent.declared_name ?? 'Unknown Agent')}</div>
                <div className="agent-meta">
                  Session {String(agent.session_id ?? '').slice(0, 12)}… ·
                  {' '}v{String(agent.declared_version ?? '?')} ·
                  {' '}Connection: {String(agent.connection_identity ?? '—')}
                </div>
                <div className="agent-stats">
                  <div className="agent-stat">Identity: <strong style={{ color: 'var(--color-pending)' }}>Declared (unverified)</strong></div>
                </div>
                <div className="agent-meta" style={{ marginTop: 8, fontSize: 11, padding: '4px 8px', background: 'rgba(245,158,11,0.06)', borderRadius: 4, border: '1px solid rgba(245,158,11,0.2)', color: 'var(--color-pending)' }}>
                  ⚠ Self-reported identity — not cryptographically verified. Not used for authorization decisions.
                </div>

                {/* Honest capability display */}
                <div className="agent-stats" style={{ marginTop: 8 }}>
                  <div className="agent-stat" style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                    Pause/Terminate: <strong>Not supported by this connection</strong>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
