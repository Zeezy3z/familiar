// Shared preload: a narrow, whitelisted IPC bridge for the capture, overlay and control pages.
import { contextBridge, ipcRenderer } from "electron";

const IN = new Set(["start", "stop", "layout", "model", "input", "vis", "sound", "speak", "status", "log", "debug"]);
const OUT = new Set(["msgs", "stats", "log", "action", "ready"]);

contextBridge.exposeInMainWorld("familiar", {
  on(channel: string, cb: (data: unknown) => void) {
    if (!IN.has(channel)) throw new Error("channel not allowed: " + channel);
    ipcRenderer.on(channel, (_e, data) => cb(data));
  },
  send(channel: string, data: unknown) {
    if (OUT.has(channel)) ipcRenderer.send(channel, data);
  },
  action(a: unknown) {
    ipcRenderer.send("action", a);
  },
  log(s: string) {
    ipcRenderer.send("log", s);
  },
  invoke(cmd: string, args?: unknown) {
    return ipcRenderer.invoke("cmd", cmd, args);
  },
});
