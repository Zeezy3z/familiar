// Capture preload: start/stop in, decoded strip messages, stats and log lines out. Nothing else.
import { contextBridge, ipcRenderer } from "electron";
import type { CaptureBridge } from "../shared/bridge";

const IN = new Set(["start", "stop"]);
const OUT = new Set(["msgs", "stats", "log"]);

contextBridge.exposeInMainWorld("familiar", {
  on(channel: string, cb: (data: any) => void) {
    if (!IN.has(channel)) throw new Error("channel not allowed: " + channel);
    ipcRenderer.on(channel, (_e, data) => cb(data));
  },
  send(channel: string, data: unknown) {
    if (OUT.has(channel)) ipcRenderer.send(channel, data);
  },
} satisfies CaptureBridge);
