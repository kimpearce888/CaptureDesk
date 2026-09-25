; ============================================================
; CaptureDesk Setup — NSIS installer (capturedesk-installer)
; Per-user install, branded MUI2 pages, full uninstaller.
; Built by scripts/build-installer.sh which defines APPSRC and OUTFILE.
; ============================================================
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!ifndef APPSRC
  !define APPSRC "../desktop-tauri/target/release"
!endif
!ifndef ENGINESRC
  !define ENGINESRC "../desktop-tauri/native/build/Release/capturedesk-engine.exe"
!endif
!ifndef HOSTSRC
  !define HOSTSRC "../native-host-cs/publish/capturedesk-native-host.exe"
!endif
!ifndef OUTFILE
  !define OUTFILE "../dist/CaptureDeskSetup.exe"
!endif
!ifndef ROOTDIR
  !define ROOTDIR ".."
!endif
; Asset paths: Windows makensis only resolves canonical backslash paths
; reliably, while POSIX builds need forward slashes. Each file can therefore
; be overridden in full (CI passes absolute Windows paths); defaults keep the
; portable ROOTDIR-relative layout for local builds. See release.yml.
!ifndef CD_ICON_FILE
  !define CD_ICON_FILE "${ROOTDIR}/desktop/assets/icons/CaptureDesk.ico"
!endif
!ifndef CD_WELCOME_BITMAP_FILE
  !define CD_WELCOME_BITMAP_FILE "${ROOTDIR}/installer/assets/sidebar.bmp"
!endif
!ifndef CD_HEADER_BITMAP_FILE
  !define CD_HEADER_BITMAP_FILE "${ROOTDIR}/installer/assets/header.bmp"
!endif
!ifndef CD_LICENSE_FILE
  !define CD_LICENSE_FILE "${ROOTDIR}/LICENSE"
!endif
!ifndef CD_EXT_ID
  ; Chrome extension origin allowed to talk to the native host.
  !define CD_EXT_ID "REPLACE_WITH_EXTENSION_ID"
!endif

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define PRODUCT       "CaptureDesk"
!define PRODUCTVER    "2.0.0"
!define PUBLISHER     "CaptureDesk Project"
!define APPID         "com.capturedesk.desktop"
!define REGKEY        "Software\CaptureDesk"
!define UNINSTKEY     "Software\Microsoft\Windows\CurrentVersion\Uninstall\CaptureDesk"
!define UNINST_EXE    "$INSTDIR\Uninstall CaptureDesk.exe"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\CaptureDesk"
InstallDirRegKey HKCU "${REGKEY}" "InstallPath"
RequestExecutionLevel user
VIProductVersion "2.0.0.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "LegalCopyright" "MIT License - CaptureDesk Project"
VIAddVersionKey "FileVersion" "${PRODUCTVER}"
VIAddVersionKey "ProductVersion" "${PRODUCTVER}"

!define MUI_ICON "${CD_ICON_FILE}"
!define MUI_UNICON "${CD_ICON_FILE}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${CD_WELCOME_BITMAP_FILE}"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${CD_HEADER_BITMAP_FILE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\CaptureDesk.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch CaptureDesk"

; Installer pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${CD_LICENSE_FILE}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

Var DesktopShortcut

Function .onInit
  StrCpy $DesktopShortcut "1"
FunctionEnd

; --- Install sections --------------------------------------------------------

Section "CaptureDesk Desktop" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; Kill a running instance so files are replaceable on upgrade.
  DetailPrint "Closing CaptureDesk if it is running…"
  ExecWait 'taskkill /IM CaptureDesk.exe /F' $0
  Sleep 400

  File /r "${APPSRC}\*.*"

  ; CaptureDesk native engine (C++ sidecar used for capture + export)
  SetOutPath "$INSTDIR\engine"
  File "${ENGINESRC}"

  ; Native messaging host (C#) for the CaptureDesk Chrome extension
  SetOutPath "$INSTDIR\NativeHost"
  File "${HOSTSRC}"
  FileOpen $0 "$INSTDIR\NativeHost\com.capturedesk.host.json" w
  FileWrite $0 '{"name":"com.capturedesk.host","description":"CaptureDesk native messaging host","path":"$INSTDIR\\NativeHost\\capturedesk-native-host.exe","type":"stdio","allowed_origins":["chrome-extension://${CD_EXT_ID}/"]}'
  FileClose $0
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.capturedesk.host" "" "$INSTDIR\NativeHost\com.capturedesk.host.json"
  WriteRegStr HKCU "Software\Chromium\NativeMessagingHosts\com.capturedesk.host" "" "$INSTDIR\NativeHost\com.capturedesk.host.json"

  ; capturedesk:// deep-link scheme (editor launches from the extension)
  WriteRegStr HKCU "Software\Classes\capturedesk" "" "URL:CaptureDesk"
  WriteRegStr HKCU "Software\Classes\capturedesk" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\capturedesk\shell\open\command" "" '"$INSTDIR\CaptureDesk.exe" "%1"'

  ; Start Menu shortcuts
  CreateDirectory "$SMPROGRAMS\CaptureDesk"
  CreateShortCut "$SMPROGRAMS\CaptureDesk\CaptureDesk.lnk" "$INSTDIR\CaptureDesk.exe"
  CreateShortCut "$SMPROGRAMS\CaptureDesk\Uninstall CaptureDesk.lnk" "${UNINST_EXE}"

  ${If} $DesktopShortcut == "1"
    CreateShortCut "$DESKTOP\CaptureDesk.lnk" "$INSTDIR\CaptureDesk.exe"
  ${EndIf}

  ; App registry + uninstall entries (per-user)
  WriteRegStr HKCU "${REGKEY}" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "Version" "${PRODUCTVER}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${PRODUCTVER}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\CaptureDesk.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"${UNINST_EXE}"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"${UNINST_EXE}" /S'

  ; Estimated size
  ${GetSize} "$INSTDIR" "" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" $0

  WriteUninstaller "${UNINST_EXE}"
SectionEnd

Section "Desktop shortcut"
  CreateShortCut "$DESKTOP\CaptureDesk.lnk" "$INSTDIR\CaptureDesk.exe"
SectionEnd

Section /o "Start CaptureDesk at Windows startup"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CaptureDesk" '"$INSTDIR\CaptureDesk.exe" --minimized'
SectionEnd

; --- Uninstaller --------------------------------------------------------------

Section "Uninstall"
  ExecWait 'taskkill /IM CaptureDesk.exe /F' $0
  Sleep 400

  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\CaptureDesk\CaptureDesk.lnk"
  Delete "$SMPROGRAMS\CaptureDesk\CaptureDesk Recordings.lnk"
  Delete "$SMPROGRAMS\CaptureDesk\Uninstall CaptureDesk.lnk"
  RMDir "$SMPROGRAMS\CaptureDesk"
  Delete "$DESKTOP\CaptureDesk.lnk"

  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.capturedesk.host"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.capturedesk.host"
  DeleteRegKey HKCU "Software\Classes\capturedesk"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CaptureDesk"

  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to remove CaptureDesk settings?$\nYour recordings in Videos\CaptureDesk are always kept." IDNO SkipData
    RMDir /r "$APPDATA\CaptureDesk"
  SkipData:
SectionEnd
