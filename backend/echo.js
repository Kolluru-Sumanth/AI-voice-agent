import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import cors from "cors";

const app = express();
app.use(cors());

const server = createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (data, isBinary) => {
    // Echo the received audio chunk back to frontend
    console.log(`Received audio chunk, size: ${data.length}`);
    ws.send(data, { binary: isBinary });
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

app.get("/", (req, res) => {
  res.send("WebSocket audio echo server is running");
});

const PORT = 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
