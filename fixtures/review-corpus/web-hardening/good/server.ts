// GOOD fixture: the malformed-cookie defect is fixed.
//   1. decodeURIComponent is wrapped in try/catch → malformed input degrades
//      gracefully to a 400 instead of throwing.
//   2. Bun.serve has an explicit `error` handler → even an unexpected throw
//      returns a generic 500 with NO source/stack/overlay leak.
//
// A review probe against this server should find NO high-severity error-path
// or source-leak issue.

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const cookie = req.headers.get('cookie') ?? '';
    let sid: string;
    try {
      sid = decodeURIComponent(cookie);
    } catch {
      // malformed percent-encoding → controlled 400, no throw, no leak.
      return new Response('bad request', {
        status: 400,
        headers: { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff' },
      });
    }
    return new Response(`session: ${sid}`, {
      headers: { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff' },
    });
  },
  error() {
    // explicit handler: generic message only, never leak source/stack/paths.
    return new Response('internal error', {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
  },
});

console.log(JSON.stringify({ port: server.port }));
