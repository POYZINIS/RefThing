# RefThing Sidecar

A small Node.js HTTP service that the Rust backend calls internally. It is
**never user-facing** and is not exposed outside localhost.

## Why it exists

Some future item types need rendering capabilities that are best done with
Node-only tooling rather than Rust:

- **3D poster snapshots** — headless three.js rendering of GLB models to a
  still image (poster) that the canvas can display like any other image.
- **Web-embed screenshots** — puppeteer capturing a thumbnail of an embedded
  web page.

These tools are mature, well-maintained, and cheap to run headless in Node.
Reimplementing them in Rust would be a large ongoing cost for a marginal
benefit.

## Why deferred

Neither feature is needed until **Phase 11** (rich item types: 3D models,
web embeds). Until then, this directory is a stub: `index.js` serves a tiny
HTTP server on port **7272** where every route returns `501 Not Implemented`
with a JSON body pointing at `docs/onboarding-new-item-type.md`.

## How it is called

The Rust backend will call the sidecar over HTTP on
`http://localhost:7272` when (and only when) a request needs one of these
Node-only renderings. The request/response contract will be defined in
Phase 11; until then, do not add real routes here.

## Running

```bash
npm run start -w sidecar   # from repo root
# or:
cd sidecar && npm start
```
