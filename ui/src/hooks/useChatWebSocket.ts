import { useEffect, useRef } from "react";

export function useChatWebSocket(props: {
  channelId: string | null;
  sessionId: string | null;
  getLastSeq(): number;
  onMessage(data: unknown): void;
}) {
  const { channelId, sessionId, getLastSeq, onMessage } = props;
  const lastSeqRef = useRef(getLastSeq);
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    lastSeqRef.current = getLastSeq;
    onMessageRef.current = onMessage;
  }, [getLastSeq, onMessage]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;
    let attempts = 0;

    const connect = () => {
      if (disposed) {
        return;
      }

      socket = new WebSocket(buildChatWsUrl(window.location));

      socket.addEventListener("open", () => {
        attempts = 0;
        if (!channelId) {
          return;
        }

        socket?.send(
          JSON.stringify({
            type: "subscribe",
            channelId,
            sessionId,
            lastSeq: lastSeqRef.current(),
          }),
        );
      });

      socket.addEventListener("message", (event) => {
        onMessageRef.current(event.data);
      });

      socket.addEventListener("close", () => {
        if (disposed) {
          return;
        }

        const nextDelay = Math.min(5_000, 500 * 2 ** attempts);
        attempts += 1;
        reconnectTimer = window.setTimeout(connect, nextDelay);
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [channelId, sessionId]);
}

function buildChatWsUrl(location: Location) {
  const url = new URL("/ws", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
