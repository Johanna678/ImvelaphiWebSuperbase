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
    lecturer_id VARCHAR(64) NULL REFERENCES users(id)
  )`);

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

  const courses = [
    { id:'course_python', title:'Python Programming', tag:'Coding', icon:'fa-brands fa-python',
      description:'Build real projects while learning core Python — from syntax to small automation scripts.',
      videos:[
        { title:'Python basics: variables & types', duration:'8:20', quiz:[
          { q:'Which keyword defines a function in Python?', options:['func','def','function','lambda'], a:1 },
          { q:'What data type is [1, 2, 3] in Python?', options:['Tuple','Dictionary','List','Set'], a:2 }
        ]},
        { title:'Loops and conditionals', duration:'11:05', quiz:[
          { q:'Which loop runs while a condition is true?', options:['for','while','repeat','until'], a:1 },
          { q:'What does "if / elif / else" control?', options:['Loop speed','Program flow','Memory use','File size'], a:1 }
        ]}
      ]},
    { id:'course_robotics', title:'Robotics & IoT', tag:'Hardware', icon:'fa-solid fa-robot',
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
    { id:'course_webdev', title:'Web Development', tag:'Coding', icon:'fa-solid fa-code',
      description:'Design and build websites and web apps from scratch using HTML, CSS and JavaScript.',
      videos:[
        { title:'HTML & CSS foundations', duration:'10:30', quiz:[
          { q:'What does CSS control on a webpage?', options:['Structure','Styling & layout','Server logic','Database'], a:1 },
          { q:'Which tag creates a hyperlink in HTML?', options:['<link>','<href>','<a>','<nav>'], a:2 }
        ]}
      ]},
    { id:'course_assistive', title:'Assistive Tech & 3D-Printed Prosthetics', tag:'Biotech', icon:'fa-solid fa-hand-back-fist',
      description:'How Imvelaphi merges robotics, biotech and 3D printing to design affordable, custom prosthetic limbs.',
      videos:[
        { title:'From design to 3D-printed limb', duration:'12:50', quiz:[
          { q:'What makes 3D-printed prosthetics more accessible?', options:['Higher cost','Custom, low-cost fabrication','Longer wait times','Heavier materials'], a:1 }
        ]}
      ]}
  ];

  for (const c of courses) {
    await run(`INSERT INTO courses (id,title,tag,icon,description,lecturer_id) VALUES (?,?,?,?,?,?)`,
      [c.id, c.title, c.tag, c.icon, c.description, lecturerId]);
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
    course_assistive_v1: '/uploads/videos/demo_prosthetic_limb.mp4'
  };
  for (const [videoId, url] of Object.entries(demoMap)) {
    await run('UPDATE videos SET video_url = ? WHERE id = ? AND video_url IS NULL', [url, videoId]);
  }
}

async function initDb() {
  await connect();
  await createSchema();
  await seed();
  await attachDemoVideos();
}

module.exports = { initDb, all, get, run, uid };
