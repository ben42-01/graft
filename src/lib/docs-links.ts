/**
 * Where the public documentation site lives (the sibling `graft-doc` repo,
 * published on GitHub Pages). Overridable at build time so QA and production
 * can point at their own copy once docs have a domain of their own.
 */
const base = (process.env.NEXT_PUBLIC_DOCS_URL ?? "https://ben42-01.github.io/graft-doc").replace(
  /\/+$/,
  "",
);

export const DOCS_URL = `${base}/`;
export const DEVELOPER_DOCS_URL = `${base}/developers/overview/`;
