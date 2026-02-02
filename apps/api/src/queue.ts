import { Queue } from "bullmq";
import { apiEnv } from "./env";

const connection = {
  url: apiEnv.redisUrl
};

export const digestQueue = new Queue("digest", { connection });
export const reminderQueue = new Queue("reminder", { connection });
