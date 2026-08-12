require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { initDb } = require('./db');
const authRoutes = require('./routes/auth');
const { router: courseRoutes } = require('./routes/courses');
const lecturerRoutes = require('./routes/lecturer');
const adminRoutes = require('./routes/admin');
const chatRoutes = require('./routes/chat');

// Ensure upload folders exist (this is the reserved "space for video")
['uploads/videos', 'uploads/docs'].forEach(dir => {
  const full = path.join(__dirname, '..', dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

async function main() {
  await initDb(); // connects to MySQL, creates the database/tables if missing, seeds demo data

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use('/api/auth', authRoutes);
  app.use('/api/courses', courseRoutes);
  app.use('/api/lecturer', lecturerRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/chat', chatRoutes);

  app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Imvelaphi LMS running on http://localhost:${PORT}`));
}

main().catch(err => {
  console.error('Failed to start server. code=%s message=%s', err && err.code, err && err.message);
  console.error(err && err.stack);
  process.exit(1);
});
