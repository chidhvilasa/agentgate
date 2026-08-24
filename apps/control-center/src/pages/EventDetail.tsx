import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';

function statusClass(status: string) {
  const s = status.toLowerCase();
  if (s.includes('succeed')) return 'allowed';
  if (s.includes('allow') && !s.includes('transform')) return 'allowed';
  // Covers both the policy decision literal 'DENY' and the audit event
  // status literal 'DENIED' (the latter never matches a bare 'deny' check).
  if (s.includes('deny') || s.includes('deni')) return 'denied';
  if (s.includes('pending') || s.includes('approval')) return 'pending';
  if (s.includes('transform')) return 'transform';
  if (s.includes('execut')) return 'executing';
  if (s.includes('fail') || s.includes('cancel') || s.includes('expir')) return 'failed';
  return 'neutral';
}

export default function EventDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [event, setEvent] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    api.event(id).then((e) => { setEvent(e as Record<string, unknown>); setLoading(false); }).catch(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="empty-state"><div className="spinner" /></div>;
  if (!event) return (
    <div className="empty-state">
      <div className="empty-state-icon">🔍</div>
      <div className="empty-state-title">Event not found</div>
      <button className="btn btn-ghost mt-16" onClick={() => navigate('/timeline')}>← Back to Timeline</button>
    </div>
  );

  const agent = event.agent as Record<string, unknown> | undefined;
  const toolCall = event.tool_call as Record<string, unknown> | undefined;
  const decision = event.decision as Record<string, unknown> | undefined;
  const status = String(event.status ?? '');

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Event Detail</h1>
          <p className="page-subtitle">Full audit record with decision trace</p>
        </div>
        <button className="btn btn-ghost" onClick={() => navigate('/timeline')}>← Timeline</button>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Summary</span>
          <span className={`badge ${statusClass(status)}`}>{status.replace(/_/g, ' ')}</span>
        </div>
        <div className="card-body">
          <div className="detail-row"><div className="detail-label">Event ID</div><div className="detail-value mono">{String(event.id)}</div></div>
          <div className="detail-row"><div className="detail-label">Sequence #</div><div className="detail-value mono">{String(event.sequence_number)}</div></div>
          <div className="detail-row"><div className="detail-label">Tool</div><div className="detail-value"><span className="tool-name">{String(toolCall?.tool ?? '—')}</span></div></div>
          <div className="detail-row"><div className="detail-label">Agent</div><div className="detail-value">{String(agent?.declared_name ?? 'unknown')} <span className="text-muted">(unverified)</span></div></div>
          <div className="detail-row"><div className="detail-label">MCP Era</div><div className="detail-value mono">{String(toolCall?.mcp_era ?? '—')}</div></div>
          <div className="detail-row"><div className="detail-label">Created</div><div className="detail-value mono">{new Date(String(event.created_at)).toISOString()}</div></div>
          <div className="detail-row"><div className="detail-label">Duration</div><div className="detail-value">{event.duration_ms != null ? `${event.duration_ms}ms` : '—'}</div></div>
        </div>
      </div>

      {decision && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Policy Decision</span>
          </div>
          <div className="card-body">
            <div className="detail-row"><div className="detail-label">Decision</div><div className="detail-value"><span className={`badge ${statusClass(String(decision.type ?? ''))}`}>{String(decision.type)}</span></div></div>
            <div className="detail-row"><div className="detail-label">Reason Code</div><div className="detail-value mono">{String(decision.reason_code ?? '—')}</div></div>
            <div className="detail-row"><div className="detail-label">Matched Rule</div><div className="detail-value mono">{String(decision.matched_rule_id ?? 'none — default applied')}</div></div>
            <div className="detail-row"><div className="detail-label">Explanation</div><div className="detail-value">{String(decision.explanation ?? '—')}</div></div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Normalized Arguments</span>
          {event.arguments_redacted && (
            <span className="badge denied" style={{ fontSize: 10 }}>REDACTED</span>
          )}
        </div>
        <div className="card-body">
          {event.arguments_redacted && (
            <div style={{ fontSize: 12, marginBottom: 10, color: 'var(--color-pending)' }}>
              ⚠ Secret patterns were detected and redacted before persistence. Raw values were never stored.
            </div>
          )}
          <pre className="code-block">
            {JSON.stringify(toolCall?.normalized_arguments ?? {}, null, 2)}
          </pre>
        </div>
      </div>

      {(status === 'SUCCEEDED' || status === 'FAILED') && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Result Security</span>
            {event.result_blocked ? (
              <span className="badge denied" style={{ fontSize: 10 }}>BLOCKED</span>
            ) : event.result_redacted ? (
              <span className="badge pending" style={{ fontSize: 10 }}>REDACTED</span>
            ) : (
              <span className="badge neutral" style={{ fontSize: 10 }}>NOT REDACTED</span>
            )}
          </div>
          <div className="card-body">
            {event.result_blocked ? (
              <div style={{ fontSize: 12, marginBottom: 10, color: 'var(--color-denied)' }}>
                ⚠ The downstream result appeared to contain a secret (or could not be fully inspected within
                configured limits) and was replaced with a safe error before reaching the agent. The raw result
                was never persisted.
              </div>
            ) : event.result_redacted ? (
              <div style={{ fontSize: 12, marginBottom: 10, color: 'var(--color-pending)' }}>
                ⚠ A recognized secret pattern was found in the downstream result and redacted before it was
                returned to the agent. The raw result was never persisted.
              </div>
            ) : (
              <div style={{ fontSize: 12, marginBottom: 10, color: 'var(--text-muted)' }}>
                No supported secret pattern detected in the downstream result.
              </div>
            )}
            <div className="detail-row">
              <div className="detail-label">Findings</div>
              <div className="detail-value mono">{String(event.result_finding_count ?? 0)}</div>
            </div>
            {event.execution_error != null && (
              <div className="detail-row">
                <div className="detail-label">Error sanitized</div>
                <div className="detail-value">
                  {event.error_redacted ? 'Yes — a secret pattern was found and redacted' : 'No secret pattern detected'}
                </div>
              </div>
            )}
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)', padding: '8px 12px', background: 'var(--bg-base)', borderRadius: 6 }}>
              Image, audio, and embedded binary (blob) content in this result, if any, is never scanned for
              secrets in either output-security mode — this reflects AgentGate's pattern-based detector, not a
              general data-loss-prevention system. See the README's Output security section.
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Tamper-Evidence Chain</span>
        </div>
        <div className="card-body">
          <div className="detail-row"><div className="detail-label">Event Hash</div><div className="detail-value mono">{String(event.event_hash ?? '—')}</div></div>
          <div className="detail-row"><div className="detail-label">Previous Hash</div><div className="detail-value mono">{String(event.previous_event_hash ?? 'genesis')}</div></div>
          <div className="detail-row"><div className="detail-label">Payload Version</div><div className="detail-value mono">{String(event.canonical_payload_version ?? '—')}</div></div>
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)', padding: '8px 12px', background: 'var(--bg-base)', borderRadius: 6 }}>
            Note: This hash chain is tamper-evident, not tamper-proof. A local administrator with database access could rewrite both records. External anchoring would be required for stronger guarantees.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Replay</span>
        </div>
        <div className="card-body">
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Replay evaluates this tool call against the current policy without executing it (dry-run only in Milestone 1).
          </div>
          <button className="btn btn-ghost" disabled>
            ▶ Dry-run Replay (coming in Milestone 2)
          </button>
        </div>
      </div>
    </>
  );
}
