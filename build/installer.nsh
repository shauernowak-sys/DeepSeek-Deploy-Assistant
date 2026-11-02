; Custom NSIS hooks for the per-user installer.
;
; Electron Builder ends the uninstall section with `RMDir /r $INSTDIR`. Everything inside the
; directory is deleted, but the directory itself can survive because it is still the uninstaller's
; working directory, leaving an empty "DeepSeek Deploy Assistant" folder behind (K-M2-11).
;
; Fix: leave the directory first, retry once, and if Windows still holds it, let a helper remove it
; after this process exits. The helper uses plain `rmdir` (no /s, no /f), so it can only ever remove
; an EMPTY directory - files the user put into the install folder are never touched.

!macro customUnInstall
  SetOutPath $TEMP
  RMDir "$INSTDIR"
  ${If} ${FileExists} "$INSTDIR"
    FileOpen $0 "$PLUGINSDIR\rmdir.bat" w
    FileWrite $0 "@echo off$\r$\n"
    FileWrite $0 "cd /d $\"$TEMP$\"$\r$\n"
    FileWrite $0 "ping -n 3 127.0.0.1 >NUL$\r$\n"
    FileWrite $0 "rmdir $\"$INSTDIR$\"$\r$\n"
    FileWrite $0 "del $\"%~f0$\"$\r$\n"
    FileClose $0
    nsExec::Exec '"$SYSDIR\cmd.exe" /C "$PLUGINSDIR\rmdir.bat"'
  ${EndIf}
!macroend