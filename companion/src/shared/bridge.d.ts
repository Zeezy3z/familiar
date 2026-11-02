// The preload bridge (src/main/preload.ts) as seen from every renderer.
export {};
declare global {
  interface Window {
    familiar: {
      on(channel: string, cb: (data: any) => void): void;
      send(channel: string, data: unknown): void;
      action(a: unknown): void;
      log(s: string): void;
      invoke(cmd: string, args?: unknown): Promise<any>;
    };
    MediaStreamTrackProcessor: any;
  }
}
