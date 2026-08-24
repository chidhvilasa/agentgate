import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import EventDetail from './EventDetail.js';
import { api } from '../api.js';

// Real network calls are never made in tests — the api module is mocked so
// these tests exercise only the component's rendering of AuditEvent-shaped
// data, matching real @agentgate/protocol fields (ADR-0009).
vi.mock('../api.js', () => ({ api: { event: vi.fn() } }));

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
