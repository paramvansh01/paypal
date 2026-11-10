import { ConfigError, loadConfig } from "../config.js";
import { createApp } from "./app.js";

try {
  const config = loadConfig();
  const app = createApp(config);
  app.listen(config.app.port, () => {
    console.log(`Kept listening on ${config.app.publicBaseUrl} (port ${config.app.port})`);
  });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
