const levelScores = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function createLogger(level = "info") {
  const threshold = levelScores[level] || levelScores.info;

  function write(logLevel, message, meta) {
    if ((levelScores[logLevel] || 0) < threshold) {
      return;
    }

    const payload = {
      time: new Date().toISOString(),
      level: logLevel,
      message
    };

    if (meta !== undefined) {
      payload.meta = meta;
    }

    const serialized = JSON.stringify(payload);
    if (logLevel === "error") {
      console.error(serialized);
      return;
    }

    if (logLevel === "warn") {
      console.warn(serialized);
      return;
    }

    console.log(serialized);
  }

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta)
  };
}

module.exports = {
  createLogger
};
