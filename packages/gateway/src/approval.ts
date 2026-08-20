import { EventEmitter } from 'node:events';
import type { Approval } from '@agentgate/protocol';
import type { AuditStorage } from './storage.js';

export type ApprovalEventName = 'created' | 'resolved' | 'expired';

export class ApprovalManager extends EventEmitter {
  private storage: AuditStorage;
  private cleanupInterval: NodeJS.Timeout;

  constructor(storage: AuditStorage) {
    super();
    this.storage = storage;
    // Expire stale approvals every 10 seconds
    this.cleanupInterval = setInterval(() => this.expireStale(), 10_000);
    this.cleanupInterval.unref();
  }

  create(opts: {
    event_id: string;
    ttl_seconds: number;
    proposed_action_display: string;
    policy_reason: string;
    scope: string;
  }): Approval {
    const expires_at = new Date(Date.now() + opts.ttl_seconds * 1000).toISOString();
    const approval = this.storage.insertApproval({
      event_id: opts.event_id,
      status: 'PENDING',
      expires_at,
      consumed: false,
      proposed_action_display: opts.proposed_action_display,
      policy_reason: opts.policy_reason,
      scope: opts.scope,
      resolved_at: null,
      resolved_by: null,
    });
    this.emit('created', approval);
    return approval;
  }

  /**
   * Approves a pending approval.
   * Single-use: once consumed, further calls are rejected.
   * Checks expiry before approving.
   */
  approve(approvalId: string): { ok: boolean; error?: string; approval?: Approval } {
    const approval = this.storage.getApproval(approvalId);
    if (!approval) return { ok: false, error: 'Approval not found.' };
    if (approval.status === 'EXPIRED') return { ok: false, error: 'Approval has expired.' };
    if (approval.status !== 'PENDING') return { ok: false, error: `Approval is already ${approval.status}.` };
    if (approval.consumed) return { ok: false, error: 'Approval has already been consumed.' };
    if (new Date(approval.expires_at) <= new Date()) {
      this.storage.resolveApproval(approvalId, 'EXPIRED');
      return { ok: false, error: 'Approval expired.' };
    }

    this.storage.resolveApproval(approvalId, 'APPROVED');
    const updated = this.storage.getApproval(approvalId)!;
    this.emit('resolved', updated);
    return { ok: true, approval: updated };
  }

  deny(approvalId: string): { ok: boolean; error?: string; approval?: Approval } {
    const approval = this.storage.getApproval(approvalId);
    if (!approval) return { ok: false, error: 'Approval not found.' };
    if (approval.status !== 'PENDING') return { ok: false, error: `Approval is already ${approval.status}.` };
    this.storage.resolveApproval(approvalId, 'DENIED');
    const updated = this.storage.getApproval(approvalId)!;
    this.emit('resolved', updated);
    return { ok: true, approval: updated };
  }

  listPending(): Approval[] {
    return this.storage.listPendingApprovals();
  }

  private expireStale(): void {
    const count = this.storage.expireStaleApprovals();
    if (count > 0) this.emit('expired', count);
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
