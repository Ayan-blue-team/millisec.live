'use strict';
const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token tələb olunur.' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET || 'fallback_secret_change_me', {
      issuer: 'millisec.live',
      audience: 'millisec-api'
    });
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token etibarsızdır.' });
  }
}

module.exports = { verifyToken };
