module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "contracts-are-leaves",
      severity: "error",
      from: { path: "^contracts/" },
      to: { path: "^(?!contracts/|node_modules/)" },
    },
    {
      name: "shared-does-not-depend-up",
      severity: "error",
      from: { path: "^shared/" },
      to: { path: "^(src|app|components|context|features)/" },
    },
    {
      name: "feature-domain-does-not-render",
      severity: "error",
      from: {
        path: "^features/[^/]+/(model|store|transport)/",
        pathNot: "^features/settings/store/SettingsStore\\.tsx$",
      },
      to: { path: "^(src|app|components|context)/" },
    },
    {
      name: "lib-does-not-depend-on-ui",
      severity: "error",
      from: { path: "^lib/" },
      to: { path: "^(src|app|components|context)/" },
    },
    {
      name: "no-route-page-imports",
      severity: "error",
      from: { pathNot: "^src/" },
      to: { path: "/page\\.(?:ts|tsx)$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)node_modules/|(^|/)\\.next/|(^|/)dist/",
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
    reporterOptions: {
      dot: { collapsePattern: "node_modules/[^/]+" },
    },
  },
};
