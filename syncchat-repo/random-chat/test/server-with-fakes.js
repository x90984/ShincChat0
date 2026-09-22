// Boots the REAL server (server/index.js) with pg + Upstash Redis swapped
// for the in-memory fakes — lets us integration-test matchmaking, the P2P
// fallback relay, content-free metadata and tombstones with zero external
// services. Run via: node test/server-with-fakes.js
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake:fake@localhost:5432/fake';
process.env.UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'fake-token';
process.env.PORT = process.env.PORT || '3999';

const Module = require('module');
const { fakePg, fakeRedis } = require('./fakes');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') return fakePg;
  if (request === '@upstash/redis') return fakeRedis;
  return originalLoad.apply(this, arguments);
};

require('../server/index.js');
