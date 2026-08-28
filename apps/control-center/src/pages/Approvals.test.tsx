import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Approvals from './Approvals.js';
import { api } from '../api.js';

// Only the Context Guard (ADR-0013) binding fields added to this page this
// milestone are covered here in depth — the pre-existing approve/deny flow
// this page already had is unchanged and untested before this milestone.
vi.mock('../api.js', () => ({
  api: {
    approvals: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
  },
}));

function baseApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'appr-1',
    event_id: 'evt-1',
    status: 'PENDING',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed: false,
    proposed_action_display: 'send_webhook({ url: "https://example.invalid" })',
    policy_reason: 'External communication requires approval.',
    scope: 'send_webhook',
    created_at: new Date().toISOString(),
    resolved_at: null,
    resolved_by: null,
    context_id: null,
    context_revision: null,
    tool_fingerprint: null,
    argument_digest: null,
    contextual_rule_id: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Approvals />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Approvals — Context Guard binding display (ADR-0013)', () => {
  it('renders no context section for a non-contextual (null-bound) approval', async () => {
    vi.mocked(api.approvals).mockResolvedValue([baseApproval()]);
    renderPage();
    await screen.findByText('send_webhook');
    expect(screen.queryByText('Context:')).not.toBeInTheDocument();
  });

  it('renders the context id, revision, rule, and exact fingerprint prefix for a contextual approval', async () => {
    vi.mocked(api.approvals).mockResolvedValue([
      baseApproval({
        context_id: 'ctx-aaaa1111bbbb2222',
        context_revision: 3,
        contextual_rule_id: 'deny-external-after-risk',
        tool_fingerprint: 'exact-fp-1234567890abcdef',
      }),
    ]);
    renderPage();
    await screen.findByText('send_webhook');
    expect(screen.getByText(/ctx-aaaa…/)).toBeInTheDocument();
    expect(screen.getByText(/rev 3/)).toBeInTheDocument();
    expect(screen.getByText('deny-external-after-risk')).toBeInTheDocument();
    expect(screen.getByText('exact-fp-123…')).toBeInTheDocument();
  });

  it('links the context id to the Context Guard page with the exact context id', async () => {
    vi.mocked(api.approvals).mockResolvedValue([
      baseApproval({ context_id: 'ctx-aaaa1111bbbb2222', context_revision: 1 }),
    ]);
    renderPage();
    await screen.findByText('send_webhook');
    const link = screen.getByRole('link', { name: /ctx-aaaa…/ });
    expect(link).toHaveAttribute('href', '/context-guard?context=ctx-aaaa1111bbbb2222');
  });

  it('omits the rule/fingerprint rows when only context_id/revision are bound (base-policy approval)', async () => {
    vi.mocked(api.approvals).mockResolvedValue([
      baseApproval({ context_id: 'ctx-aaaa1111bbbb2222', context_revision: 0, contextual_rule_id: 'base-policy', tool_fingerprint: null }),
    ]);
    renderPage();
    await screen.findByText('send_webhook');
    expect(screen.getByText('base-policy')).toBeInTheDocument();
    expect(screen.queryByText(/Tool fingerprint/)).not.toBeInTheDocument();
  });

  it('never renders a raw secret-shaped tool_fingerprint value in full', async () => {
    vi.mocked(api.approvals).mockResolvedValue([
      baseApproval({ context_id: 'ctx-1', context_revision: 0, tool_fingerprint: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' }),
    ]);
    renderPage();
    await screen.findByText('send_webhook');
    expect(document.body.textContent).not.toContain('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  });
});
