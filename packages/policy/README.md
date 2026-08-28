# @agentgate/policy

The policy schema, first-match evaluation engine, path normalization, and secret detection/redaction used by
[AgentGate](https://github.com/chidhvilasa/agentgate)'s gateway. Depends only on `@agentgate/protocol` and a
small set of pure utility libraries — no network, filesystem side effects beyond reading a config file you pass
in, or downstream tool execution.

> **Public beta.** See the [main repository README](https://github.com/chidhvilasa/agentgate#readme) and
> [`docs/POLICY_REFERENCE.md`](https://github.com/chidhvilasa/agentgate/blob/main/docs/POLICY_REFERENCE.md) for
> the full policy language. Installing `@agentgate/policy` directly is normally only useful if you are building
> your own tooling that needs to load or evaluate an AgentGate policy file outside the gateway itself.

```sh
npm install @agentgate/policy
```

```ts
import { loadPolicyFile, evaluate } from '@agentgate/policy';
```

Licensed under [Apache-2.0](./LICENSE).
