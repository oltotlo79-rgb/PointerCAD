# Never terminate an editing application, including silent updates and removal.
!macro customCheckAppRunning
  nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
  Pop $R0
  ${If} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "PointerCADで編集中の文書を保存し、アプリを閉じてから、もう一度実行してください。$\r$\nSave your documents and close PointerCAD before continuing." /SD IDOK
    SetErrorLevel 2
    Quit
  ${ElseIf} $R0 != 603
    MessageBox MB_OK|MB_ICONEXCLAMATION "PointerCADが終了していることを確認できませんでした。何も変更せずに終了します。$\r$\nUnable to check whether PointerCAD is closed. No files were changed." /SD IDOK
    SetErrorLevel 3
    Quit
  ${EndIf}
!macroend

# The default builder recognizes this command-line flag even when its deletion option is false.
!macro customUnInit
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "保存した文書・設定・復元用の控えを削除する指定は、この配布版では使えません。$\r$\nRemoving saved application data is not supported by this installer." /SD IDOK
    SetErrorLevel 4
    Quit
  ${EndIf}
!macroend

# Generated from the actual packaged files; there is no recursive deletion of the install folder.
!include "${BUILD_RESOURCES_DIR}\uninstall-files.nsh"
