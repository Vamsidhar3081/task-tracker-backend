import joi from "joi"; 

const today = new Date();
today.setHours(0, 0, 0, 0);

const registerSchema = joi.object({
    name: joi.string().min(3).max(30).required(),
    email: joi.string().email().required(),
    password: joi.string().min(6).required()
}).unknown(false);

const loginSchema = joi.object({
    email: joi.string().email().required(),
    password: joi.string().min(6).required()
}).unknown(false);

const createTasksSchema = joi.object({
    title: joi.string().min(3).max(30).required(),
    description: joi.string().min(3).required(),
    feedback_date: joi.date().iso().required(),
    status: joi.valid("ONGOING", "COMPLETED").optional(),
}).unknown(false);

const updateTasksSchema = joi.object({
    title: joi.string().min(3).max(30).required(),
    description: joi.string().min(3).required(),
    status: joi.valid("ONGOING", "DELAYED", "COMPLETED").optional(),
}).unknown(false);

const delayTaskSchema = joi.object({
  newDate: joi.date().iso().min(today).required(),
  reason: joi.string().trim().max(255).required()
})
.unknown(false);


export {registerSchema,loginSchema,createTasksSchema,updateTasksSchema,delayTaskSchema};