# Security Policy

Do not post credentials, raw tool output, local savings stores, or vulnerability
details in public issues, logs, screenshots, or workflow artifacts.

## Reporting

GitHub private vulnerability reporting was verified **disabled** on 2026-09-14.
The maintainer must enable it before broader source publication. This policy does
not activate a private reporting channel or promise a response time.

Until a private channel is enabled, open a
[contact request](https://github.com/Vmoosky/SlipStream/issues/new) addressed to
[@Vmoosky](https://github.com/Vmoosky), containing only a request for a confidential
security contact. Do not include the vulnerability or any sensitive evidence.
Once GitHub private reporting is enabled, use the repository's Security tab to
report the affected revision, reproduction steps, and impact privately.

## Validation Boundaries

The prepared workflows use redacted Gitleaks scans, JavaScript/TypeScript CodeQL,
and dependency review. They are not enforcement evidence until published and
verified on GitHub. Missing permissions or unavailable checks are blockers, not
successful results. No stable-release support schedule is currently promised;
include the exact affected revision in a report.

Artifacts and ledgers can contain sensitive tool output. Keep them local, respect
workspace trust and user approvals, and never upload them for debugging by
default. See the [implementation boundaries](README.md#security) and
[contribution gates](CONTRIBUTING.md).