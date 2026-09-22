// In-memory stand-ins for Postgres (`pg`) and Upstash Redis so the real
// server can be exercised end-to-end without external services. Only the
// queries the app actually runs are implemented.
const crypto = require('crypto');

const state = {
  users: new Map(),      // id -> row
  convos: new Map(),     // id -> row
  tombstones: new Map(), // convId -> Map(messageId -> createdAt)
  settings: new Map()
};

function runSql(sql, params = []) {
  const q = sql.trim();

  if (q.includes('CREATE TABLE') || q.includes('ALTER TABLE') || q.includes('CREATE UNIQUE INDEX') || q.includes('CREATE INDEX')) return [];

  if (q.startsWith('INSERT INTO settings')) {
    state.settings.set(params[0], params[1]);
    return [];
  }

  if (q.startsWith('SELECT 1 FROM users WHERE email_lower')) return [];
  if (q.startsWith('SELECT 1 FROM users WHERE username_lower')) return [];
  if (q.startsWith('SELECT 1 FROM users WHERE phone_hash')) return [];

  if (q.startsWith('INSERT INTO users')) {
    const [id, username, usernameLower, email, emailLower, phone, phoneHash, salt, hash, gender, createdAt, displayName, birthDate, youtubeLink] = params;
    state.users.set(id, {
      id, username, username_lower: usernameLower, email, email_lower: emailLower,
      phone, phone_hash: phoneHash, salt, hash, gender, oauth_provider: null, oauth_id: null,
      created_at: createdAt, is_premium: 0, is_banned: 0, last_country: null,
      display_name: displayName, bio: null, photo: null, birth_date: birthDate,
      youtube_link: youtubeLink, last_lat: null, last_lon: null
    });
    return [];
  }

  if (q.startsWith('SELECT * FROM users WHERE id = $1')) {
    const u = state.users.get(params[0]);
    return u ? [u] : [];
  }

  if (q.startsWith('UPDATE users SET gender')) {
    const u = state.users.get(params[1]);
    if (u && u.gender === null) { u.gender = params[0]; return [{ id: u.id }]; }
    return [];
  }

  if (q.startsWith('UPDATE users SET last_country')) return [];
  if (q.startsWith('UPDATE users SET is_banned')) {
    const u = state.users.get(params[0]);
    if (u) u.is_banned = params[1];
    return [];
  }

  if (q.startsWith('SELECT blocked_id FROM blocks')) return [];
  if (q.startsWith('SELECT muted_user_id FROM muted_users')) return [];

  if (q.startsWith('SELECT * FROM conversations WHERE (user_a = $1 AND user_b = $2)')) {
    for (const c of state.convos.values()) {
      if ((c.user_a === params[0] && c.user_b === params[1]) || (c.user_a === params[1] && c.user_b === params[0])) return [c];
    }
    return [];
  }

  if (q.startsWith('INSERT INTO conversations')) {
    const [id, userA, userB, createdAt] = params;
    state.convos.set(id, {
      id, user_a: userA, user_b: userB, created_at: createdAt, last_message_at: null,
      disappearing_mode: 'none', unread_a: 0, unread_b: 0,
      last_message_type: null, last_message_sender: null
    });
    return [];
  }

  if (q.startsWith('SELECT * FROM conversations WHERE id = $1')) {
    const c = state.convos.get(params[0]);
    return c ? [c] : [];
  }

  if (q.startsWith('SELECT * FROM conversations WHERE user_a = $1 OR user_b = $1')) {
    return [...state.convos.values()].filter(c => c.user_a === params[0] || c.user_b === params[0]);
  }

  // noteConversationActivity
  if (q.startsWith('UPDATE conversations SET') && q.includes('last_message_type')) {
    const c = state.convos.get(params[0]);
    if (c) {
      c.last_message_type = params[1];
      c.last_message_sender = params[2];
      if (c.user_a !== params[2]) c.unread_a += 1;
      if (c.user_b !== params[2]) c.unread_b += 1;
      c.last_message_at = Date.now();
    }
    return [];
  }

  // clearUnread
  if (q.startsWith('UPDATE conversations SET') && q.includes('unread_a = CASE WHEN user_a =')) {
    const c = state.convos.get(params[0]);
    if (c) {
      if (c.user_a === params[1]) c.unread_a = 0;
      if (c.user_b === params[1]) c.unread_b = 0;
    }
    return [];
  }

  // flushTouches batch
  if (q.startsWith('UPDATE conversations SET last_message_at')) {
    const c = state.convos.get(params[1]);
    if (c) c.last_message_at = params[0];
    return [];
  }

  if (q.startsWith('BEGIN') || q.startsWith('COMMIT') || q.startsWith('ROLLBACK')) return [];

  if (q.startsWith('INSERT INTO message_tombstones')) {
    if (!state.tombstones.has(params[0])) state.tombstones.set(params[0], new Map());
    state.tombstones.get(params[0]).set(params[1], params[2]);
    return [];
  }

  if (q.startsWith('SELECT message_id FROM message_tombstones')) {
    const set = state.tombstones.get(params[0]);
    return set ? [...set.keys()].map(id => ({ message_id: id })) : [];
  }

  if (q.startsWith('DELETE FROM message_tombstones')) return [];
  if (q.startsWith('SELECT COUNT(*) AS cnt FROM messages')) return [{ cnt: 0 }];
  if (q.startsWith('SELECT * FROM messages')) return [];
  if (q.startsWith('DELETE FROM')) return [];

  return [];
}

const fakePg = {
  Pool: class FakePool {
    constructor() {}
    on() {}
    async query(sql, params) { return { rows: runSql(sql, params) }; }
    async connect() {
      return {
        query: async (sql, params) => ({ rows: runSql(sql, params) }),
        release: () => {}
      };
    }
  }
};

const fakeRedis = {
  Redis: class FakeRedis {
    constructor() {}
    async get() { return null; }
    async set() {}
    async del() {}
  }
};

module.exports = { fakePg, fakeRedis, state };
