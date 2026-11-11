import "dotenv/config";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "socket.io";

const { Pool } = pg;
const port = Number(process.env.PORT ?? 3001);
const jwtSecret = process.env.JWT_SECRET;
const cookieName = "orbit_session";
const tokenLifetime = "7d";

if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be set to a random value of at least 32 characters.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://chat:chat@localhost:5432/chatapp",
});
pool.on("error", (error) => console.error("Unexpected PostgreSQL pool error:", error));

const app = express();
const httpServer = createServer(app);
const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";
const io = new Server(httpServer, {
  cors: { origin: clientOrigin, credentials: true },
  allowRequest: (request, callback) => {
    const origin = request.headers.origin;
    callback(null, !origin || origin === clientOrigin);
  },
});

app.use(helmet());
app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const issueToken = (user) =>
  jwt.sign(
    { sub: user.id, username: user.username, displayName: user.display_name },
    jwtSecret,
    { expiresIn: tokenLifetime },
  );

const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.display_name,
});

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};

async function authenticate(req, res, next) {
  const token = req.cookies[cookieName];
  if (!token) return res.status(401).json({ error: "Please sign in to continue." });

  try {
    const payload = jwt.verify(token, jwtSecret);
    let result;
    try {
      result = await pool.query(
        "SELECT id, username, display_name FROM users WHERE id = $1",
        [payload.sub],
      );
    } catch (error) {
      console.error("Could not authenticate socket connection:", error);
      return next(new Error("Chat service is unavailable."));
    }
    if (!result.rowCount) return res.status(401).json({ error: "Your session has expired." });
    req.user = result.rows[0];
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: "Your session has expired." });
    }
    next(error);
  }
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function hasChatAccess(chatId, userId) {
  const result = await pool.query(
    "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2",
    [chatId, userId],
  );
  return result.rowCount > 0;
}

app.get("/api/health", asyncRoute(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok" });
}));

app.post("/api/auth/register", authLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body.username ?? "").trim().toLowerCase();
  const displayName = String(req.body.displayName ?? "").trim();
  const password = String(req.body.password ?? "");

  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3–24 letters, numbers, or underscores." });
  }
  if (displayName.length < 1 || displayName.length > 48) {
    return res.status(400).json({ error: "Display name must be between 1 and 48 characters." });
  }
  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: "Password must be between 8 and 72 characters." });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const result = await pool.query(
      `INSERT INTO users (username, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, display_name`,
      [username, displayName, passwordHash],
    );
    const user = result.rows[0];
    res.cookie(cookieName, issueToken(user), cookieOptions).status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That username is already taken." });
    throw error;
  }
}));

app.post("/api/auth/login", authLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body.username ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  const result = await pool.query(
    "SELECT id, username, display_name, password_hash FROM users WHERE username = $1",
    [username],
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Username or password is incorrect." });
  }
  res.cookie(cookieName, issueToken(user), cookieOptions).json({ user: publicUser(user) });
}));

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined }).status(204).end();
});

app.get("/api/me", authenticate, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get("/api/users", authenticate, asyncRoute(async (req, res) => {
  const search = String(req.query.search ?? "").trim().slice(0, 60);
  const result = await pool.query(
    `SELECT id, username, display_name
     FROM users
     WHERE id <> $1 AND ($2 = '' OR username ILIKE $3 OR display_name ILIKE $3)
     ORDER BY display_name
     LIMIT 100`,
    [req.user.id, search, `%${search}%`],
  );
  res.json({ users: result.rows.map(publicUser) });
}));

app.get("/api/chats", authenticate, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.kind, c.created_at,
       (SELECT m.text FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
       (SELECT m.created_at FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
       COALESCE((
         SELECT json_agg(json_build_object(
           'id', u.id, 'username', u.username, 'displayName', u.display_name
         ) ORDER BY u.display_name)
         FROM chat_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.chat_id = c.id AND cm.user_id <> $1
       ), '[]'::json) AS members
     FROM chats c
     JOIN chat_members mine ON mine.chat_id = c.id AND mine.user_id = $1
     ORDER BY COALESCE(
       (SELECT m.created_at FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1),
       c.created_at
     ) DESC`,
    [req.user.id],
  );
  res.json({ chats: result.rows });
}));

app.post("/api/chats/direct", authenticate, asyncRoute(async (req, res) => {
  const otherUserId = String(req.body.userId ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(otherUserId)) {
    return res.status(400).json({ error: "Choose a valid person to message." });
  }
  if (otherUserId === req.user.id) return res.status(400).json({ error: "You cannot message yourself." });
  const target = await pool.query("SELECT id FROM users WHERE id = $1", [otherUserId]);
  if (!target.rowCount) return res.status(404).json({ error: "That account could not be found." });

  const existing = await pool.query(
    `SELECT c.id
     FROM chats c
     JOIN chat_members cm ON cm.chat_id = c.id
     WHERE c.kind = 'direct'
     GROUP BY c.id
     HAVING count(*) = 2
       AND array_agg(cm.user_id ORDER BY cm.user_id) =
           ARRAY[LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid)]
     LIMIT 1`,
    [req.user.id, otherUserId],
  );
  if (existing.rowCount) return res.json({ chatId: existing.rows[0].id });

  const chatId = await withTransaction(async (client) => {
    const created = await client.query(
      "INSERT INTO chats (kind) VALUES ('direct') RETURNING id",
    );
    await client.query(
      "INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)",
      [created.rows[0].id, req.user.id, otherUserId],
    );
    return created.rows[0].id;
  });
  for (const userId of [req.user.id, otherUserId]) {
    io.in(`user:${userId}`).socketsJoin(chatId);
    io.to(`user:${userId}`).emit("chat:added", { chatId });
  }
  res.status(201).json({ chatId });
}));

app.post("/api/chats/group", authenticate, asyncRoute(async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const memberIds = [...new Set(
    Array.isArray(req.body.memberIds) ? req.body.memberIds.map(String) : [],
  )].filter((id) => id !== req.user.id);
  if (name.length < 2 || name.length > 60) {
    return res.status(400).json({ error: "Group name must be between 2 and 60 characters." });
  }
  if (memberIds.length < 1 || memberIds.length > 49 ||
      memberIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    return res.status(400).json({ error: "Choose between 1 and 49 valid people for your group." });
  }
  const memberCheck = await pool.query(
    "SELECT count(*)::int AS count FROM users WHERE id = ANY($1::uuid[])",
    [memberIds],
  );
  if (memberCheck.rows[0].count !== memberIds.length) {
    return res.status(400).json({ error: "One or more selected accounts could not be found." });
  }

  const chatId = await withTransaction(async (client) => {
    const created = await client.query(
      "INSERT INTO chats (kind, name) VALUES ('group', $1) RETURNING id",
      [name],
    );
    const allMembers = [req.user.id, ...memberIds];
    const values = allMembers.map((_, index) => `($1, $${index + 2})`).join(", ");
    await client.query(
      `INSERT INTO chat_members (chat_id, user_id) VALUES ${values}`,
      [created.rows[0].id, ...allMembers],
    );
    return created.rows[0].id;
  });
  for (const userId of [req.user.id, ...memberIds]) {
    io.in(`user:${userId}`).socketsJoin(chatId);
    io.to(`user:${userId}`).emit("chat:added", { chatId });
  }
  res.status(201).json({ chatId });
}));

app.get("/api/chats/:chatId/messages", authenticate, asyncRoute(async (req, res) => {
  if (!(await hasChatAccess(req.params.chatId, req.user.id))) {
    return res.status(404).json({ error: "Conversation not found." });
  }
  const result = await pool.query(
    `SELECT m.id, m.chat_id, m.text, m.created_at,
       json_build_object(
         'id', u.id, 'username', u.username, 'displayName', u.display_name
       ) AS sender
     FROM (
       SELECT * FROM messages WHERE chat_id = $1
       ORDER BY created_at DESC LIMIT 100
     ) m
     JOIN users u ON u.id = m.sender_id
     ORDER BY m.created_at ASC`,
    [req.params.chatId],
  );
  res.json({ messages: result.rows });
}));

app.post("/api/chats/:chatId/messages", authenticate, asyncRoute(async (req, res) => {
  const text = String(req.body.text ?? "").trim();
  if (!text || text.length > 4000) {
    return res.status(400).json({ error: "Messages must be between 1 and 4,000 characters." });
  }
  if (!(await hasChatAccess(req.params.chatId, req.user.id))) {
    return res.status(404).json({ error: "Conversation not found." });
  }
  const result = await pool.query(
    `INSERT INTO messages (chat_id, sender_id, text)
     VALUES ($1, $2, $3)
     RETURNING id, chat_id, text, created_at`,
    [req.params.chatId, req.user.id, text],
  );
  const message = { ...result.rows[0], sender: publicUser(req.user) };
  io.to(req.params.chatId).emit("message:new", message);
  res.status(201).json({ message });
}));

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

const onlineCounts = new Map();
const activeCalls = new Map();
const maxCallParticipants = 6;

function emitCallError(socket, acknowledge, message) {
  const response = { error: message };
  if (typeof acknowledge === "function") acknowledge(response);
  else socket.emit("call:error", response);
}

function finishCall(call, reason) {
  if (!activeCalls.has(call.id)) return;
  activeCalls.delete(call.id);
  clearTimeout(call.timeout);
  const users = new Set([...call.participants.keys(), ...call.invited]);
  for (const userId of users) {
    io.to(`user:${userId}`).emit("call:ended", { callId: call.id, reason });
  }
}

io.use(async (socket, next) => {
  const token = socket.request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!token) return next(new Error("Authentication required."));
  let payload;
  try {
    payload = jwt.verify(decodeURIComponent(token), jwtSecret);
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return next(new Error("Authentication required."));
    }
    return next(error);
  }
  const result = await pool.query(
    "SELECT id, username, display_name FROM users WHERE id = $1",
    [payload.sub],
  );
  if (!result.rowCount) return next(new Error("Authentication required."));
  socket.data.user = result.rows[0];
  next();
});

io.on("connection", async (socket) => {
  const user = socket.data.user;
  const firstConnection = !onlineCounts.has(user.id);
  onlineCounts.set(user.id, (onlineCounts.get(user.id) ?? 0) + 1);
  let memberships;
  try {
    memberships = await pool.query(
      "SELECT chat_id FROM chat_members WHERE user_id = $1",
      [user.id],
    );
  } catch (error) {
    console.error("Could not load socket chat memberships:", error);
    const remaining = (onlineCounts.get(user.id) ?? 1) - 1;
    if (remaining <= 0) onlineCounts.delete(user.id);
    else onlineCounts.set(user.id, remaining);
    socket.disconnect(true);
    return;
  }
  for (const membership of memberships.rows) socket.join(membership.chat_id);
  socket.join(`user:${user.id}`);
  socket.emit("presence:snapshot", [...onlineCounts.keys()]);
  if (firstConnection) io.emit("presence:update", { userId: user.id, online: true });

  socket.on("chat:join", async ({ chatId } = {}) => {
    try {
      if (typeof chatId !== "string" || !(await hasChatAccess(chatId, user.id))) {
        socket.emit("chat:error", { error: "Conversation not found." });
        return;
      }
      socket.join(chatId);
    } catch (error) {
      console.error("Could not join chat room:", error);
      socket.emit("chat:error", { error: "Could not join conversation. Try reconnecting." });
    }
  });

  socket.on("call:start", async ({ chatId, mode } = {}, acknowledge) => {
    try {
      if (typeof chatId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(chatId) ||
          !["audio", "video"].includes(mode)) {
        return emitCallError(socket, acknowledge, "Choose a valid conversation and call type.");
      }

      const membership = await pool.query(
        `SELECT c.kind, c.name, u.id, u.username, u.display_name
         FROM chats c
         JOIN chat_members cm ON cm.chat_id = c.id
         JOIN users u ON u.id = cm.user_id
         WHERE c.id = $1
         ORDER BY u.display_name`,
        [chatId],
      );
      if (!membership.rowCount || !membership.rows.some((member) => member.id === user.id)) {
        return emitCallError(socket, acknowledge, "You are not a member of this conversation.");
      }
      if (membership.rowCount > maxCallParticipants) {
        return emitCallError(socket, acknowledge, `Calls currently support up to ${maxCallParticipants} people.`);
      }
      if ([...activeCalls.values()].some((call) =>
        call.participants.has(user.id) || call.invited.has(user.id))) {
        return emitCallError(socket, acknowledge, "You are already in another call.");
      }

      const callId = randomUUID();
      const participants = new Map([[user.id, publicUser(user)]]);
      const invitedMembers = membership.rows.filter((member) => member.id !== user.id);
      const call = {
        id: callId,
        chatId,
        chatName: membership.rows[0].kind === "group" ? membership.rows[0].name : null,
        mode,
        callerId: user.id,
        participants,
        invited: new Set(invitedMembers.map((member) => member.id)),
        timeout: null,
      };
      activeCalls.set(callId, call);
      call.timeout = setTimeout(() => finishCall(call, "no-answer"), 45_000);

      const caller = publicUser(user);
      for (const member of invitedMembers) {
        io.to(`user:${member.id}`).emit("call:incoming", {
          callId,
          chatId,
          chatName: call.chatName,
          mode,
          caller,
        });
      }
      if (typeof acknowledge === "function") {
        acknowledge({
          callId,
          chatId,
          chatName: call.chatName,
          mode,
          participants: invitedMembers.map(publicUser),
        });
      }
    } catch (error) {
      console.error("Could not start call:", error);
      emitCallError(socket, acknowledge, "Could not start the call. Please try again.");
    }
  });

  socket.on("call:join", ({ callId } = {}, acknowledge) => {
    const call = activeCalls.get(callId);
    if (!call) return emitCallError(socket, acknowledge, "This call has ended.");
    if (!call.invited.has(user.id) && !call.participants.has(user.id)) {
      return emitCallError(socket, acknowledge, "You were not invited to this call.");
    }
    if (call.participants.has(user.id)) {
      if (typeof acknowledge === "function") {
        acknowledge({
          callId,
          participants: [...call.participants.values()].filter((member) => member.id !== user.id),
        });
      }
      return;
    }
    call.invited.delete(user.id);
    call.participants.set(user.id, publicUser(user));
    clearTimeout(call.timeout);
    socket.join(call.id);

    const otherParticipants = [...call.participants.values()].filter((member) => member.id !== user.id);
    for (const peer of otherParticipants) {
      io.to(`user:${peer.id}`).emit("call:peer-joined", { callId, peer: publicUser(user) });
      io.to(`user:${user.id}`).emit("call:peer-joined", { callId, peer });
    }
    if (typeof acknowledge === "function") acknowledge({ callId, participants: otherParticipants });
  });

  socket.on("call:reject", ({ callId } = {}, acknowledge) => {
    const call = activeCalls.get(callId);
    if (!call || !call.invited.has(user.id)) {
      return emitCallError(socket, acknowledge, "This call invitation has expired.");
    }
    call.invited.delete(user.id);
    io.to(`user:${call.callerId}`).emit("call:peer-rejected", {
      callId,
      peer: publicUser(user),
    });
    if (call.invited.size === 0 && call.participants.size === 1) finishCall(call, "no-answer");
    if (typeof acknowledge === "function") acknowledge({ ok: true });
  });

  socket.on("call:signal", ({ callId, to, signal } = {}, acknowledge) => {
    const call = activeCalls.get(callId);
    if (!call || !call.participants.has(user.id) || !call.participants.has(to) || user.id === to) {
      return emitCallError(socket, acknowledge, "This call connection is no longer available.");
    }
    const description = signal?.description;
    const candidate = signal?.candidate;
    const validDescription = description &&
      ["offer", "answer"].includes(description.type) &&
      typeof description.sdp === "string" &&
      description.sdp.length <= 100_000;
    const validCandidate = candidate === null || (
      candidate &&
      typeof candidate.candidate === "string" &&
      candidate.candidate.length <= 5_000
    );
    if ((!validDescription && !validCandidate) || (description && candidate !== undefined)) {
      return emitCallError(socket, acknowledge, "Invalid call connection data.");
    }
    io.to(`user:${to}`).emit("call:signal", {
      callId,
      from: publicUser(user),
      signal: validDescription ? { description } : { candidate },
    });
    if (typeof acknowledge === "function") acknowledge({ ok: true });
  });

  socket.on("call:leave", ({ callId } = {}, acknowledge) => {
    const call = activeCalls.get(callId);
    if (!call || (!call.participants.has(user.id) && !call.invited.has(user.id))) {
      if (typeof acknowledge === "function") acknowledge({ ok: true });
      return;
    }
    const wasCaller = call.callerId === user.id;
    const wasInvited = call.invited.delete(user.id);
    const wasParticipant = call.participants.delete(user.id);
    if (wasParticipant || wasInvited) {
      for (const participantId of call.participants.keys()) {
        io.to(`user:${participantId}`).emit("call:peer-left", {
          callId,
          userId: user.id,
        });
      }
    }
    if (wasCaller || call.participants.size === 0) finishCall(call, "ended");
    if (typeof acknowledge === "function") acknowledge({ ok: true });
  });

  socket.on("disconnect", async () => {
    const remaining = (onlineCounts.get(user.id) ?? 1) - 1;
    if (remaining <= 0) {
      onlineCounts.delete(user.id);
      io.emit("presence:update", { userId: user.id, online: false });
    } else {
      onlineCounts.set(user.id, remaining);
    }

    try {
      if ((await io.in(`user:${user.id}`).fetchSockets()).length === 0) {
        for (const call of activeCalls.values()) {
          if (!call.participants.has(user.id) && !call.invited.has(user.id)) continue;
          if (call.callerId === user.id) finishCall(call, "ended");
          else {
            call.invited.delete(user.id);
            call.participants.delete(user.id);
            for (const participantId of call.participants.keys()) {
              io.to(`user:${participantId}`).emit("call:peer-left", {
                callId: call.id,
                userId: user.id,
              });
            }
            if (call.participants.size === 0) finishCall(call, "ended");
          }
        }
      }
    } catch (error) {
      console.error("Could not clean up disconnected call participant:", error);
    }
  });
});

async function start() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username varchar(24) NOT NULL UNIQUE,
      display_name varchar(48) NOT NULL,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chats (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL CHECK (kind IN ('direct', 'group')),
      name varchar(60),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (chat_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text varchar(4000) NOT NULL CHECK (length(trim(text)) > 0),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_chat_created_idx
      ON messages(chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS chat_members_user_idx
      ON chat_members(user_id, chat_id);
  `);
  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`Orbit server listening on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("Unable to start Orbit server:", error);
  process.exitCode = 1;
});
