type WebSocketCtor = typeof globalThis.WebSocket;

declare module "node:undici" {
  export const WebSocket: WebSocketCtor;
  const _default: {
    WebSocket: WebSocketCtor;
  };
  export default _default;
}

