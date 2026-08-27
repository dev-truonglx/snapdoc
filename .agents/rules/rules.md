---
trigger: always_on
---

Luôn đảm bảo các chức năng khác hoạt động tốt
chỉ sửa code của tính năng đang làm
nếu có sửa code ảnh hưởng tới tính năng khác hãy báo lại
quan trọng: chỉ sửa code trong phạm vi task, không sửa ảnh hưởng task khác
luôn kiểm tra lỗi build (npm run build) sau khi sửa code