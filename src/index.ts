/**
 * The package's one export, which both OpenCode majors load. OpenCode 2
 * takes it as a plugin definition, its `id` and `setup`; OpenCode 1, finding
 * an object with an `id` and a `server` function, calls `server`. Each
 * passes over the other's half, so the same entry serves a person on either.
 */

import { server } from './v1.js';
import { setup } from './v2.js';

export default {
  id: 'telmoni.observability',
  setup,
  server,
};
