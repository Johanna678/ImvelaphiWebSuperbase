const express = require('express');
const { get, all, run, uid } = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

async function courseProgress(userId, courseId) {
  const { n: total } = await get('SELECT COUNT(*)::int AS n FROM videos WHERE course_id = ?', [courseId]);
  const enr = await get('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?', [userId, courseId]);
  if (!enr) return { pct:0, watched:0, total, quizAvg:null };

  const rows = await all('SELECT watched, quiz_score, quiz_total FROM video_progress WHERE enrollment_id = ?', [enr.id]);
  const watched = rows.filter(r => r.watched).length;
  const scored = rows.filter(r => r.quiz_score != null && r.quiz_total);
  const quizAvg = scored.length
    ? Math.round(scored.reduce((a, r) => a + r.quiz_score / r.quiz_total, 0) / scored.length * 100)
    : null;
  return { pct: total ? Math.round(watched / total * 100) : 0, watched, total, quizAvg };
}

/* List all courses (catalogue) */
router.get('/', async (req, res) => {
  const courses = await all('SELECT * FROM courses');
  const withCounts = await Promise.all(courses.map(async c => ({
    id: c.id, title: c.title, tag: c.tag, icon: c.icon, description: c.description,
    videoCount: (await get('SELECT COUNT(*)::int AS n FROM videos WHERE course_id = ?', [c.id])).n
  })));
  res.json({ success:true, courses: withCounts });
});

/* Student dashboard: assigned courses + progress */
router.get('/me/dashboard', authRequired, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ success:false, message:'Students only.' });
  const enrolled = await all(`
    SELECT c.* FROM courses c
    JOIN enrollments e ON e.course_id = c.id
    WHERE e.user_id = ?
  `, [req.user.id]);
  const withProgress = await Promise.all(enrolled.map(async c => ({
    id:c.id, title:c.title, tag:c.tag, icon:c.icon, description:c.description,
    progress: await courseProgress(req.user.id, c.id)
  })));
  res.json({ success:true, courses: withProgress });
});

/* Course detail with videos + quiz (answers stripped for students) */
router.get('/:id', authRequired, async (req, res) => {
  const course = await get('SELECT * FROM courses WHERE id = ?', [req.params.id]);
  if (!course) return res.status(404).json({ success:false, message:'Course not found.' });

  const videos = await all('SELECT * FROM videos WHERE course_id = ? ORDER BY order_index', [course.id]);
  const enr = req.user.role === 'student'
    ? await get('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?', [req.user.id, course.id])
    : null;

  const videoPayload = await Promise.all(videos.map(async v => {
    const questions = await all('SELECT * FROM quiz_questions WHERE video_id = ? ORDER BY order_index', [v.id]);
    const progressRow = enr
      ? await get('SELECT * FROM video_progress WHERE enrollment_id = ? AND video_id = ?', [enr.id, v.id])
      : null;
    return {
      id: v.id, title: v.title, duration: v.duration,
      videoUrl: v.video_url || null,   // null = reserved space, front end shows "video coming soon"
      docUrl: v.doc_url || null,
      quiz: questions.map(q => ({
        id: q.id, question: q.question, options: JSON.parse(q.options),
        // never leak the answer index to a student ahead of submission
        answerIndex: req.user.role === 'student' ? undefined : q.answer_index
      })),
      progress: progressRow ? {
        watched: !!progressRow.watched, quizScore: progressRow.quiz_score, quizTotal: progressRow.quiz_total
      } : { watched:false, quizScore:null, quizTotal:null }
    };
  }));

  res.json({ success:true, course: { id:course.id, title:course.title, tag:course.tag, icon:course.icon, description:course.description, videos: videoPayload } });
});

/* Submit a quiz for a video — server grades it, never trusts client-side score */
router.post('/:courseId/videos/:videoId/quiz', authRequired, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ success:false, message:'Students only.' });
  const { answers } = req.body; // { questionId: selectedOptionIndex }
  const questions = await all('SELECT * FROM quiz_questions WHERE video_id = ?', [req.params.videoId]);
  if (!questions.length) return res.status(404).json({ success:false, message:'No quiz found for this video.' });

  let score = 0;
  const results = questions.map(q => {
    const selected = answers ? answers[q.id] : undefined;
    const correct = selected === q.answer_index;
    if (correct) score++;
    return { questionId: q.id, correct, correctIndex: q.answer_index, selected };
  });

  let enr = await get('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?', [req.user.id, req.params.courseId]);
  if (!enr) {
    const id = uid('enr');
    await run('INSERT INTO enrollments (id,user_id,course_id) VALUES (?,?,?)', [id, req.user.id, req.params.courseId]);
    enr = { id };
  }

  const existing = await get('SELECT id FROM video_progress WHERE enrollment_id = ? AND video_id = ?', [enr.id, req.params.videoId]);
  if (existing) {
    await run('UPDATE video_progress SET watched=1, quiz_score=?, quiz_total=? WHERE id=?', [score, questions.length, existing.id]);
  } else {
    await run('INSERT INTO video_progress (id,enrollment_id,video_id,watched,quiz_score,quiz_total) VALUES (?,?,?,1,?,?)',
      [uid('vp'), enr.id, req.params.videoId, score, questions.length]);
  }

  res.json({ success:true, score, total: questions.length, results });
});

/* Mark a video watched without a quiz result yet */
router.post('/:courseId/videos/:videoId/watched', authRequired, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ success:false, message:'Students only.' });
  let enr = await get('SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?', [req.user.id, req.params.courseId]);
  if (!enr) {
    const id = uid('enr');
    await run('INSERT INTO enrollments (id,user_id,course_id) VALUES (?,?,?)', [id, req.user.id, req.params.courseId]);
    enr = { id };
  }
  const existing = await get('SELECT id FROM video_progress WHERE enrollment_id = ? AND video_id = ?', [enr.id, req.params.videoId]);
  if (existing) await run('UPDATE video_progress SET watched=1 WHERE id=?', [existing.id]);
  else await run('INSERT INTO video_progress (id,enrollment_id,video_id,watched) VALUES (?,?,?,1)', [uid('vp'), enr.id, req.params.videoId]);
  res.json({ success:true });
});

module.exports = { router, courseProgress };
