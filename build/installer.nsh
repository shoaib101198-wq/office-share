; Allow Office Share through Windows Firewall on private/office networks
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Share"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Office Share" dir=in action=allow program="$INSTDIR\Office Share.exe" enable=yes profile=private,domain'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Office Share"'
  Delete "$APPDATA\Microsoft\Windows\SendTo\Office Share.lnk"
!macroend
