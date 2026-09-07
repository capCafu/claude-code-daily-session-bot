// config.ts loads dotenv, so anything the suite depends on must be pinned here
// or the developer's own .env leaks in and the tests vary by machine.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "111,222";
process.env.TIMEZONE = "UTC";
process.env.DB_PATH = ":memory:";
// Empty means "unset" to parseAccounts, giving the single implicit account.
// It must still be present in process.env so dotenv leaves it alone.
process.env.CLAUDE_ACCOUNTS = "";
process.env.CLAUDE_ACCOUNTS_DIR = "data/accounts";
