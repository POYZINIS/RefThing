// RefThing sidecar stub.
// The sidecar exists for Node-only tooling (three.js headless GLB poster
// snapshots, puppeteer web-embed screenshots) that the Rust backend shells
// out to over HTTP. It is deferred until Phase 11, so every route returns
// 501. See docs/onboarding-new-item-type.md.

import { createServer } from 'node:http';

const PORT = 7272;

const server = createServer((_req, res) => {
  res.writeHead(501, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: 'not_implemented',
      detail:
        'Sidecar deferred until Phase 11 (3D poster snapshots, web-embed screenshots). See docs/onboarding-new-item-type.md.',
    }),
  );
});

server.listen(PORT, () => {
  console.log(`refthing-sidecar stub listening on http://localhost:${PORT}`);
});
