import { loadHubConfig } from "./config.js";
import { createHubServer } from "./http.js";

const config = loadHubConfig();
export const server = createHubServer(config);

server.listen(config.server.port, config.server.host, () => {
  console.log(`friday-hub listening on ${config.server.host}:${config.server.port}`);
});
