import { db } from "../config/db.js";
import { embed } from "./embeddings.js";
import { upsertTaskEmbedding, deleteTaskEmbedding } from "./vectorStore.js";

// Rebuilds the embedding for one task from MySQL (the source of truth).
// If the task is gone or soft-deleted, its embedding is removed instead.
// Never throws: a failure here must not break saving the task.
export const refreshTaskEmbedding = async (taskId) => {
  try {
    const [rows] = await db.query(
      "SELECT id, assigned_to, title, description FROM tasks WHERE id = ? AND is_deleted = 0",
      [taskId]
    );
    if (rows.length === 0) {
      await deleteTaskEmbedding(taskId);
      return;
    }
    const t = rows[0];
    const content = [t.title, t.description].filter(Boolean).join(". ");
    await upsertTaskEmbedding({
      taskId: t.id,
      assignedTo: t.assigned_to,
      content,
      embedding: await embed(content),
    });
  } catch (error) {
    console.error("Embedding refresh failed for task", taskId, error?.message);
  }
};

export const removeTaskEmbeddings = async (taskIds) => {
  for (const taskId of taskIds) {
    try {
      await deleteTaskEmbedding(taskId);
    } catch (error) {
      console.error("Embedding delete failed for task", taskId, error?.message);
    }
  }
};