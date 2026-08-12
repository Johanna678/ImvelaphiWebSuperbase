const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret-change-me';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'dev-refresh-secret-change-me';
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '30m';
const REFRESH_TOKEN_TTL = process.env.REFRESH_TOKEN_TTL || '7d';

function signAccessToken(payload) { return jwt.sign(payload, ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_TTL }); }
function signRefreshToken(payload) { return jwt.sign(payload, REFRESH_TOKEN_SECRET, { expiresIn: REFRESH_TOKEN_TTL }); }
function verifyRefreshToken(token) { return jwt.verify(token, REFRESH_TOKEN_SECRET); }

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success:false, message:'Not authenticated.' });
  try {
    req.user = jwt.verify(token, ACCESS_TOKEN_SECRET);
    next();
  } catch {
    return res.status(401).json({ success:false, message:'Session expired, please log in again.' });
  }
}

function roleRequired(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success:false, message:'You do not have access to this resource.' });
    }
    next();
  };
}

module.exports = { authRequired, roleRequired, signAccessToken, signRefreshToken, verifyRefreshToken };
