'use strict';
const express = require('express');
const { getDB } = require('../config/database');
const router = express.Router();

// GET /api/v1/users — admin only
router.get('/users', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Giriş qadağandır.' });
  }
  try {
    const db = getDB();
    const result = await db.query(
      'SELECT id, username, email, role, last_login, created_at FROM users ORDER BY id'
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ message: 'Server xətası.' });
  }
});

module.exports = router;
