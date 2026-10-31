import OpenAI from "openai";
import { z } from "zod";
import { db } from "../config/db.js";
import { embed } from "../services/embeddings.js";
import { searchSimilar } from "../services/vectorStore.js";

const MAX_STEPS = 5;
const LIST_LIMIT = 50;
const MODEL_ROWS = 30;
const REASON_LIMIT = 100;
const SEARCH_COUNT = 8;
const MIN_SIMILARITY = 0.2;

/* ---------- reused helpers (unchanged) ---------- */

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
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL });
};

/* ---------- validation (model output is untrusted input) ---------- */

const QuerySchema = z.object({
  mode: z.enum(["count", "list", "stats"]),
  assignee_names: z.array(z.string()).nullish(),
  status: z.enum(["ONGOING", "DELAYED", "COMPLETED"]).nullish(),
  overdue: z.boolean().nullish(),
  delay_count: z
    .object({
      op: z.enum([">", ">=", "<", "<=", "="]),
      value: z.coerce.number().int().min(0).max(1000),
    })
    .nullish(),
  keyword: z.string().max(100).nullish(),
});

const HistorySchema = z.object({ task_title: z.string().min(1).max(200) });

const ReasonsSchema = z.object({ assignee_names: z.array(z.string()).nullish() });

const SearchSchema = z.object({ query: z.string().min(1).max(200) });

/* ---------- tool definitions the model sees ---------- */

const tools = [
  {
    type: "function",
    function: {
      name: "query_tasks",
      description:
        "Query tasks with any combination of exact filters. Use mode=count for 'how many', mode=list for 'show/which/list', mode=stats for a user's workload overview (totals by status plus overdue). The keyword filter only matches exact words in the title or description; for topic or meaning questions use search_tasks_by_meaning instead.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["count", "list", "stats"] },
          assignee_names: {
            type: "array",
            items: { type: "string" },
            description: "Names of assignees as written by the user. Omit for all visible users.",
          },
          status: { type: "string", enum: ["ONGOING", "DELAYED", "COMPLETED"] },
          overdue: { type: "boolean", description: "True for tasks not completed whose due date has passed." },
          delay_count: {
            type: "object",
            description: "Filter by number of recorded delays, e.g. more than 3 delays = {op: '>', value: 3}.",
            properties: {
              op: { type: "string", enum: [">", ">=", "<", "<=", "="] },
              value: { type: "integer", minimum: 0 },
            },
            required: ["op", "value"],
          },
          keyword: { type: "string", description: "Exact text to match in the task title or description." },
        },
        required: ["mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_task_delay_history",
      description:
        "Get one specific task and its delay history (old date, new date, reason). Use only when the user names a single task and asks why it was delayed or wants a summary of its delays. Do NOT use this for general questions about many tasks; use get_delay_reasons for those.",
      parameters: {
        type: "object",
        properties: { task_title: { type: "string", description: "Title or part of the title of the task." } },
        required: ["task_title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_delay_reasons",
      description:
        "Use this for ANY general question about why tasks are delayed or what the common delay reasons are. Returns the recorded delay reasons across ALL tasks at once, newest first, each with its task title and assignee. Can also be limited to one or more assignees.",
      parameters: {
        type: "object",
        properties: {
          assignee_names: {
            type: "array",
            items: { type: "string" },
            description: "Optional. Limit to these assignees. Omit for everyone visible.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_tasks_by_meaning",
      description:
        "Find tasks related to a topic or theme by meaning, even when the exact words differ. Use for questions like 'tasks related to payment problems', 'anything about login issues', 'tasks similar to the dashboard work'. Call it once with a short descriptive query that adds only a few closely related terms. Returns tasks ranked by similarity.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Short descriptive phrase with the main topic plus a few closely related terms, e.g. 'payment gateway and checkout problems, online transactions, refunds'." },
        },
        required: ["query"],
      },
    },
  },
];

/* ---------- tool implementations (your code runs these, not the model) ---------- */

const GROUP_BY = "GROUP BY t.id, t.title, t.description, t.status, t.feedback_date, u.name";

const runQueryTasks = async (req, args, users) => {
  const values = [];
  let where = accessScope(req, values);

  const matchedUsers = [];
  if (args.assignee_names?.length) {
    const ids = [];
    for (const name of args.assignee_names) {
      const { user, suggestions } = resolveUser(name, users);
      if (!user) {
        return { error: `I could not confidently match the user "${name}".`, suggestions: suggestions || [] };
      }
      ids.push(user.id);
      matchedUsers.push(user.name);
    }
    where += ` AND t.assigned_to IN (${ids.map(() => "?").join(",")})`;
    values.push(...ids);
  }
  if (args.status) { where += " AND t.status = ?"; values.push(args.status); }
  if (args.overdue) where += " AND t.status != 'COMPLETED' AND t.feedback_date < CURDATE()";
  if (args.keyword) {
    where += " AND (t.title LIKE ? OR t.description LIKE ?)";
    values.push(`%${args.keyword}%`, `%${args.keyword}%`);
  }

  let having = "";
  if (args.delay_count) {
    having = `HAVING COUNT(d.id) ${args.delay_count.op} ?`; // op is whitelisted by Zod
    values.push(args.delay_count.value);
  }

  const base = `FROM tasks t
    INNER JOIN users u ON u.id = t.assigned_to
    LEFT JOIN task_delays d ON d.task_id = t.id
    WHERE ${where}
    ${GROUP_BY}
    ${having}`;

  console.log("AI query_tasks:", JSON.stringify(args));

  if (args.mode === "count") {
    const [[row]] = await db.query(`SELECT COUNT(*) AS count FROM (SELECT t.id ${base}) x`, values);
    return { matched_users: matchedUsers, count: Number(row.count) };
  }

  if (args.mode === "stats") {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS total_tasks,
              COALESCE(SUM(x.status = 'ONGOING'), 0) AS ongoing_tasks,
              COALESCE(SUM(x.status = 'DELAYED'), 0) AS delayed_tasks,
              COALESCE(SUM(x.status = 'COMPLETED'), 0) AS completed_tasks,
              COALESCE(SUM(x.status != 'COMPLETED' AND x.feedback_date < CURDATE()), 0) AS overdue_tasks
       FROM (SELECT t.id, t.status, t.feedback_date ${base}) x`,
      values
    );
    return {
      matched_users: matchedUsers,
      stats: {
        total_tasks: Number(row.total_tasks),
        ongoing_tasks: Number(row.ongoing_tasks),
        delayed_tasks: Number(row.delayed_tasks),
        completed_tasks: Number(row.completed_tasks),
        overdue_tasks: Number(row.overdue_tasks),
      },
    };
  }

  const [rows] = await db.query(
    `SELECT t.id, t.title, t.description, t.status, t.feedback_date,
            u.name AS assignee_name, COUNT(d.id) AS delay_count
     ${base}
     ORDER BY t.feedback_date ASC LIMIT ${LIST_LIMIT}`,
    values
  );
  return { matched_users: matchedUsers, tasks: rows.map(taskDto), truncated: rows.length === LIST_LIMIT };
};

const runDelayHistory = async (req, { task_title }) => {
  const values = [];
  let where = accessScope(req, values);
  where += " AND t.title LIKE ?";
  values.push(`%${task_title}%`);

  const [tasks] = await db.query(
    `SELECT t.id, t.title, t.description, t.status, t.feedback_date,
            u.name AS assignee_name, COUNT(d.id) AS delay_count
     FROM tasks t
     INNER JOIN users u ON u.id = t.assigned_to
     LEFT JOIN task_delays d ON d.task_id = t.id
     WHERE ${where}
     ${GROUP_BY}
     ORDER BY t.updated_at DESC LIMIT 4`,
    values
  );
  if (tasks.length === 0) return { error: "No matching task was found." };

  const matches = [];
  for (const task of tasks) {
    const [delays] = await db.query(
      "SELECT old_date, new_date, reason, created_at FROM task_delays WHERE task_id = ? ORDER BY created_at ASC",
      [task.id]
    );
    matches.push({ task: taskDto(task), delays });
  }

  if (matches.length === 1) return matches[0];
  return { multiple_matches: matches.length, matches };
};

const runDelayReasons = async (req, args, users) => {
  const values = [];
  let where = accessScope(req, values);

  if (args.assignee_names?.length) {
    const ids = [];
    for (const name of args.assignee_names) {
      const { user, suggestions } = resolveUser(name, users);
      if (!user) {
        return { error: `I could not confidently match the user "${name}".`, suggestions: suggestions || [] };
      }
      ids.push(user.id);
    }
    where += ` AND t.assigned_to IN (${ids.map(() => "?").join(",")})`;
    values.push(...ids);
  }

  const [rows] = await db.query(
    `SELECT t.title, u.name AS assignee_name, d.reason, d.old_date, d.new_date, d.created_at
     FROM task_delays d
     INNER JOIN tasks t ON t.id = d.task_id
     INNER JOIN users u ON u.id = t.assigned_to
     WHERE ${where}
     ORDER BY d.created_at DESC LIMIT ${REASON_LIMIT}`,
    values
  );
  return { total_delay_entries: rows.length, truncated: rows.length === REASON_LIMIT, delays: rows };
};

const rerank = async (query, candidates) => {
  const completion = await client().chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-5.4-nano",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          'You judge relevance. Given a topic and a list of tasks, return ONLY a JSON object like {"relevant_ids": [1, 2]} with the ids of tasks whose title or description is genuinely about the topic. Judge only by the task text. Return an empty list if none are relevant.',
      },
      {
        role: "user",
        content: JSON.stringify({
          topic: query,
          tasks: candidates.map(({ id, title, description }) => ({ id, title, description })),
        }),
      },
    ],
  });
  const text = completion.choices[0].message.content || "";
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) throw new Error("No JSON in rerank reply");
  return new Set(JSON.parse(json[0]).relevant_ids.map(Number));
};

const runSemanticSearch = async (req, { query }) => {
  console.log("AI semantic search:", query);
  const ownerId = req.user.role === "ADMIN" ? null : req.user.id;
  const found = await searchSimilar(await embed(query), { ownerId, count: SEARCH_COUNT });
  console.log("AI semantic scores:", found.map((m) => `${m.task_id}:${m.similarity.toFixed(3)}`).join("  "));
  const matches = found.filter((m) => m.similarity >= MIN_SIMILARITY);
  if (matches.length === 0) return { tasks: [], message: "No tasks related to that topic were found." };

  // Re-check permissions in MySQL: only tasks the current user may see come back.
  const values = [];
  let where = accessScope(req, values);
  where += ` AND t.id IN (${matches.map(() => "?").join(",")})`;
  values.push(...matches.map((m) => m.task_id));

  const [rows] = await db.query(
    `SELECT t.id, t.title, t.description, t.status, t.feedback_date,
            u.name AS assignee_name, COUNT(d.id) AS delay_count
     FROM tasks t
     INNER JOIN users u ON u.id = t.assigned_to
     LEFT JOIN task_delays d ON d.task_id = t.id
     WHERE ${where}
     ${GROUP_BY}`,
    values
  );

  const score = new Map(matches.map((m) => [m.task_id, m.similarity]));
  const tasks = rows
    .map((row) => ({ ...taskDto(row), similarity: Number((score.get(row.id) ?? 0).toFixed(3)) }))
    .sort((a, b) => b.similarity - a.similarity);
    let kept = tasks;
  try {
    const relevantIds = await rerank(query, tasks);
    kept = tasks.filter((t) => relevantIds.has(Number(t.id)));
  } catch (error) {
    console.error("Rerank failed, using similarity only:", error?.message);
  }
  console.log("AI semantic kept:", kept.map((t) => t.id).join(","));
  if (kept.length === 0) return { tasks: [], message: "No tasks related to that topic were found." };
  return { tasks: kept };
};

/* ---------- keep what the model reads small and cheap ---------- */

const forModel = (data) => {
  if (!data.tasks) return data;
  return {
    ...data,
    total_returned: data.tasks.length,
    tasks: data.tasks.slice(0, MODEL_ROWS).map(({ description, ...rest }) => rest),
  };
};

/* ---------- the assistant loop ---------- */

const systemPrompt = (req, users) => `You are the assistant of a task tracker. Today's date is ${new Date().toISOString().slice(0, 10)}.
Rules:
- When ranking causes, rank by the number of entries in each group, highest first, and check the numbers before stating which is most common.
- Always use the tools to get data. Never guess counts, names or task details.
- Valid statuses: ONGOING, DELAYED, COMPLETED. "Overdue" means not completed and past its due date: use the overdue filter, not a status.
- "Delays" are the recorded delay entries of a task. Use delay_count for questions like "delayed more than 3 times".
- Use mode=count for "how many", mode=list for "show/which/list", mode=stats for a user's workload overview.
- When the user asks for several numbers at once, such as total, completed, delayed and overdue tasks, call query_tasks once with mode=stats instead of several count calls, then report every number from the result.
- For questions about a topic or theme, such as "tasks related to payment problems", "anything about login issues" or "tasks similar to X", call search_tasks_by_meaning once. Write the query as a short descriptive phrase about the topic, adding only a few closely related terms, for example "payment gateway and checkout problems, online transactions, refunds" for a payment question, or "login page problems, sign in failures" for a login question. Do not add loosely related words. Do NOT try several keyword guesses with query_tasks for these. Only mention tasks that were returned, and say that results are ranked by similarity, so the last ones may be only loosely related. If none are returned, say no related tasks were found.
- For ANY general question about why tasks are delayed, common delay reasons, or delay patterns, you MUST call get_delay_reasons first and only. Do NOT call query_tasks or get_task_delay_history for these questions. After it returns, describe only what the returned reasons say: group similar reasons, mention how many entries there are, and quote the actual reasons. Do not explain how the system works and do not add reasons that are not in the data. If the reasons are unclear or meaningless, say so. Start by stating the total number of entries. Put every entry in exactly one group, and make sure the group counts add up to the total before answering; if they don't, recount.
- To explain why one specific named task was delayed, call get_task_delay_history and summarize only the returned data. Mention the number of delays and the recorded reasons. If there are none, say no delays are recorded. If several tasks match the title, say so and summarize each one separately, naming its assignee and description.
- If a tool returns an error or suggestions, tell the user and ask them to clarify. Never invent users or tasks.
- If the question is unrelated to tasks, say you can only help with task questions.
- Keep answers short. Full task lists are shown to the user separately, so give the key number or a one-line summary instead of repeating every task. If results are truncated, say so.
- ${req.user.role === "ADMIN" ? "The current user is an admin and can see all users." : "The current user is a regular user and can only see their own tasks."}
Known users: ${JSON.stringify(users.map((u) => u.name).slice(0, 200))}`;

const runAssistant = async (req, question, users) => {
  const ai = client();
  const model = process.env.OPENAI_MODEL || "gpt-5.4-nano";
  const messages = [
    { role: "system", content: systemPrompt(req, users) },
    { role: "user", content: question },
  ];
  let last = null;
  const results = []

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const completion = await ai.chat.completions.create({
      model,
      temperature: 0,
      tools,
      tool_choice: "auto",
      messages,
    });
    const msg = completion.choices[0].message;
    if (!msg.tool_calls?.length) return { answer: msg.content || "", last ,results};

    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });

    for (const call of msg.tool_calls) {
      let data;
      let args = null;
      console.log("AI tool call:", call.function.name, call.function.arguments);
      try {
        const raw = JSON.parse(call.function.arguments || "{}");
        if (call.function.name === "query_tasks") {
          args = QuerySchema.parse(raw);
          data = await runQueryTasks(req, args, users);
        } else if (call.function.name === "get_task_delay_history") {
          args = HistorySchema.parse(raw);
          data = await runDelayHistory(req, args);
        } else if (call.function.name === "get_delay_reasons") {
          args = ReasonsSchema.parse(raw);
          data = await runDelayReasons(req, args, users);
        } else if (call.function.name === "search_tasks_by_meaning") {
          args = SearchSchema.parse(raw);
          data = await runSemanticSearch(req, args);
        } else {
          data = { error: `Unknown tool: ${call.function.name}` };
        }
      } catch (error) {
        console.error("Tool call failed:", call.function.name, error?.message);
        data = {
          error:
            error instanceof z.ZodError
              ? `Invalid arguments: ${error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
              : "The tool failed to run.",
        };
      }
      last = { name: call.function.name, args, data };
      results.push(last);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(forModel(data)) });
    }
  }
  return { answer: "I could not finish answering that. Please try rephrasing your question.", last, results };
};

/* ---------- route handler ---------- */

const legacyIntent = (name, args) => {
  if (name === "get_task_delay_history") return "SUMMARIZE_TASK_DELAYS";
  if (args.mode === "count") return "COUNT_TASKS";
  if (args.mode === "stats") return "USER_STATS";
  if (args.overdue) return "LIST_OVERDUE_TASKS";
  if (args.delay_count) return "LIST_TASKS_WITH_MIN_DELAYS";
  return "LIST_TASKS";
};

export const queryTasksWithAI = async (req, res) => {
  try {
    const question = String(req.body?.question || "").trim().slice(0, 500);
    if (!question) return res.status(400).json({ message: "Please enter a question." });

    const users = await visibleUsers(req);
    const { answer, last, results } = await runAssistant(req, question, users);
    const multiCount =
      results.length > 1 && results.every((r) => r.name === "query_tasks" && r.args?.mode === "count");
    const response = { answer };

        if (multiCount) {
      response.intent = "MULTI_COUNT";
    } else if (last?.data?.error) {
      response.message = last.data.error;
      response.suggestions = last.data.suggestions || [];
      if (last.data.tasks) response.tasks = last.data.tasks;
    } else if (last?.name === "query_tasks") {
      const { data, args } = last;
      response.intent = legacyIntent(last.name, args);
      response.matched_users = data.matched_users;
      response.status = args.status || null;
      if (data.count !== undefined) response.count = data.count;
      if (data.tasks) response.tasks = data.tasks;
      if (data.stats) response.stats = data.stats;
    } else if (last?.name === "get_task_delay_history") {
      response.intent = "SUMMARIZE_TASK_DELAYS";
      response.task = last.data.task;
      response.delays = last.data.delays;
      response.summary = answer;
    } else if (last?.name === "get_delay_reasons") {
      response.intent = "DELAY_REASONS";
      response.delays = last.data.delays;
      response.summary = answer;
    } else if (last?.name === "search_tasks_by_meaning") {
      response.intent = "SEMANTIC_SEARCH";
      response.tasks = last.data.tasks;
    }
    return res.json(response);
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
    return res.status(missingKey ? 503 : 500).json({
      message: missingKey ? error.message : "Unable to process the task question",
    });
  }
};