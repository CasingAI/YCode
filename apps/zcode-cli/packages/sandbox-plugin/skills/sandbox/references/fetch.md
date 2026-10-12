# Sandbox fetch

Global `fetch` on the live instance, like current Node and browsers. It talks to servers. It does not replace WebFetch.

WebFetch: one public page → readable text → a small model answers `prompt` (may ask for the domain).
Sandbox `fetch`: pagination, JSON, loops, keep the response on globals and keep computing. Never asks.

## How to call

```js
const response = await fetch("https://api.example.com/items");
const data = await response.json();
```

`Headers`, `Request`, `Response`, `AbortController`, and `AbortSignal` exist as globals. There is no `require("http")` / `require("https")`. Other `require(...)` ids still fail: no Node module loader.

Ask / Plan / Agent can all call `fetch`, including POST / PUT / PATCH / DELETE. Sandbox never asks the user.

## What works

- `fetch(url, { method, headers, body, signal, redirect })`
- `body`: string or `Uint8Array` (no `Buffer`, no Blob, no FormData)
- `response.ok` / `status` / `statusText` / `url` / `redirected` / `headers`
- `response.text()` / `response.json()` / `response.arrayBuffer()`
- Default redirect behavior follows like Node. `redirect: "manual"` returns the 3xx to you.
- No default timeout. Cancel with `AbortController`. A Sandbox tool timeout backgrounds the call; it does not abort JS or in-flight `fetch`.

Keep large payloads on globals and `return` a summary.

## Cookies and headers

There is no cookie jar. Each request sends only the headers you set. To reuse a token across Sandbox calls, store it on a global and send it again.

## Refused destinations

These fail with `code: "SANDBOX_FETCH_EGRESS"` (or unsupported protocol), not a mode error:

- not `http:` / `https:` (including `file:`)
- link-local addresses
- cloud instance metadata

localhost, loopback, and private LAN targets are allowed.

## Not in this handbook

No Blob, FormData, or streaming body. No Node `http` module. Do not invent those methods.
