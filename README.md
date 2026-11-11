# Orbit Chat

Orbit is a responsive, real-time chat app MVP built around a simple idea: keep good conversations close. It includes account registration, one-to-one chats, group conversations, live messages, online presence, and browser-based voice/video calls with screen sharing.

## Run locally

Requirements: Node.js 20.19+ (or 22.12+) and Docker.

1. Copy the environment template and set a random JWT secret of at least 32 characters:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Start PostgreSQL:

   ```powershell
   docker compose up -d postgres
   ```

3. Install dependencies and start the app:

   ```powershell
   npm install
   npm run dev
   ```

4. Open [http://localhost:5173](http://localhost:5173) and create an account. Create another account in a separate browser profile to try live one-to-one and group chats.

The database container is exposed on host port 5433 to avoid colliding with a local PostgreSQL service. The server creates its database tables on startup. The API and Socket.IO server run on port 3001; Vite proxies browser requests to it during development.

## Production build

```powershell
npm run build
npm start
```

Set `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET`, `PORT`, and `CLIENT_ORIGIN` in the deployment environment. Serve the built `dist` directory with a static host or reverse proxy, and use HTTPS so session cookies remain secure.

## Calls and screen sharing

Start a voice or video call from a conversation header. Group calls support up to six people. During a call, use **Share screen** to present a screen or window; the browser will ask you to choose what to share. Calls require camera and microphone permission, and screen sharing requires a secure browser context (localhost or HTTPS).

Calls use peer-to-peer WebRTC with a public STUN server. Some networks require a TURN relay to connect; production deployments should configure a trusted TURN service and review its access, privacy, and cost policies. The development setup does not include TURN.

Messages are stored in PostgreSQL and delivered live to connected members. This MVP does not provide end-to-end encryption, file uploads, push notifications, or message editing/deletion. Do not use it for sensitive conversations without a security review and a production deployment plan.
