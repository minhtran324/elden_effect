# 🎬 Elden LiveEffect Studio Pro

> **Hệ thống Trình điều khiển Hiệu ứng Video & Hũ Quà Rơi TikTok Live Chuyên Nghiệp 60FPS**  
> Tương thích hoàn hảo với OBS Studio, TikTok Live Studio, vMix và Prism Live Studio.

---

## ✨ Tính Năng Nổi Bật

### 1. 🎞️ LiveEffect NLE Studio (Trình Dựng & Xóa Phông Video)
- **Preview & Biên tập thời gian thực:** Cắt ghép clip, điều chỉnh timeline, hiệu ứng âm thanh trực tiếp trên trình duyệt.
- **Xóa phông xanh (Chroma Key) WebGL 60FPS:** Thuật toán lọc màu xanh mượt mà không hao tổn CPU, hỗ trợ kênh trong suốt WebM Alpha `yuva420p`.
- **Hiệu ứng Fade In / Fade Out thông minh:** Không bị ám xanh viền nhân vật khi chuyển cảnh mờ dần.

### 2. 🎁 Kết Nối TikTok Live & Kho 770+ Quà Tặng
- **Kết nối trực tiếp:** Nhận diện sự kiện Live realtime không cần tài khoản trung gian.
- **Khớp quà chuẩn xác theo Gift ID:** Tự động đối chiếu mã ID quà tặng chuẩn từ TikTok, giải quyết triệt để rào cản tiếng Anh / tiếng Việt.
- **Cơ chế Gacha Tỉ lệ Nổ / Xịt:** Tùy biến tỉ lệ % trúng hiệu ứng cho từng món quà hoặc theo mốc xu tối thiểu.
- **🎮 Bộ Bắn Test & Giả Lập:** Test mọi hiệu ứng video, âm thanh và quà tặng lên OBS mà không cần phải bật Live thật.

### 3. 🏺 Hũ Quà Rơi Vật Lý 2D (Physics Jar Engine)
- **Mô phỏng vật lý chân thực (Matter.js):** Quà rơi, nảy và va chạm tự nhiên vào hũ khi người xem donate.
- **Tùy biến đa dạng:** Thay đổi kiểu dáng hũ, vị trí xuất hiện, kích cỡ hạt quà và sticker trang trí thương hiệu.

### 4. ⚡ Hệ Thống Cập Nhật Tự Động (Auto-Update Engine)
- Tự động kiểm tra và nâng cấp phiên bản mới qua GitHub Releases: `minhtran324/elden_effect`.
- **Bảo toàn dữ liệu 100%:** Giữ nguyên video đã dựng, cấu hình hũ và bảng quy tắc của người dùng khi cập nhật.

---

## 🚀 Hướng Dẫn Sử Dụng Nhanh

### Cách 1: Chạy Bản Portable 1-Click (Khuyên Dùng)
1. Bấm đúp chuột vào file **`KhoiDong_Studio.bat`**.
2. Trình duyệt sẽ tự động mở trang Quản Trị: `http://localhost:3000/admin.html`.
3. Khi livestream xong, bấm đúp vào **`Tat_Studio.bat`** để tắt máy chủ an toàn.

### Cách 2: Chạy Bằng Node.js
```bash
# Di chuyển vào thư mục ứng dụng
cd elden-live-effect-studio

# Cài đặt thư viện phụ thuộc
npm install

# Khởi động máy chủ
npm start
```

---

## 📺 Cài Đặt Vào OBS Studio

Tạo 2 nguồn **Browser Source** (Trình duyệt) trong OBS:

| Nguồn OBS | Đường Dẫn URL | Độ Phân Giải Đề Xuất |
| :--- | :--- | :--- |
| **Hiệu Ứng Video Quà Tặng** | `http://localhost:3000/overlay.html` | 1080 x 1920 (9:16 dọc) |
| **Hũ Quà Rơi Vật Lý** | `http://localhost:3000/jar.html` | 1080 x 1920 (9:16 dọc) |

> 💡 **Mẹo:** Trong thuộc tính nguồn Browser của OBS, hãy tick vào ô *"Shutdown source when not visible"* và *"Refresh browser when scene becomes active"* để tối ưu bộ nhớ.

---

## 🛠️ Cấu Trúc Thư Mục

```
EldenEffect/
├── KhoiDong_Studio.bat          # Launcher 1-click khởi động studio
├── Tat_Studio.bat               # Script tắt studio nhanh chóng
├── HUONG_DAN_SU_DUNG.txt        # Hướng dẫn chi tiết cho streamer
├── README.md                    # Tài liệu dự án
└── elden-live-effect-studio/    # Thư mục mã nguồn chính
    ├── server.js                # Máy chủ Express & Socket.IO backend
    ├── package.json             # Cấu hình dependencies
    ├── rules.json               # Cấu hình danh sách hiệu ứng & tỉ lệ quà
    ├── jar_config.json          # Cấu hình hũ quà vật lý
    ├── update_config.json       # Cấu hình phiên bản & auto-update
    └── public/                  # Giao diện web & tài nguyên tĩnh
        ├── admin.html           # Bảng điều khiển trung tâm (Dashboard)
        ├── editor.html          # Trình dựng video LiveEffect NLE Studio
        ├── overlay.html         # Trang nhúng OBS phát video trong suốt
        ├── jar.html             # Trang nhúng OBS hũ quà vật lý
        └── gifts_cache.json     # Danh mục 770+ quà TikTok CDN chính thức
```

---

## 📄 Bản Quyền & Giấy Phép
Dự án được phát triển bởi **minhtran324**. Mọi đóng góp và báo lỗi vui lòng mở Issue trên GitHub Repository.
