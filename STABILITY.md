# Stability Policy

StateCore's `/v1` HTTP API is **frozen**, and currently covers 21 operations
across 19 paths.

The freeze shipped in the `v1.1.0` release, but do not read a release tag as the
contract's version. The contract carries its own number — `info.version` in the
generated OpenAPI document — and that is the one that tells you how current a
spec you are holding. It is at **`1.5.0`** and moves on every additive change to
the surface. The rule and the full history are in
[docs/api.md](docs/api.md#versioning-the-contract).

## What "frozen" means

- **The `/v1` contract is additive-only.** New endpoints and new *optional*
  response fields may be added. Existing endpoints, request/response shapes,
  semantics, and the error model will not change or be removed within `/v1`.
- **Only patch-level fixes break this**, and only for bugs or security issues —
  never as a feature-driven contract change.
- A future incompatible contract becomes a new version namespace (e.g. `/v2`),
  never a silent change to `/v1`.

## What is explicitly NOT frozen

The **digest / drift algorithm** (how the State Layer summarizes events into
stable state, the merge/novelty/consistency heuristics) is an internal
implementation detail, **not** part of the `/v1` contract. It will keep
improving — driven by real usage data — via minor/patch releases. These
improvements may change the *content* of digests/state for the better while
keeping the `/v1` request/response contract unchanged.

This is the single intended surface of ongoing change: real-data-driven
improvements to the core algorithm that remain non-breaking to `/v1`.

## Versioning

Semantic versioning. Additive features → minor; bug/security/algorithm-quality
fixes → patch; an incompatible `/v1` change would require a major + a new API
version namespace.
