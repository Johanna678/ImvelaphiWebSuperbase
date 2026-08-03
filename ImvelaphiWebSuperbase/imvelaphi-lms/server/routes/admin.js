const express = require('express');
const bcrypt = require('bcryptjs');
const { get, all, run, uid } = require('../db');
const { authRequired, roleRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, roleRequired('admin'));

/* ---------------- Lecturer accounts ----------------
   This is the ONLY way a lecturer account gets created — lecturers
   cannot self-register (see server/routes/auth.js). An admin sets
   the lecturer's email and an initial password here; the lecturer
   then logs in with those credentials through the normal
   POST /api/auth/login endpoint, exactly like any other user. */
router.post('/lecturers', async (req, res) => {
  const { firstName, lastName, email, password, location } = req.body;
  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ success:false, message:'First name, last name, email and password are required.' });
  }
  if (password.length < 4) {
    return res.status(400).json({ success:false, message:'Password must be at least 4 characters.' });
  }
  const existing = await get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existing) return res.status(409).json({ success:false, message:'An account with that email already exists.' });

  const id = uid('lect');
  const hash = bcrypt.hashSync(password, 10);
  await run(
    `INSERT INTO users (id,first_name,last_name,age,gender,location,email,password_hash,role) VALUES (?,?,?,?,?,?,?,?,'lecturer')`,
    [id, firstName, lastName, null, null, location || null, email.toLowerCase(), hash]
  );

  res.json({ success:true, lecturer: { id, firstName, lastName, email: email.toLowerCase() } });
});

router.get('/lecturers', async (req, res) => {
  const lecturers = await all(`SELECT id, first_name, last_name, email FROM users WHERE role = 'lecturer' ORDER BY first_name`);
  res.json({ success:true, lecturers: lecturers.map(l => ({ id:l.id, firstName:l.first_name, lastName:l.last_name, email:l.email })) });
});

/* Assign (or reassign) which lecturer teaches a course — this is
   what makes different modules/courses belong to different
   lecturers, each with their own uploaded videos and quizzes. */
router.patch('/courses/:id/lecturer', async (req, res) => {
  const { lecturerId } = req.body;
  const course = await get('SELECT * FROM courses WHERE id = ?', [req.params.id]);
  if (!course) return res.status(404).json({ success:false, message:'Course not found.' });
  const lecturer = await get(`SELECT id FROM users WHERE id = ? AND role = 'lecturer'`, [lecturerId]);
  if (!lecturer) return res.status(400).json({ success:false, message:'Lecturer not found.' });

  await run('UPDATE courses SET lecturer_id = ? WHERE id = ?', [lecturerId, course.id]);
  res.json({ success:true });
});

router.get('/users', async (req, res) => {
  const users = await all('SELECT id,first_name,last_name,age,gender,location,email,role FROM users');
  res.json({ success:true, users: users.map(u => ({
    id:u.id, firstName:u.first_name, lastName:u.last_name, age:u.age, gender:u.gender, location:u.location, email:u.email, role:u.role
  }))});
});

router.get('/courses', async (req, res) => {
  const courses = await all('SELECT * FROM courses');
  const payload = await Promise.all(courses.map(async c => {
    const lecturer = c.lecturer_id ? await get('SELECT first_name, last_name FROM users WHERE id = ?', [c.lecturer_id]) : null;
    const { n: videoCount } = await get('SELECT COUNT(*)::int AS n FROM videos WHERE course_id = ?', [c.id]);
    return { id:c.id, title:c.title, tag:c.tag, videoCount, lecturerId: c.lecturer_id, lecturerName: lecturer ? `${lecturer.first_name} ${lecturer.last_name}` : '—' };
  }));
  res.json({ success:true, courses: payload });
});

router.get('/stats', async (req, res) => {
  const total = (await get('SELECT COUNT(*)::int AS n FROM users')).n;
  const students = (await get(`SELECT COUNT(*)::int AS n FROM users WHERE role='student'`)).n;
  const lecturers = (await get(`SELECT COUNT(*)::int AS n FROM users WHERE role='lecturer'`)).n;
  const courses = (await get('SELECT COUNT(*)::int AS n FROM courses')).n;
  res.json({ success:true, stats: { total, students, lecturers, courses } });
});

module.exports = router;
