; Installer hooks (tauri.conf.json bundle.windows.nsis.installerHooks), run
; by every install — including an update, which the updater runs silently.

!macro NSIS_HOOK_POSTINSTALL
  ; .ref files show their own icon (the page), not the app's.
  ; ("RefThing board" is the file class tauri.conf.json's association names.)
  WriteRegStr SHCTX "Software\Classes\RefThing board\DefaultIcon" "" "$\"$INSTDIR\ref-file.ico$\""

  ; An update keeps the existing desktop and Start menu shortcuts as they
  ; are, and Explorer keeps showing their cached icon. Re-point them at the
  ; app so they pick up its new icon.
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}

  ; Tell Explorer that icons and file associations changed
  ; (SHCNE_ASSOCCHANGED, flushed): it refreshes its icon cache, so the
  ; desktop, the taskbar and .ref files show the new icons right away.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend
