; ============================================================
; CaptureDesk Setup — NSIS installer (capturedesk-installer)
; Per-user install, branded MUI2 pages, full uninstaller.
; Built by scripts/build-installer.sh which defines APPSRC and OUTFILE.
; ============================================================
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!ifndef APPSRC
  !define APPSRC "../build/CaptureDesk-win32-x64"
!endif
!ifndef OUTFILE
  !define OUTFILE "../dist/CaptureDeskSetup.exe"
!endif
!ifndef ROOTDIR
  !define ROOTDIR ".."
!endif

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define PRODUCT       "CaptureDesk"
!define PRODUCTVER    "1.0.0"
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
VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "LegalCopyright" "MIT License - CaptureDesk Project"
VIAddVersionKey "FileVersion" "${PRODUCTVER}"
VIAddVersionKey "ProductVersion" "${PRODUCTVER}"

!define MUI_ICON "${ROOTDIR}/desktop/assets/icons/CaptureDesk.ico"
!define MUI_UNICON "${ROOTDIR}/desktop/assets/icons/CaptureDesk.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${ROOTDIR}/installer/assets/sidebar.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${ROOTDIR}/installer/assets/header.bmp"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\CaptureDesk.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch CaptureDesk"

; Installer pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${ROOTDIR}/LICENSE"
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

  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CaptureDesk"

  MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to remove CaptureDesk settings?$\nYour recordings in Videos\CaptureDesk are always kept." IDNO SkipData
    RMDir /r "$APPDATA\CaptureDesk"
  SkipData:
SectionEnd
