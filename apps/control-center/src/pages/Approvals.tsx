import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';

function ApprovalTimer({ expiresAt }: { expiresAt: string }) {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    const update = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      setRemaining(Math.max(0, Math.ceil(ms / 1000)));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return (
    <div className="approval-timer">
      ⏱ {remaining}s
    </div>
  );
}

interface ApprovalsProps {
  onCountChange?: (count: number) => void;
}

export default function Approvals({ onCountChange }: ApprovalsProps) {
  const [approvals, setApprovals] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.approvals() as Record<string, unknown>[];
      setApprovals(data);
      onCountChange?.(data.length);
    } catch {}
    setLoading(false);
  }, [onCountChange]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const handleDeny = async (approval: Record<string, unknown>) => {
    setActing(String(approval.id));
    try {
      await api.deny(String(approval.id));
      await load();
    } catch (err) {
      alert(`Deny failed: ${(err as Error).message}`);
    }
    setActing(null);
  };

  const handleApprove = async (approval: Record<string, unknown>) => {
    const confirmed = window.confirm(
      `⚠ You are about to APPROVE:\n\n${String(approval.proposed_action_display)}\n\nThis will execute the action ONCE. Are you sure?`
    );
    if (!confirmed) return;
    setActing(String(approval.id));
    try {
      await api.approve(String(approval.id), String(approval.event_id));
      await load();
    } catch (err) {
      alert(`Approve failed: ${(err as Error).message}`);
    }
    setActing(null);
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Approval Queue</h1>
          <p className="page-subtitle">Review and decide on pending tool calls. Deny is the safe default.</p>
        </div>
        {approvals.length > 0 && (
          <span className="badge pending">{approvals.length} pending</span>
        )}
      </div>

      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : approvals.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">✅</div>
          <div className="empty-state-title">No pending approvals</div>
          <div className="empty-state-desc">All tool calls have been resolved or are awaiting agent activity.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-16">
          {approvals.map((approval: Record<string, unknown>) => (
            <div key={String(approval.id)} className="approval-card">
              <div className="approval-header">
                <div>
                  <div className="approval-tool">🔧 {String(approval.scope ?? '—')}</div>
                  <div className="approval-reason">{String(approval.policy_reason ?? '')}</div>
                </div>
                <ApprovalTimer expiresAt={String(approval.expires_at)} />
              </div>

              <div>
                <div className="text-muted" style={{ fontSize: 11, marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Proposed Action
                </div>
                <div className="approval-args">{String(approval.proposed_action_display ?? '—')}</div>
              </div>

              <div className="approval-meta">
                <div className="approval-meta-item">
                  <span>📋</span>
                  <span><strong>Scope:</strong> {String(approval.scope ?? '—')}</span>
                </div>
                <div className="approval-meta-item">
                  <span>⌚</span>
                  <span><strong>Expires:</strong> {new Date(String(approval.expires_at)).toLocaleTimeString()}</span>
                </div>
                <div className="approval-meta-item">
                  <span>🔑</span>
                  <span><strong>Single-use</strong> — approval consumed on execute</span>
                </div>
                <div className="approval-meta-item">
                  <span>🆔</span>
                  <span className="text-mono">{String(approval.id).slice(0, 8)}…</span>
                </div>
              </div>

              <div className="approval-actions">
                {/* Deny: Primary, prominent, safe action */}
                <button
                  id={`deny-${approval.id}`}
                  className="btn-deny"
                  disabled={acting === String(approval.id)}
                  onClick={() => handleDeny(approval)}
                >
                  {acting === String(approval.id) ? '…' : '✕ Deny (Safe Default)'}
                </button>
                {/* Approve: Secondary, deliberate */}
                <button
                  id={`approve-${approval.id}`}
                  className="btn-approve"
                  disabled={acting === String(approval.id)}
                  onClick={() => handleApprove(approval)}
                >
                  ✓ Approve Once
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
