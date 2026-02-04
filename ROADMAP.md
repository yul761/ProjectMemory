# Roadmap

## Near Term (0-2 months)

- Improve digest latency while keeping consistency pass >= 0.9.
- Add API + worker integration test coverage in CI.
- Add stronger auth option (JWT/API key gateway guidance for production).
- Publish first tagged release with changelog discipline.

## Mid Term (2-4 months)

- Add retrieval plugin interface for vector backends (optional, BYO).
- Add scoped RBAC for multi-team deployments.
- Add reminder delivery adapters beyond Telegram.
- Improve benchmark suite with scenario packs and deterministic fixtures.

## Long Term (4+ months)

- Memory graph primitives (entity + relation extraction as optional pipeline).
- Policy-driven retention and archival controls.
- Multi-region deployment playbook and disaster recovery templates.
- Ecosystem adapters (Slack/Discord/Notion) as reference integrations.

## Contribution Priorities

If you want to contribute today, start with:
1. Digest latency reduction without quality regressions.
2. Integration tests for reminders and digest rebuild.
3. Docs improvements for production deployment.
