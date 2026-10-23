/** One definition for both majors: OpenCode 1 calls `server`, OpenCode 2 `setup`, which OpenCode 1.19 calls too. */

import { server } from './v1.js';
import { setup } from './v2.js';

export default {
  id: 'telmoni.observability',
  setup,
  server,
};
