# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, exposed credential,
private benchmark asset, or personal-data leak. Use GitHub's private security
reporting feature for this repository. If private reporting is unavailable,
contact a QVerisAI organization owner through a private channel.

Include the affected revision, reproduction steps, likely impact, and any
suggested mitigation. Do not include live credentials or unnecessary personal
data in the report.

## Supported versions

Security fixes are applied to the latest release and the default branch. Older
benchmark releases are immutable research artifacts unless a disclosure risk
requires removal or replacement.

## Benchmark-specific risks

Generated agent output and replay artifacts are untrusted. Review them before
publication and never execute recorded commands outside an isolated test
environment. Local run directories, provider payloads, credentials, private
holdouts, and reviewer identities must not be committed.
