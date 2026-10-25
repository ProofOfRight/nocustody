# Security policy

nocustody handles payment verification. We take reports seriously.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the repository's Security tab).

Please include the affected version or commit, a description, reproduction steps and the impact you expect.

We aim to acknowledge reports within 3 working days and to agree on a disclosure timeline with the reporter.

## Scope

Of particular interest:

- crediting a payment that is not final, not successful, for a different asset or to a different address;
- double crediting, or a payment settling the wrong invoice;
- substitution of receiving addresses;
- webhook forgery or replay;
- secret leakage (API keys, webhook secrets) through logs, responses or errors;
- supply-chain issues in dependencies or the build.

Background: [docs/threat-model.md](docs/threat-model.md), [docs/security.md](docs/security.md).

## Supported versions

Before 0.1 only the `main` branch is supported.
