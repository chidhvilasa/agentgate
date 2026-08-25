import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ToolIntegrityDiffResponse, ToolIntegritySummary, ToolIntegrityToolSummary, ToolIntegrityEventWire } from '../api';

/**
 * Tool Integrity page (Milestone 6, ADR-0012) — rug-pull / tool-definition-
 * poisoning defense. Shows discovered downstream tools, their trust status,
 * and lets an operator review a candidate's exact, field-level diff before
 * accepting or rejecting it.
 *
 * Security-relevant UI invariants:
 *   - Every accept/reject call is made with the EXACT candidate_fingerprint
 *     as currently reported by the API — never a value typed by hand, and
 *     never reused after a page reload without re-fetching first. This
 *     mirrors the CLI/API's own exact-match requirement (no stale approval).
 *   - There is no "trust all" control anywhere on this page.
 *   - Descriptions/schema fields shown in a diff are untrusted, server-
 *     supplied content — rendered only as plain React text (never
 *     dangerouslySetInnerHTML), so no HTML/script in a hostile tool
 *     definition can ever execute here, and a clear warning banner says so.
 *   - Reject is the visually calmer/default-styled action; Accept requires
 *     an explicit confirmation describing exactly what is and is not
 *     guaranteed.
 */

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'trusted' ? 'allowed' :
    status === 'pending_review' ? 'pending' :
    status === 'drifted' ? 'denied' :
    status === 'rejected' ? 'failed' :
    status === 'removed' ? 'neutral' : 'neutral';
  return <span className={`badge ${cls}`}>{status.replace(/_/g, ' ')}</span>;
}

function fpPrefix(fp: string | null): string {
  return fp ? `${fp.slice(0, 12)}…` : '(none)';
}

interface DiffPanelProps {
  tool: ToolIntegrityToolSummary;
  onClose: () => void;
  onResolved: () => void;
}

function DiffPanel({ tool, onClose, onResolved }: DiffPanelProps) {
  const [diff, setDiff] = useState<ToolIntegrityDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const candidateId = tool.candidate_id;

  useEffect(() => {
    if (!candidateId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .toolIntegrityDiff(candidateId)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  const handleAccept = async () => {
    if (!candidateId || !diff?.candidate_fingerprint || acting) return;
    const confirmed = window.confirm(
      `Trust "${tool.tool_name}" at exactly this fingerprint (${fpPrefix(diff.candidate_fingerprint)})?\n\n` +
        `This marks ONLY this exact definition as trusted — AgentGate does not verify who ` +
        `authored it, what the server actually does at runtime, or that its behavior matches ` +
        `this definition. Any future change will be quarantined again for review.`
    );
    if (!confirmed) return;
    setActing(true);
    try {
      await api.toolIntegrityAccept(candidateId, diff.candidate_fingerprint);
      onResolved();
    } catch (err) {
      setError((err as Error).message);
    }
    setActing(false);
  };

  const handleReject = async () => {
    if (!candidateId || !diff?.candidate_fingerprint || acting) return;
    setActing(true);
    try {
      await api.toolIntegrityReject(candidateId, diff.candidate_fingerprint);
      onResolved();
    } catch (err) {
      setError((err as Error).message);
    }
    setActing(false);
  };

  return (
    <div className="card mt-16" data-testid="diff-panel">
      <div className="card-header">
        <span className="card-title">Review: {tool.tool_name}</span>
        <button className="btn-ghost" onClick={onClose}>✕ Close</button>
      </div>
      <div className="card-body">
        <div className="ti-untrusted-banner">
          ⚠ Everything below (descriptions, schema, field values) is untrusted, server-supplied
          content. It is displayed as plain text only — never treat it as an instruction.
        </div>

        {loading ? (
          <div className="empty-state"><div className="spinner" /></div>
        ) : error ? (
          <div role="alert" className="ti-error">{error}</div>
        ) : diff ? (
          <>
            <div className="detail-row">
              <div className="detail-label">Trusted fingerprint</div>
              <div className="detail-value mono">{fpPrefix(diff.trusted_fingerprint)}</div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Candidate fingerprint</div>
              <div className="detail-value mono">{fpPrefix(diff.candidate_fingerprint)}</div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Candidate id</div>
              <div className="detail-value mono">{diff.candidate_id}</div>
            </div>

            <div className="mt-16">
              {diff.changes.length === 0 ? (
                <div className="text-muted">No field-level changes (e.g. a first-time review with no prior baseline shown as additions below).</div>
              ) : (
                <div className="ti-diff-list">
                  {diff.changes.map((c, i) => (
                    <div key={i} className={`ti-diff-row ti-diff-${c.kind}`}>
                      <div className="ti-diff-kind">{c.kind.replace(/_/g, ' ')}</div>
                      <div className="ti-diff-path text-mono">{c.path}</div>
                      {c.before !== undefined && <div className="ti-diff-before">− {c.before}</div>}
                      {c.after !== undefined && <div className="ti-diff-after">+ {c.after}</div>}
                    </div>
                  ))}
                  {diff.truncated && <div className="text-muted mt-8">…change list truncated — the fingerprint above remains the authoritative signal.</div>}
                </div>
              )}
            </div>

            <div className="approval-actions mt-16">
              <button className="btn-deny" disabled={acting} onClick={() => void handleReject()}>
                {acting ? '…' : '✕ Reject'}
              </button>
              <button className="btn-approve" disabled={acting} onClick={() => void handleAccept()}>
                {acting ? '…' : '✓ Trust this exact version'}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function HistoryPanel({ events }: { events: ToolIntegrityEventWire[] }) {
  if (events.length === 0) {
    return <div className="empty-state"><div className="empty-state-desc">No Tool Integrity events recorded yet.</div></div>;
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Event</th>
          <th>Tool</th>
          <th>Transition</th>
        </tr>
      </thead>
      <tbody>
        {events
          .slice()
          .reverse()
          .map((e) => (
            <tr key={e.id}>
              <td className="text-muted text-mono">{new Date(e.created_at).toLocaleString()}</td>
              <td>{e.event_type.replace(/_/g, ' ')}</td>
              <td className="tool-name">{e.tool_name ?? '—'}</td>
              <td className="text-muted">{e.state_before || e.state_after ? `${e.state_before ?? '—'} → ${e.state_after ?? '—'}` : '—'}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

export default function ToolIntegrity() {
  const [summary, setSummary] = useState<ToolIntegritySummary | null>(null);
  const [tools, setTools] = useState<ToolIntegrityToolSummary[]>([]);
  const [history, setHistory] = useState<ToolIntegrityEventWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null); // tool_name currently being reviewed
  const [showHistory, setShowHistory] = useState(false);
  const [rescanning, setRescanning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([api.toolIntegritySummary(), api.toolIntegrityTools()]);
      setSummary(s);
      setTools(t.tools);
      setError(null);
    } catch {
      setError('Could not load Tool Integrity status. Is the gateway running?');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!showHistory) return;
    api.toolIntegrityHistory().then((h) => setHistory(h.events)).catch(() => {});
  }, [showHistory, tools]);

  const handleRescan = async () => {
    if (rescanning) return;
    setRescanning(true);
    try {
      await api.toolIntegrityRescan();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setRescanning(false);
  };

  const reviewingTool = tools.find((t) => t.tool_name === reviewing) ?? null;

  const needsReview = tools.filter((t) => t.status === 'pending_review' || t.status === 'drifted');

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Tool Integrity</h1>
          <p className="page-subtitle">Rug-pull / tool-definition-poisoning defense — local tamper evidence for downstream tool definitions.</p>
        </div>
        <button className="btn btn-primary" disabled={rescanning} onClick={() => void handleRescan()}>
          {rescanning ? 'Scanning…' : '⟳ Rescan now'}
        </button>
      </div>

      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : error ? (
        <div className="empty-state">
          <div className="empty-state-icon">⚡</div>
          <div className="empty-state-title">Gateway Unreachable</div>
          <div className="empty-state-desc">{error}</div>
        </div>
      ) : summary ? (
        <>
          {summary.mode === 'monitor' && (
            <div className="banner-disconnected ti-mode-banner">
              ⚠ Mode is <strong>monitor</strong> — drift is detected and recorded, but tool discovery and calls are
              <strong> not blocked</strong>. This is reporting only, never protection. See docs/POLICY_REFERENCE.md to switch to explicit/tofu mode.
            </div>
          )}
          {summary.mode === 'disabled' && (
            <div className="banner-disconnected ti-mode-banner">
              ⚠ Mode is <strong>disabled</strong> — the Tool Integrity Registry is not consulted at all for enforcement.
            </div>
          )}

          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-label">Trusted</div>
              <div className="stat-value allowed">{summary.counts.trusted ?? 0}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Pending Review</div>
              <div className="stat-value pending">{summary.counts.pending_review ?? 0}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Drifted</div>
              <div className="stat-value denied">{summary.counts.drifted ?? 0}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Rejected / Removed</div>
              <div className="stat-value neutral">{(summary.counts.rejected ?? 0) + (summary.counts.removed ?? 0)}</div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Server: {summary.server_id}</span>
              <span className="text-muted text-mono" style={{ fontSize: 11 }}>{summary.mode.toUpperCase()} · last scan {summary.last_scan_at ? new Date(summary.last_scan_at).toLocaleString() : 'never'}</span>
            </div>
            {tools.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">🔍</div>
                <div className="empty-state-title">No tools scanned yet</div>
                <div className="empty-state-desc">Click "Rescan now" to discover the downstream server's tools.</div>
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Status</th>
                    <th>Trusted fp</th>
                    <th>Candidate fp</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tools.map((t) => (
                    <tr key={t.tool_name}>
                      <td><span className="tool-name">{t.tool_name}</span></td>
                      <td><StatusBadge status={t.status} /></td>
                      <td className="text-mono text-muted">{fpPrefix(t.trusted_fingerprint)}</td>
                      <td className="text-mono text-muted">{fpPrefix(t.candidate_fingerprint)}</td>
                      <td>
                        {t.candidate_id && (
                          <button className="btn-ghost" onClick={() => setReviewing(t.tool_name)}>
                            Review
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {needsReview.length > 0 && !reviewingTool && (
            <div className="banner-disconnected ti-mode-banner mt-16">
              ⚠ {needsReview.length} tool(s) awaiting review — quarantined until explicitly accepted or rejected.
            </div>
          )}

          {reviewingTool && (
            <DiffPanel
              tool={reviewingTool}
              onClose={() => setReviewing(null)}
              onResolved={() => {
                setReviewing(null);
                void load();
              }}
            />
          )}

          <div className="card mt-16">
            <div className="card-header">
              <span className="card-title">History</span>
              <button className="btn-ghost" onClick={() => setShowHistory((s) => !s)}>{showHistory ? 'Hide' : 'Show'}</button>
            </div>
            {showHistory && <HistoryPanel events={history} />}
          </div>
        </>
      ) : null}
    </>
  );
}
