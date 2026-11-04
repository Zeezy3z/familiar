// "Check for updates": one GET to GitHub's latest release, only when the player clicks the button
// in the control panel. Never scheduled, never in the background, never downloads anything.

/** The answer the control panel shows. */
export interface CheckUpdate {
  current: string;
  latest?: string;
  /** Newer than `current`: "<latest> is out · Open the download page". */
  newer?: boolean;
  /** The release page to open (only on the player's click; see isReleasesUrl). */
  url?: string;
  prerelease?: boolean;
  error?: string;
}

/** The project's releases page (the update path: the installer or the release zip). */
export const RELEASES_URL = "https://github.com/Zeezy3z/familiar/releases";
