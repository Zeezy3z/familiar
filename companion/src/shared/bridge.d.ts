// The preload bridges as seen from each renderer: every window gets its own preload
// (src/main/preload-{control,overlay,capture}.ts) exposing only what that page uses.
export interface ControlBridge {
  on(channel: string, cb: (data: any) => void): void;
  invoke(cmd: string, args?: unknown): Promise<any>;
}
export interface OverlayBridge {
  on(channel: string, cb: (data: any) => void): void;
  action(a: unknown): void;
  log(s: string): void;
}
export interface CaptureBridge {
  on(channel: string, cb: (data: any) => void): void;
  send(channel: string, data: unknown): void;
}
declare global {
  interface Window {
    /** Each renderer narrows this to its own bridge type (its `bridge` constant). */
    familiar: ControlBridge | OverlayBridge | CaptureBridge;
    MediaStreamTrackProcessor: any;
  }
}
