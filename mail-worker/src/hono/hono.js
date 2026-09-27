import { Hono } from 'hono';
import { TrieRouter } from 'hono/router/trie-router';
import result from '../model/result';
// Register the trie at module initialization instead of building/falling back
// between matchers on the first authenticated request.
const app = new Hono({ router: new TrieRouter() });

// The private application is same-origin. Do not install a wildcard CORS policy.
app.onError((err, c) => {
  if (err.name === 'BizError') {
    const status = Number.isInteger(err.code) && err.code >= 400 && err.code <= 599 ? err.code : 400;
    return c.json(result.fail(err.message, status), status);
  }
  // Never expose database queries, secrets, or private content from exception messages.
  console.error(JSON.stringify({ stage: 'api', code: 'INTERNAL_ERROR' }));
  return c.json(result.fail('SERVICE_UNAVAILABLE', 503), 503);
});

export default app;
