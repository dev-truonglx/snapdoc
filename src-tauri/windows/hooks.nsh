; SnapDoc NSIS installer hooks
; Đăng ký "Capabilities" để Windows 10/11 nhận SnapDoc trong "Open with" list
; cho các file ảnh. Thiếu key này → app bị ẩn dù APP_ASSOCIATE đã ghi registry.
;
; Cấu trúc registry theo Windows App Registration spec:
; HKCU\Software\SnapDoc\Capabilities
;   FileAssociations\  .ext → ProgID

!macro NSIS_HOOK_POSTINSTALL
  ; Khai báo Capabilities — Windows đọc key này để build "Open with" list
  WriteRegStr SHCTX "Software\SnapDoc\Capabilities" "ApplicationName"        "SnapDoc"
  WriteRegStr SHCTX "Software\SnapDoc\Capabilities" "ApplicationDescription" "Fast screenshot and image annotation editor"

  ; Map từng extension → ProgID (phải khớp với name trong fileAssociations)
  WriteRegStr SHCTX "Software\SnapDoc\Capabilities\FileAssociations" ".png"  "SnapDoc.ImageFile"
  WriteRegStr SHCTX "Software\SnapDoc\Capabilities\FileAssociations" ".jpg"  "SnapDoc.ImageFile"
  WriteRegStr SHCTX "Software\SnapDoc\Capabilities\FileAssociations" ".jpeg" "SnapDoc.ImageFile"
  WriteRegStr SHCTX "Software\SnapDoc\Capabilities\FileAssociations" ".webp" "SnapDoc.ImageFile"
  WriteRegStr SHCTX "Software\SnapDoc\Capabilities\FileAssociations" ".bmp"  "SnapDoc.ImageFile"
  WriteRegStr SHCTX "Software\SnapDoc\Capabilities\FileAssociations" ".gif"  "SnapDoc.ImageFile"

  ; Đăng ký Capabilities vào RegisteredApplications — bắt buộc để Windows nhận
  WriteRegStr SHCTX "Software\RegisteredApplications" "SnapDoc" "Software\SnapDoc\Capabilities"

  ; Notify shell để refresh "Open with" list ngay lập tức
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Dọn sạch registry khi gỡ cài đặt
  DeleteRegKey SHCTX "Software\SnapDoc"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "SnapDoc"

  ; Notify shell
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
