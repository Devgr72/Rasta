#!/usr/bin/env node
// node scripts/mock.js — start the server with mock vision, without spending tokens.
// Cross-platform replacement for `RASTA_MOCK_VISION=1 node server.js`.
process.env.RASTA_MOCK_VISION = '1';
require('../server').start();
