export default function Policies() {
  const policyExample = `version: 1

defaults:
  decision: deny

rules:
  - id: allow-project-reads
    description: Allow reading files inside the project root.
    agents: ["claude-code"]
    tools: ["read_file", "list_directory"]
    paths: ["\${PROJECT_ROOT}/**"]
    decision: allow

  - id: approve-file-writes
    description: Require approval before writing any file.
    tools: ["write_file", "create_directory"]
    decision: require_approval
    approval_ttl_seconds: 120

  - id: block-secret-exfiltration
    description: Block network calls that contain secrets.
    tools: ["network.*", "fetch", "http_request"]
    contains_secrets: true
    decision: deny`;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Policies</h1>
          <p className="page-subtitle">Active policy rules loaded by the gateway</p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Policy File</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>policies/agentgate.example.yml</span>
        </div>
        <div className="card-body">
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, padding: '8px 12px', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 6 }}>
            ℹ Policy editing is read-only in Milestone 1. Edit <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 3 }}>policies/agentgate.example.yml</code> directly and restart the gateway to apply changes.
          </div>
          <pre className="code-block">{policyExample}</pre>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Decision Reference</span>
        </div>
        <div className="card-body">
          <div className="flex flex-col gap-12">
            {[
              { decision: 'allow', desc: 'Execute immediately. Arguments are still redacted in audit record.' },
              { decision: 'deny', desc: 'Block execution. Audit event recorded. Error returned to agent.' },
              { decision: 'require_approval', desc: 'Pause and wait for human approval in the Approvals queue. Expires after TTL.' },
              { decision: 'allow_with_transform', desc: 'Redact specified argument fields before forwarding to downstream server.' },
            ].map(({ decision, desc }) => (
              <div key={decision} className="detail-row">
                <div className="detail-label">
                  <span className={`badge ${
                    decision === 'allow' ? 'allowed' :
                    decision === 'deny' ? 'denied' :
                    decision === 'require_approval' ? 'pending' : 'transform'
                  }`}>{decision}</span>
                </div>
                <div className="detail-value">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
