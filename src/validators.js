import joi from "joi";

const today = new Date();
today.setHours(0, 0, 0, 0);

const registerSchema = joi
  .object({
    name: joi.string().trim().min(3).max(100).required(),
    email: joi.string().trim().email().max(150).required(),
    password: joi.string().min(6).max(72).required(),
  })
  .unknown(false);

const createUserSchema = joi
  .object({
    name: joi.string().trim().min(3).max(100).required(),
    email: joi.string().trim().email().max(150).required(),
    password: joi.string().min(6).max(72).required(),
    role: joi.valid("USER", "ADMIN").default("USER"),
  })
  .unknown(false);

const loginSchema = joi
  .object({
    email: joi.string().trim().email().required(),
    password: joi.string().min(6).required(),
  })
  .unknown(false);

const createTasksSchema = joi
  .object({
    title: joi.string().trim().min(3).max(100).required(),
    description: joi.string().trim().min(3).max(500).required(),
    feedback_date: joi.date().iso().required(),
    status: joi.valid("ONGOING", "DELAYED", "COMPLETED").optional(),
    assignedTo: joi.number().integer().positive().optional(),
  })
  .unknown(false);

const updateTasksSchema = joi
  .object({
    title: joi.string().trim().min(3).max(100).optional(),
    description: joi.string().trim().min(3).max(500).optional(),
    feedback_date: joi.date().iso().optional(),
    status: joi.valid("ONGOING", "DELAYED", "COMPLETED").optional(),
    assignedTo: joi.number().integer().positive().optional(),
  })
  .min(1)
  .unknown(false);

const delayTaskSchema = joi
  .object({
    newDate: joi.date().iso().min(today).required(),
    reason: joi.string().trim().max(255).required(),
  })
  .unknown(false);

const aiTaskQuerySchema = joi
  .object({
    question: joi.string().trim().min(3).max(1000).required(),
  })
  .unknown(false);

export {
  registerSchema,
  createUserSchema,
  loginSchema,
  createTasksSchema,
  updateTasksSchema,
  delayTaskSchema,
  aiTaskQuerySchema,
};
