import { Router, Request, Response } from "express";
import { handleChatMessage } from "../agents/chatAgent.js";
import { createLogger } from "../logger.js";

const log = createLogger("chat");
export const chatRouter = Router();

// Serve pay page
chatRouter.get("/pay/:seq", async (req: Request, res: Response) => {
  const { seq } = req.params;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Sellable - Secure Checkout</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' https://*.razorpay.com;">
      <style>
        body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        .chat-box { border: 1px solid #ddd; border-radius: 8px; padding: 10px; height: 300px; overflow-y: auto; margin: 10px 0; }
        .message { margin: 5px 0; padding: 8px 12px; border-radius: 16px; max-width: 80%; }
        .user { background: #007bff; color: white; margin-left: auto; }
        .agent { background: #f1f1f1; }
        input { width: 80%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>Secure Checkout</h1>
      <div id="chat" class="chat-box"></div>
      <div style="display: flex; gap: 10px;">
        <input type="text" id="msg" placeholder="Ask about this offer...">
        <button onclick="send()">Send</button>
      </div>
      <script>
        const seq = '${seq}';
        const sessionToken = '${crypto.randomUUID()}';
        const chat = document.getElementById('chat');

        function addMessage(text, isUser) {
          const div = document.createElement('div');
          div.className = 'message ' + (isUser ? 'user' : 'agent');
          div.textContent = text;
          chat.appendChild(div);
          chat.scrollTop = chat.scrollHeight;
        }

        async function send() {
          const input = document.getElementById('msg');
          const msg = input.value.trim();
          if (!msg) return;
          addMessage(msg, true);
          input.value = '';

          const res = await fetch('/chat/' + seq, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, session_token: sessionToken }),
          });
          const data = await res.json();
          addMessage(data.response, false);
        }

        document.getElementById('msg').addEventListener('keypress', (e) => {
          if (e.key === 'Enter') send();
        });

        addMessage('Welcome! How can I help you with this offer?', false);
      </script>
    </body>
    </html>
  `);
});

// Chat endpoint
chatRouter.post("/chat/:seq", async (req: Request, res: Response) => {
  const { seq } = req.params;
  const { message, session_token } = req.body;

  if (!message || !session_token) {
    res.status(400).json({ error: "message and session_token required" });
    return;
  }

  try {
    const result = await handleChatMessage(seq, message, session_token);
    res.json(result);
  } catch (err: any) {
    log.error({ seq, error: err.message }, "Chat error");
    res.status(500).json({ response: "Sorry, I'm having trouble. Please try again." });
  }
});
