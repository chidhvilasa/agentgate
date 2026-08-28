# @chidhvilasa/protocol

Shared TypeScript types for [AgentGate](https://github.com/chidhvilasa/agentgate): audit events, policy
decisions, agent identity, and the Control API contract. This package has no runtime dependencies of its own —
it is a pure type/interface library consumed by `@chidhvilasa/policy` and `@chidhvilasa/gateway`.

> **Public beta.** See the [main repository README](https://github.com/chidhvilasa/agentgate#readme) for
> AgentGate itself — the MCP security gateway this package's types describe. Installing `@chidhvilasa/protocol`
> directly is normally only useful if you are building your own tooling against AgentGate's audit/Control API
> data shapes.

```sh
npm install @chidhvilasa/protocol
```

```ts
import type { AuditEvent, Approval, PolicyDecision } from '@chidhvilasa/protocol';
```

Licensed under [Apache-2.0](./LICENSE).
