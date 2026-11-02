export interface BuildIdentity { commit: string | null; dirty: boolean | null }
declare const __FAMILIAR_BUILD__: BuildIdentity;

// Literal injected by build.mjs. Reading a checkout or dist metadata file here would relabel an
// already-running process after an update. Unstamped builds remain explicitly unavailable.
export const RUNNING_BUILD: Readonly<BuildIdentity> = Object.freeze(
  typeof __FAMILIAR_BUILD__ === "undefined" ? { commit: null, dirty: null } : __FAMILIAR_BUILD__,
);
