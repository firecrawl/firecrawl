import { configDotenv } from "dotenv";
import { logger } from "../lib/logger";
import type { Request } from "express";
import WSWebSocket from "ws";
configDotenv();

/**
 * Attaches WebSocket proxying logic to the Express application
 * This function should be called after creating the Express app but before starting the server
 */
export function attachWsProxy(app: any) {
  logger.info("Attaching WebSocket proxy to Express app");

  // Make sure express-ws is properly initialized
  if (!app.ws) {
    logger.error(
      "Express app does not have WebSocket support. Make sure express-ws is properly initialized.",
    );
    return;
  }

  // Define the WebSocket route
  app.ws("/agent-livecast", (clientWs: WSWebSocket, req: Request) => {
    try {
      console.log(req.url);
      const url = new URL(req.url ?? "", "http://placeholder/");
      const sessionIdParam = url.searchParams.get("userProvidedId") || "";

      const workerWsUrl = `${process.env.FIRE_ENGINE_BETA_URL?.replace("http", "ws")}?userProvidedId=${sessionIdParam}`;
      console.log(workerWsUrl);
      const wsWorker = new WebSocket(workerWsUrl);

      wsWorker.onopen = () => {
        // clientWs is your user's browser socket
        // wsWorker is the worker's socket

        // Forward messages from the user -> worker
        clientWs.on("message", dataFromClient => {
          wsWorker.send(dataFromClient as unknown as string);
        });

        // Forward messages from the worker -> user
        wsWorker.onmessage = event => {
          clientWs.send(event.data);
        };

        // Close events
        clientWs.on("close", () => wsWorker.close());
        wsWorker.onclose = () => clientWs.close();
      };
    } catch (error) {
      console.error("Error in wsProxy upgrade:", error);
      clientWs.close();
    }
  });

  logger.info("WebSocket proxy successfully attached to Express app");
}
