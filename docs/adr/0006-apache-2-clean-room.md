# 0006. Apache-2.0 license, clean-room implementation

- Status: accepted, amended by [0023](0023-mpl-for-dev-dependencies.md)
- Date: 2026-10-26

## Context

Need an explicit patent grant, contribution terms without a CLA, protection of the project name from fake forks, GPL-3.0 compatibility and no barrier for corporate users.

## Decision

License under Apache-2.0. `LICENSE` and `NOTICE` at the root, `SPDX-License-Identifier: Apache-2.0` header in sources, DCO (`Signed-off-by`) checked in CI. Dependencies only under compatible licenses (MIT/BSD/ISC/Apache); GPL/AGPL/LGPL dependencies are forbidden and checked in CI. Code from GPL projects (BEpusdt, epusdt, Bicycle, Spice harvester, SHKeeper) is not copied or used as a template.

## Consequences

License check and DCO check are part of CI.
