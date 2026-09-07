import { TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS } from "./config";
import { initDb } from "./db";
import { createBot } from "./bot";
import { restoreSchedules, setDailyScheduleCallback, setScheduleCallback } from "./scheduler";

initDb();

const bot = createBot(TELEGRAM_BOT_TOKEN);

setScheduleCallback((schedule, success, error) => {
  const chatId = ALLOWED_USER_IDS[0];
  const message = success
    ? `Scheduled warmup fired (ID ${schedule.id}). Session started!`
    : `Scheduled warmup failed (ID ${schedule.id}): ${error}`;
  // Telegram can be unreachable; an unhandled rejection here would be noisy.
  bot.sendMessage(chatId, message).catch((err) => {
    console.error("Failed to send schedule notification:", err.message);
  });
});

setDailyScheduleCallback((schedule, success, error) => {
  const chatId = ALLOWED_USER_IDS[0];
  const message = success
    ? `Daily warmup fired (ID ${schedule.id}). Session started! Next warmup: ${schedule.warmup_at}`
    : `Daily warmup failed (ID ${schedule.id}): ${error}`;
  bot.sendMessage(chatId, message).catch((err) => {
    console.error("Failed to send daily notification:", err.message);
  });
});

restoreSchedules();

console.log("Bot started");
