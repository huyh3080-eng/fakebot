# Cập nhật app mà không mất dữ liệu

## Dữ liệu được lưu ở đâu?

- **Windows:** `%APPDATA%\Oceandeep Bot Panel\`  
  (hoặc `...\Oceandeep Bot Panel\profile-<tên>\` nếu dùng profile)
- Trong đó:
  - `data.yml` — toàn bộ config (IP, port, bot, lệnh, delay, v.v.)
  - `chat-debug.log` — log debug chat (nếu bật)

Khi bạn **cập nhật** app (thay file .exe hoặc cả thư mục app), **thư mục trên không bị ghi đè**. Chỉ phần chương trình được thay; dữ liệu vẫn nằm trong AppData.

## Cách cập nhật an toàn

1. **Chỉ thay file chương trình**  
   Ghi đè (hoặc thay thế) file .exe / thư mục app bằng bản mới. **Không** xóa thư mục `%APPDATA%\Oceandeep Bot Panel\`.

2. **Nếu muốn backup trước khi cập nhật**  
   - Copy cả thư mục `Oceandeep Bot Panel` trong AppData ra chỗ khác (ví dụ Desktop).  
   - Sau khi cập nhật, config cũ vẫn được dùng từ AppData; chỉ cần restore lại thư mục đó nếu có sự cố.

3. **Sau khi cập nhật**  
   - App vẫn đọc `data.yml` cũ.  
   - **Tính năng mới** sẽ có thêm ô/config mới; giá trị mặc định được thêm vào, **không** làm mất config cũ (IP, bot, lệnh, delay, v.v.).

## Kỹ thuật (cho dev)

- Config có `configVersion`; khi đổi cấu trúc có thể tăng version và viết migration trong `loadCfg()`.
- Khi lưu config từ UI, luôn **merge** với config đang lưu (`...loadCfg(), ...cfg`) để không mất key cũ khi bản client mới chưa gửi đủ key.
