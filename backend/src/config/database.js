'use strict';
const { Pool } = require('pg');
let pool = null;

function getDB() {
  if (!pool) {
    pool = new Pool({
      host:     process.env.DB_HOST     || 'postgres',
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME     || 'millisec',
      user:     process.env.DB_USER     || 'millisec_user',
      password: process.env.DB_PASSWORD || 'changeme',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', err => console.error('[DB] Xəta:', err.message));
    pool.connect((err) => {
      if (err) console.error('[DB] Bağlantı xətası:', err.message);
      else console.log('[DB] PostgreSQL bağlantısı quruldu');
    });
  }
  return pool;
}

module.exports = { getDB };
