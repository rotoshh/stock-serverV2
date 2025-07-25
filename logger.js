// logger.js
const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'server.log');

function writeLog(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`; // ← תוקן כאן
  fs.appendFile(logFile, line, (err) => {
    if (err) console.error("❌ שגיאה בכתיבה ללוג:", err.message);
  });
}

module.exports = {
  info: (msg) => {
    console.log(msg);
    writeLog('info', msg);
  },
  error: (msg) => {
    console.error(msg);
    writeLog('error', msg);
  },
  warn: (msg) => {
    console.warn(msg);
    writeLog('warn', msg);
  }
};
