'use strict';
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { splunkLog } = require('./config/splunk');

const app  = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: [
    'https://millisec.live',
    'https://www.millisec.live',
    'https://intranet.millisec.live',
    'http://localhost',
    'http://localhost:3000'
  ],
  credentials: true
}));

app.use(express.json({ limit: '10kb' }));
app.set('trust proxy', 1);

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: 'Çox sayda cəhd. 15 dəqiqə gözləyin.' },
  handler: (req, res, next, options) => {
    splunkLog({ event: 'login_rate_limit', ip: req.ip, username: req.body?.username });
    res.status(429).json(options.message);
  }
});

// Routes
app.use('/api/login', loginLimiter, require('./routes/auth'));
app.use('/api/v1',    require('./middleware/auth').verifyToken, require('./routes/profile'));
app.use('/api/v1',    require('./middleware/auth').verifyToken, require('./routes/users'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'millisec-api',
    version: '1.0.0'
  });
});

// Request logger
app.use((req, res, next) => {
  res.on('finish', () => {
    splunkLog({
      event:   'http_request',
      method:  req.method,
      path:    req.path,
      status:  res.statusCode,
      ip:      req.ip,
      raw:     `${req.ip} - - [${new Date().toUTCString()}] "${req.method} ${req.path} HTTP/1.1" ${res.statusCode}`
    });
  });
  next();
});

// 404
app.use((req, res) => res.status(404).json({ message: 'Tapılmadı.' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ message: 'Server xətası.' });
});

app.listen(PORT, () => console.log(`[Millisec API] Port ${PORT} üzərindən işləyir`));
