const express = require('express');
const jwt = require('jsonwebtoken');
const { get } = require('../db');

const router = express.Router();

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret-change-me';

/* Auth is OPTIONAL here — the chat box also appears on the public
   marketing page for visitors who haven't logged in yet. If a valid
   access token is present we attach req.user so the assistant can
   speak to the person by name and role; if not, it just treats them
   as a visitor. A bad/expired token is ignored rather than rejected. */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, ACCESS_TOKEN_SECRET); } catch { /* ignore, treat as visitor */ }
  }
  next();
}

function buildSystemPrompt(userInfo) {
  const auth = userInfo
    ? `The person is already logged in to Imvelaphi LMS as a ${userInfo.role}${userInfo.firstName ? ` named ${userInfo.firstName}` : ''}. Never tell them to log in or register — help them do the task inside the app instead. Point them to the right screen by name (e.g. "open your dashboard", "use Upload new content on the lecturer page", "check Programme overview").`
    : `The person is browsing the public site and is not logged in. If they want to learn, tell them to click "Get started" to register as a student. Lecturer and admin accounts are not self-registered — an Imvelaphi admin creates lecturer accounts, and lecturers log in with the credentials the admin gives them.`;

  return `You are the Imvelaphi LMS Assistant, a friendly in-app helper for Imvelaphi Technologies' learning platform.

${auth}

ABOUT THE PLATFORM:
- Imvelaphi Technologies teaches robotics, IoT, programming (Python, web development) and assistive/3D-printed prosthetics technology.
- Courses are made up of modules ("videos"). Each module has its own video and its own quiz — watching the video and passing its quiz marks that module complete.
- Students: register freely, are auto-enrolled in all courses, watch videos, take quizzes, and track progress on their dashboard.
- Lecturers: cannot self-register. An admin creates their account. Once created, they log in normally and can upload new videos (with an optional supporting document) plus write quiz questions for each video, and see every learner's progress and quiz scores for their courses.
- Admins: seeded directly in the database, never self-registered. They see every user and the full course catalogue, create new lecturer accounts, and assign which lecturer teaches which course.

STYLE:
- Plain conversational text. No Markdown, no asterisks, no headings, no bullet characters — write lists as normal sentences.
- Keep replies short: 2-4 short sentences unless the person clearly wants more detail.
- Warm and practical tone.

RULES:
- Never invent specific grades, scores, user names, or data you don't actually have.
- Stay in scope: this app, how to use it, and its subject areas. For anything else, say briefly that it's outside what you can help with here.`;
}

function fallbackReply(question, userInfo) {
  const q = (question || '').toLowerCase();
  const role = userInfo?.role;

  if (q.includes('quiz')) {
    if (role === 'lecturer') return "When you upload a video, add its quiz questions right there in the same form — type each question, its answer options, and mark the correct one. Students only see the quiz after watching that module's video.";
    return "Each video has its own quiz right underneath it. Watch the video, answer every question, then submit — your score and progress update straight away.";
  }
  if (q.includes('upload') || q.includes('video')) {
    if (role === 'lecturer') return 'Open Upload new content on your lecturer dashboard, pick the course, give the module a title, attach the video file (and a supporting doc if you like), add its quiz questions, then submit. It stays available to students from then on.';
    return 'Lecturers upload each module\'s video from their dashboard. Once it\'s uploaded it stays available to enrolled students permanently — you can rewatch any completed module any time.';
  }
  if (q.includes('lecturer') && (q.includes('add') || q.includes('create') || q.includes('new'))) {
    return 'Only an admin can add a lecturer. From Programme overview, use the Add lecturer form with their name, email and a starting password — they can log in with those details straight away.';
  }
  if (q.includes('register') || q.includes('sign up') || q.includes('account')) {
    if (role) return "You're already signed in, so there's nothing to register.";
    return 'Click "Get started" to register as a student — you\'ll be auto-enrolled in every course. Lecturer accounts are created by an admin, not self-registered.';
  }
  if (q.includes('progress') || q.includes('dashboard')) {
    return role === 'lecturer'
      ? 'Your dashboard shows every enrolled learner, how many videos they\'ve watched per course, and their average quiz score.'
      : 'Your dashboard shows overall progress, videos watched per course, and your average quiz score across everything you\'ve completed.';
  }
  return userInfo?.firstName
    ? `Hi ${userInfo.firstName}. I can help with courses, uploading or watching videos, quizzes, and how the ${role} side of Imvelaphi LMS works. What do you need?`
    : "I'm the Imvelaphi LMS Assistant. Ask me how courses, videos, quizzes or accounts work on this platform.";
}

router.post('/', optionalAuth, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success:false, message:'messages (array) is required.' });
  }

  let userInfo = null;
  if (req.user) {
    const u = await get('SELECT first_name, role FROM users WHERE id = ?', [req.user.id]);
    if (u) userInfo = { firstName: u.first_name, role: u.role };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const last = [...messages].reverse().find(m => m.role === 'user');
    return res.json({ success:true, reply: fallbackReply(last?.content, userInfo), provider:'fallback' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.CHAT_MODEL || 'claude-sonnet-4-6',
        max_tokens: 500,
        system: buildSystemPrompt(userInfo),
        messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }))
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[chat] Anthropic API error', response.status, text);
      const last = [...messages].reverse().find(m => m.role === 'user');
      return res.json({ success:true, reply: fallbackReply(last?.content, userInfo), provider:'fallback' });
    }

    const data = await response.json();
    const reply = data.content?.find(b => b.type === 'text')?.text || "I'm not sure how to answer that.";
    res.json({ success:true, reply, provider:'anthropic' });
  } catch (err) {
    console.error('[chat] request failed', err.message);
    const last = [...messages].reverse().find(m => m.role === 'user');
    res.json({ success:true, reply: fallbackReply(last?.content, userInfo), provider:'fallback' });
  }
});

module.exports = router;
