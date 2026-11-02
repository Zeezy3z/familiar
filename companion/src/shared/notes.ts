// Notices the hub writes into a quest that the catch-up list and the thread state read back. One
// home for the text and the patterns that recognise it, so a reworded note can't go unnoticed.

export const STOPPING_NOTE = "Stopping…";
export const STOPPED_NOTE = "Stopped.";
export const INTERRUPTED_NOTE = "Interrupted: Familiar was closed or restarted during this turn. Send a message to continue.";

/** A turn that stopped short (also matches "Stopping." saved by older builds). */
export const STOP_NOTICE = /^(Interrupted:|Stopped\.|Stopping[.…])/;
/** A provider's usage limit. */
export const USAGE_LIMIT_NOTICE = /usage limit reached:/i;
