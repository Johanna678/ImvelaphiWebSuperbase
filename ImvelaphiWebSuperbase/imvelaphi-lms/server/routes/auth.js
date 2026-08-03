const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run, uid } = require('../db');
const { authRequired, signAccessToken, signRefreshToken, verifyRefreshToken } = require('../middleware/auth');

const router = express.Router();

function toPublicUser(row) {
  return {
    id: row.id, firstName: row.first_name, lastName: row.last_name,
    age: row.age, gender: row.gender, location: row.location,
    email: row.email, role: row.role
  };
}

function issueTokens(user) {
  const payload = { id: user.id, role: user.role };
  return { accessToken: signAccessToken(payload), refreshToken: signRefreshToken(payload) };
}

/* Public self-registration only ever creates STUDENT accounts.
   Lecturer and admin accounts are never self-registered — lecturers
   are created by an admin (see POST /api/admin/lecturers), and
   admins are seeded directly in the database. Even if a client
   sends a `role` field, it is ignored on purpose so nobody can grant
   themselves elevated access by editing the request body. */
router.post('/register', async (req, res) => {
  const { firstName, lastName, age, gender, location, email, password } = req.body;
  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ success:false, message:'Missing required fields.' });
  }
  const role = 'student';
  const existing = await get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existing) return res.status(409).json({ success:false, message:'An account with that email already exists.' });

  const id = uid('user');
  const hash = bcrypt.hashSync(password, 10);
  await run(
    `INSERT INTO users (id,first_name,last_name,age,gender,location,email,password_hash,role) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, firstName, lastName, age || null, gender || null, location || null, email.toLowerCase(), hash, role]
  );

  const courses = await require('../db').all('SELECT id FROM courses');
  for (const c of courses) {
    await run('INSERT INTO enrollments (id,user_id,course_id) VALUES (?,?,?)', [uid('enr'), id, c.id]);
  }

  const user = await get('SELECT * FROM users WHERE id = ?', [id]);
  const tokens = issueTokens(user);
  res.json({ success:true, ...tokens, user: toPublicUser(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await get('SELECT * FROM users WHERE email = ?', [(email || '').toLowerCase()]);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ success:false, message:'Incorrect email or password.' });
  }
  const tokens = issueTokens(user);
  res.json({ success:true, ...tokens, user: toPublicUser(user) });
});

/* Exchange a refresh token for a new access token, without asking the user to log in again */
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ success:false, message:'Missing refresh token.' });
  try {
    const payload = verifyRefreshToken(refreshToken);
    const user = await get('SELECT * FROM users WHERE id = ?', [payload.id]);
    if (!user) return res.status(401).json({ success:false, message:'Account no longer exists.' });
    const accessToken = signAccessToken({ id: user.id, role: user.role });
    res.json({ success:true, accessToken });
  } catch {
    res.status(401).json({ success:false, message:'Refresh token expired, please log in again.' });
  }
});

router.get('/me', authRequired, async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ success:false, message:'User not found.' });
  res.json({ success:true, user: toPublicUser(user) });
});

module.exports = router;
