import { receive } from './inbound/receive.js';

export default {
  email: receive,
  fetch() { return new Response('Not Found', { status: 404 }); },
};
