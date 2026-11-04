; Included by electron-builder's NSIS script (electron-builder.yml nsis.include).
; Uninstalling removes the "start with Windows" entry the app registers (main.ts applyLoginItem), so
; it does not point at a deleted Familiar.exe, and the Claude Code the app downloaded on first run
; (%LOCALAPPDATA%\Familiar\claude, about 250 MB; fetch-claude.cjs). An update also runs the old
; uninstaller; it keeps both then (the new version re-registers the entry on its next start, and
; fetches only a Claude Code version it doesn't have). The copied addon in WoW and %APPDATA%\Familiar
; (config, saved quests, log) are left in place (docs/releasing.md).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Familiar"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Familiar"
    RMDir /r "$LOCALAPPDATA\Familiar\claude"
    RMDir "$LOCALAPPDATA\Familiar" ; only if nothing else is in it
  ${endIf}
!macroend
