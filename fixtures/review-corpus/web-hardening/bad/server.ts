// BAD fixture: malformed-cookie → unhandled throw, no error handler.
// Seeded defect: decodeURIComponent on a request cookie with NO try/catch and
// Bun.serve with NO `error` handler. A malformed percent-encoding (e.g. %ZZ)
// makes decodeURIComponent throw a URIError; with no error handler Bun returns
// a 500 whose body can leak the dev error overlay / source / stack.
//
// Expected review finding: dimension web-hardening / error-path, severity high.

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const cookie = req.headers.get('cookie') ?? '';
    // unhandled: a malformed percent-encoding throws URIError here.
    const sid = decodeURIComponent(cookie);
    return new Response(`session: ${sid}`, {
      headers: { 'content-type': 'text/plain' },
    });
  },
  // NOTE: no `error(err) { ... }` handler — malformed input crashes the request
  // and Bun's default error response can expose internals in development.
});

// Allow running standalone for probing: print the chosen port to stdout.
console.log(JSON.stringify({ port: server.port }));
