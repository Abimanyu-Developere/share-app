import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  Mic,
  MicOff,
  MonitorUp,
  Phone,
  PhoneOff,
  X,
} from "lucide-react";

const rtcConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(10_000).emit(event, payload, (timeoutError, response) => {
      if (timeoutError) {
        reject(new Error("The call service did not respond. Please try again."));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function displayCallTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  return `${minutes}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export default function CallOverlay({ call, socket, user, onChange, onClose }) {
  const [localStream, setLocalStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [remotePeers, setRemotePeers] = useState([]);
  const [cameraEnabled, setCameraEnabled] = useState(call.mode === "video");
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const [callError, setCallError] = useState("");
  const [callNotice, setCallNotice] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const peersRef = useRef(new Map());
  const callRef = useRef(call);
  const localVideoRef = useRef(null);
  callRef.current = call;
  localStreamRef.current = localStream;
  screenStreamRef.current = screenStream;

  const sendSignal = useCallback((peerId, signal) => {
    const activeCallId = callRef.current.callId;
    if (!activeCallId) return;
    socket.emit("call:signal", {
      callId: activeCallId,
      to: peerId,
      signal,
    }, (response) => {
      if (response?.error) setCallError(response.error);
    });
  }, [socket]);

  const releaseMedia = useCallback(() => {
    for (const record of peersRef.current.values()) record.connection.close();
    peersRef.current.clear();
    setRemotePeers([]);
    for (const track of screenStreamRef.current?.getTracks() ?? []) track.onended = null;
    stopStream(screenStreamRef.current);
    stopStream(localStreamRef.current);
    screenStreamRef.current = null;
    localStreamRef.current = null;
    setScreenStream(null);
    setLocalStream(null);
  }, []);

  const createPeerConnection = useCallback((peer) => {
    const existing = peersRef.current.get(peer.id);
    if (existing) return existing;

    const connection = new RTCPeerConnection(rtcConfiguration);
    const videoSender = connection.addTransceiver("video", { direction: "sendrecv" }).sender;
    const stream = localStreamRef.current;
    if (stream) {
      for (const track of stream.getAudioTracks()) connection.addTrack(track, stream);
    }
    const cameraTrack = screenStreamRef.current?.getVideoTracks()[0] ?? stream?.getVideoTracks()[0];
    const record = {
      connection,
      videoSender,
      pendingCandidates: [],
      ready: cameraTrack ? videoSender.replaceTrack(cameraTrack) : Promise.resolve(),
    };

    connection.ontrack = (event) => {
      const current = peersRef.current.get(peer.id);
      if (!current) return;
      const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      setRemotePeers((peers) => {
        const next = new Map(peers.map((item) => [item.user.id, item]));
        next.set(peer.id, { user: peer, stream: remoteStream });
        return [...next.values()];
      });
    };
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(peer.id, { candidate: event.candidate.toJSON() });
      }
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed") {
        setCallError(`Could not connect to ${peer.displayName}. Check your network and try again.`);
      }
    };

    peersRef.current.set(peer.id, record);
    return record;
  }, [sendSignal]);

  const createOffer = useCallback(async (peer) => {
    const record = createPeerConnection(peer);
    await record.ready;
    if (record.connection.signalingState !== "stable") return;
    const offer = await record.connection.createOffer();
    await record.connection.setLocalDescription(offer);
    sendSignal(peer.id, { description: record.connection.localDescription.toJSON() });
  }, [createPeerConnection, sendSignal]);

  const acceptIncomingCall = useCallback(async () => {
    setCallError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: call.mode === "video",
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      const response = await emitWithAck(socket, "call:join", { callId: call.callId });
      onChange((current) => current?.callId === call.callId
        ? { ...current, status: "active", participants: response.participants }
        : current);
    } catch (error) {
      setCallError(error.message);
      if (localStreamRef.current) {
        stopStream(localStreamRef.current);
        localStreamRef.current = null;
        setLocalStream(null);
      }
    }
  }, [call.callId, call.mode, onChange, socket]);

  useEffect(() => {
    if (call.status !== "outgoing") return undefined;
    let cancelled = false;
    let pendingStream;

    async function startCall() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera and microphone access is not available in this browser.");
        }
        pendingStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: call.mode === "video",
        });
        if (cancelled) {
          stopStream(pendingStream);
          return;
        }
        localStreamRef.current = pendingStream;
        setLocalStream(pendingStream);
        const response = await emitWithAck(socket, "call:start", {
          chatId: call.chatId,
          mode: call.mode,
        });
        if (cancelled) {
          stopStream(pendingStream);
          socket.emit("call:leave", { callId: response.callId });
          return;
        }
        onChange((current) => current?.requestId === call.requestId
          ? {
            ...current,
            ...response,
            status: "ringing",
            participants: response.participants,
          }
          : current);
      } catch (error) {
        if (!cancelled) {
          stopStream(pendingStream);
          localStreamRef.current = null;
          setLocalStream(null);
          setCallError(error.message);
          onChange((current) => current?.requestId === call.requestId
            ? { ...current, status: "failed" }
            : current);
        }
      }
    }

    startCall();
    return () => {
      cancelled = true;
      if (pendingStream && callRef.current.status !== "active" &&
          callRef.current.status !== "ringing") {
        stopStream(pendingStream);
      }
    };
  }, [call.requestId]);

  useEffect(() => {
    if (!call.callId) return undefined;

    const onPeerJoined = ({ callId, peer }) => {
      if (callId !== callRef.current.callId || peer.id === user.id) return;
      onChange((current) => {
        if (current?.callId !== callId) return current;
        const participants = [...(current.participants ?? [])];
        if (!participants.some((participant) => participant.id === peer.id)) participants.push(peer);
        return { ...current, status: "active", participants };
      });
      if (user.id.localeCompare(peer.id) < 0) {
        createOffer(peer).catch((error) => setCallError(error.message));
      } else {
        createPeerConnection(peer);
      }
    };

    const onPeerLeft = ({ callId, userId }) => {
      if (callId !== callRef.current.callId) return;
      const record = peersRef.current.get(userId);
      record?.connection.close();
      peersRef.current.delete(userId);
      setRemotePeers((peers) => peers.filter((peer) => peer.user.id !== userId));
      onChange((current) => current?.callId === callId
        ? { ...current, participants: current.participants.filter((peer) => peer.id !== userId) }
        : current);
    };

    const onSignal = async ({ callId, from, signal }) => {
      if (callId !== callRef.current.callId) return;
      try {
        const record = createPeerConnection(from);
        await record.ready;
        if (signal.description) {
          await record.connection.setRemoteDescription(signal.description);
          for (const candidate of record.pendingCandidates.splice(0)) {
            await record.connection.addIceCandidate(candidate);
          }
          if (signal.description.type === "offer") {
            const answer = await record.connection.createAnswer();
            await record.connection.setLocalDescription(answer);
            sendSignal(from.id, { description: record.connection.localDescription.toJSON() });
          }
        } else if (signal.candidate) {
          if (record.connection.remoteDescription) {
            await record.connection.addIceCandidate(signal.candidate);
          } else {
            record.pendingCandidates.push(signal.candidate);
          }
        }
      } catch (error) {
        setCallError(`Could not establish the call: ${error.message}`);
      }
    };

    const onRejected = ({ callId, peer }) => {
      if (callId === callRef.current.callId) {
        setCallNotice(`${peer.displayName} declined the call.`);
      }
    };

    const onEnded = ({ callId, reason }) => {
      if (callId !== callRef.current.callId) return;
      releaseMedia();
      onChange((current) => current?.callId === callId
        ? { ...current, status: "ended", endReason: reason }
        : current);
    };

    const onError = ({ error }) => setCallError(error);
    socket.on("call:peer-joined", onPeerJoined);
    socket.on("call:peer-left", onPeerLeft);
    socket.on("call:signal", onSignal);
    socket.on("call:peer-rejected", onRejected);
    socket.on("call:ended", onEnded);
    socket.on("call:error", onError);

    return () => {
      socket.off("call:peer-joined", onPeerJoined);
      socket.off("call:peer-left", onPeerLeft);
      socket.off("call:signal", onSignal);
      socket.off("call:peer-rejected", onRejected);
      socket.off("call:ended", onEnded);
      socket.off("call:error", onError);
    };
  }, [call.callId, createOffer, createPeerConnection, onChange, releaseMedia, sendSignal, socket, user.id]);

  useEffect(() => {
    if (call.status !== "active") return undefined;
    const timer = setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [call.status, call.callId]);

  useEffect(() => {
    const preview = screenStream ?? localStream;
    if (localVideoRef.current && preview && localVideoRef.current.srcObject !== preview) {
      localVideoRef.current.srcObject = preview;
    }
  }, [localStream, screenStream]);

  useEffect(() => () => releaseMedia(), [releaseMedia]);

  async function stopScreenShare() {
    const display = screenStreamRef.current;
    if (!display) return;
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] ?? null;
    for (const record of peersRef.current.values()) {
      await record.videoSender.replaceTrack(cameraTrack);
    }
    display.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    screenStreamRef.current = null;
    setScreenStream(null);
  }

  async function shareScreen() {
    setCallError("");
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("Screen sharing is not available in this browser.");
      }
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = display.getVideoTracks()[0];
      if (!track) {
        stopStream(display);
        throw new Error("No screen was selected for sharing.");
      }
      screenStreamRef.current = display;
      setScreenStream(display);
      for (const record of peersRef.current.values()) {
        await record.videoSender.replaceTrack(track);
      }
      track.onended = () => {
        stopScreenShare().catch((error) => setCallError(error.message));
      };
    } catch (error) {
      if (error.name !== "NotAllowedError") setCallError(error.message);
    }
  }

  function toggleMicrophone() {
    const nextEnabled = !microphoneEnabled;
    for (const track of localStreamRef.current?.getAudioTracks() ?? []) {
      track.enabled = nextEnabled;
    }
    setMicrophoneEnabled(nextEnabled);
  }

  function toggleCamera() {
    const nextEnabled = !cameraEnabled;
    for (const track of localStreamRef.current?.getVideoTracks() ?? []) {
      track.enabled = nextEnabled;
    }
    setCameraEnabled(nextEnabled);
  }

  function closeCall() {
    if (call.callId) socket.emit("call:leave", { callId: call.callId });
    onClose();
  }

  function declineCall() {
    socket.emit("call:reject", { callId: call.callId });
    onClose();
  }

  const title = call.chatName || call.caller?.displayName || call.chatTitle || "Orbit call";
  const callStatus = call.status === "incoming"
    ? `${call.mode === "video" ? "Video" : "Voice"} call from ${call.caller?.displayName ?? "your friend"}`
    : call.status === "outgoing"
      ? "Getting your camera and microphone ready…"
      : call.status === "ringing"
        ? "Calling…"
        : call.status === "ended"
          ? call.endReason === "no-answer" ? "No one answered." : "Call ended"
          : call.status === "failed"
            ? "Could not start the call."
            : `${displayCallTime(elapsedSeconds)} · ${remotePeers.length ? "Connected" : "Waiting for others…"}`;

  return (
    <div className="call-backdrop">
      <section className={`call-window ${remotePeers.some((peer) => peer.stream.getVideoTracks().length) ? "call-window-video" : ""}`}
        aria-label="Call"
        aria-modal="true"
        role="dialog"
      >
        <header className="call-header">
          <div className="call-header-brand"><span className="brand-mark"><Phone size={16} fill="currentColor" /></span><span>orbit<span className="brand-period">.</span></span></div>
          <div className="call-header-name">
            <strong>{title}</strong>
            <span className={call.status === "active" ? "call-connected" : ""}>{callStatus}</span>
          </div>
          <button className="call-close" onClick={closeCall} aria-label="Close call"><X size={19} /></button>
        </header>

        {call.status === "incoming" ? (
          <div className="call-incoming">
            <div className={`call-avatar avatar-${call.caller?.id ? "lavender" : "peach"}`}>
              {(call.caller?.displayName ?? "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}
              <span className="call-ring" />
            </div>
            <span className="call-eyebrow">INCOMING {call.mode === "video" ? "VIDEO" : "VOICE"} CALL</span>
            <h2>{call.caller?.displayName ?? "Someone"} is calling</h2>
            <p>{call.chatName || "Pick up and say hello."}</p>
            {callError && <p className="call-error" role="alert">{callError}</p>}
            <div className="call-actions">
              <button className="call-action call-decline" onClick={declineCall} aria-label="Decline call"><PhoneOff size={20} /></button>
              <button className="call-action call-accept" onClick={acceptIncomingCall} aria-label="Accept call"><Phone size={20} /></button>
            </div>
            <div className="call-action-labels"><span>Decline</span><span>Answer</span></div>
          </div>
        ) : call.status === "ended" || call.status === "failed" ? (
          <div className="call-ended">
            <span className="call-ended-icon"><PhoneOff size={24} /></span>
            <h2>{callStatus}</h2>
            {callError && <p className="call-error" role="alert">{callError}</p>}
            <button className="call-finish-button" onClick={closeCall}>Close</button>
          </div>
        ) : (
          <div className="call-stage">
            {remotePeers.length ? (
              <div className={`call-peer-grid ${remotePeers.length > 1 ? "call-peer-grid-group" : ""}`}>
                {remotePeers.map(({ user: peer, stream }) => {
                  const hasVideo = stream.getVideoTracks().some((track) => track.readyState === "live");
                  return (
                    <article className={`call-peer-tile ${hasVideo ? "has-video" : ""}`} key={peer.id}>
                      {hasVideo
                        ? <video autoPlay playsInline ref={(element) => { if (element && element.srcObject !== stream) element.srcObject = stream; }} />
                        : <div className={`call-peer-avatar avatar-${peer.id ? "lavender" : "peach"}`}>{peer.displayName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</div>}
                      {!hasVideo && <audio autoPlay ref={(element) => { if (element && element.srcObject !== stream) element.srcObject = stream; }} />}
                      <span className="call-peer-name">{peer.displayName}</span>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="call-waiting">
                <span className="call-waiting-orbit orbit-outer" />
                <span className="call-waiting-orbit orbit-inner" />
                <div className="call-waiting-avatar"><Phone size={29} /></div>
                <span className="call-waiting-label">{call.status === "ringing" ? "RINGING" : "STARTING CALL"}</span>
                <strong>{title}</strong>
                <span>{callStatus}</span>
              </div>
            )}
            {localStream && (screenStream || localStream.getVideoTracks().length > 0) && (
              <div className={`call-local-preview ${screenStream ? "call-sharing-preview" : ""}`}>
                <video autoPlay muted playsInline ref={localVideoRef} />
                <span>{screenStream ? "You’re sharing your screen" : "You"}</span>
              </div>
            )}
            {(callError || callNotice) && (
              <p className={callError ? "call-error call-toast" : "call-notice"} role="status">
                {callError || callNotice}
              </p>
            )}
          </div>
        )}

        {call.status !== "incoming" && call.status !== "ended" && call.status !== "failed" && (
          <footer className="call-controls">
            <button className={`call-control ${microphoneEnabled ? "" : "call-control-off"}`}
              disabled={!localStream}
              onClick={toggleMicrophone}
              title={microphoneEnabled ? "Mute microphone" : "Unmute microphone"}
              aria-label={microphoneEnabled ? "Mute microphone" : "Unmute microphone"}>
              {microphoneEnabled ? <Mic size={19} /> : <MicOff size={19} />}
              <span>{microphoneEnabled ? "Mute" : "Unmute"}</span>
            </button>
            {call.mode === "video" && (
              <button className={`call-control ${cameraEnabled ? "" : "call-control-off"}`}
                disabled={!localStream}
                onClick={toggleCamera}
                title={cameraEnabled ? "Turn camera off" : "Turn camera on"}
                aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}>
                {cameraEnabled ? <Camera size={19} /> : <CameraOff size={19} />}
                <span>Camera</span>
              </button>
            )}
            <button className={`call-control ${screenStream ? "call-control-sharing" : ""}`}
              disabled={!localStream || call.status === "outgoing"}
              onClick={screenStream ? () => stopScreenShare().catch((error) => setCallError(error.message)) : shareScreen}
              title={screenStream ? "Stop sharing screen" : "Share your screen"}
              aria-label={screenStream ? "Stop sharing screen" : "Share your screen"}>
              <MonitorUp size={19} />
              <span>{screenStream ? "Stop share" : "Share screen"}</span>
            </button>
            <button className="call-end-button" onClick={closeCall} title="End call" aria-label="End call">
              {call.status === "outgoing" || call.status === "ringing"
                ? <PhoneOff size={19} />
                : <Phone size={19} className="call-hangup-icon" />}
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}
