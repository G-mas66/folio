!macro customInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == ""
    StrCpy $INSTDIR "D:\个人工作台\应用\${APP_FILENAME}"
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  ${EndIf}
!macroend
