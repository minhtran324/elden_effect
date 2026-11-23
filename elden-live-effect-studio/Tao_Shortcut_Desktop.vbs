Set WshShell = CreateObject("WScript.Shell")
strDesktop = WshShell.SpecialFolders("Desktop")
strCurrentDir = WshShell.CurrentDirectory

Set oShortcut = WshShell.CreateShortcut(strDesktop & "\LiveEffect Studio.lnk")
oShortcut.TargetPath = strCurrentDir & "\KhoiDong_Studio.bat"
oShortcut.WorkingDirectory = strCurrentDir
oShortcut.Description = "Khoi dong LiveEffect Studio & Hu Qua TikTok Live"
oShortcut.WindowStyle = 1
oShortcut.Save

WScript.Echo "Da tao bieu tuong 'LiveEffect Studio' tren man hinh Desktop thanh cong!"
