import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import EventDetail from './EventDetail.js';
import { api } from '../api.js';

// Real network calls are never made in tests — the api module is mocked so
// these tests exercise only the component's rendering of AuditEvent-shaped
// data, matching real @agentgate/protocol fields (ADR-0009).
vi.mock('../api.js', () => ({ api: { event: vi.fn(), replay: vi.fn() } }));

// Synthetic-only — this string must never appear in rendered output; it
// stands in for what a real un-redacted secret would look like if the
// component ever accidentally rendered tool_call.raw_arguments instead of
// the already-redacted normalized_arguments.
const RAW_SECRET_STANDIN = 'AKIAIOSFODNN7EXAMPLE';

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    sequence_number: 1,
    previous_event_hash: null,
    event_hash: 'deadbeef',
    canonical_payload_version: '2',
    created_at: '2026-01-01T00:00:00.000Z',
    agent: { session_id: 's1', declared_name: 'test-agent', declared_version: '1.0', connection_identity: 'x', verified_identity: false },
    tool_call: {
      tool: 'fetch_data',
      raw_arguments: { note: `raw contained ${RAW_SECRET_STANDIN}` },
      normalized_arguments: { note: 'clean, redacted already by the backend' },
      mcp_era: 'legacy-2025',
      jsonrpc_id: null,
    },
    status: 'SUCCEEDED',
    decision: { type: 'ALLOW', reason_code: 'POLICY_ALLOW', explanation: 'Allowed by rule "x".', matched_rule_id: 'x' },
    execution_succeeded: true,
    execution_error: null,
    duration_ms: 12,
    arguments_redacted: false,
    result_redacted: false,
    result_blocked: false,
    result_finding_count: 0,
    error_redacted: false,
    ...overrides,
  };
}

function renderEventDetail() {
  return render(
    <MemoryRouter initialEntries={['/events/evt-1']}>
      <Routes>
        <Route path="/events/:id" element={<EventDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('EventDetail — Result Security card', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(api.event).mockReset();
  });

  it('shows a neutral "not redacted" state for a clean result with zero findings', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent());
    renderEventDetail();
    expect(await screen.findByText('NOT REDACTED')).toBeInTheDocument();
    expect(screen.getByText(/No supported secret pattern detected/)).toBeInTheDocument();
    // A zero finding count must not be phrased as "fully safe" anywhere.
    expect(screen.queryByText(/fully safe/i)).not.toBeInTheDocument();
  });

  it('shows the redacted state and finding count for a redacted result', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent({ result_redacted: true, result_finding_count: 2 }));
    renderEventDetail();
    expect(await screen.findByText('REDACTED')).toBeInTheDocument();
    expect(screen.getByText(/recognized secret pattern was found in the downstream result/)).toBeInTheDocument();
    // "2" alone would also match the unrelated "Payload Version: 2" row
    // elsewhere on the page — scope the query to the Findings row itself.
    const findingsLabel = screen.getByText('Findings');
    const findingsRow = findingsLabel.closest('.detail-row');
    expect(findingsRow).not.toBeNull();
    expect(findingsRow).toHaveTextContent('2');
  });

  it('shows the blocked state for a blocked result', async () => {
    vi.mocked(api.event).mockResolvedValue(
      baseEvent({ result_blocked: true, result_finding_count: 1, status: 'SUCCEEDED' })
    );
    renderEventDetail();
    expect(await screen.findByText('BLOCKED')).toBeInTheDocument();
    expect(screen.getByText(/replaced with a safe error before reaching the agent/)).toBeInTheDocument();
  });

  it('shows the sanitized-error state for a FAILED event', async () => {
    vi.mocked(api.event).mockResolvedValue(
      baseEvent({
        status: 'FAILED',
        execution_succeeded: false,
        execution_error: 'downstream failed while holding [REDACTED]',
        error_redacted: true,
      })
    );
    renderEventDetail();
    expect(await screen.findByText('Error sanitized')).toBeInTheDocument();
    expect(screen.getByText(/secret pattern was found and redacted/)).toBeInTheDocument();
  });

  it('does not render the Result Security card for non-terminal-execution statuses (e.g. DENIED)', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent({ status: 'DENIED', decision: { type: 'DENY', reason_code: 'POLICY_DENY', explanation: 'Denied.', matched_rule_id: 'x' } }));
    renderEventDetail();
    await screen.findByText('Event Detail');
    expect(screen.queryByText('Result Security')).not.toBeInTheDocument();
  });

  it('preserves existing status badge styling (DENIED renders as denied)', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent({ status: 'DENIED', decision: { type: 'DENY', reason_code: 'POLICY_DENY', explanation: 'Denied.', matched_rule_id: 'x' } }));
    renderEventDetail();
    const badge = await screen.findByText('DENIED');
    expect(badge.className).toContain('denied');
  });

  it('never renders the raw (un-redacted) tool_call.raw_arguments, only normalized_arguments', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent());
    renderEventDetail();
    await screen.findByText('Event Detail');
    expect(screen.queryByText((_, node) => Boolean(node?.textContent?.includes(RAW_SECRET_STANDIN)))).toBeNull();
    expect(document.body.textContent).not.toContain(RAW_SECRET_STANDIN);
  });

  it('renders the event hash and preserves the Tamper-Evidence Chain card', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent());
    renderEventDetail();
    expect(await screen.findByText('Tamper-Evidence Chain')).toBeInTheDocument();
    expect(screen.getByText('deadbeef')).toBeInTheDocument();
  });
});

// Synthetic-only — must never appear in the rendered card unless the mocked
// replay response itself includes it (i.e. the component must not fabricate
// or leak anything beyond what the API returned).
const REPLAY_SECRET_STANDIN = 'sk-should-never-render-in-the-replay-card-abcdefgh';

function baseReplayResult(overrides: Record<string, unknown> = {}) {
  return {
    replay_id: 'replay-1',
    source_event_id: 'evt-1',
    evaluated_at: '2026-01-02T00:00:00.000Z',
    mode: 'policy_only',
    executed: false,
    source_arguments_redacted: false,
    policy_digest: 'abc1234567890def',
    original: { decision_type: 'ALLOW', matched_rule_id: 'allow-reads', reason_code: 'POLICY_ALLOW' },
    current: {
      decision_type: 'ALLOW',
      matched_rule_id: 'allow-reads',
      reason_code: 'POLICY_ALLOW',
      explanation: 'Allowed by rule "allow-reads".',
      transformations: [],
    },
    decision_changed: false,
    matched_rule_changed: false,
    reason_code_changed: false,
    comparison: 'Policy decision unchanged.',
    limitations: ['Safe Replay never executes the tool — this is a policy comparison only.'],
    ...overrides,
  };
}

describe('EventDetail — Safe Replay card (ADR-0010)', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(api.event).mockReset();
    vi.mocked(api.replay).mockReset();
  });

  it('shows the no-execution card before any replay is run, with no execution control anywhere', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent());
    renderEventDetail();
    expect(await screen.findByText('Safe Replay')).toBeInTheDocument();
    expect(screen.getByText('NO TOOL EXECUTION')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run safe replay/i })).toBeInTheDocument();
    // No control anywhere on the page can execute or approve the historical call.
    expect(screen.queryByText(/dry_run/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /execute/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve and run/i })).not.toBeInTheDocument();
  });

  it('runs a replay and shows an unchanged decision', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent());
    vi.mocked(api.replay).mockResolvedValue(baseReplayResult());
    renderEventDetail();
    fireEvent.click(await screen.findByRole('button', { name: /run safe replay/i }));

    expect(await screen.findByText('UNCHANGED')).toBeInTheDocument();
    expect(screen.getByText('Policy decision unchanged.')).toBeInTheDocument();
    expect(screen.getByText(/No tool execution occurred/)).toBeInTheDocument();
    expect(screen.getByText('replay-1')).toBeInTheDocument();
    expect(api.replay).toHaveBeenCalledTimes(1);
    expect(api.replay).toHaveBeenCalledWith('evt-1');
  });

  it('runs a replay and shows a changed decision', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent());
    vi.mocked(api.replay).mockResolvedValue(
      baseReplayResult({
        current: {
          decision_type: 'DENY',
          matched_rule_id: 'deny-reads',
          reason_code: 'POLICY_DENY',
          explanation: 'Denied by rule "deny-reads".',
          transformations: [],
        },
        decision_changed: true,
        matched_rule_changed: true,
        comparison: 'Policy decision changed from ALLOW to DENY.',
      })
    );
    renderEventDetail();
    fireEvent.click(await screen.findByRole('button', { name: /run safe replay/i }));

    expect(await screen.findByText('CHANGED')).toBeInTheDocument();
    expect(screen.getByText('Policy decision changed from ALLOW to DENY.')).toBeInTheDocument();
  });

  it('shows a warning when the source arguments were redacted', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent());
    vi.mocked(api.replay).mockResolvedValue(baseReplayResult({ source_arguments_redacted: true }));
    renderEventDetail();
    fireEvent.click(await screen.findByRole('button', { name: /run safe replay/i }));

    expect(await screen.findByText(/original arguments were redacted before storage/)).toBeInTheDocument();
  });

  it('does not show the redaction warning when the source arguments were not redacted', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent());
    vi.mocked(api.replay).mockResolvedValue(baseReplayResult({ source_arguments_redacted: false }));
    renderEventDetail();
    fireEvent.click(await screen.findByRole('button', { name: /run safe replay/i }));

    await screen.findByText('UNCHANGED');
    expect(screen.queryByText(/original arguments were redacted before storage/)).not.toBeInTheDocument();
  });

  it('shows a safe error message and allows retry when replay fails', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent());
    vi.mocked(api.replay)
      .mockRejectedValueOnce(new Error('Event not found.'))
      .mockResolvedValueOnce(baseReplayResult());
    renderEventDetail();
    fireEvent.click(await screen.findByRole('button', { name: /run safe replay/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Event not found.');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByText('UNCHANGED')).toBeInTheDocument();
    expect(api.replay).toHaveBeenCalledTimes(2);
  });

  it('prevents a double-submit from issuing two requests', async () => {
    vi.mocked(api.event).mockResolvedValue(baseEvent());
    let resolveReplay: (value: unknown) => void = () => {};
    vi.mocked(api.replay).mockReturnValue(
      new Promise((resolve) => {
        resolveReplay = resolve;
      })
    );
    renderEventDetail();
    const button = await screen.findByRole('button', { name: /run safe replay/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    resolveReplay(baseReplayResult());
    await screen.findByText('UNCHANGED');
    expect(api.replay).toHaveBeenCalledTimes(1);
  });

  it('never renders a value that was not present in the replay response', async () => {
    vi.mocked(api.event).mockResolvedValue(
      baseEvent({ tool_call: { tool: 'fetch_data', raw_arguments: { note: REPLAY_SECRET_STANDIN }, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null } })
    );
    vi.mocked(api.replay).mockResolvedValue(baseReplayResult());
    renderEventDetail();
    fireEvent.click(await screen.findByRole('button', { name: /run safe replay/i }));

    await waitFor(() => expect(screen.getByText('UNCHANGED')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain(REPLAY_SECRET_STANDIN);
  });
});
