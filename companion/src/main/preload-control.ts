// Control panel preload: status/log pushes and the settings commands (ipcMain.handle("cmd"), which
// main also restricts to this window). The only preload that exposes invoke.
import { contextBridge, ipcRenderer } from "electron";
import type { ControlBridge } from "../shared/bridge";

const IN = new Set(["status", "log"]);

contextBridge.exposeInMainWorld("familiar", {
  on(channel: string, cb: (data: any) => void) {
    if (!IN.has(channel)) throw new Error("channel not allowed: " + channel);
    ipcRenderer.on(channel, (_e, data) => cb(data));
  },
  invoke(cmd: string, args?: unknown) {
    return ipcRenderer.invoke("cmd", cmd, args);
  },
} satisfies ControlBridge);
