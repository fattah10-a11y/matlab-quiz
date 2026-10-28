# MATLAB Quiz — CS01104

Timed practice quizzes for CS01104, published on GitHub Pages.

- **Sign-in** uses GitHub. Only accounts whose primary email is a Rowan address (`rowan.edu`, including `students.rowan.edu`) can sign up. Your own GitHub login is let in as the instructor.
- **Every quiz** is 20 questions in 30 minutes and covers all 12 topics, drawn from the week 1–7 lectures and Assignment 3. Questions and answer order are shuffled. Each student gets questions they have not seen before first.
- **Students** see their score trend, topic mastery, the topics to focus on, and every past quiz with all four choices explained.
- **You** see class statistics, every student's progress, per-question accuracy (you can turn questions off), and the quiz settings. You can also download a CSV of the roster.

Not included, as requested: eigenvalues and eigenvectors, lookup tables and interpolation, 3D plotting, and interactive plotting.

## How it fits together

GitHub Pages only serves static files, so it cannot sign people in or remember scores. The site therefore talks to a free **Supabase** project, which provides the database and the GitHub sign-in.

| Part                    | Where it lives     | What it does                                                             |
| ----------------------- | ------------------ | ------------------------------------------------------------------------ |
| `site/`               | GitHub Pages       | The web app students open                                                |
| `supabase/schema.sql` | Supabase database  | Tables, the Rowan-only sign-up rule, quiz generation, timing and grading |
| `bank/*.md`           | Your computer only | The question bank, including the answer key                              |

Grading happens in the database. The browser never receives the correct answers until a quiz is submitted. The 30-minute limit is enforced on the server: answers saved after the deadline are refused, and an abandoned quiz is graded automatically.

## One-time setup (about 30 minutes)

You need [Node.js](https://nodejs.org) (already installed on this computer), a GitHub account, and a free [Supabase](https://supabase.com) account.

### 1. Create the Supabase project

1. Sign in at supabase.com and create a new project (any name, for example `matlab-quiz`). Save the database password somewhere safe.
2. When the project is ready, open **SQL Editor**, paste the whole of `supabase/schema.sql`, and click **Run**.
3. Make yourself the instructor. In the SQL Editor, run this with your GitHub username in lowercase:

   ```sql
   insert into quiz.admin_logins (github_login) values ('your-github-username');
   ```

   Do this before you sign in for the first time. Your GitHub email does not need to be a Rowan address.

### 2. Load the questions

In PowerShell:

```powershell
cd "C:\Users\Abdul\Documents\MATLAB_Course\Quiz_App"
npm install
npm run build:seed
```

This checks every question and writes `supabase/questions_seed.sql`. Open that file, paste it into the Supabase SQL Editor, and run it.

### 3. Turn on GitHub sign-in

1. Decide your repository name now; the site address will be `https://<your-github-username>.github.io/<repository>/`.
2. On GitHub, go to **Settings → Developer settings → OAuth Apps → New OAuth App**:
   - Application name: `MATLAB Quiz`
   - Homepage URL: your site address from step 1
   - Authorization callback URL: `https://<project-ref>.supabase.co/auth/v1/callback` (Supabase shows this exact URL on the GitHub provider page)
3. Create the app, then copy the **Client ID** and generate a **Client secret**.
4. In Supabase, open **Authentication → Sign In / Providers**:
   - **GitHub**: enable it and paste the Client ID and secret.
   - **Email**: disable it, so GitHub is the only way in.
   - Leave **Allow new users to sign up** on. The database decides who may join.
5. In Supabase, open **Authentication → URL Configuration**:
   - Site URL: your site address
   - Redirect URLs: add `https://<your-github-username>.github.io/<repository>/**`

### 4. Connect the site to Supabase

Copy two values into `site/config.js`:

- the **Project URL**, from **Project Settings → Data API** (or the **Connect** button on the project page);
- the **anon** or **publishable** key, from **Project Settings → API Keys**.

Both values are meant to be public. Never put the `service_role` or secret key in the site.

### 5. Publish on GitHub Pages

1. Create the repository on GitHub. Public is fine; see "Keeping answers private" below.
2. Push this folder:

   ```powershell
   cd "C:\Users\Abdul\Documents\MATLAB_Course\Quiz_App"
   git init -b main
   git add .
   git commit -m "MATLAB quiz app"
   git remote add origin https://github.com/<your-github-username>/<repository>.git
   git push -u origin main
   ```
3. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**. The workflow run started by your push fails at `configure-pages` with "Not Found", because Pages was not on yet. Run it again: **Actions → Deploy to GitHub Pages → Run workflow**. From then on, every push that changes `site/` publishes it; each deploy takes a minute or two.
4. Open the site and sign in with your GitHub account. You should see an **Instructor** link in the top bar.

## What to tell students

Students need to set this up once before their first sign-in:

> The MATLAB quizzes are at `https://<your-github-username>.github.io/<repository>/`. Sign in with GitHub. Your GitHub account must use your Rowan email as its **primary** email: on GitHub go to Settings → Emails, add your Rowan address, verify it, and choose it as your primary email address. Each quiz is 20 questions in 30 minutes. The timer keeps running if you close the page, and your answers save as you go. After you submit, you can review every question with explanations, and your dashboard tracks your progress.

If a student signs in with the wrong email, the site explains how to fix it. They can then simply sign in again.

## Running the course

- **Instructor → Overview**: class average, score distribution, accuracy by topic, and the students to check on.
- **Instructor → Students**: search and sort the roster, open any student's dashboard and quiz reviews, and download a CSV.
- **Instructor → Questions**: accuracy for every question. Questions under 30% are marked for a second look, and switching one off removes it from new quizzes.
- **Instructor → Settings**: the time limit and how many questions each topic contributes. Changes apply to quizzes started afterwards.
- **Removing someone**: Supabase → Authentication → Users → delete the user. Their results are deleted with them.
- **Adding another instructor or TA**: add their GitHub login to `quiz.admin_logins`, as in setup step 1.3.
- **Supabase free plan**: a project pauses after a week with no activity; restore it from the Supabase dashboard. During the semester, student activity keeps it running.
- **Student records**: names, emails and scores are stored in your Supabase project. If the quizzes count toward grades, check Rowan's guidance on keeping student records in outside services.

## Editing questions

Questions live in `bank/`, one Markdown file per topic:

````markdown
# Topic: loops | Loops & Vectorization | Week 2 | 2

## loo-03 | medium | Week 2 L2, slide 44
What does this print?
```matlab
n = 1;
while n < 100
    n = n * 2;
end
fprintf('%d\n', n)
```
- [x] `128`
  > 64 < 100 is true, so n doubles to 128; then the loop stops.
- [ ] `64`
  > The test happens before each pass, so 64 is doubled once more.
- [ ] `100`
  > n only takes powers of 2.
- [ ] The loop never ends.
  > `n = n * 2` eventually makes the condition false.
````

- The topic line gives an id, title, week label, and the default number of questions per quiz.
- Each question has a unique id, a difficulty (`easy`, `medium` or `hard`) and a source. It needs exactly four options, one marked `[x]`, and each option needs a `>` explanation.
- Option order does not matter, because options are shuffled for every student.

After editing, run `npm run build:seed` and run the new `supabase/questions_seed.sql` in Supabase. Changed questions are updated. Questions you deleted are switched off, not erased, so past results stay intact. Topic counts you changed under **Settings** are kept.

## Keeping answers private

`bank/` and `supabase/questions_seed.sql` hold the answer key, so `.gitignore` keeps them out of the repository. Back up `bank/` yourself, for example to OneDrive. If your repository is private, you can remove those two lines from `.gitignore`.

## Local preview and tests

```powershell
npm run dev            # preview at http://127.0.0.1:8787 with demo accounts and sample data
npm test               # database tests: sign-up rules, grading, time limit, privacy, admin
npm run test:browser   # end-to-end run in Microsoft Edge; screenshots go to .qa/
```

The preview runs the real `schema.sql` in an in-memory database and replaces GitHub with a page of demo accounts (two students, the instructor, and an outside account that is refused). It does not touch Supabase. `npm run vendor` refreshes `site/vendor/supabase.js` after updating `@supabase/supabase-js`.
