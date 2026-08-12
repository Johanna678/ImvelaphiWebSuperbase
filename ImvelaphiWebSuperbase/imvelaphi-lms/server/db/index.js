require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function uid(prefix) { return prefix + '_' + crypto.randomBytes(6).toString('hex'); }

const { DATABASE_URL } = process.env;

let pool;

/* The rest of the app (all route files) writes queries with MySQL-style
   '?' placeholders, e.g. run('... WHERE id = ?', [id]). Postgres needs
   numbered placeholders ($1, $2, ...) instead, so we translate here in
   one place rather than rewriting every query across the codebase. */
function toPgQuery(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/* ---------------- Connection ---------------- */
async function connect() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add your Supabase connection string as the DATABASE_URL environment variable.');
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Supabase requires SSL; rejectUnauthorized:false keeps this simple
    // without needing to bundle Supabase's CA certificate.
    ssl: { rejectUnauthorized: false }
  });
  // Fail fast with a clear error if the connection string/credentials are wrong,
  // instead of only discovering it on the first real query later.
  await pool.query('SELECT 1');
}

/* Small query helpers so the rest of the app reads like the sync API
   (get/all/run) most examples use — just with await in front. */
async function all(sql, params = []) { const res = await pool.query(toPgQuery(sql), params); return res.rows; }
async function get(sql, params = []) { const rows = await all(sql, params); return rows[0] || null; }
async function run(sql, params = []) { return pool.query(toPgQuery(sql), params); }

/* ---------------- Schema ---------------- */
async function createSchema() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    age INT NULL,
    gender VARCHAR(50) NULL,
    location VARCHAR(150) NULL,
    email VARCHAR(190) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('student','lecturer','admin')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS courses (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    tag VARCHAR(80) NULL,
    icon VARCHAR(80) NULL,
    description TEXT NULL,
    image_url VARCHAR(255) NULL,
    lecturer_id VARCHAR(64) NULL REFERENCES users(id)
  )`);
  // Column added after initial release — add it in place for databases
  // that were created before image_url existed, without touching
  // anything else in the table.
  await run(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS image_url VARCHAR(255) NULL`);

  await run(`CREATE TABLE IF NOT EXISTS videos (
    id VARCHAR(64) PRIMARY KEY,
    course_id VARCHAR(64) NOT NULL REFERENCES courses(id),
    title VARCHAR(200) NOT NULL,
    duration VARCHAR(20) NULL,
    video_url VARCHAR(255) NULL,   -- stays NULL ("space for video") until a lecturer uploads a file
    doc_url VARCHAR(255) NULL,
    order_index INT DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS quiz_questions (
    id VARCHAR(64) PRIMARY KEY,
    video_id VARCHAR(64) NOT NULL REFERENCES videos(id),
    question TEXT NOT NULL,
    options TEXT NOT NULL,        -- JSON array, stored as text
    answer_index INT NOT NULL,
    order_index INT DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS enrollments (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id),
    course_id VARCHAR(64) NOT NULL REFERENCES courses(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, course_id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS video_progress (
    id VARCHAR(64) PRIMARY KEY,
    enrollment_id VARCHAR(64) NOT NULL REFERENCES enrollments(id),
    video_id VARCHAR(64) NOT NULL REFERENCES videos(id),
    watched INT DEFAULT 0,
    quiz_score INT NULL,
    quiz_total INT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (enrollment_id, video_id)
  )`);
}

/* ---------------- Course catalogue ----------------
   Single source of truth for the 3 courses this LMS ships with.
   Used both by seed() (fresh database) and migrateCourses()
   (a database that already has different/old course rows —
   those get removed and these get inserted in their place). */
const COURSE_DEFS = [
  { id:'course_electronics', title:'Electronics', tag:'Hardware', icon:'fa-solid fa-microchip',
    image:'/images/course-electronics.jpg',
    description:'Learn the building blocks of electronics — circuits, components and how to safely wire and test them.',
    videos:[
      { title:'Circuits & components 101', duration:'9:10', quiz:[
        { q:'What does a resistor do in a circuit?', options:['Stores energy','Limits current flow','Generates light','Boosts voltage'], a:1 },
        { q:'What unit measures electrical current?', options:['Volt','Ohm','Watt','Ampere'], a:3 }
      ]},
      { title:'Breadboarding your first circuit', duration:'12:00', quiz:[
        { q:'Why use a breadboard when prototyping?', options:['It is permanent','It solders components','It lets you test without soldering','It generates power'], a:2 }
      ]}
    ]},
  { id:'course_robotics', title:'Robotics / IoT', tag:'Hardware', icon:'fa-solid fa-robot',
    image:'/images/course-robotics.jpg',
    description:'Wire, program and control smart devices — sensors, motors, microcontrollers and connected objects.',
    videos:[
      { title:'Intro to microcontrollers', duration:'9:40', quiz:[
        { q:'What does IoT stand for?', options:['Internet of Things','Input Output Terminal','Integrated Optic Tech','Internal Object Type'], a:0 },
        { q:'Which component reads real-world signals (light, motion)?', options:['Actuator','Sensor','Resistor','Capacitor'], a:1 }
      ]},
      { title:'Building a simple robotic arm', duration:'14:15', quiz:[
        { q:'What converts electrical signal into motion?', options:['Sensor','Actuator/Motor','Battery','Breadboard'], a:1 }
      ]}
    ]},
  { id:'course_innovation', title:'Innovation', tag:'Design', icon:'fa-solid fa-lightbulb',
    image:'/images/course-innovation.jpg',
    description:'How Imvelaphi turns ideas into working tech — from concept and prototyping to real builds like 3D-printed prosthetics.',
    videos:[
      { title:'From idea to prototype', duration:'11:20', quiz:[
        { q:'What is the main purpose of a prototype?', options:['To sell immediately','To test and refine an idea','To replace the final product','To skip design'], a:1 }
      ]},
      { title:'From design to 3D-printed limb', duration:'12:50', quiz:[
        { q:'What makes 3D-printed prosthetics more accessible?', options:['Higher cost','Custom, low-cost fabrication','Longer wait times','Heavier materials'], a:1 }
      ]}
    ]}
];

async function insertCourseFull(c, lecturerId) {
  await run(`INSERT INTO courses (id,title,tag,icon,description,image_url,lecturer_id) VALUES (?,?,?,?,?,?,?)`,
    [c.id, c.title, c.tag, c.icon, c.description, c.image, lecturerId]);
  for (let vi = 0; vi < c.videos.length; vi++) {
    const v = c.videos[vi];
    const videoId = `${c.id}_v${vi + 1}`;
    await run(`INSERT INTO videos (id,course_id,title,duration,video_url,doc_url,order_index) VALUES (?,?,?,?,NULL,NULL,?)`,
      [videoId, c.id, v.title, v.duration, vi]);
    for (let qi = 0; qi < v.quiz.length; qi++) {
      const q = v.quiz[qi];
      await run(`INSERT INTO quiz_questions (id,video_id,question,options,answer_index,order_index) VALUES (?,?,?,?,?,?)`,
        [uid('q'), videoId, q.q, JSON.stringify(q.options), q.a, qi]);
    }
  }
}

/* ---------------- Seed (only runs once, on an empty table) ---------------- */
async function seed() {
  const { n } = await get('SELECT COUNT(*)::int AS n FROM users');
  if (n > 0) return;

  const lecturerId = 'lect_mlamuleli';
  const adminId = 'admin_default';
  const pw = bcrypt.hashSync('demo1234', 10);

  await run(`INSERT INTO users (id,first_name,last_name,age,gender,location,email,password_hash,role) VALUES (?,?,?,?,?,?,?,?,?)`,
    [lecturerId, 'Mlamuleli', 'Moyo', 33, 'Male', 'Johannesburg, Gauteng', 'mlamuleli@imvelaphi.tech', pw, 'lecturer']);
  await run(`INSERT INTO users (id,first_name,last_name,age,gender,location,email,password_hash,role) VALUES (?,?,?,?,?,?,?,?,?)`,
    [adminId, 'Imvelaphi', 'Admin', 30, 'Prefer not to say', 'Johannesburg, Gauteng', 'admin@imvelaphi.tech', pw, 'admin']);

  for (const c of COURSE_DEFS) {
    await insertCourseFull(c, lecturerId);
  }
}

/* ---------------- Demo lecture videos ----------------
   The project ships with three real short clips of Imvelaphi's own
   robotics/prosthetics work. This wires them into specific video
   ("module") rows so the app has real playable content out of the
   box instead of every module showing "coming soon". Runs on every
   startup (not just first seed) and only ever fills in a NULL
   video_url, so it never overwrites something a lecturer uploaded
   through the UI. */
async function attachDemoVideos() {
  const demoMap = {
    course_robotics_v1: '/uploads/videos/demo_microcontrollers.mp4',
    course_robotics_v2: '/uploads/videos/demo_robotic_arm.mp4',
    course_innovation_v2: '/uploads/videos/demo_prosthetic_limb.mp4'
  };
  for (const [videoId, url] of Object.entries(demoMap)) {
    await run('UPDATE videos SET video_url = ? WHERE id = ? AND video_url IS NULL', [url, videoId]);
  }
}

/* ---------------- Migration: enforce the 3-course catalogue above.
   Handles a database that was already seeded with different/old
   course rows (e.g. a prior version's "Python Programming", "Web
   Development", "Biotech" courses) — anything not in COURSE_DEFS
   gets removed, and any of the 3 that's missing gets inserted.
   Also backfills course images if they were seeded before
   image_url existed. Safe to run on every startup. ---------------- */
async function migrateCourses() {
  const keepIds = COURSE_DEFS.map(c => c.id);
  const existing = await all('SELECT id FROM courses');

  for (const row of existing) {
    if (keepIds.includes(row.id)) continue;
    // Not one of ours — remove it and everything hanging off it.
    const videoIds = (await all('SELECT id FROM videos WHERE course_id = ?', [row.id])).map(v => v.id);
    for (const vId of videoIds) {
      await run('DELETE FROM quiz_questions WHERE video_id = ?', [vId]);
      await run('DELETE FROM video_progress WHERE video_id = ?', [vId]);
    }
    await run('DELETE FROM videos WHERE course_id = ?', [row.id]);
    await run('DELETE FROM enrollments WHERE course_id = ?', [row.id]);
    await run('DELETE FROM courses WHERE id = ?', [row.id]);
  }

  const lecturer = await get(`SELECT id FROM users WHERE role = 'lecturer' ORDER BY created_at ASC LIMIT 1`);
  const lecturerId = lecturer ? lecturer.id : null;

  for (const c of COURSE_DEFS) {
    const found = await get('SELECT id, image_url FROM courses WHERE id = ?', [c.id]);
    if (!found) {
      await insertCourseFull(c, lecturerId);
    } else if (!found.image_url) {
      await run('UPDATE courses SET image_url = ? WHERE id = ?', [c.image, c.id]);
    }
  }
}

async function initDb() {
  await connect();
  await createSchema();
  await seed();
  await migrateCourses();
  await attachDemoVideos();
}

module.exports = { initDb, all, get, run, uid };
