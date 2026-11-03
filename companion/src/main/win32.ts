// Win32 via koffi (no native compile). Read-only window queries only: we never send messages,
// input or focus to the game. Handles are opaque pointers (BigInt-backed in koffi 3.x).
import koffi from "koffi";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const dwmapi = koffi.load("dwmapi.dll");

const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
koffi.alias("HWND", HANDLE);
koffi.struct("RECT", { left: "int32_t", top: "int32_t", right: "int32_t", bottom: "int32_t" });
koffi.struct("POINT", { x: "int32_t", y: "int32_t" });
const EnumWindowsProc = koffi.proto("bool __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)");

const EnumWindows = user32.func("bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)");
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(HWND hWnd)");
const IsWindow = user32.func("bool __stdcall IsWindow(HWND hWnd)");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(HWND hWnd, _Out_ uint8_t *lpString, int nMaxCount)");
const GetClassNameW = user32.func("int __stdcall GetClassNameW(HWND hWnd, _Out_ uint8_t *lpClassName, int nMaxCount)");
const GetWindowThreadProcessId = user32.func("uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *lpdwProcessId)");
const GetClientRect = user32.func("bool __stdcall GetClientRect(HWND hWnd, _Out_ RECT *lpRect)");
const ClientToScreen = user32.func("bool __stdcall ClientToScreen(HWND hWnd, _Inout_ POINT *lpPoint)");
const GetForegroundWindow = user32.func("HWND __stdcall GetForegroundWindow()");
const IsIconic = user32.func("bool __stdcall IsIconic(HWND hWnd)");
const SetWindowPos = user32.func("bool __stdcall SetWindowPos(HWND hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)");
const GetWindowLongPtrW = user32.func("intptr_t __stdcall GetWindowLongPtrW(HWND hWnd, int nIndex)");
const SetWindowLongPtrW = user32.func("intptr_t __stdcall SetWindowLongPtrW(HWND hWnd, int nIndex, intptr_t dwNewLong)");
// Read-only input state (to keep the overlay on a window the player is dragging); nothing is sent.
const GetCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ POINT *lpPoint)");
const GetAsyncKeyState = user32.func("int16_t __stdcall GetAsyncKeyState(int vKey)");
const OpenProcess = kernel32.func("HANDLE __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)");
const QueryFullProcessImageNameW = kernel32.func(
  "bool __stdcall QueryFullProcessImageNameW(HANDLE hProcess, uint32_t dwFlags, _Out_ uint8_t *lpExeName, _Inout_ uint32_t *lpdwSize)",
);
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(HANDLE hObject)");
const DwmGetWindowAttribute = dwmapi.func("int32_t __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t dwAttribute, _Out_ RECT *pvAttribute, uint32_t cbAttribute)");

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

export type Hwnd = bigint; // koffi 3.x represents handles as BigInt

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const hwndKey = (h: Hwnd | null | undefined): string => (h ? String(h) : "0");

export function hwndFromBuffer(buf: Buffer): Hwnd {
  return buf.readBigUInt64LE(0);
}

function windowText(hwnd: Hwnd) {
  const buf = Buffer.alloc(512 * 2);
  const n = GetWindowTextW(hwnd, buf, 512);
  return buf.toString("utf16le", 0, n * 2);
}

function className(hwnd: Hwnd) {
  const buf = Buffer.alloc(256 * 2);
  const n = GetClassNameW(hwnd, buf, 256);
  return buf.toString("utf16le", 0, n * 2);
}

function windowPid(hwnd: Hwnd): number {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

function processImagePath(pid: number): string | null {
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return null;
  try {
    const buf = Buffer.alloc(1024 * 2);
    const size = [1024];
    if (!QueryFullProcessImageNameW(h, 0, buf, size)) return null;
    return buf.toString("utf16le", 0, size[0] * 2);
  } finally {
    CloseHandle(h);
  }
}

export interface GameWindow {
  hwnd: Hwnd;
  key: string;
  pid: number;
  exe: string;
  /** Full image path of the game process ("" when it could not be read). */
  path: string;
  title: string;
  cls: string;
}

const EXE_RE = /^wow[a-z0-9-]*\.exe$/i; // Wow.exe, WowB.exe (beta), WowT.exe (PTR), WowClassic.exe, Wow-ARM64.exe, ...

/**
 * Find the World of Warcraft game window (largest visible top-level window of a Wow*.exe).
 * FAMILIAR_TARGET_TITLE (dev/test) targets a window by exact title instead, e.g. "FakeWoW".
 */
export function findGameWindow(): GameWindow | null {
  const targetTitle = process.env.FAMILIAR_TARGET_TITLE;
  const found: GameWindow[] = [];
  const cb = koffi.register((hwnd: Hwnd) => {
    try {
      if (!IsWindowVisible(hwnd)) return true;
      const pid = windowPid(hwnd);
      const img = processImagePath(pid);
      const exe = img ? img.split("\\").pop() ?? "" : "";
      if (targetTitle ? windowText(hwnd) !== targetTitle : !EXE_RE.test(exe)) return true;
      const cls = className(hwnd);
      if (/^(IME|MSCTFIME|Default IME)/i.test(cls)) return true;
      found.push({ hwnd, key: hwndKey(hwnd), pid, exe, path: img ?? "", title: windowText(hwnd), cls });
    } catch {
      /* window vanished */
    }
    return true;
  }, koffi.pointer(EnumWindowsProc));
  try {
    EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  if (!found.length) return null;
  found.sort((a, b) => area(clientRectOnScreen(b.hwnd)) - area(clientRectOnScreen(a.hwnd)));
  return found[0];
}

const area = (r: Rect | null) => (r ? r.width * r.height : 0);

export function isWindow(h: Hwnd) {
  return !!h && IsWindow(h);
}

/** Client area in physical screen pixels (Electron is per-monitor DPI aware). */
export function clientRectOnScreen(hwnd: Hwnd): Rect | null {
  const r: any = {};
  if (!GetClientRect(hwnd, r)) return null;
  const p: any = { x: 0, y: 0 };
  if (!ClientToScreen(hwnd, p)) return null;
  return { x: p.x, y: p.y, width: r.right - r.left, height: r.bottom - r.top };
}

/** What Windows.Graphics.Capture captures for a window (includes the title bar when windowed). */
export function extendedFrameBounds(hwnd: Hwnd): Rect | null {
  const r: any = {};
  if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) !== 0) return null;
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

export function foregroundKey(): string {
  return hwndKey(GetForegroundWindow());
}

export function isMinimized(h: Hwnd) {
  return !!IsIconic(h);
}

/** Overlay window hygiene: hide from Alt-Tab and re-assert topmost without activating. */
export function makeToolWindow(h: Hwnd) {
  const GWL_EXSTYLE = -20;
  const cur = Number(GetWindowLongPtrW(h, GWL_EXSTYLE));
  SetWindowLongPtrW(h, GWL_EXSTYLE, cur | 0x80 /*TOOLWINDOW*/ | 0x08000000 /*NOACTIVATE*/ | 0x20 /*TRANSPARENT*/);
}

export function reassertTopmost(h: Hwnd) {
  const SWP_NOSIZE = 0x1,
    SWP_NOMOVE = 0x2,
    SWP_NOACTIVATE = 0x10;
  SetWindowPos(h, -1, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
}

/** Mouse cursor position in screen pixels (read-only). */
export function cursorPos(): { x: number; y: number } | null {
  const p = { x: 0, y: 0 };
  return GetCursorPos(p) ? p : null;
}

/** Whether a mouse button is held right now (read-only). The primary button is VK_LBUTTON unless
 * the user swapped buttons; either counts as "still dragging". */
export function mouseButtonDown(): boolean {
  return (GetAsyncKeyState(0x01) & 0x8000) !== 0 || (GetAsyncKeyState(0x02) & 0x8000) !== 0;
}

/** Whether the primary (left) mouse button is held right now (read-only). */
export function leftButtonDown(): boolean {
  return (GetAsyncKeyState(0x01) & 0x8000) !== 0;
}

/** Whether the right mouse button is held right now (read-only). */
export function rightButtonDown(): boolean {
  return (GetAsyncKeyState(0x02) & 0x8000) !== 0;
}

/** Whether a virtual key is held right now (read-only global key state: no hook, nothing is sent). */
export function keyDown(vk: number): boolean {
  return (GetAsyncKeyState(vk) & 0x8000) !== 0;
}
