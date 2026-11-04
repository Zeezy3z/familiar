; Included by electron-builder's NSIS script (electron-builder.yml nsis.include).
; Uninstalling removes the "start with Windows" entry the app registers (main.ts applyLoginItem), so
; it does not point at a deleted Familiar.exe. An update also runs the old uninstaller; it keeps the
; entry then (the new version re-registers it on its next start anyway). The copied addon in WoW and
; %APPDATA%\Familiar are left in place (docs/releasing.md).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Familiar"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Familiar"
  ${endIf}
!macroend
