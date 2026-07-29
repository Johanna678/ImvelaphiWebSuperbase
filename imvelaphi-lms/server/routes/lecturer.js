const express = require('express');
const multer = require('multer');
const path = require('path');
const { get, all, run, uid } = require('../db');
const { authRequired, roleRequired } = require('../middleware/auth');
const { courseProgress } = require('./courses');

const router = express.Router();

/* Storage: videos and docs land in /uploads. This is the actual
   "space for video" reserved on disk — until a lecturer uploads
   here, videos.video_url stays NULL and the front end shows a
   placeholder instead of pretending there's real content. */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = file.fieldname === 'video' ? 'uploads/videos' : 'uploads/docs';
    cb(null, path.join(__dirname, '..', '..', dir));
  },
  filename: (req, file, cb) => cb(null, `${uid('file')}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video' && !file.mimetype.startsWith('video/')) return cb(new Error('Video field must be a video file.'));
    if (file.fieldname === 'doc' && !/pdf|word|officedocument/.test(file.mimetype)) return cb(new Error('Doc field must be a PDF or Word file.'));
    cb(null, true);
  }
});

router.use(authRequired, roleRequired('lecturer'));

/* Courses this lecturer teaches */
router.get('/courses', async (req, res) => {
  const courses = await all('SELECT * FROM courses WHERE lecturer_id = ?', [req.user.id]);
  res.json({ success:true, courses });
});

/* Add a new video ("module") — with its own video file, optional
   doc, and its own quiz questions — to a course. Each module gets
   its own distinct video and its own quiz, so different modules
   never share the same lecture content. `quiz` arrives as a JSON
   string: [{ question, options:[...], answerIndex }, ...] */
router.post('/courses/:courseId/videos', upload.fields([{ name:'video', maxCount:1 }, { name:'doc', maxCount:1 }]), async (req, res) => {
  const course = await get('SELECT * FROM courses WHERE id = ? AND lecturer_id = ?', [req.params.courseId, req.user.id]);
  if (!course) return res.status(404).json({ success:false, message:'Course not found for this lecturer.' });

  const { title, duration } = req.body;
  if (!title) return res.status(400).json({ success:false, message:'Video title is required.' });

  let quiz = [];
  if (req.body.quiz) {
    try { quiz = JSON.parse(req.body.quiz); } catch { quiz = []; }
    quiz = Array.isArray(quiz) ? quiz.filter(q => q && q.question && Array.isArray(q.options) && q.options.filter(o => o && o.trim()).length >= 2) : [];
  }

  const videoFile = req.files?.video?.[0];
  const docFile = req.files?.doc?.[0];
  const videoUrl = videoFile ? `/uploads/videos/${videoFile.filename}` : null;
  const docUrl = docFile ? `/uploads/docs/${docFile.filename}` : null;

  const { n: count } = await get('SELECT COUNT(*)::int AS n FROM videos WHERE course_id = ?', [course.id]);
  const videoId = uid('vid');
  await run(`INSERT INTO videos (id,course_id,title,duration,video_url,doc_url,order_index) VALUES (?,?,?,?,?,?,?)`,
    [videoId, course.id, title, duration || '—', videoUrl, docUrl, count]);

  for (let qi = 0; qi < quiz.length; qi++) {
    const q = quiz[qi];
    const options = q.options.filter(o => o && o.trim());
    const answerIndex = Math.min(Math.max(Number(q.answerIndex) || 0, 0), options.length - 1);
    await run(`INSERT INTO quiz_questions (id,video_id,question,options,answer_index,order_index) VALUES (?,?,?,?,?,?)`,
      [uid('q'), videoId, q.question, JSON.stringify(options), answerIndex, qi]);
  }

  res.json({ success:true, video: { id:videoId, title, duration: duration || '—', videoUrl, docUrl, quizCount: quiz.length } });
});

/* Learner performance across this lecturer's courses */
router.get('/performance', async (req, res) => {
  const courses = await all('SELECT * FROM courses WHERE lecturer_id = ?', [req.user.id]);
  const students = await all(`SELECT * FROM users WHERE role = 'student'`);

  const rows = [];
  for (const s of students) {
    for (const c of courses) {
      const enr = await get('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?', [s.id, c.id]);
      if (!enr) continue;
      const progress = await courseProgress(s.id, c.id);
      rows.push({ studentId: s.id, studentName: `${s.first_name} ${s.last_name}`, courseId: c.id, courseTitle: c.title, progress });
    }
  }

  res.json({ success:true, rows, courseCount: courses.length, studentCount: students.length });
});

module.exports = router;
