import OpenAI from "openai";
import { db } from "../config/db.js";

const INTENTS = [
  "LIST_TASKS",
  "COUNT_TASKS",
  "USER_STATS",
  "LIST_OVERDUE_TASKS",
  "LIST_TASKS_WITH_MIN_DELAYS",
  "SUMMARIZE_TASK_DELAYS",
  "UNSUPPORTED",
];

const querySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: INTENTS },
    assignee_name: { type: ["string", "null"] },
    task_title: { type: ["string", "null"] },
    min_delays: { type: ["integer", "null"], minimum: 0, maximum: 100 },
    status: { type: ["string", "null"], enum: ["ONGOING", "DELAYED", "COMPLETED", null] },
  },
  required: ["intent", "assignee_name", "task_title", "min_delays", "status"],
};

const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const distance = (left, right) => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[right.length];
};

const mentionsUser = (question, name) => {
  const escaped = name.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)${escaped}(?=$|\\W)`, "i").test(question);
};

const resolveUser = (requestedName, users) => {
  if (!requestedName) return { user: null };
  const input = normalize(requestedName);
  const exact = users.find((user) => normalize(user.name) === input);
  if (exact) return { user: exact };

  const ranked = users
    .map((user) => ({ user, score: distance(input, normalize(user.name)) }))
    .sort((a, b) => a.score - b.score);
  const best = ranked[0];
  if (!best) return { user: null, suggestions: [] };

  const limit = Math.max(1, Math.floor(Math.max(input.length, normalize(best.user.name).length) * 0.34));
  if (best.score <= limit && ranked.filter((item) => item.score === best.score).length === 1) {
    return { user: best.user, correctedFrom: requestedName };
  }
  return { user: null, suggestions: ranked.slice(0, 3).map((item) => item.user.name) };
};

const visibleUsers = async (req) => {
  if (req.user.role === "ADMIN") {
    const [users] = await db.query("SELECT id, name FROM users WHERE role = 'USER' ORDER BY name");
    return users;
  }
  const [users] = await db.query("SELECT id, name FROM users WHERE id = ?", [req.user.id]);
  return users;
};

const accessScope = (req, values) => {
  if (req.user.role === "ADMIN") return "t.is_deleted = 0";
  values.push(req.user.id);
  return "t.is_deleted = 0 AND t.assigned_to = ?";
};

const inferTaskTitle = async (req, question) => {
  const values = [];
  const where = accessScope(req, values);
  const [rows] = await db.query(`SELECT t.id, t.title FROM tasks t WHERE ${where} LIMIT 1000`, values);
  const normalizedQuestion = normalize(question);
  return rows
    .filter((row) => normalizedQuestion.includes(normalize(row.title)))
    .sort((a, b) => normalize(b.title).length - normalize(a.title).length)[0]?.title || null;
};

const taskDto = (task) => ({
  id: task.id,
  title: task.title,
  description: task.description,
  status: task.status,
  feedback_date: task.feedback_date,
  assignee_name: task.assignee_name,
  delay_count: Number(task.delay_count),
});

const client = () => {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-5.4-nano";
  console.log("AI provider:", baseURL.includes("groq.com") ? "Groq" : "OpenAI");
  console.log("AI model:", model);
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL });
};

const interpret = async (question, users) => {
  const response = await client().responses.create({
    model: process.env.OPENAI_MODEL || "gpt-5.4-nano",
    store: false,
    instructions: "Extract the task tracker operation and filters. Understand any question about tasks or users, including listing, counting, status (ONGOING, DELAYED, COMPLETED), overdue state, assignees, title/description keywords, delay counts, and user workload. Use LIST_TASKS for show/find/what questions, COUNT_TASKS for how-many questions, USER_STATS for user workload questions, and SUMMARIZE_TASK_DELAYS for delay explanations. Never answer the question, invent a person, or invent a task title. Use UNSUPPORTED only for unrelated requests.",
    input: `Question: ${question}\nVisible users: ${JSON.stringify(users.map(({ name }) => name))}`,
    text: { format: { type: "json_schema", name: "task_query", strict: true, schema: querySchema } },
  });
  return JSON.parse(response.output_text);
};

const listTasks = async (req, { overdue = false, assigneeId, assigneeIds, minDelays, delayOperator = ">", status, title }) => {
  const values = [];
  let where = accessScope(req, values);
  if (overdue) where += " AND t.status != 'COMPLETED' AND t.feedback_date < CURDATE()";
  if (assigneeId) { where += " AND t.assigned_to = ?"; values.push(assigneeId); }
  if (Array.isArray(assigneeIds) && assigneeIds.length > 0) { where += ` AND t.assigned_to IN (${assigneeIds.map(() => "?").join(",")})`; values.push(...assigneeIds); }
  if (status) { where += " AND t.status = ?"; values.push(status); }
  if (title) { where += " AND (t.title LIKE ? OR t.description LIKE ?)"; values.push(`%${title}%`, `%${title}%`); }
  let having = "";
  if (Number.isInteger(minDelays)) {
    const safeOperator = [">", "<", ">=", "<=", "="].includes(delayOperator) ? delayOperator : ">";
    having = ` HAVING COUNT(d.id) ${safeOperator} ?`;
    values.push(minDelays);
  }
  console.log("AI SQL task filter:", { overdue, assigneeId, assigneeIds, minDelays, status, title });

  const [tasks] = await db.query(
    `SELECT t.id, t.title, t.description, t.status, t.feedback_date, assignee.name AS assignee_name, COUNT(d.id) AS delay_count
     FROM tasks t
     INNER JOIN users assignee ON assignee.id = t.assigned_to
     LEFT JOIN task_delays d ON d.task_id = t.id
     WHERE ${where}
     GROUP BY t.id, t.title, t.description, t.status, t.feedback_date, assignee.name
     ${having}
     ORDER BY t.feedback_date ASC LIMIT 100`,
    values
  );
  const result = tasks.map(taskDto);
  console.log("AI SQL task result counts:", result.map(({ id, title, delay_count }) => ({ id, title, delay_count })));
  return result;
};

const summarize = async (task, delays) => {
  const response = await client().responses.create({
    model: process.env.OPENAI_MODEL || "gpt-5.4-nano",
    store: false,
    instructions: "Write a concise natural-language summary of why this task was delayed. Use only the supplied task and delay-history data. Mention the number of delays and recorded reasons. Do not return JSON, operation names, filters, or code. If there are no delay records, say that no delays are recorded.",
    input: JSON.stringify({ task: taskDto(task), delays }),

  });
  return response.output_text;
};

export const queryTasksWithAI = async (req, res) => {
  try {
    const users = await visibleUsers(req);
    const parsed = await interpret(req.body.question, users);
    console.log("AI parsed query:", JSON.stringify(parsed));
    const summarizePhrase = /\bsummar(?:ize|ise)\b/i.test(req.body.question);
    if (summarizePhrase) parsed.intent = "SUMMARIZE_TASK_DELAYS";
    if (parsed.intent === "SUMMARIZE_TASK_DELAYS" && !parsed.task_title) {
      parsed.task_title = await inferTaskTitle(req, req.body.question);
    }

    const overduePhrase = /\boverdue\b/i.test(req.body.question);
    if (overduePhrase) {
      parsed.intent = "LIST_OVERDUE_TASKS";
      parsed.status = null;
    }

    const delayPhrase = req.body.question.match(/more than\s+(\d+)\s+delays?/i);
    const lessPhrase = req.body.question.match(/less than\s+(\d+)\s+delays?/i);
    const atLeastPhrase = req.body.question.match(/at least\s+(\d+)\s+delays?/i);
    const exactPhrase = req.body.question.match(/exactly\s+(\d+)\s+delays?/i);
    let delayOperator = ">";
    if (lessPhrase) { parsed.min_delays = Number(lessPhrase[1]); delayOperator = "<"; parsed.intent = "LIST_TASKS"; }
    if (atLeastPhrase) { parsed.min_delays = Number(atLeastPhrase[1]); delayOperator = ">="; parsed.intent = "LIST_TASKS"; }
    if (exactPhrase) { parsed.min_delays = Number(exactPhrase[1]); delayOperator = "="; parsed.intent = "LIST_TASKS"; }

    if (delayPhrase) {
      parsed.min_delays = Number(delayPhrase[1]);
      parsed.intent = "LIST_TASKS_WITH_MIN_DELAYS";
    }
    if (parsed.intent === "UNSUPPORTED") {
      return res.status(400).json({ message: "I can search tasks by status, assignee, title, overdue state, and delay count, or summarize task delays." });
    }

    const userMatch = resolveUser(parsed.assignee_name, users);
    const questionLower = req.body.question.toLowerCase();
    const mentionedUsers = users.filter((user) => mentionsUser(questionLower, user.name));
    const assigneeIds = mentionedUsers.length > 0 ? mentionedUsers.map((user) => user.id) : (userMatch.user ? [userMatch.user.id] : undefined);
    if (parsed.assignee_name && !userMatch.user && mentionedUsers.length === 0) {
      return res.status(404).json({ message: "I could not confidently match that user.", suggestions: userMatch.suggestions || [] });
    }

    if (parsed.intent === "COUNT_TASKS") {
      const tasks = await listTasks(req, { assigneeIds, status: parsed.status || undefined, title: parsed.task_title || undefined, minDelays: parsed.min_delays ?? undefined, delayOperator });
      return res.json({ intent: parsed.intent, matched_users: mentionedUsers.length ? mentionedUsers.map((user) => user.name) : (userMatch.user ? [userMatch.user.name] : []), status: parsed.status || null, count: tasks.length });
    }

    if (parsed.intent === "USER_STATS") {
      const tasks = await listTasks(req, { assigneeIds });
      const stats = { total_tasks: tasks.length, ongoing_tasks: tasks.filter((task) => task.status === "ONGOING").length, delayed_tasks: tasks.filter((task) => task.status === "DELAYED").length, completed_tasks: tasks.filter((task) => task.status === "COMPLETED").length, overdue_tasks: tasks.filter((task) => task.status !== "COMPLETED" && task.feedback_date && new Date(task.feedback_date) < new Date()).length };
      return res.json({ intent: parsed.intent, matched_users: mentionedUsers.length ? mentionedUsers.map((user) => user.name) : (userMatch.user ? [userMatch.user.name] : []), stats });
    }

    if (parsed.intent === "LIST_TASKS") {
      const tasks = await listTasks(req, { assigneeIds, status: parsed.status || undefined, title: parsed.task_title || undefined, minDelays: parsed.min_delays ?? undefined, delayOperator });
      return res.json({ intent: parsed.intent, matched_users: mentionedUsers.length ? mentionedUsers.map((user) => user.name) : (userMatch.user ? [userMatch.user.name] : []), status: parsed.status || null, tasks });
    }

    if (parsed.intent === "LIST_OVERDUE_TASKS") {
      const tasks = await listTasks(req, { overdue: true, assigneeIds });
      return res.json({ intent: parsed.intent, matched_users: mentionedUsers.length ? mentionedUsers.map((user) => user.name) : (userMatch.user ? [userMatch.user.name] : []), corrected_from: userMatch.correctedFrom || null, tasks });
    }

    if (parsed.intent === "LIST_TASKS_WITH_MIN_DELAYS") {
      const tasks = await listTasks(req, { assigneeIds, minDelays: parsed.min_delays ?? 2, delayOperator });
      return res.json({ intent: parsed.intent, matched_users: mentionedUsers.length ? mentionedUsers.map((user) => user.name) : (userMatch.user ? [userMatch.user.name] : []), corrected_from: userMatch.correctedFrom || null, tasks });
    }

    if (parsed.intent === "SUMMARIZE_TASK_DELAYS" && !parsed.task_title) {
      return res.status(404).json({ message: "Please include the task title you want summarized." });
    }

    const values = [];
    let where = accessScope(req, values);
    where += " AND t.title LIKE ?";
    values.push(`%${parsed.task_title || ""}%`);
    const [tasks] = await db.query(
      `SELECT t.id, t.title, t.description, t.status, t.feedback_date, assignee.name AS assignee_name, COUNT(d.id) AS delay_count
       FROM tasks t INNER JOIN users assignee ON assignee.id = t.assigned_to LEFT JOIN task_delays d ON d.task_id = t.id
       WHERE ${where}
       GROUP BY t.id, t.title, t.description, t.status, t.feedback_date, assignee.name
       ORDER BY t.updated_at DESC LIMIT 4`,
      values
    );
    if (tasks.length === 0) return res.status(404).json({ message: "No matching task was found." });
    if (tasks.length > 1) return res.status(409).json({ message: "I found multiple matching tasks.", tasks: tasks.map(taskDto) });

    const [delays] = await db.query("SELECT old_date, new_date, reason, created_at FROM task_delays WHERE task_id = ? ORDER BY created_at ASC", [tasks[0].id]);
    return res.json({ intent: parsed.intent, task: taskDto(tasks[0]), delays, summary: await summarize(tasks[0], delays) });
  } catch (error) {
    console.error("AI task query failed", {
      message: error?.message,
      name: error?.name,
      status: error?.status,
      code: error?.code,
      type: error?.type,
      requestId: error?.request_id || error?.headers?.["x-request-id"],
      cause: error?.cause?.message,
    });
    const missingKey = error.message === "OPENAI_API_KEY is not configured";
    return res.status(missingKey ? 503 : 500).json({ message: missingKey ? error.message : "Unable to process the task question" });
  }
};
