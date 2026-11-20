;; FF-pane 安装包自定义脚本（electron-builder nsis.include）。
;; T11.20：卸载时问一句要不要同时卸载 Claude 沙盒（srt-sandbox 账户和它的网络过滤规则），默认不卸。
;; 静默卸载、升级时的自动卸载都不问、不卸：这个沙盒是 Claude Code 自己的，FF-pane 外面也可能在用。
;; 卸载走用户自己那份 Claude 的 `claude sandbox uninstall`（会弹一次管理员确认），要带内部开关才认 Windows 沙盒。

!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfSilent ffpane_sandbox_done
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "要同时卸载 Claude 沙盒吗？$\r$\n$\r$\n它是 FF-pane 的「可改+跑命令」Claude 窗口用来限制写入范围的，会删掉本机的 srt-sandbox 账户和它的网络过滤规则，Windows 会再弹一次管理员确认。$\r$\n$\r$\n如果你在 FF-pane 外面也用 Claude 沙盒，选「否」。" IDYES ffpane_sandbox_remove IDNO ffpane_sandbox_done
    ffpane_sandbox_remove:
      System::Call 'Kernel32::SetEnvironmentVariable(t "CLAUDE_CODE_NANKEEN_KESTREL", t "1")i'
      nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c claude sandbox uninstall --json'
      Pop $0
      StrCmp $0 "0" ffpane_sandbox_done
      MessageBox MB_OK|MB_ICONEXCLAMATION "Claude 沙盒没卸成功（返回 $0）。可以之后在 PowerShell 里运行：claude sandbox uninstall"
    ffpane_sandbox_done:
  ${endIf}
!macroend
