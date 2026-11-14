import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCheck,
  CircleHelp,
  Download,
  MessageCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Paperclip,
  Phone,
  Search,
  Send,
  Smile,
  Sparkles,
  Users,
  Video,
  X,
} from "lucide-react";
import CallOverlay from "./CallOverlay.jsx";

const apiBaseUrl = (
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD ? "https://orbit-chat-api.onrender.com" : "__UNSET__")
).replace(/\/+$/, "");
const maxAttachmentBytes = 50 * 1024 * 1024;

async function api(path, options = {}) {
  if (apiBaseUrl === "__UNSET__") {
    throw new Error(
      "API base URL is not configured. Set VITE_API_URL to your Render API URL (for example https://orbit-chat-api.onrender.com) in the deployment environment — do not point it at the Cloudflare site URL."
    );
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("The API returned a non-JSON response. Confirm VITE_API_URL points at the backend API, not the frontend host.");
  }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error ?? "Something went wrong.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function initials(name = "") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function colorFor(value = "") {
  const colors = ["lavender", "peach", "mint", "blue", "rose", "gold"];
  const score = [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return colors[score % colors.length];
}

function Avatar({ name, online = false, size = "normal" }) {
  return (
    <span className={`avatar avatar-${colorFor(name)} avatar-${size}`}>
      {initials(name) || "?"}
      {online && <i className="online-dot" />}
    </span>
  );
}

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const data = await api(path, {
        method: "POST",
        body: JSON.stringify(form),
      });
      onAuthenticated(data.user);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  function changeMode(nextMode) {
    setMode(nextMode);
    setError("");
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <a className="brand auth-brand" href="/" aria-label="Orbit home">
          <span className="brand-mark"><MessageCircle size={21} fill="currentColor" /></span>
          <span>orbit<span className="brand-period">.</span></span>
        </a>
        <div className="auth-intro">
          <span className="eyebrow"><Sparkles size={14} /> YOUR PEOPLE, IN ORBIT</span>
          <h1>{mode === "login" ? "Good to see you." : "Make yourself at home."}</h1>
          <p>
            {mode === "login"
              ? "Sign in and pick up right where the conversation left off."
              : "A little space for the conversations that matter."}
          </p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          {mode === "register" && (
            <label>
              Your name
              <input
                autoComplete="name"
                maxLength={48}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                placeholder="How people know you"
                required
                value={form.displayName}
              />
            </label>
          )}
          <label>
            Username
            <input
              autoComplete="username"
              maxLength={24}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              placeholder="Your unique handle"
              required
              value={form.username}
            />
          </label>
          <label>
            Password
            <input
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              placeholder="At least 8 characters"
              required
              type="password"
              value={form.password}
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button auth-submit" disabled={busy} type="submit">
            {busy ? "One moment…" : mode === "login" ? "Sign in" : "Create account"}
            {!busy && <ArrowUp size={17} className="arrow-diagonal" />}
          </button>
        </form>
        <p className="auth-switch">
          {mode === "login" ? "New around here?" : "Already have an account?"}
          <button
            onClick={() => changeMode(mode === "login" ? "register" : "login")}
            type="button"
          >
            {mode === "login" ? "Create an account" : "Sign in"}
          </button>
        </p>
        <div className="auth-footnote"><span /> Your conversations stay between you and your people.</div>
      </section>
      <aside className="auth-art" aria-hidden="true">
        <div className="art-orbit orbit-one" />
        <div className="art-orbit orbit-two" />
        <div className="art-orbit orbit-three" />
        <div className="floating-note note-top"><span className="note-dot dot-peach" /> the weekend crew <b>just now</b></div>
        <div className="floating-note note-bottom"><Avatar name="Mia Chen" size="small" /><span>Made it home safe ✨</span><CheckCheck size={15} /></div>
        <div className="art-copy">
          <span>GOOD CONVERSATIONS<br />HAVE A PLACE.</span>
          <h2>Stay close,<br /><em>wherever.</em></h2>
        </div>
        <div className="art-caption">A little corner of the internet, just for your people.</div>
      </aside>
    </main>
  );
}

function chatName(chat) {
  if (!chat) return "";
  if (chat.kind === "group") return chat.name;
  return chat.members?.[0]?.displayName ?? chat.members?.[0]?.username ?? "New conversation";
}

function chatMemberCount(chat) {
  return (chat?.members?.length ?? 0) + 1;
}

function chatSubtitle(chat, online) {
  if (chat.kind === "group") {
    const count = chatMemberCount(chat);
    return `${count} ${count === 1 ? "person" : "people"}`;
  }
  const person = chat.members?.[0];
  if (person && online.has(person.id)) return "online now";
  return person ? `@${person.username}` : "Your conversation";
}

function formatTime(dateString) {
  if (!dateString) return "";
  const date = new Date(dateString);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Sidebar({
  user,
  chats,
  people,
  selectedChatId,
  onSelectChat,
  onStartDirect,
  onNewGroup,
  onLogout,
  online,
  mode,
  onModeChange,
}) {
  const [search, setSearch] = useState("");
  const visibleChats = chats.filter((chat) => chatName(chat).toLowerCase().includes(search.toLowerCase()));
  const visiblePeople = people.filter((person) =>
    `${person.displayName} ${person.username}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <aside className={`sidebar ${selectedChatId ? "sidebar-hidden-mobile" : ""}`}>
      <header className="sidebar-header">
        <a className="brand" href="/" aria-label="Orbit home">
          <span className="brand-mark"><MessageCircle size={19} fill="currentColor" /></span>
          <span>orbit<span className="brand-period">.</span></span>
        </a>
        <button className="icon-button profile-button" onClick={onLogout} title={`Sign out ${user.displayName}`} aria-label="Sign out">
          <Avatar name={user.displayName} size="small" />
        </button>
      </header>
      <div className="sidebar-greeting">
        <span className="eyebrow">YOUR LITTLE CORNER</span>
        <h1>Hey, {user.displayName.split(" ")[0]} <span>✳</span></h1>
        <p>Good conversations start here.</p>
      </div>
      <div className="sidebar-tabs" role="tablist">
        <button className={mode === "chats" ? "active" : ""} onClick={() => onModeChange("chats")} role="tab">
          <MessageCircle size={16} /> Chats <span className="tab-count">{chats.length || ""}</span>
        </button>
        <button className={mode === "people" ? "active" : ""} onClick={() => onModeChange("people")} role="tab">
          <Users size={16} /> People
        </button>
      </div>
      <div className="search-box">
        <Search size={16} />
        <input
          aria-label={mode === "chats" ? "Search conversations" : "Search people"}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={mode === "chats" ? "Find a conversation" : "Find your people"}
          value={search}
        />
        {search && <button aria-label="Clear search" onClick={() => setSearch("")}><X size={14} /></button>}
      </div>
      {mode === "chats" ? (
        <div className="sidebar-list">
          <div className="list-heading">
            <span>RECENT</span>
            <button onClick={onNewGroup} aria-label="Create a group" title="Create a group">
              <MessageSquarePlus size={16} />
            </button>
          </div>
          {visibleChats.length ? visibleChats.map((chat) => {
            const name = chatName(chat);
            const person = chat.members?.[0];
            return (
              <button
                className={`chat-row ${selectedChatId === chat.id ? "selected" : ""}`}
                key={chat.id}
                onClick={() => onSelectChat(chat.id)}
              >
                {chat.kind === "group"
                  ? <span className={`avatar group-avatar avatar-${colorFor(name)}`}><Users size={19} /></span>
                  : <Avatar name={name} online={person && online.has(person.id)} />}
                <span className="chat-row-copy">
                  <span className="chat-row-title">{name}</span>
                  <span className="chat-row-preview">{chat.last_message || chatSubtitle(chat, online)}</span>
                </span>
                <span className="chat-row-meta">{formatTime(chat.last_message_at ?? chat.created_at)}</span>
              </button>
            );
          }) : (
            <div className="list-empty">
              <span className="empty-icon"><MessageCircle size={19} /></span>
              <strong>{search ? "No matches just yet" : "A fresh start"}</strong>
              <p>{search ? "Try a different name." : "Say hello to someone to start a conversation."}</p>
              <button onClick={() => onModeChange("people")}>Find your people <ArrowUp size={14} className="arrow-diagonal" /></button>
            </div>
          )}
        </div>
      ) : (
        <div className="sidebar-list">
          <div className="list-heading"><span>YOUR PEOPLE</span></div>
          {visiblePeople.length ? visiblePeople.map((person) => (
            <button className="person-row" key={person.id} onClick={() => onStartDirect(person)}>
              <Avatar name={person.displayName} online={online.has(person.id)} />
              <span className="person-copy">
                <strong>{person.displayName}</strong>
                <span>@{person.username}{online.has(person.id) ? " · online" : ""}</span>
              </span>
              <MessageCircle size={17} className="person-message-icon" />
            </button>
          )) : (
            <div className="list-empty">
              <span className="empty-icon"><Users size={19} /></span>
              <strong>{search ? "No one by that name" : "Your people are on the way"}</strong>
              <p>{search ? "Try another search." : "When others join Orbit, you’ll find them here."}</p>
            </div>
          )}
        </div>
      )}
      <footer className="sidebar-footer">
        <div className="footer-status"><span /> Everything is in orbit</div>
        <button className="footer-help" aria-label="About Orbit" title="A friendly space for your conversations"><CircleHelp size={17} /></button>
      </footer>
    </aside>
  );
}

function GroupModal({ people, onClose, onCreate }) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const togglePerson = (id) => {
    setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onCreate(name, selected);
    } catch (requestError) {
      setError(requestError.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="group-modal" aria-labelledby="group-title" aria-modal="true" role="dialog">
        <header>
          <div><span className="eyebrow">MAKE IT A GROUP</span><h2 id="group-title">Bring everyone in.</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        </header>
        <form onSubmit={submit}>
          <label className="modal-label">
            Group name
            <input autoFocus maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="The good ones" required value={name} />
          </label>
          <div className="modal-people-heading"><span>INVITE PEOPLE</span><span>{selected.length} selected</span></div>
          <div className="modal-people">
            {people.map((person) => (
              <button
                aria-pressed={selected.includes(person.id)}
                className={`modal-person ${selected.includes(person.id) ? "chosen" : ""}`}
                key={person.id}
                onClick={() => togglePerson(person.id)}
                type="button"
              >
                <Avatar name={person.displayName} size="small" />
                <span><strong>{person.displayName}</strong><small>@{person.username}</small></span>
                <span className="selection-check">{selected.includes(person.id) && <Check size={13} />}</span>
              </button>
            ))}
            {!people.length && <p className="modal-empty">More people will show up here when they join Orbit.</p>}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button modal-submit" disabled={busy || selected.length < 1} type="submit">
            {busy ? "Creating…" : `Create group${selected.length ? ` · ${selected.length + 1}` : ""}`}
            {!busy && <ArrowUp size={16} className="arrow-diagonal" />}
          </button>
        </form>
      </section>
    </div>
  );
}

function ChatView({
  chat,
  user,
  online,
  messages,
  onSend,
  onSendFile,
  onDownloadFile,
  onBack,
  onStartCall,
  loading,
  error,
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const endRef = useRef(null);
  const fileInputRef = useRef(null);
  const title = chatName(chat);
  const person = chat.kind === "direct" ? chat.members?.[0] : null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function submit(event) {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      if (await onSend(text.trim())) setText("");
    } finally {
      setSending(false);
    }
  }

  async function selectFile(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setUploadError("");
    if (!file.size) {
      setUploadError("Empty files cannot be sent.");
      return;
    }
    if (file.size > maxAttachmentBytes) {
      setUploadError("Files must be 50 MB or smaller.");
      return;
    }
    setUploadingFile(true);
    try {
      await onSendFile(file);
    } finally {
      setUploadingFile(false);
    }
  }

  return (
    <section className="conversation">
      <header className="conversation-header">
        <button className="back-button icon-button" onClick={onBack} aria-label="Back to conversations"><ArrowLeft size={20} /></button>
        {chat.kind === "group"
          ? <span className={`avatar group-avatar avatar-${colorFor(title)}`}><Users size={19} /></span>
          : <Avatar name={title} online={person && online.has(person.id)} />}
        <div className="conversation-heading">
          <h2>{title}</h2>
          <span className={person && online.has(person.id) ? "presence-online" : ""}>
            {chatSubtitle(chat, online)}
          </span>
        </div>
        <div className="conversation-actions">
          <button
            className="call-start-button"
            onClick={() => onStartCall("audio")}
            title="Start a voice call"
            aria-label="Start a voice call"
          >
            <Phone size={17} />
          </button>
          <button
            className="call-start-button call-start-video"
            onClick={() => onStartCall("video")}
            title="Start a video call"
            aria-label="Start a video call"
          >
            <Video size={18} />
          </button>
        </div>
        <button className="icon-button header-more" aria-label="Conversation options" title="Conversation options">
          <MoreHorizontal size={21} />
        </button>
      </header>
      <div className="message-scroll">
        <div className="conversation-date"><span /> TODAY <span /></div>
        <div className="message-welcome">
          <div className="welcome-sparkle">✳</div>
          <strong>This is your space.</strong>
          <span>Say hello and let the conversation find its orbit.</span>
        </div>
        {loading && <div className="message-status">Loading messages…</div>}
        {(uploadError || error) && <div className="message-error">{uploadError || error}</div>}
        {messages.map((message, index) => {
          const mine = message.sender.id === user.id;
          const previous = messages[index - 1];
          const grouped = previous && previous.sender.id === message.sender.id &&
            new Date(message.created_at) - new Date(previous.created_at) < 5 * 60 * 1000;
          return (
            <div className={`message-line ${mine ? "message-mine" : ""} ${grouped ? "message-grouped" : ""}`} key={message.id}>
              {!mine && !grouped && <Avatar name={message.sender.displayName} size="tiny" />}
              {!mine && grouped && <span className="avatar-spacer" />}
              <div className="message-content">
                {!mine && chat.kind === "group" && !grouped && <span className="message-author">{message.sender.displayName}</span>}
                <div className="message-bubble">
                  {message.attachment ? (
                    <button
                      className="message-attachment"
                      onClick={() => onDownloadFile(message)}
                      title={`Download ${message.attachment.name}`}
                      type="button"
                    >
                      <Paperclip size={17} />
                      <span>
                        <strong>{message.attachment.name}</strong>
                        <small>{formatFileSize(message.attachment.size)} · Download</small>
                      </span>
                      <Download size={15} />
                    </button>
                  ) : message.text ? <p>{message.text}</p> : null}
                  <span className="message-time">
                    {formatTime(message.created_at)}
                    {mine && <CheckCheck size={14} />}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={submit}>
        <div className="composer-box">
          <input
            ref={fileInputRef}
            aria-label="Choose a file"
            className="file-input"
            onChange={selectFile}
            type="file"
          />
          <button
            className="composer-tool"
            disabled={sending || uploadingFile}
            onClick={() => fileInputRef.current?.click()}
            title="Attach a file (up to 50 MB)"
            type="button"
            aria-label="Attach a file"
          >
            <Paperclip size={18} />
          </button>
          <button className="composer-tool" type="button" aria-label="Emoji picker (coming soon)" title="Emoji picker coming soon"><Smile size={19} /></button>
          <textarea
            aria-label="Write a message"
            maxLength={4000}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form.requestSubmit();
              }
            }}
            placeholder="Write something kind…"
            rows={1}
            value={text}
          />
          {text.length > 3500 && <span className="character-count">{4000 - text.length}</span>}
          <button className="send-button" disabled={!text.trim() || sending || uploadingFile} type="submit" aria-label="Send message">
            {sending ? <Send size={17} /> : <ArrowUp size={18} />}
          </button>
        </div>
        <span className="composer-hint">
          {uploadingFile ? "Uploading file…" : <>Enter to send <i /> Shift + Enter for a new line</>}
        </span>
      </form>
    </section>
  );
}

function EmptyConversation({ onFindPeople, error }) {
  return (
    <section className="empty-conversation">
      <div className="empty-art">
        <div className="empty-ring ring-a" /><div className="empty-ring ring-b" />
        <div className="empty-chat-icon"><MessageCircle size={32} fill="currentColor" /></div>
        <span className="floating-star star-a">✳</span><span className="floating-star star-b">✦</span>
      </div>
      <span className="eyebrow">A LITTLE SPACE FOR YOUR PEOPLE</span>
      <h2>Good things start<br />with <em>hello.</em></h2>
      <p>Pick a conversation on the left, or find someone new to say hi to.</p>
      {error && <p className="empty-error" role="alert">{error}</p>}
      <button className="secondary-button" onClick={onFindPeople}><Users size={16} /> Find your people</button>
    </section>
  );
}

function ChatApp({ user, onLogout, appError }) {
  const [chats, setChats] = useState([]);
  const [people, setPeople] = useState([]);
  const [selectedChatId, setSelectedChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [online, setOnline] = useState(() => new Set());
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [showGroup, setShowGroup] = useState(false);
  const [sidebarMode, setSidebarMode] = useState("chats");
  const [socket, setSocket] = useState(null);
  const [call, setCall] = useState(null);
  const selectedChatIdRef = useRef(selectedChatId);
  const callRef = useRef(call);
  selectedChatIdRef.current = selectedChatId;
  callRef.current = call;
  const selectedChat = useMemo(() => chats.find((chat) => chat.id === selectedChatId), [chats, selectedChatId]);

  const loadChats = useCallback(async () => {
    const data = await api("/api/chats");
    setChats(data.chats);
  }, []);

  const loadPeople = useCallback(async () => {
    const data = await api("/api/users");
    setPeople(data.users);
  }, []);

  useEffect(() => {
    Promise.all([loadChats(), loadPeople()]).catch((error) => setMessageError(error.message));
  }, [loadChats, loadPeople]);

  useEffect(() => {
    const socket = io(apiBaseUrl || undefined, { withCredentials: true });
    setSocket(socket);
    socket.on("message:new", (message) => {
      setMessages((current) => {
        if (message.chat_id !== selectedChatIdRef.current || current.some((item) => item.id === message.id)) return current;
        return [...current, message];
      });
      loadChats().catch((error) => setMessageError(error.message));
    });
    socket.on("presence:update", ({ userId, online: isOnline }) => {
      setOnline((current) => {
        const next = new Set(current);
        if (isOnline) next.add(userId);
        else next.delete(userId);
        return next;
      });
    });
    socket.on("presence:snapshot", (userIds) => setOnline(new Set(userIds)));
    socket.on("call:incoming", (incoming) => {
      if (callRef.current) {
        socket.emit("call:reject", { callId: incoming.callId });
        return;
      }
      setCall({
        ...incoming,
        caller: incoming.caller,
        participants: [incoming.caller],
        status: "incoming",
      });
    });
    socket.on("chat:added", ({ chatId }) => {
      socket.emit("chat:join", { chatId });
      loadChats().catch((error) => setMessageError(error.message));
    });
    socket.on("connect_error", () => setMessageError("Live updates are reconnecting."));
    socket.on("chat:error", ({ error }) => setMessageError(error));
    return () => {
      socket.disconnect();
      setSocket(null);
    };
  }, [loadChats]);

  useEffect(() => {
    if (!selectedChatId) {
      setMessages([]);
      return;
    }
    let active = true;
    setMessages([]);
    setMessageLoading(true);
    setMessageError("");
    api(`/api/chats/${selectedChatId}/messages`)
      .then((data) => { if (active) setMessages(data.messages); })
      .catch((error) => { if (active) setMessageError(error.message); })
      .finally(() => { if (active) setMessageLoading(false); });
    return () => { active = false; };
  }, [selectedChatId]);

  async function startDirect(person) {
    try {
      const data = await api("/api/chats/direct", {
        method: "POST",
        body: JSON.stringify({ userId: person.id }),
      });
      await loadChats();
      setSelectedChatId(data.chatId);
    } catch (error) {
      setMessageError(error.message);
    }
  }

  async function createGroup(name, memberIds) {
    const data = await api("/api/chats/group", {
      method: "POST",
      body: JSON.stringify({ name, memberIds }),
    });
    await loadChats();
    setShowGroup(false);
    setSelectedChatId(data.chatId);
  }

  async function sendMessage(text) {
    setMessageError("");
    try {
      const data = await api(`/api/chats/${selectedChatId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setMessages((current) => current.some((message) => message.id === data.message.id)
        ? current
        : [...current, data.message]);
      loadChats().catch((error) => setMessageError(error.message));
      return true;
    } catch (error) {
      setMessageError(error.message);
      return false;
    }
  }

  async function sendFile(file) {
    setMessageError("");
    try {
      const data = await api(`/api/chats/${selectedChatId}/attachments`, {
        method: "POST",
        body: file,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
        },
      });
      setMessages((current) => current.some((message) => message.id === data.message.id)
        ? current
        : [...current, data.message]);
      loadChats().catch((error) => setMessageError(error.message));
      return true;
    } catch (error) {
      setMessageError(error.message);
      return false;
    }
  }

  async function downloadFile(message) {
    setMessageError("");
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/chats/${message.chat_id}/messages/${message.id}/file`,
        { credentials: "include" },
      );
      if (!response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const data = await response.json();
          throw new Error(data.error ?? "Could not download the file.");
        }
        throw new Error("Could not download the file.");
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = message.attachment.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      setMessageError(error.message);
    }
  }

  function startCall(mode) {
    if (!socket?.connected) {
      setMessageError("Connecting to the call service. Please try again in a moment.");
      return;
    }
    if (chatMemberCount(selectedChat) > 6) {
      setMessageError("Calls currently support up to 6 people.");
      return;
    }
    setMessageError("");
    setCall({
      requestId: crypto.randomUUID(),
      chatId: selectedChat.id,
      chatTitle: chatName(selectedChat),
      mode,
      status: "outgoing",
      participants: [],
    });
  }

  return (
    <main className="app-shell">
      <Sidebar
        chats={chats}
        onLogout={onLogout}
        onNewGroup={() => setShowGroup(true)}
        onSelectChat={setSelectedChatId}
        onStartDirect={startDirect}
        online={online}
        people={people}
        selectedChatId={selectedChatId}
        user={user}
        mode={sidebarMode}
        onModeChange={setSidebarMode}
      />
      {selectedChat ? (
        <ChatView
          chat={selectedChat}
          error={messageError}
          key={selectedChatId}
          loading={messageLoading}
          messages={messages}
          onBack={() => setSelectedChatId(null)}
          onDownloadFile={downloadFile}
          onSendFile={sendFile}
          onStartCall={startCall}
          onSend={sendMessage}
          online={online}
          user={user}
        />
      ) : (
        <EmptyConversation error={messageError} onFindPeople={() => setSidebarMode("people")} />
      )}
      {showGroup && <GroupModal people={people} onClose={() => setShowGroup(false)} onCreate={createGroup} />}
      {call && (
        <CallOverlay
          call={call}
          onChange={setCall}
          onClose={() => setCall(null)}
          socket={socket}
          user={user}
        />
      )}
      {appError && <div className="app-toast" role="alert">{appError}</div>}
    </main>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [appError, setAppError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api("/api/me")
      .then((data) => {
        setUser(data.user);
        setSessionError("");
      })
      .catch((error) => {
        if (error.status === 401) {
          setUser(null);
          setSessionError("");
        } else {
          setSessionError(error.message);
        }
      })
      .finally(() => setCheckingSession(false));
  }, [attempt]);

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      setAppError("");
      setUser(null);
    } catch (error) {
      setAppError(`Could not sign out: ${error.message}`);
    }
  }

  if (checkingSession) {
    return <main className="loading-screen"><span className="brand-mark"><MessageCircle size={21} fill="currentColor" /></span></main>;
  }
  if (sessionError) {
    return (
      <main className="session-error">
        <span className="brand-mark"><MessageCircle size={21} fill="currentColor" /></span>
        <h1>Orbit is having trouble connecting.</h1>
        <p>{sessionError}</p>
        <button className="primary-button" onClick={() => { setCheckingSession(true); setAttempt((value) => value + 1); }}>
          Try again
        </button>
      </main>
    );
  }
  return user
    ? <ChatApp appError={appError} key={user.id} user={user} onLogout={logout} />
    : <AuthScreen onAuthenticated={setUser} />;
}
