import { TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, ACCOUNTS, IS_MULTI_ACCOUNT } from "./config";
import { initDb } from "./db";
import { createBot } from "./bot";
import { restoreSchedules, setDailyScheduleCallback, setScheduleCallback } from "./scheduler";

initDb();

const bot = createBot(TELEGRAM_BOT_TOKEN);

setScheduleCallback((schedule, success, error) => {
  const chatId = ALLOWED_USER_IDS[0];
  const tag = IS_MULTI_ACCOUNT ? `[${schedule.account}] ` : "";
  const message = success
    ? `${tag}Scheduled warmup fired (ID ${schedule.id}). Session started!`
    : `${tag}Scheduled warmup failed (ID ${schedule.id}): ${error}`;
  // Telegram can be unreachable; an unhandled rejection here would be noisy.
  bot.sendMessage(chatId, message).catch((err) => {
    console.error("Failed to send schedule notification:", err.message);
  });
});

setDailyScheduleCallback((schedule, success, error) => {
  const chatId = ALLOWED_USER_IDS[0];
  const tag = IS_MULTI_ACCOUNT ? `[${schedule.account}] ` : "";
  const message = success
    ? `${tag}Daily warmup fired (ID ${schedule.id}). Session started! Next warmup: ${schedule.warmup_at}`
    : `${tag}Daily warmup failed (ID ${schedule.id}): ${error}`;
  bot.sendMessage(chatId, message).catch((err) => {
    console.error("Failed to send daily notification:", err.message);
  });
});

restoreSchedules();

console.log(
  IS_MULTI_ACCOUNT
    ? `Bot started with ${ACCOUNTS.length} accounts: ${ACCOUNTS.map((a) => a.name).join(", ")}`
    : "Bot started"
);
