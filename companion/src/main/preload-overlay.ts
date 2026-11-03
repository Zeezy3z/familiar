// Glass preload: the renderer that parses agent markdown gets only what it draws from and its
// clicks. No settings surface, no request/response channel.
import { contextBridge, ipcRenderer } from "electron";
import type { OverlayBridge } from "../shared/bridge";

const IN = new Set(["layout", "model", "input", "vis", "sound", "speak"]);

contextBridge.exposeInMainWorld("familiar", {
  on(channel: string, cb: (data: any) => void) {
    if (!IN.has(channel)) throw new Error("channel not allowed: " + channel);
    ipcRenderer.on(channel, (_e, data) => cb(data));
  },
  action(a: unknown) {
    ipcRenderer.send("action", a);
  },
  log(s: string) {
    ipcRenderer.send("log", s);
  },
} satisfies OverlayBridge);
