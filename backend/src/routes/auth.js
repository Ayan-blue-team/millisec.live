'use strict';
const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const { getDB }     = require('../config/database');
const { splunkLog } = require('../config/splunk');

const router = express.Router();

router.post('/', async (req, res) => {
  const { username, password, mfa_code } = req.body;
  const ip = req.ip;

  if (!username || !password) {
    return res.status(400).json({ message: 'İstifadəçi adı və şifrə tələb olunur.' });
  }

  try {
    const db = getDB();
    const result = await db.query(
      `SELECT id, username, email, password_hash, role, mfa_secret, mfa_enabled, created_at
       FROM users WHERE username = $1 OR email = $1`,
      [username.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      await bcrypt.compare(password, '$2a$10$dummyhashtopreventtimingattacks00000000000');
      splunkLog({ event: 'login_failed', reason: 'user_not_found', ip, username, status: 401 });
      return res.status(401).json({ message: 'İstifadəçi adı və ya şifrə yanlışdır.' });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      splunkLog({ event: 'login_failed', reason: 'wrong_password', ip, username, status: 401 });
      return res.status(401).json({ message: 'İstifadəçi adı və ya şifrə yanlışdır.' });
    }

    // MFA check
    const requireMFA = process.env.REQUIRE_MFA === 'true';
    if (requireMFA || user.mfa_enabled) {
      if (!mfa_code) {
        return res.status(401).json({ message: 'MFA kodu tələb olunur.', mfa_required: true });
      }
      const mfaValid = speakeasy.totp.verify({
        secret: user.mfa_secret,
        encoding: 'base32',
        token: mfa_code,
        window: 1
      });
      if (!mfaValid) {
        splunkLog({ event: 'login_failed', reason: 'mfa_invalid', ip, username, status: 401 });
        return res.status(401).json({ message: 'MFA kodu yanlışdır.' });
      }
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET || 'fallback_secret_change_me',
      { expiresIn: '8h', issuer: 'millisec.live', audience: 'millisec-api' }
    );

    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    splunkLog({ event: 'login_success', username: user.username, role: user.role, ip, status: 200 });

    return res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role, created_at: user.created_at }
    });

  } catch (err) {
    console.error('[login] DB error:', err.message);
    return res.status(500).json({ message: 'Server xətası.' });
  }
});

module.exports = router;
