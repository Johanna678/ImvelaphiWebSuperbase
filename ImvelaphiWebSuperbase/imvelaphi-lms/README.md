# Imvelaphi Technologies — LMS (MySQL edition)

A learning-management webapp for Imvelaphi Technologies: students work
through courses (video → quiz → progress), lecturers upload content and
track learner performance, and admins get a programme-wide overview.

## Stack

- **Backend:** Node.js + Express
- **Database:** MySQL (via `mysql2`) — schema and demo data are created
  automatically the first time you run the server.
- **Auth:** JWT access + refresh tokens (`jsonwebtoken`), password
  hashing (`bcryptjs`)
- **File uploads:** `multer`, saved to `/uploads/videos` and `/uploads/docs`
- **Frontend:** plain HTML/CSS/JS calling the API with `fetch` — no
  build step required.

## What was fixed from the previous zip

1. **`.env` was inside `public/`**, which Express serves to any visitor
   — anyone who guessed the URL could have downloaded your DB password
   and JWT secrets. It's now at the project root, which is never
   served. **Rotate the MySQL password and both JWT secrets** — the
   old ones were sitting in a publicly-servable folder and were shared
   in a zip, so treat them as compromised even though this repo now
   points somewhere safer.
2. A stray folder literally named `{server,server/routes,...}` was
   left over from a `mkdir -p project/{a,b,c}` command run in a shell
   that doesn't expand braces (common outside bash, e.g. plain `sh` or
   some Windows terminals). Deleted.
3. `mysql2` and `dotenv` were installed and `.env` was configured, but
   nothing in the code actually used them — `server/db/index.js` and
   every route were still the SQLite version. They're now rewritten to
   run on MySQL, using the exact variable names already in your `.env`
   (`DB_HOST`, `DB_NAME`, `ACCESS_TOKEN_SECRET`, etc.), including an
   access+refresh token pair since your `.env` had both TTLs defined.

## Steps to connect it to your database

1. **Install MySQL (or MariaDB, which is fully compatible)** if you
   don't have a server running yet:
   - macOS: `brew install mysql && brew services start mysql`
   - Ubuntu/Debian: `sudo apt install mysql-server && sudo systemctl start mysql`
   - Windows: install MySQL Community Server from mysql.com, or use
     XAMPP/WAMP which bundles it.

2. **Copy `.env.example` to `.env`** and fill in your real values:
   ```bash
   cp .env.example .env
   ```
   Set `DB_USER` / `DB_PASSWORD` to a MySQL user that can create
   databases (root is fine for local dev). Set `ACCESS_TOKEN_SECRET`
   and `REFRESH_TOKEN_SECRET` to two different long random strings —
   `openssl rand -hex 32` is a quick way to generate one.

3. **Install dependencies and start the server:**
   ```bash
   npm install
   npm start
   ```
   On first run, the app connects to MySQL, runs
   `CREATE DATABASE IF NOT EXISTS <DB_NAME>`, creates all the tables,
   and seeds a demo lecturer, admin, and four courses. You don't need
   to run any SQL by hand.

4. Open **http://localhost:3000**.

If it can't connect, the error will usually tell you which part is
wrong: `ECONNREFUSED` means MySQL isn't running or the host/port in
`.env` is wrong; `ER_ACCESS_DENIED_ERROR` means the user/password is
wrong; `ER_BAD_DB_ERROR` shouldn't happen since the app creates the DB
itself, but if your MySQL user lacks `CREATE` privileges you'll need
to create `imvelaphi_lms` (or your `DB_NAME`) manually first.

## Demo logins (seeded automatically)

| Role     | Email                        | Password   |
|----------|-------------------------------|-----------|
| Lecturer | mlamuleli@imvelaphi.tech      | demo1234  |
| Admin    | admin@imvelaphi.tech          | demo1234  |

Register a new account to try the student side — new students are
automatically assigned all four courses.

## Roles & who can create them

- **Student** — anyone can self-register from the "Get started" button.
  That's the *only* role the public register form can create; even if
  someone edits the request and sends `"role":"admin"`, the server
  ignores it and creates a student anyway (`server/routes/auth.js`).
- **Lecturer** — cannot self-register at all. An admin creates the
  account from **Programme overview → Add a lecturer** (name, email,
  starting password). The lecturer then logs in immediately with
  those credentials through the normal login form — no separate
  "activation" step.
- **Admin** — never self-registered; the one seeded above is created
  directly in the database on first run.

Admins can also reassign which lecturer teaches a course from the
dropdown in the **Course catalogue** table on the admin page.

## Videos, modules & quizzes

Each course is a sequence of **modules** (the `videos` table) — every
module has its own video file and its own quiz, so no two modules
ever share the same lecture content. When a lecturer uploads a new
module (**Upload new content**), they now also write that module's
quiz right there in the same form: add a question, add its answer
options, mark the correct one, repeat. The quiz is graded server-side
and never trusts the browser.

Three real short clips of Imvelaphi's own robotics/prosthetics work
ship with the repo and are wired into specific modules automatically
on first run (`server/db/index.js` → `attachDemoVideos`), so the app
has real playable content immediately instead of every module reading
"coming soon". This never overwrites a video a lecturer has actually
uploaded.

## "Space for video"

Every course video has a `video_url` column that starts out `NULL`.
Until a lecturer uploads an actual file (or the demo clips above fill
it in), the student-facing course page shows a reserved placeholder —
"VIDEO COMING SOON" — instead of a fake or stock video. Once
uploaded, the file is saved to `/uploads/videos/` and streams from
there **permanently** — it isn't tied to the upload session, so
students can watch it any time after that, indefinitely. Same idea
for `doc_url`.

## AI chat box

A floating chat bubble (bottom-right) is on every page — landing,
student dashboard, course/video page, lecturer dashboard, and admin
overview. It's role-aware: it knows whether it's talking to a
visitor, a student, a lecturer, or an admin, and answers accordingly
(`server/routes/chat.js`, mounted at `POST /api/chat`).

- With `ANTHROPIC_API_KEY` set in `.env`, it calls the Anthropic API
  (model configurable via `CHAT_MODEL`, defaults to `claude-sonnet-4-6`).
- Without a key, it still works using built-in canned answers about
  registering, uploading, quizzes, and adding lecturers — so the app
  is fully usable out of the box, and you can add a real key later
  without changing any frontend code.

## Project structure

```
server/
  index.js              Express app entry point — connects to MySQL, then listens
  db/index.js             MySQL connection, schema, seed data, demo-video wiring
  middleware/auth.js       access/refresh JWT verification, role guard
  routes/
    auth.js                 register (students only) / login / refresh / me
    courses.js               course listing, detail, quiz submission (server-graded)
    lecturer.js               lecturer's courses, content + quiz upload, learner performance
    admin.js                   users, courses, stats, create lecturer, reassign course lecturer
    chat.js                    AI chat widget backend
public/
  index.html              marketing home + login/register modal (student-only register)
  dashboard.html            student dashboard
  course.html                video + quiz page
  lecturer.html               upload content + quiz builder + performance table
  admin.html                   programme overview + add lecturer + reassign courses
  css/style.css
  js/app.js                API client + reusable AI chat widget (fetch wrapper, tokens in localStorage)
uploads/
  videos/  docs/          uploaded files land here (includes 3 seeded demo clips)
.env                     your real config — never commit this
.env.example             template to copy from
```

## Notes for extending this

- Access tokens expire after `ACCESS_TOKEN_TTL` (30 min by default);
  the frontend automatically exchanges the refresh token for a new one
  when it gets a 401, so users aren't logged out mid-session.
- Uploaded videos are served as static files under `/uploads`; swap
  that for S3/cloud storage by changing `multer`'s storage engine in
  `server/routes/lecturer.js` and pointing `video_url` at the returned
  cloud URL instead of a local path.
- Requires **Node 18+** (the chat route uses the built-in `fetch`).
- A course only has one lecturer at a time (`courses.lecturer_id`).
  If you need co-teaching later, that'd mean a join table between
  courses and lecturers instead of the single foreign key.
