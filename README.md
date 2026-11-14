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

### Deploy with Cloudflare and Render

Cloudflare hosts the static frontend; the Node.js API and PostgreSQL database must run separately. This repository includes a Render Blueprint in `render.yaml` for the API and database.

1. In Render, create a new Blueprint from this GitHub repository and deploy it. The Blueprint generates a `JWT_SECRET`, connects the API to PostgreSQL, and allows the Cloudflare site origin. The free PostgreSQL plan is for testing and may have usage or expiration limits; check Render's current plan details before storing important data.

2. The production frontend defaults to `https://orbit-chat-api.onrender.com`, the API URL for this Render Blueprint. If Render assigns a different URL or you use another API host, set the Cloudflare Workers & Pages build variable `VITE_API_URL` to the Render **API service** URL (for example `https://my-api.onrender.com`) for production (and preview if needed), then trigger a fresh deployment.

3. For file attachments to display, `VITE_API_URL` must be set in Cloudflare's **environment** (Workers & Pages build vars), not in a local `.env` file. Local `.env` values are not baked into a Cloudflare frontend build. `NODE_ENV`/`PROD` is not reliably `true` on Cloudflare, so if `VITE_API_URL` is missing the app falls back to an empty API base URL and looks for the API on the Cloudflare site origin; message/file uploads and attachment downloads then fail silently and attachments never appear.

4. If your Cloudflare site uses a different domain, update Render's `CLIENT_ORIGIN` to that exact origin and redeploy the API. The Blueprint sets `COOKIE_SAME_SITE=none` for cross-site session cookies; both sites must use HTTPS.

5. Open `https://<your-api-host>/api/health`. It should return JSON such as `{"status":"ok"}`. Then reload the Cloudflare site and try registering an account.

Do not set `VITE_API_URL` to the Cloudflare site URL: it must point to the Render API service. Keep database credentials and `JWT_SECRET` in Render environment settings, not in Cloudflare frontend variables.

## Calls and screen sharing

Start a voice or video call from a conversation header. Group calls support up to six people. During a call, use **Share screen** to present a screen or window; the browser will ask you to choose what to share. Calls require camera and microphone permission, and screen sharing requires a secure browser context (localhost or HTTPS).

Calls use peer-to-peer WebRTC with a public STUN server. Some networks require a TURN relay to connect; production deployments should configure a trusted TURN service and review its access, privacy, and cost policies. The development setup does not include TURN.

Messages and file attachments are stored in PostgreSQL and delivered live to connected members. Attachments accept any file type, are downloaded rather than rendered inline, and are limited to 50 MB each; storing files in PostgreSQL can consume database capacity quickly. This MVP does not provide end-to-end encryption, push notifications, or message editing/deletion. Do not use it for sensitive conversations without a security review and a production deployment plan.