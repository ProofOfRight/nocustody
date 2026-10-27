// SPDX-License-Identifier: Apache-2.0
// Layer boundaries (docs/adr/0005, docs/adr/0013): domain <- application <- adapters <- app.
export default {
  forbidden: [
    {
      name: "domain-is-pure",
      comment: "domain: plain TypeScript, no I/O, no packages, no other layers",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { pathNot: "^src/domain/" },
    },
    {
      name: "application-depends-on-domain-only",
      comment: "application: use cases and ports; may import domain only",
      severity: "error",
      from: { path: "^src/application/" },
      to: { pathNot: "^src/(domain|application)/" },
    },
    {
      name: "adapters-not-on-app",
      comment: "adapters must not import the composition root",
      severity: "error",
      from: { path: "^src/adapters/" },
      to: { path: "^src/app/" },
    },
    {
      name: "tools-are-standalone",
      comment: "src/tools (the address canary): Node built-ins only, independent of the gateway it checks",
      severity: "error",
      from: { path: "^src/tools/" },
      to: { dependencyTypesNot: ["core"] },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-dev-deps-in-src",
      severity: "error",
      from: { path: "^src/", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["npm-dev"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(\\.test\\.ts|/test-fixtures\\.ts|/testing/.*)$" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: [".ts", ".js"] },
  },
};
