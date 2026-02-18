FlowTasks – Backend
Overview

FlowTasks is a task accountability API that allows users to create, delay, complete, and manage tasks securely.  
Each user can access only their own tasks using JWT-based authentication.

Tech Stack
- Node.js
- Express.js
- MySQL
- JWT Authentication
- Bcrypt (Password Hashing)

Setup

1. Clone the repository

```bash
git clone https://github.com/yourusername/flowtasks-backend.git
cd flowtasks-backend
```
2. Install dependencies

```bash
npm install
```
3. Create `.env` file

```
PORT=5000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=flowtasks
JWT_SECRET=your_secret_key
```

4. Run the server

```bash
npm run dev
```

Server runs at:

```
http://localhost:5000
```

Authentication
- Passwords are hashed using bcrypt.
- Login returns a signed JWT.
- Protected routes require `Authorization: Bearer <token>`.
- All task operations are scoped using `req.user.id` to ensure user privacy.

---
Core Features
- User Registration & Login
- Create, Update, Delete Tasks
- Delay Tasks with reason & history tracking
- Complete Tasks (immutable after completion)
- Pagination, search, and filtering
