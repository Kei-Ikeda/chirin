# Security policy

## Reporting a vulnerability

Report it privately through GitHub Security Advisories:
[**Report a vulnerability**](https://github.com/Kei-Ikeda/chirin/security/advisories/new).

Please do not open a public issue for something you believe is exploitable. The advisory form
keeps the report between us until there is a fix to release.

A report is easiest to act on when it says which version of chirin and of VS Code you saw it
on, and what an attacker gains — the threat model below is what defines "gains" here.

## Supported versions

The latest release only. A fix ships as a new version on the Marketplace and as a `.vsix` on
the matching GitHub release; earlier versions are not patched.

chirin is one person's side project. Reports are read and answered on a best-effort basis,
with no committed response time. The warranty disclaimer in [LICENSE](../LICENSE) applies as
it always has — this policy adds no warranty and no service level.

## Scope

The trust boundary, what is defended, and what is accepted rather than prevented are all in
the README's [threat model](../README.md#threat-model). A report lands best when it names the
row it breaks, or the vector that table is missing.

Two answers are settled by design rather than open questions:

- Running a command on a match will never be added, in any form. The reasoning is under
  [Contributing](../README.md#contributing)
- On Windows and Linux the extension activates but shows no notification. That is the
  documented platform limit, not a failure to report

## Verifying a release

Each GitHub release carries the `.vsix` and a `.sha256` of it. The checksum is published
alongside the artifact, so it detects a corrupted download rather than a compromised release.
