import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, openEventStream } from '../api';
import type {
  ContextSummary,
  ContextStatus,
  ContextStatusReport,
  ContextHistoryReport,
  ContextExplainReport,
  ContextVerifyReport,
  ContextEventWire,
} from '../api';

/**
 * Context Guard page (Milestone 7, ADR-0013) — cross-tool session-risk
 * escalation defense. Shows the AgentGate-local execution context(s), the
 * policy-owned risk labels a context has accumulated from observed tool
 * results, and — for a context currently gated on a contextual decision —
 * why a later call was denied or requires exact approval.
 *
 * Security/product-truth invariants enforced throughout this page:
 *   - A "context" is AgentGate's own OBSERVED gateway history — never a
 *     claim of model-reasoning inspection or causal proof that one result
 *     actually influenced a later call. Every surface that shows
 *     accumulated labels repeats this rather than implying otherwise.
 *   - No raw tool arguments, results, or prompt-injection text are ever
 *     requested from or rendered by this page — only label names, rule
 *     ids, safe bounded reason strings, and redacted-linkage ids, which is
 *     everything the underlying storage boundary retains in the first
 *     place (see context-guard/state.ts).
 *   - Every tool name, reason, and label is untrusted, potentially
 *     attacker-influenced display text — rendered only as plain React
 *     text, never `dangerouslySetInnerHTML`.
 *   - Reset is the only mutating control on this page: exact revision,
 *     required non-empty bounded reason, explicit confirmation, and no
 *     reset-all / remove-label / mark-safe / force shortcut anywhere.
 */

const MAX_REASON_LENGTH = 2000;
const LIST_LIMIT = 200;

function idPrefix(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/** Strips ANSI/control characters from untrusted display text at the render boundary — the same defensive posture the CLI's sanitizeForTerminal() applies, adapted for the DOM (React already prevents markup injection; this only prevents control-character layout tricks). */
function sanitizeText(value: string | null | undefined, maxLength = 400): string {
  if (!value) return '';
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}

function StatusBadge({ status }: { status: ContextStatus }) {
  const cls = status === 'active' ? 'allowed' : status === 'reset' ? 'transform' : 'neutral';
  return <span className={`badge ${cls}`}>{status}</span>;
}

function LabelChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return <span className="badge allowed" style={{ fontSize: 10 }}>clean — no labels</span>;
  }
  // Bound rendered label count defensively — labels are policy-owned and
  // already capped server-side (MAX_LABELS_PER_TOOL/MAX_CUSTOM_LABELS), but
  // never assume a future config change can't widen that without a UI fix.
  const bounded = labels.slice(0, 32);
  return (
    <div className="cg-label-row">
      {bounded.map((l) => (
        <span key={l} className="cg-label-chip">{sanitizeText(l, 80)}</span>
      ))}
      {labels.length > bounded.length && <span className="text-muted" style={{ fontSize: 11 }}>+{labels.length - bounded.length} more</span>}
    </div>
  );
}

const CORRELATION_NOTE =
  'This is AgentGate’s own observed gateway history — which tools were called and what operator policy classifies their results as. It is not proof that a later call was actually caused by an earlier result, and AgentGate never reads or inspects the model’s own reasoning or memory.';

function timelineDotClass(e: ContextEventWire): string {
  if (e.event_type === 'label_added') return 'label';
  if (e.event_type === 'context_reset') return 'reset';
  if (e.event_type === 'context_closed' || e.event_type === 'context_expired' || e.event_type === 'context_created') return 'lifecycle';
  if (e.event_type === 'call_evaluated') {
    if (e.action === 'deny') return 'deny';
    if (e.action === 'require_approval') return 'approval';
    return 'allow';
  }
  return 'lifecycle';
}

function timelineTitle(e: ContextEventWire): string {
  switch (e.event_type) {
    case 'context_created':
      return 'Context created';
    case 'label_added':
      return `Label${(e.labels_added?.length ?? 0) === 1 ? '' : 's'} added`;
    case 'call_evaluated':
      return `Call evaluated — ${e.action ?? 'allow'}`;
    case 'context_reset':
      return 'Context reset';
    case 'context_expired':
      return 'Context expired';
    case 'context_closed':
      return 'Context closed';
    default:
      return e.event_type;
  }
}

function TimelineRow({ e }: { e: ContextEventWire }) {
  return (
    <div className="cg-timeline-row">
      <div className={`cg-timeline-dot ${timelineDotClass(e)}`} />
      <div>
        <div className="cg-timeline-title">{timelineTitle(e)}</div>
        <div className="cg-timeline-meta text-mono">
          {new Date(e.created_at).toLocaleString()}
          {e.revision_after != null && ` · rev ${e.revision_before ?? '?'} → ${e.revision_after}`}
          {e.tool_name && (
            <>
              {' · '}
              <span className="tool-name">{sanitizeText(e.tool_name, 80)}</span>
            </>
          )}
        </div>
        {e.labels_added && e.labels_added.length > 0 && (
          <div className="cg-timeline-detail"><LabelChips labels={e.labels_added} /></div>
        )}
        {e.event_type === 'call_evaluated' && (
          <div className="cg-timeline-detail">
            {e.rule_id ? <>rule <span className="text-mono">{sanitizeText(e.rule_id, 128)}</span></> : <span className="text-muted">no contextual rule matched</span>}
            {e.reason && <div className="mt-4">{sanitizeText(e.reason)}</div>}
          </div>
        )}
        {e.event_type === 'context_reset' && (
          <div className="cg-timeline-detail">
            {e.reviewer && <>by <span className="text-mono">{sanitizeText(e.reviewer, 64)}</span> — </>}
            {sanitizeText(e.reason)}
          </div>
        )}
        {e.source_event_id && (
          <div className="cg-timeline-detail">
            <Link to={`/events/${encodeURIComponent(e.source_event_id)}`} className="text-mono" style={{ color: 'var(--accent-text)' }}>
              view originating event →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

interface ResetDialogProps {
  context: ContextSummary;
  onClose: () => void;
  onDone: (outcome: 'ok' | 'stale') => void;
}

function ResetDialog({ context, onClose, onDone }: ResetDialogProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlightRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_REASON_LENGTH && !submitting;

  const handleConfirm = async () => {
    if (!canSubmit || inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.contextReset(context.context_id, context.revision, trimmed);
      if (result.ok) {
        onDone('ok');
      } else {
        setError(result.error ?? 'Reset failed.');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onDone('stale');
      } else {
        setError(err instanceof Error ? err.message : 'Reset failed.');
      }
    }
    inFlightRef.current = false;
    setSubmitting(false);
  };

  return (
    <div className="cg-modal-overlay" onClick={onClose}>
      <div
        className="cg-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cg-reset-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="cg-reset-title" className="cg-modal-title">⚠ Reset this context?</div>
        <div className="cg-note">
          Reset begins a new AgentGate enforcement state for this context (revision {context.revision} → {context.revision + 1},
          labels cleared going forward). It cannot erase, and has no effect whatsoever on, anything the upstream LLM or MCP client
          itself already remembers from before the reset — its own conversation history, cached tool results, or reasoning
          already produced. Any pending contextual approval bound to this context will be invalidated.
        </div>
        <label htmlFor="cg-reset-reason" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          Reason (required)
        </label>
        <textarea
          id="cg-reset-reason"
          ref={textareaRef}
          value={reason}
          maxLength={MAX_REASON_LENGTH}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this context being reset?"
        />
        <div className="text-muted" style={{ fontSize: 11 }}>{trimmed.length}/{MAX_REASON_LENGTH}</div>
        {error && <div role="alert" className="ti-error">{error}</div>}
        <div className="cg-modal-actions">
          <button className="btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="cg-reset-trigger" disabled={!canSubmit} onClick={() => void handleConfirm()}>
            {submitting ? '…' : 'Confirm reset'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ContextDetailProps {
  contextId: string;
  onResetDone: () => void;
}

function ContextDetail({ contextId, onResetDone }: ContextDetailProps) {
  const [summary, setSummary] = useState<ContextSummary | null>(null);
  const [history, setHistory] = useState<ContextHistoryReport | null>(null);
  const [explain, setExplain] = useState<ContextExplainReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showReset, setShowReset] = useState(false);
  const [staleNotice, setStaleNotice] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, h, ex] = await Promise.all([
        api.context(contextId),
        api.contextHistory(contextId, 200),
        api.contextExplain(contextId),
      ]);
      setSummary(s);
      setHistory(h);
      setExplain(ex);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load context detail.');
    }
    setLoading(false);
  }, [contextId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  if (loading) return <div className="card"><div className="empty-state"><div className="spinner" /></div></div>;
  if (error || !summary) {
    return (
      <div className="card">
        <div className="empty-state">
          <div className="empty-state-icon">⚡</div>
          <div className="empty-state-title">Could not load this context</div>
          <div className="empty-state-desc">{error ?? 'Unknown error.'}</div>
          <button className="btn btn-ghost mt-16" onClick={() => void load()}>Retry</button>
        </div>
      </div>
    );
  }

  const latestDecision = explain?.ok ? explain.latest_decision : undefined;
  const escalated = latestDecision != null && latestDecision.action !== 'allow';

  return (
    <div className="card mt-16" data-testid="context-detail">
      <div className="card-header">
        <span className="card-title">Context {idPrefix(summary.context_id)}</span>
        <div className="flex items-center gap-8">
          <button
            className="btn-ghost"
            style={{ fontSize: 11 }}
            onClick={() => {
              try {
                void navigator.clipboard?.writeText(summary.context_id);
              } catch {
                // Clipboard access can be unavailable/blocked — non-fatal.
              }
            }}
          >
            copy full id
          </button>
          <StatusBadge status={summary.status} />
        </div>
      </div>
      <div className="card-body">
        {staleNotice && (
          <div className="cg-stale-banner mt-8" style={{ marginBottom: 16 }}>
            The context changed since you opened the reset dialog (revision advanced). Current state has been reloaded —
            review it again before resetting.
          </div>
        )}

        <div className="cg-note" style={{ marginBottom: 16 }}>{CORRELATION_NOTE}</div>

        <div className="detail-row">
          <div className="detail-label">Revision</div>
          <div className="detail-value mono">{summary.revision}</div>
        </div>
        <div className="detail-row">
          <div className="detail-label">Labels</div>
          <div className="detail-value"><LabelChips labels={summary.labels} /></div>
        </div>
        <div className="detail-row">
          <div className="detail-label">Server</div>
          <div className="detail-value mono">{summary.server_identity ?? '—'}</div>
        </div>
        <div className="detail-row">
          <div className="detail-label">Created</div>
          <div className="detail-value mono">{new Date(summary.created_at).toLocaleString()}</div>
        </div>
        <div className="detail-row">
          <div className="detail-label">Updated</div>
          <div className="detail-value mono">{new Date(summary.updated_at).toLocaleString()}</div>
        </div>
        {explain?.ok && explain.lifecycle_note && (
          <div className="detail-row">
            <div className="detail-label">Lifecycle</div>
            <div className="detail-value">{explain.lifecycle_note}</div>
          </div>
        )}

        {escalated && latestDecision && (
          <div className={`cg-escalation ${latestDecision.action === 'require_approval' ? 'pending' : ''} mt-16`} data-testid="escalation-panel">
            <div className="cg-timeline-title" style={{ marginBottom: 8 }}>
              Latest contextual decision: <span className={`badge ${latestDecision.action === 'deny' ? 'denied' : 'pending'}`}>{latestDecision.action.replace(/_/g, ' ')}</span>
            </div>
            <div className="detail-row">
              <div className="detail-label">Attempted tool</div>
              <div className="detail-value"><span className="tool-name">{sanitizeText(latestDecision.tool_name, 128)}</span></div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Matched rule</div>
              <div className="detail-value mono">{latestDecision.rule_id ? sanitizeText(latestDecision.rule_id, 128) : 'base policy (no contextual rule)'}</div>
            </div>
            <div className="detail-row">
              <div className="detail-label">Reason</div>
              <div className="detail-value">{sanitizeText(latestDecision.reason)}</div>
            </div>
            {latestDecision.action === 'deny' && (
              <div className="mt-8" style={{ fontSize: 12, color: 'var(--text-danger)' }}>
                This call was blocked before it ever reached the downstream server — Context Guard's deny path is enforced
                ahead of downstream execution (ADR-0013).
              </div>
            )}
            {latestDecision.action === 'require_approval' && (
              <div className="mt-8" style={{ fontSize: 12, color: 'var(--text-warning)' }}>
                This call requires an exact, revision-bound approval before it can reach the downstream server. See{' '}
                <Link to="/approvals" style={{ color: 'var(--accent-text)' }}>Approvals</Link>.
              </div>
            )}
          </div>
        )}

        {explain?.ok && explain.label_origins && explain.label_origins.length > 0 && (
          <div className="mt-16">
            <div className="cg-timeline-title" style={{ marginBottom: 8 }}>What established the active labels</div>
            {explain.label_origins.map((o) => (
              <div key={o.label} className="cg-timeline-detail" style={{ marginBottom: 6 }}>
                <span className="cg-label-chip">{sanitizeText(o.label, 80)}</span>
                {' — '}
                {o.tool_name && <span className="tool-name" style={{ marginRight: 4 }}>{sanitizeText(o.tool_name, 80)}</span>}
                {o.source_event_id ? (
                  <Link to={`/events/${encodeURIComponent(o.source_event_id)}`} className="text-mono" style={{ color: 'var(--accent-text)' }}>
                    view event
                  </Link>
                ) : (
                  <span className="text-muted">no linked event</span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-16">
          <div className="cg-timeline-title" style={{ marginBottom: 4 }}>Transition timeline</div>
          {history && history.events.length > 0 ? (
            <>
              {!history.chain_valid && (
                <div className="ti-error mt-8" style={{ marginBottom: 8 }}>
                  ⚠ Chain verification failed{history.chain_error ? `: ${history.chain_error}` : '.'} This is local tamper
                  evidence, not proof — see the Chain integrity note in the Overview.
                </div>
              )}
              <div className="cg-timeline">
                {history.events.map((e) => (
                  <TimelineRow key={e.id} e={e} />
                ))}
              </div>
              {history.truncated && <div className="text-muted mt-8">…history truncated to the most recent {history.events.length} transitions.</div>}
            </>
          ) : (
            <div className="text-muted" style={{ fontSize: 12.5 }}>No transitions recorded for this context yet.</div>
          )}
        </div>

        {summary.status === 'active' ? (
          <div className="mt-16" style={{ borderTop: '1px solid var(--bg-border)', paddingTop: 16 }}>
            <button className="cg-reset-trigger" onClick={() => setShowReset(true)}>
              Reset this context…
            </button>
          </div>
        ) : (
          <div className="mt-16 text-muted" style={{ fontSize: 12 }}>
            This context is {summary.status} — reset is only available for an active context.
          </div>
        )}
      </div>

      {showReset && (
        <ResetDialog
          context={summary}
          onClose={() => setShowReset(false)}
          onDone={(outcome) => {
            setShowReset(false);
            if (outcome === 'stale') setStaleNotice(true);
            void load();
            onResetDone();
          }}
        />
      )}
    </div>
  );
}

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

export default function ContextGuard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [report, setReport] = useState<ContextStatusReport | null>(null);
  const [integrity, setIntegrity] = useState<ContextVerifyReport | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<ContextStatus | ''>('');
  const [selected, setSelected] = useState<string | null>(searchParams.get('context'));
  const [liveUpdates, setLiveUpdates] = useState(0);
  const [connState, setConnState] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const streamRef = useRef<EventSource | null>(null);
  // Always holds the CURRENT load() closure (current stateFilter included)
  // so the SSE effect below — opened once on mount — never calls a stale
  // closure after the user changes the state filter.
  const loadRef = useRef<() => Promise<void>>(async () => {});

  const load = useCallback(async () => {
    try {
      const [r, i] = await Promise.all([
        api.contexts({ state: stateFilter || undefined, limit: LIST_LIMIT }),
        api.contextIntegrity().catch(() => null),
      ]);
      setReport(r);
      setIntegrity(i);
      setLoadState('ready');
      setErrorMessage(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setLoadState('unavailable');
      } else {
        setLoadState('error');
        setErrorMessage(err instanceof Error ? err.message : 'Could not load Context Guard status.');
      }
    }
  }, [stateFilter]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 8000);
    return () => clearInterval(id);
  }, [load]);

  // Live updates: Context Guard transitions arrive as `context_event`
  // frames on the SAME SSE stream the rest of the app already uses. A
  // fresh subscriber never receives events published before it connected
  // (see api.ts's openEventStream doc comment) — the REST fetch above is
  // always the source of truth for state as of mount/poll; SSE here only
  // triggers a prompt refetch rather than reconstructing state from
  // individual frames, which keeps this resilient to any duplicate or
  // out-of-order frame without needing per-event reconciliation logic.
  useEffect(() => {
    // Opened unconditionally on mount, regardless of whether Context Guard
    // itself is configured — the SSE endpoint always exists; if Context
    // Guard is unavailable, no `context_event` frame is ever published, so
    // this simply never fires the refetch below (harmless, no wasted work
    // beyond one idle connection, matching the connection-state indicator
    // every other live page already shows unconditionally).
    const es = openEventStream(
      () => {},
      () => setConnState('reconnecting'),
      () => {
        setConnState('live');
        setLiveUpdates((c) => c + 1);
        void loadRef.current();
      }
    );
    streamRef.current = es;
    es.onopen = () => setConnState('live');
    return () => {
      es.close();
      streamRef.current = null;
    };
    // Intentionally [] — the stream is opened exactly once per page mount.
    // It always calls loadRef.current() (kept fresh by the effect above),
    // never a closed-over `load`, so a stateFilter change afterward is
    // still respected without tearing down and reopening the connection.
  }, []);

  const selectContext = (id: string | null) => {
    setSelected(id);
    const next = new URLSearchParams(searchParams);
    if (id) next.set('context', id);
    else next.delete('context');
    setSearchParams(next, { replace: true });
  };

  if (loadState === 'loading') {
    return (
      <>
        <div className="page-header">
          <div>
            <h1 className="page-title">Context Guard</h1>
            <p className="page-subtitle">Cross-tool session-risk escalation defense</p>
          </div>
        </div>
        <div className="empty-state"><div className="spinner" /></div>
      </>
    );
  }

  if (loadState === 'unavailable') {
    return (
      <>
        <div className="page-header">
          <div>
            <h1 className="page-title">Context Guard</h1>
            <p className="page-subtitle">Cross-tool session-risk escalation defense</p>
          </div>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">◈</div>
          <div className="empty-state-title">Context Guard is not configured</div>
          <div className="empty-state-desc">
            This gateway was not started with <span className="text-mono">context_guard</span> configured, so no execution
            contexts exist to show. See docs/POLICY_REFERENCE.md to enable it.
          </div>
        </div>
      </>
    );
  }

  if (loadState === 'error') {
    return (
      <>
        <div className="page-header">
          <div>
            <h1 className="page-title">Context Guard</h1>
            <p className="page-subtitle">Cross-tool session-risk escalation defense</p>
          </div>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">⚡</div>
          <div className="empty-state-title">Gateway Unreachable</div>
          <div className="empty-state-desc">{errorMessage}</div>
          <button className="btn btn-ghost mt-16" onClick={() => void load()}>Retry</button>
        </div>
      </>
    );
  }

  const contexts = report?.contexts ?? [];
  const counts = { active: 0, closed: 0, expired: 0, reset: 0 };
  for (const c of contexts) counts[c.status] += 1;
  const withLabels = contexts.filter((c) => c.status === 'active' && c.labels.length > 0);
  const pendingApprovalContexts = contexts.filter((c) => c.pending_approval_count > 0);
  const totalPendingApprovals = contexts.reduce((sum, c) => sum + c.pending_approval_count, 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Context Guard</h1>
          <p className="page-subtitle">Cross-tool session-risk escalation defense — conservative, observed gateway history, not model introspection.</p>
        </div>
        <div className="live-indicator" title={connState === 'live' ? 'Connected' : connState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}>
          <span className="live-dot" style={connState !== 'live' ? { background: 'var(--color-pending)' } : undefined} />
          {connState === 'live' ? `LIVE · ${liveUpdates} updates` : connState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Active</div>
          <div className="stat-value allowed">{counts.active}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Closed</div>
          <div className="stat-value neutral">{counts.closed}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Expired</div>
          <div className="stat-value neutral">{counts.expired}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Reset</div>
          <div className="stat-value transform">{counts.reset}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active with labels</div>
          <div className="stat-value pending">{withLabels.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Pending approvals</div>
          <div className="stat-value pending">{totalPendingApprovals}</div>
        </div>
      </div>

      {integrity && (
        <div className={`cg-note`}>
          Chain integrity: <strong className={integrity.valid ? 'text-success' : 'text-danger'}>{integrity.valid ? 'verified' : 'FAILED'}</strong>
          {' '}({integrity.count} events checked). {integrity.limitation}
        </div>
      )}

      {report?.truncated && (
        <div className="cg-stale-banner">
          Showing {contexts.length} of {report.total} contexts — narrow with the state filter below to see the rest.
        </div>
      )}

      {pendingApprovalContexts.length > 0 && (
        <div className="cg-escalation pending">
          <div className="cg-timeline-title" style={{ marginBottom: 6 }}>{pendingApprovalContexts.length} context(s) awaiting a contextual approval decision</div>
          <div className="text-muted" style={{ fontSize: 12 }}>See <Link to="/approvals" style={{ color: 'var(--accent-text)' }}>Approvals</Link> to resolve.</div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Contexts</span>
          <select
            aria-label="Filter by lifecycle state"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as ContextStatus | '')}
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--bg-border)', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
          >
            <option value="">All states</option>
            <option value="active">Active</option>
            <option value="closed">Closed</option>
            <option value="expired">Expired</option>
            <option value="reset">Reset</option>
          </select>
        </div>
        {contexts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            <div className="empty-state-title">No contexts recorded yet</div>
            <div className="empty-state-desc">A context is created for each stdio connection once the gateway starts.</div>
          </div>
        ) : (
          <>
            {/* Desktop/tablet: the full 7-column table. Hidden below
                ~640px in favor of the stacked card list — a 7-column table
                cannot reflow into ~380px of usable width without either
                losing information (clipped by `.card`'s own
                `overflow: hidden`) or requiring blind horizontal scroll,
                neither of which is "intentional narrow reflow." */}
            <div className="cg-table-scroll cg-contexts-table">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Context</th>
                    <th>State</th>
                    <th>Rev</th>
                    <th>Labels</th>
                    <th>Server</th>
                    <th>Updated</th>
                    <th>Approval</th>
                  </tr>
                </thead>
                <tbody>
                  {contexts.map((c) => (
                    <tr
                      key={c.context_id}
                      className={`cg-context-row${selected === c.context_id ? ' selected' : ''}`}
                      onClick={() => selectContext(c.context_id)}
                    >
                      <td className="cg-context-id">{idPrefix(c.context_id)}</td>
                      <td><StatusBadge status={c.status} /></td>
                      <td className="text-mono">{c.revision}</td>
                      <td><LabelChips labels={c.labels} /></td>
                      <td className="text-muted text-mono">{c.server_identity ? idPrefix(c.server_identity) : '—'}</td>
                      <td className="text-muted text-mono">{new Date(c.updated_at).toLocaleTimeString()}</td>
                      <td>{c.pending_approval_count > 0 ? <span className="badge pending" style={{ fontSize: 10 }}>{c.pending_approval_count} pending</span> : <span className="text-muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Narrow (~420px): a stacked card per context — every field
                still visible, nothing clipped or scroll-hidden. */}
            <div className="cg-contexts-cards">
              {contexts.map((c) => (
                <div
                  key={c.context_id}
                  className={`cg-context-card${selected === c.context_id ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectContext(c.context_id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectContext(c.context_id);
                    }
                  }}
                >
                  <div className="cg-context-card-row">
                    <span className="cg-context-id">{idPrefix(c.context_id)}</span>
                    <StatusBadge status={c.status} />
                  </div>
                  <LabelChips labels={c.labels} />
                  <div className="cg-context-card-meta">
                    <span>rev {c.revision}</span>
                    <span>{new Date(c.updated_at).toLocaleTimeString()}</span>
                    {c.pending_approval_count > 0 && <span className="badge pending" style={{ fontSize: 10 }}>{c.pending_approval_count} pending</span>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {selected && <ContextDetail contextId={selected} onResetDone={() => void load()} />}
    </>
  );
}
