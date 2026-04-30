'use strict';
const express = require('express');
const { getDB } = require('../config/database');
const router = express.Router();

// GET /api/v1/profile
router.get('/profile', async (req, res) => {
  try {
    const db = getDB();
    const result = await db.query(
      'SELECT id, username, email, role, last_login, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'İstifadəçi tapılmadı.' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server xətası.' });
  }
});

module.exports = router;
