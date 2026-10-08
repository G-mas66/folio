param([long]$WindowHandle, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FolioWindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr handle, int attr, out int value, int size);
}
'@
[FolioWindowCapture]::SetProcessDPIAware() | Out-Null
$folioHandle = [IntPtr]::new($WindowHandle)
[FolioWindowCapture]::SetForegroundWindow($folioHandle) | Out-Null
$folioRect = New-Object FolioWindowCapture+Rect
if (-not [FolioWindowCapture]::GetWindowRect($folioHandle, [ref]$folioRect)) { throw 'Cannot locate the test window' }
$folioDark = 0
$folioHresult = [FolioWindowCapture]::DwmGetWindowAttribute($folioHandle, 20, [ref]$folioDark, 4)
$folioX = [Math]::Max(0, $folioRect.Left)
$folioY = [Math]::Max(0, $folioRect.Top)
$folioWidth = $folioRect.Right - $folioX
$folioHeight = [Math]::Min(160, $folioRect.Bottom - $folioY)
$folioBitmap = New-Object System.Drawing.Bitmap $folioWidth, $folioHeight
$folioGraphics = [System.Drawing.Graphics]::FromImage($folioBitmap)
try {
  $folioGraphics.CopyFromScreen($folioX, $folioY, 0, 0, $folioBitmap.Size)
  $folioBitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $folioGraphics.Dispose()
  $folioBitmap.Dispose()
}
[PSCustomObject]@{darkMode=$folioDark;hresult=$folioHresult;width=$folioWidth;height=$folioHeight;screenshot=$OutputPath} | ConvertTo-Json -Compress
