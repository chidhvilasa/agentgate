import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { openEventStream, api } from '../api';

function statusClass(status: string) {
  const s = status.toLowerCase();
  if (s.includes('succeed')) return 'allowed';
  if (s.includes('allow') && !s.includes('transform')) return 'allowed';
  // Audit event status is always the literal 'DENIED' (never bare 'DENY'),
  // so matching only the 'deny' substring never fires — check both forms.
  if (s.includes('deny') || s.includes('deni')) return 'denied';
  if (s.includes('pending') || s.includes('approval')) return 'pending';
  if (s.includes('transform')) return 'transform';
  if (s.includes('execut')) return 'executing';
  if (s.includes('fail') || s.includes('cancel') || s.includes('expir')) return 'failed';
  return 'neutral';
}

export default function Timeline() {
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [liveCount, setLiveCount] = useState(0);
  const navigate = useNavigate();
  const streamRef = useRef<EventSource | null>(null);

  // Load historical events
  useEffect(() => {
    api.events({ limit: '100' })
      .then((e) => { setEvents(e as Record<string, unknown>[]); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Open live SSE stream
  useEffect(() => {
    streamRef.current = openEventStream((data) => {
      const ev = data as Record<string, unknown>;
      // Only add terminal/evaluated events (not intermediate states)
      if (ev.id) {
        setEvents((prev) => {
          const idx = prev.findIndex((e) => e.id === ev.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = ev;
            return next;
          }
          return [ev, ...prev].slice(0, 200);
        });
        setLiveCount((c) => c + 1);
      }
    });
    return () => streamRef.current?.close();
  }, []);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Live Timeline</h1>
          <p className="page-subtitle">Every intercepted tool call, in real time</p>
        </div>
        <div className="live-indicator">
          <span className="live-dot" />
          LIVE · {liveCount} updates
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state"><div className="spinner" /></div>
        ) : events.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            <div className="empty-state-title">No events yet</div>
            <div className="empty-state-desc">Waiting for Claude Code to connect and make tool calls through AgentGate.</div>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Tool</th>
                <th>Decision</th>
                <th>Agent</th>
                <th>Rule</th>
                <th>Duration</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev: Record<string, unknown>) => {
                const agent = ev.agent as Record<string, unknown> | undefined;
                const toolCall = ev.tool_call as Record<string, unknown> | undefined;
                const decision = ev.decision as Record<string, unknown> | undefined;
                return (
                  <tr key={String(ev.id)} onClick={() => navigate(`/events/${ev.id}`)}>
                    <td className="text-mono text-muted">{String(ev.sequence_number ?? '—')}</td>
                    <td><span className="tool-name">{String(toolCall?.tool ?? '—')}</span></td>
                    <td>
                      <span className={`badge ${statusClass(String(ev.status ?? ''))}`}>
                        {String(ev.status ?? '').replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="text-muted">{String(agent?.declared_name ?? 'unknown')}</td>
                    <td className="text-muted text-mono">
                      {decision?.matched_rule_id ? String(decision.matched_rule_id) : <em>default-deny</em>}
                    </td>
                    <td className="text-muted">
                      {ev.duration_ms != null ? `${ev.duration_ms}ms` : '—'}
                    </td>
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
