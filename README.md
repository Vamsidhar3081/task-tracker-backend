# FlowTasks – Backend

## Overview

FlowTasks is a task accountability API. Users create, delay, complete and manage tasks, and every delay is recorded with a reason. It has role-based access: admins manage users and see all tasks, while regular users see only their own. It also includes an **AI assistant** that answers natural-language questions about tasks.

The React frontend is in a separate repository: [task-tracker](https://github.com/Vamsidhar3081/task-tracker).

## Tech Stack

- Node.js, Express.js
- MySQL (hosted on Aiven)
- JWT authentication, bcrypt password hashing
- Zod for validating AI tool arguments
- LLM through an OpenAI-compatible API (Groq)
- `@huggingface/transformers` for local embeddings (`all-MiniLM-L6-v2`)

## Features

- User registration and login (JWT)
- Roles: `ADMIN` and `USER`. Admins create users and assign tasks.
- Create, update and soft-delete tasks
- Delay a task with a reason and a new date, with full delay history
- Complete tasks (a completed task cannot be delayed)
- Pagination, search and filtering
- Statistics endpoint: total, completed, delayed, ongoing and overdue counts over all tasks
- AI task assistant (see below)

## AI Assistant

Users ask questions in plain language, for example:

- "How many tasks assigned to Mouser are overdue?"
- "Show me all tasks with more than 2 delays."
- "How many tasks are there, and how many are completed, delayed and overdue?"
- "Why do tasks keep getting delayed?"
- "Summarize why the dashboard task got delayed."
- "Which tasks are related to payment problems?"

### How it works

The assistant uses **LLM tool calling**. The model never touches the database. It only chooses a tool and its arguments. My backend validates them, runs a permission-checked, parameterized SQL query, and returns the result to the model, which writes the answer.

| Tool | Purpose |
|---|---|
| `query_tasks` | Exact filters (assignee, status, overdue, delay count, keyword) with count, list or stats modes |
| `get_task_delay_history` | Delay history of a named task. If several tasks share the title, each is summarized. |
| `get_delay_reasons` | Delay reasons across all tasks, for pattern questions |
| `search_tasks_by_meaning` | Semantic search for topic questions |

Flow of one request:

1. The frontend sends the question to the assistant endpoint.
2. The model chooses a tool and writes its arguments.
3. The backend validates the arguments with Zod and runs the matching function.
4. The result goes back to the model, which writes a short answer.
5. The backend returns the answer together with the structured data (tasks, counts or statistics).

### Semantic search (RAG)

1. Each task's title and description is converted to an embedding with a local model and stored in MySQL (`task_embeddings`, vectors stored as JSON).
2. The model writes a short search phrase for the question. That phrase is embedded the same way, and the closest tasks are found by cosine similarity.
3. Weak matches are dropped, and permissions are re-checked in MySQL for every result.
4. A relevance filter (a second model call) keeps only tasks genuinely about the topic. Similarity scores alone could not separate related from unrelated tasks across different topics.
5. Embeddings are refreshed automatically when a task is created, edited or deleted.

### Security

- Access control is enforced in SQL (`accessScope`), never in the prompt. Non-admins can only ever query their own tasks.
- All SQL uses parameterized queries. The only value placed in the SQL text, the comparison operator, is restricted to a fixed whitelist by Zod.
- Model-produced tool arguments are treated as untrusted input and validated with Zod. Validation errors are returned to the model so it can correct itself.
- Question length is capped, tool loops are capped, and the model receives a trimmed copy of the data to limit cost.
- Passwords are hashed with bcrypt, and protected routes require `Authorization: Bearer <token>`.

### Evaluation

Results on a small hand-made question set (23 tasks):

| Question | Expected | Result |
|---|---|---|
| Overall counts (total, completed, delayed, overdue) | Match a direct SQL query | Pass (23 / 8 / 10 / 14) |
| Tasks with more than 2 delays | Exactly the 3 matching tasks | Pass |
| Tasks related to payment problems | Refund, UPI and Razorpay tasks | 3 of 3, no wrong tasks |
| Any tasks about login issues | Safari login task | 1 of 1, no wrong tasks |

Notes from testing:
- An early version embedded delay reasons together with task text, which caused false matches. Removing them fixed it.
- A single similarity cutoff could not work across topics, so a relevance-filter step was added.
- The dashboard originally counted statuses from one page of tasks. A server-side statistics endpoint fixed it, and it now matches the assistant and the database.
- Delay-reason summaries are grouped by the model, so group counts can occasionally be off by a small amount, while the entries themselves come exactly from the database.

## Setup

1. Clone the repository

```bash
git clone https://github.com/Vamsidhar3081/flowtasks-backend.git
cd flowtasks-backend
```

2. Install dependencies

```bash
npm install
```

3. Create a `.env` file

```
PORT=5000

# MySQL
MYSQLHOST=your-host
MYSQLPORT=3306
MYSQLUSER=your-user
MYSQLPASSWORD=your-password
MYSQLDATABASE=your-database

# Auth
JWT_SECRET=your_secret_key
JWT_EXPIRES_IN=1d

# AI assistant (OpenAI-compatible API, e.g. Groq)
OPENAI_API_KEY=your_groq_api_key
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_MODEL=openai/gpt-oss-120b
```

Never commit the `.env` file or expose the API key in the frontend.

4. Create the embeddings table and embed existing tasks

```bash
node src/scripts/embedTasks.js
```

The first run downloads the embedding model (about 25 MB). After this, embeddings update automatically when tasks change.

5. Run the server

```bash
npm run dev
```

The server runs at `http://localhost:5000`.

## API Overview

| Method | Route | Description |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | Register and log in |
| GET / POST | `/auth/users` | List users, create a user (admin) |
| DELETE | `/auth/users/:userId` | Delete a user (admin) |
| POST | `/auth/createtask` | Create a task |
| GET | `/auth/gettasks` | List tasks (pagination, search, filters) |
| GET | `/auth/taskstats` | Total, completed, delayed, ongoing and overdue counts |
| GET | `/auth/tasks/:taskId` | Task details with delay history |
| PUT | `/auth/updateticket/:taskId` | Update a task |
| POST | `/auth/tasks/:taskId/delay` | Delay a task with a reason |
| PATCH | `/auth/tasks/:taskId/complete` | Complete a task |
| DELETE | `/auth/tasks/:taskId` | Soft-delete a task |
| POST | `/ai/query` | Ask the AI assistant a question |

All routes are served under the API base path used by the frontend (`VITE_API_URL`).

## Known Limitations

- Embeddings are stored as JSON in MySQL and compared in application code. This is fine for hundreds of tasks. A dedicated vector database would be the next step at larger scale.
- The relevance filter adds one extra model call to topic searches.
- The assistant has no memory between questions. Each question is answered on its own.
- The evaluation set is small, and more test questions are needed for stronger conclusions.